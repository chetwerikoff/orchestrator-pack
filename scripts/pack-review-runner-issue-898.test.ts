// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_EFFECTIVE_BUDGET_MS,
  buildReviewerBudgetSpawnEnv,
  createReviewerBudgetLedger,
  resolveReviewerBudgetDecision,
  resolveSoftDeadlineMs,
  resolveTestBudgetMs,
} from '../plugins/codex-pr-reviewer/lib/reviewer_budget.ts';
import { startPackReview } from './pack-review-runner.ts';
import {
  commitPackReviewTerminal,
  readPackReviewAuthority,
  reopenPackReviewAuthorityForExplicitExtraReview,
} from './pack-review-state.ts';
import {
  createPackReviewRun,
  setPackReviewRunTerminal,
} from './lib/pack-review-run-store.ts';
import { resolveBoundIssueSnapshot } from './lib/reverify-bound-issue-snapshot.ts';
import type { CarryoverReplayResult } from './pack-review-carryover.ts';

const roots: string[] = [];
const originalEnv = { ...process.env };
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function cleanPayload(): string {
  return JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] });
}

function issueBody(tier: 'T1' | 'T2' = 'T2', marker = ''): string {
  return [
    '```complexity-tier',
    `tier: ${tier}`,
    `advisory-prior: ${tier}`,
    '```',
    marker,
  ].filter(Boolean).join('\n');
}

function setupHarness(storeRoot: string): void {
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEWER = 'codex';
  process.env.OPK_BASE_DIR = join(storeRoot, 'base');
  process.env.OPK_REVIEW_CLAIM_DIR = join(storeRoot, 'base', 'projects', 'orchestrator-pack', 'review-start-claims');
  process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR = join(storeRoot, 'bound-issue-snapshots');
}

function startFixture(storeRoot: string, overrides: Record<string, unknown> = {}) {
  return startPackReview({
    projectId: 'orchestrator-pack',
    storeRoot,
    sourceRepoRoot: process.cwd(),
    prNumber: 1529,
    headSha: HEAD_A,
    fixtureCurrentPrHeadSha: HEAD_A,
    fixturePrState: 'OPEN',
    fixturePrBody: 'Closes #1529',
    fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
    fixturePostReviewHeadSha: HEAD_A,
    fixturePostReviewPrBody: 'Closes #1529',
    fixtureIssueBody: issueBody(),
    fixtureReviewStdout: cleanPayload(),
    fixtureGithubReviewId: 1529,
    fixtureRequiredStatusWriter: async () => {},
    fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    ...overrides,
  });
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #898 effective reviewer budget contract', () => {
  it('keeps 600000 default and applies 2400000 live override with ceil-to-second runner deadline', () => {
    expect(resolveReviewerBudgetDecision({})).toEqual({
      effectiveBudgetMs: 600000,
      effectiveBudgetSource: 'default',
      maxEffectiveBudgetMs: MAX_EFFECTIVE_BUDGET_MS,
      runnerTimeoutRequiredMs: 900000,
      runnerTimeoutSeconds: 900,
      runnerTimeoutMs: 900000,
      runnerTimeoutSource: 'derived',
      runnerOverheadMs: 300000,
    });
    expect(resolveReviewerBudgetDecision({
      OPK_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: '2400000',
    })).toMatchObject({
      effectiveBudgetMs: 2400000,
      effectiveBudgetSource: 'env',
      runnerTimeoutRequiredMs: 2700000,
      runnerTimeoutSeconds: 2700,
      runnerTimeoutMs: 2700000,
    });
    expect(resolveReviewerBudgetDecision({
      OPK_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: '600001',
    })).toMatchObject({
      runnerTimeoutRequiredMs: 900001,
      runnerTimeoutSeconds: 901,
      runnerTimeoutMs: 901000,
    });
  });

  it('accepts the exact maximum and rejects noncanonical, unsafe, overflowing, or preempting input', () => {
    expect(resolveReviewerBudgetDecision({
      OPK_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: String(MAX_EFFECTIVE_BUDGET_MS),
    })).toMatchObject({
      runnerTimeoutRequiredMs: 2147483000,
      runnerTimeoutSeconds: 2147483,
      runnerTimeoutMs: 2147483000,
    });
    for (const value of [
      String(MAX_EFFECTIVE_BUDGET_MS + 1),
      '0', '-1', '+1', ' 600000', '600000 ', '6e5', '600000.0', '9007199254740992',
    ]) {
      expect(() => resolveReviewerBudgetDecision({
        OPK_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: value,
      })).toThrow(/reviewer_budget_invalid/);
    }
    expect(() => resolveReviewerBudgetDecision({}, 899)).toThrow(/below required 900/);
    expect(resolveReviewerBudgetDecision({}, 901)).toMatchObject({
      runnerTimeoutSeconds: 901,
      runnerTimeoutMs: 901000,
      runnerTimeoutSource: 'explicit',
    });
  });

  it('rejects invalid budget and preempting timeout before runner store or claim effects', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-budget-preflight-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store-not-created');
    process.env.OPK_CODEX_REVIEW_EFFECTIVE_BUDGET_MS = '6e5';
    await expect(startPackReview({ storeRoot })).rejects.toThrow(/reviewer_budget_invalid/);
    expect(existsSync(storeRoot)).toBe(false);

    delete process.env.OPK_CODEX_REVIEW_EFFECTIVE_BUDGET_MS;
    await expect(startPackReview({ storeRoot, timeoutSeconds: '899' })).rejects.toThrow(
      /below required 900/,
    );
    expect(existsSync(storeRoot)).toBe(false);
  });

  it('propagates one ledger into child timeout telemetry without recomputation', () => {
    const ledger = createReviewerBudgetLedger({
      OPK_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: '2400000',
    }, 1_000);
    expect(buildReviewerBudgetSpawnEnv(ledger, {})).toMatchObject({
      OPK_REVIEW_EFFECTIVE_BUDGET_MS: '2400000',
      OPK_REVIEW_SOFT_DEADLINE_MS: '2040000',
      OPK_REVIEW_TEST_BUDGET_MS: '120000',
      OPK_REVIEW_HARD_DEADLINE_MS: '2401000',
      OPK_REVIEW_BUDGET_STARTED_MS: '1000',
      OPK_REVIEW_RUNNER_TIMEOUT_REQUIRED_MS: '2700000',
      OPK_REVIEW_RUNNER_TIMEOUT_SECONDS: '2700',
      OPK_REVIEW_RUNNER_TIMEOUT_MS: '2700000',
    });
  });

  it('preserves sibling env fallback behavior and emits complete telemetry', () => {
    const fallback = createReviewerBudgetLedger({});
    const live = createReviewerBudgetLedger({ OPK_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: '2400000' });
    expect(resolveSoftDeadlineMs(fallback.effectiveBudgetMs)).toBe(510000);
    expect(resolveSoftDeadlineMs(live.effectiveBudgetMs)).toBe(2040000);
    expect(resolveTestBudgetMs(fallback.effectiveBudgetMs)).toBe(120000);
    expect(resolveTestBudgetMs(live.effectiveBudgetMs)).toBe(120000);
    expect(live).toMatchObject({
      effectiveBudgetSource: 'env',
      maxEffectiveBudgetMs: MAX_EFFECTIVE_BUDGET_MS,
      runnerTimeoutRequiredMs: 2700000,
      runnerTimeoutSeconds: 2700,
      runnerTimeoutMs: 2700000,
      runnerTimeoutSource: 'derived',
      runnerOverheadMs: 300000,
    });
    expect(resolveSoftDeadlineMs(600000, { OPK_CODEX_REVIEW_SOFT_DEADLINE_MS: 'not-a-number' })).toBe(510000);
    expect(resolveTestBudgetMs(600000, { OPK_CODEX_REVIEW_TEST_BUDGET_MS: 'not-a-number' })).toBe(120000);
  });
});

describe('Issue #1529 economical PR-led pack-review starts', () => {
  it('uses explicit PR authority even when session cache is corrupt and freezes the linked Issue snapshot', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-1529-pr-led-'));
    roots.push(storeRoot);
    setupHarness(storeRoot);
    const corruptCache = join(storeRoot, 'corrupt-session-cache.json');
    process.env.OPK_PR_SESSION_BINDING_CACHE = corruptCache;
    const body = issueBody('T2', 'winner-body');

    const result = await startFixture(storeRoot, {
      sessionId: 'stale-worker-session',
      fixtureIssueBody: body,
    });

    expect(result).toMatchObject({ ok: true, created: true, reused: false });
    const snapshot = resolveBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 1529,
      prHeadSha: HEAD_A,
      issueNumber: 1529,
      storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
    });
    expect(snapshot.status).toBe('found');
    expect(snapshot.snapshotPath && readFileSync(snapshot.snapshotPath, 'utf8')).toContain('winner-body');
  });

  it('requires an explicit PR even when the advisory session cache has one', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-1529-cache-cannot-select-'));
    roots.push(storeRoot);
    setupHarness(storeRoot);
    const cachePath = join(storeRoot, 'session-cache.json');
    process.env.OPK_PR_SESSION_BINDING_CACHE = cachePath;
    writeFileSync(cachePath, JSON.stringify({
      records: {
        current: {
          sessionId: 'worker-1529',
          prNumber: 1529,
          headSha: HEAD_A,
          repoSlug: 'chetwerikoff/orchestrator-pack',
          issueNumber: 1529,
          superseded: false,
        },
      },
    }));

    await expect(startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      sessionId: 'worker-1529',
      headSha: HEAD_A,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
    })).rejects.toThrow(/requires --pr-number/);
  });

  it('treats a mismatching valid session binding as advisory when an explicit PR is supplied', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-1529-cache-advisory-'));
    roots.push(storeRoot);
    setupHarness(storeRoot);
    const cachePath = join(storeRoot, 'session-cache.json');
    process.env.OPK_PR_SESSION_BINDING_CACHE = cachePath;
    writeFileSync(cachePath, JSON.stringify({
      records: {
        stale: {
          sessionId: 'worker-1529',
          prNumber: 999,
          headSha: HEAD_B,
          repoSlug: 'other/repository',
          issueNumber: 999,
          superseded: false,
        },
      },
    }));

    const result = await startFixture(storeRoot, { sessionId: 'worker-1529' });
    expect(result).toMatchObject({ ok: true, created: true, reused: false });
  });

  it('refuses a PR with no closing Issue instead of inferring one from caller/session data', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-1529-no-issue-'));
    roots.push(storeRoot);
    setupHarness(storeRoot);

    await expect(startFixture(storeRoot, {
      fixturePrBody: 'Refs #1529',
    })).rejects.toThrow(/no resolvable closing Issue/);
  });

  it('rejects a changed PR-linked Issue under the claim before snapshot capture or run creation', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-1529-issue-drift-under-claim-'));
    roots.push(storeRoot);
    setupHarness(storeRoot);

    const result = await startFixture(storeRoot, {
      fixturePrBodyAfterClaim: 'Closes #1530',
    });

    expect(result).toMatchObject({ ok: false, created: false, reused: false, httpStatus: 409 });
    expect(String(result.reason)).toContain('review target Issue changed');
    expect(resolveBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 1529,
      prHeadSha: HEAD_A,
      issueNumber: 1529,
      storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
    }).status).toBe('missing');
  });

  it('rejects a changed PR-linked Issue after review before terminal publication', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-1529-issue-drift-post-review-'));
    roots.push(storeRoot);
    setupHarness(storeRoot);

    const result = await startFixture(storeRoot, {
      fixturePrBodyAfterClaim: 'Closes #1529',
      fixturePostReviewPrBody: 'Closes #1530',
    });

    expect(result).toMatchObject({ ok: false, created: true, reused: false, httpStatus: 409 });
    expect(String(result.reason)).toContain('review target Issue changed');
  });

  it('suppresses a repeated clean same-head model invocation', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-1529-same-head-'));
    roots.push(storeRoot);
    setupHarness(storeRoot);
    const invocationLog = join(storeRoot, 'invocations.jsonl');
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;

    const first = await startFixture(storeRoot);
    const second = await startFixture(storeRoot);

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ created: false, reused: true });
    expect(readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
  });

  it('serializes concurrent first starts before snapshot capture so one durable Issue body wins', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-1529-race-'));
    roots.push(storeRoot);
    setupHarness(storeRoot);

    const results = await Promise.all([
      startFixture(storeRoot, { fixtureIssueBody: issueBody('T2', 'body-A') }),
      startFixture(storeRoot, { fixtureIssueBody: issueBody('T2', 'body-B') }),
    ]);
    expect(results.filter((result) => result.created === true)).toHaveLength(1);

    const snapshot = resolveBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 1529,
      prHeadSha: HEAD_A,
      issueNumber: 1529,
      storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
    });
    expect(snapshot.status).toBe('found');
    const durable = snapshot.snapshotPath ? readFileSync(snapshot.snapshotPath, 'utf8') : '';
    expect(durable.includes('body-A') || durable.includes('body-B')).toBe(true);
    expect(durable.includes('body-A') && durable.includes('body-B')).toBe(false);
  });

  it('uses conflict-free carry-over on a new head without a second reviewer model call', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-1529-carryover-'));
    roots.push(storeRoot);
    setupHarness(storeRoot);
    const invocationLog = join(storeRoot, 'invocations.jsonl');
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;

    const first = await startFixture(storeRoot);
    expect(first.ok).toBe(true);

    process.env.PACK_REVIEWER = 'gpt';
    const replay: CarryoverReplayResult = {
      kind: 'conflict_free_carryover',
      sourceHeadSha: HEAD_A,
      mainSha: 'c'.repeat(40),
      targetHeadSha: HEAD_B,
      mergeBaseSha: 'd'.repeat(40),
      replayTreeSha: 'e'.repeat(40),
      replayDigest: 'fixture-replay',
    };
    const second = await startFixture(storeRoot, {
      headSha: HEAD_B,
      fixtureCurrentPrHeadSha: HEAD_B,
      fixturePostReviewHeadSha: HEAD_B,
      fixtureCarryoverReplay: replay,
      fixtureCarryoverSourceCleanRunId: String(first.runId),
    });

    expect(second.ok).toBe(true);
    expect(readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
  });

  it('allows at-cap explicit clean evidence to settle an exact new-head carry-over with zero model calls', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-1529-at-cap-explicit-carryover-'));
    roots.push(storeRoot);
    setupHarness(storeRoot);
    const invocationLog = join(storeRoot, 'invocations.jsonl');
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
    const finding = JSON.stringify({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ title: 'blocking', severity: 'blocking' }],
    });

    const first = await startFixture(storeRoot, {
      fixtureIssueBody: issueBody('T1'),
      fixtureReviewStdout: finding,
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: issueBody('T1'),
    });
    expect(first.ok).toBe(true);
    const atCap = readPackReviewAuthority(1529, { storeRoot });
    expect(atCap?.cycle).toMatchObject({
      state: 'at_cap_open_findings',
      consumedHeadShas: [HEAD_A],
    });

    const reopened = reopenPackReviewAuthorityForExplicitExtraReview({
      prNumber: 1529,
      expectedTransitionSeq: atCap!.transitionSeq,
      headSha: HEAD_A,
      options: { storeRoot },
    });
    const explicitRun = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1529,
      headSha: HEAD_A,
      linkedSessionId: 'operator-explicit-fixture',
      startReason: 'operator explicit fixture',
      surface: 'operator_adjudicated;session-binding=advisory;issue=1529',
      trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(),
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      automaticBudgetDisposition: 'non_consuming_explicit',
      allowCompletedSameHeadReplay: true,
    }).run;
    setPackReviewRunTerminal(explicitRun.id, 'up_to_date', {
      reviewVerdict: 'clean',
      findingCount: 0,
      findings: [],
    }, { projectId: 'orchestrator-pack', storeRoot });
    commitPackReviewTerminal({
      prNumber: 1529,
      expectedTransitionSeq: reopened.transitionSeq,
      terminal: {
        schemaVersion: 1,
        terminalContractVersion: 2,
        terminalSource: 'normal',
        automaticBudgetDisposition: 'non_consuming_explicit',
        runId: explicitRun.id,
        targetSha: HEAD_A,
        reviewVerdict: 'clean',
        findingCount: 0,
        findingsDigest: 'fixture-explicit-clean',
      },
      status: 'up_to_date',
      findingCount: 0,
      options: { storeRoot },
    });
    const explicitAuthority = readPackReviewAuthority(1529, { storeRoot });
    expect(explicitAuthority?.terminal).toMatchObject({
      runId: explicitRun.id,
      targetSha: HEAD_A,
      reviewVerdict: 'clean',
      automaticBudgetDisposition: 'non_consuming_explicit',
    });
    expect(explicitAuthority?.cycle).toMatchObject({
      state: 'at_cap_open_findings',
      consumedHeadShas: [HEAD_A],
    });

    const replay: CarryoverReplayResult = {
      kind: 'conflict_free_carryover',
      sourceHeadSha: HEAD_A,
      mainSha: 'c'.repeat(40),
      targetHeadSha: HEAD_B,
      mergeBaseSha: 'd'.repeat(40),
      replayTreeSha: 'e'.repeat(40),
      replayDigest: 'fixture-at-cap-replay',
    };
    const beforeCarryoverCalls = readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
    const second = await startFixture(storeRoot, {
      headSha: HEAD_B,
      fixtureCurrentPrHeadSha: HEAD_B,
      fixturePostReviewHeadSha: HEAD_B,
      fixtureIssueBody: issueBody('T1'),
      fixtureCarryoverReplay: replay,
      fixtureCarryoverSourceCleanRunId: explicitRun.id,
    });

    expect(second).toMatchObject({ ok: true, created: true, reused: false });
    expect(readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/).filter(Boolean)).toHaveLength(beforeCarryoverCalls);
    const authority = readPackReviewAuthority(1529, { storeRoot });
    expect(authority?.terminal).toMatchObject({
      targetSha: HEAD_B,
      reviewVerdict: 'clean',
      terminalSource: 'conflict_free_carryover',
      sourceCleanRunId: undefined,
    });
    expect(authority?.cycle).toMatchObject({
      state: 'closed',
      consumedHeadShas: [HEAD_A],
    });
  });

  it('does not invoke a reviewer for an automatic new-head start after the T1 cap is exhausted', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-1529-cap-'));
    roots.push(storeRoot);
    setupHarness(storeRoot);
    const invocationLog = join(storeRoot, 'invocations.jsonl');
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
    const finding = JSON.stringify({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ title: 'blocking', severity: 'blocking' }],
    });

    const first = await startFixture(storeRoot, {
      fixtureIssueBody: issueBody('T1'),
      fixtureReviewStdout: finding,
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: issueBody('T1'),
    });
    expect(first.ok).toBe(true);

    const second = await startFixture(storeRoot, {
      headSha: HEAD_B,
      fixtureCurrentPrHeadSha: HEAD_B,
      fixturePostReviewHeadSha: HEAD_B,
      fixtureIssueBody: issueBody('T1'),
    });
    expect(second).toMatchObject({ ok: false, created: false, reason: 'at_cap_continuation_required' });
    expect(readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
  });
});
