// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  observeGptPackReviewAttempt,
  observeNativePackReviewAttempt,
  parseAuthoritativeTier,
  startPackReview,
} from './pack-review-runner.ts';
import type { PackReviewRunRecord } from './lib/pack-review-run-store.ts';
import { runProcess } from './kernel/subprocess.ts';
import {
  PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
  commitSmokeOrderingTransition,
  initializePackReviewAuthority,
  readPackReviewAuthority,
} from './pack-review-state.ts';

const roots: string[] = [];
const originalEnv = { ...process.env };
const HEAD = 'a'.repeat(40);

function setupHarness(storeRoot: string): void {
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEWER = 'codex';
  process.env.OPK_BASE_DIR = join(storeRoot, 'base');
  process.env.OPK_REVIEW_CLAIM_DIR = join(storeRoot, 'base', 'projects', 'orchestrator-pack', 'review-start-claims');
  process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR = join(storeRoot, 'bound-issue-snapshots');
}

function cleanPayload(): string {
  return JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] });
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #1826 reviewer-native replacement observation', () => {
  function gptRun(admissionStartedAtUtc: string): PackReviewRunRecord {
    return {
      schemaVersion: 1,
      id: 'prr-gpt-observation',
      runId: 'prr-gpt-observation',
      projectId: 'orchestrator-pack',
      key: `pr-1826-${HEAD}`,
      prNumber: 1826,
      targetSha: HEAD,
      headSha: HEAD,
      status: 'failed',
      latestRunStatus: 'failed',
      linkedSessionId: 'worker',
      startReason: 'automatic',
      surface: 'test',
      trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(),
      automaticBudgetDisposition: 'consume',
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      accountingVersion: 'issue-1826-logical-rounds-1-1-2',
      reviewCycleId: 'cycle-1826',
      logicalRoundOrdinal: 1,
      logicalRoundCap: 2,
      resolvedReviewer: 'gpt',
      reviewRound: {
        schema: 'pack-review-gpt-round/v1',
        reviewer: 'gpt',
        tier: 'T3',
        accountingVersion: 'issue-1826-logical-rounds-1-1-2',
        roundOrdinal: 1,
        cardinality: 3,
        issueNumber: 1826,
        boundIssueSnapshotDigest: 'd'.repeat(64),
        sourceSlots: [
          {
            slotId: 'slot-01',
            ordinal: 1,
            lifecycle: 'invocation_started',
            invocationId: 'invocation-01',
            attemptOrdinal: 1,
            admissionStartedAtUtc,
            launchProfileKey: 'profile-01',
            launchCdpUrl: 'http://127.0.0.1:9222',
          },
          { slotId: 'slot-02', ordinal: 2, lifecycle: 'planned' },
          { slotId: 'slot-03', ordinal: 3, lifecycle: 'planned' },
        ],
      },
      runnerPid: process.pid,
      createdAt: admissionStartedAtUtc,
      updatedAt: admissionStartedAtUtc,
      heartbeatAtUtc: admissionStartedAtUtc,
      findings: [],
      deliveryOutcomes: {},
    };
  }

  function gptObservationDeps(input: {
    markerPresent: boolean;
    generating: boolean | 'unknown';
    replyPresent?: boolean;
    nodesTruncated?: boolean;
  }) {
    const marker = `OPKTURNV1${'a'.repeat(32)}`;
    const probe = async (args: { operation: string }) => {
      if (args.operation === 'list') {
        return {
          schema: 'browser-gpt-page-probe/v1',
          operation: 'list',
          status: 'ok',
          diagnostic_only: true,
          workflow_authority: 'none',
          targets_truncated: false,
          targets: [{ target_id: 'target-1', normalized_url: 'https://chatgpt.com/c/one', title: 'one' }],
        };
      }
      return {
        schema: 'browser-gpt-page-probe/v1',
        operation: 'inspect',
        status: 'ok',
        diagnostic_only: true,
        workflow_authority: 'none',
        snapshot: {
          generation_in_progress: input.generating,
          nodes_truncated: input.nodesTruncated === true,
          nodes: [
            ...(input.markerPresent ? [{
              role: 'user',
              document_ordinal: 1,
              innerText: { head: `${marker} prompt`, byte_length: 64 },
            }] : []),
            ...(input.replyPresent ? [{
              role: 'assistant',
              document_ordinal: 2,
              innerText: { head: 'done', byte_length: 4 },
            }] : []),
          ],
        },
      };
    };
    const readObservation = () => ({
      schema: 'state-light-turn-observation/v1' as const,
      version: 1 as const,
      invocation_id: 'invocation-01',
      profile_key: 'profile-01',
      marker,
      phase: 'sent_unharvested' as const,
      send_witness: 'owned_marker' as const,
      send_count: 1,
      conversation_url: 'https://chatgpt.com/c/one',
      transitioned_at: '2026-08-30T00:00:00.000Z',
      transition_reason: 'fixture',
    });
    return { probe: probe as never, readObservation: readObservation as never };
  }

  it('does not replace a Browser GPT turn that is still generating before 15 minutes', async () => {
    const start = Date.parse('2026-08-30T00:00:00.000Z');
    const observed = await observeGptPackReviewAttempt(
      gptRun(new Date(start).toISOString()),
      start + 14 * 60_000,
      gptObservationDeps({ markerPresent: true, generating: true }),
    );
    expect(observed).toMatchObject({ state: 'generating', replacementEligible: false });
  });

  it('permits Browser GPT replacement after 15 minutes of confirmed generation and GitHub absence', async () => {
    const start = Date.parse('2026-08-30T00:00:00.000Z');
    const observed = await observeGptPackReviewAttempt(
      gptRun(new Date(start).toISOString()),
      start + 15 * 60_000,
      gptObservationDeps({ markerPresent: true, generating: true }),
    );
    expect(observed).toMatchObject({ state: 'replacement_eligible', replacementEligible: true });
  });

  it('does not authorize replacement from a truncated all-tab message census', async () => {
    const start = Date.parse('2026-08-30T00:00:00.000Z');
    const observed = await observeGptPackReviewAttempt(
      gptRun(new Date(start).toISOString()),
      start + 20 * 60_000,
      gptObservationDeps({ markerPresent: false, generating: false, nodesTruncated: true }),
    );
    expect(observed).toMatchObject({ state: 'observation_unavailable', replacementEligible: false });
  });
  it('requires recovery of an attributable finished reply instead of replacement', async () => {
    const start = Date.parse('2026-08-30T00:00:00.000Z');
    const observed = await observeGptPackReviewAttempt(
      gptRun(new Date(start).toISOString()),
      start + 60_000,
      gptObservationDeps({ markerPresent: true, generating: false, replyPresent: true }),
    );
    expect(observed).toMatchObject({ state: 'reply_recovery_required', replacementEligible: false });
  });

  it('uses the live fallback Claude child after same-run active-binding rollover until its own ceiling', async () => {
    if (process.platform === 'win32') return;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const firstStartedAt = '2026-08-30T00:00:00.000Z';
    const fallbackStartedAt = '2026-08-30T00:05:00.000Z';
    let resolveFirstPid!: (pid: number) => void;
    const firstPidReady = new Promise<number>((resolve) => { resolveFirstPid = resolve; });
    const firstResult = runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      allowEmptyStdout: true,
      onSpawn: resolveFirstPid,
    });
    const firstPid = await firstPidReady;

    const run = gptRun(firstStartedAt);
    run.reviewRound = undefined;
    run.resolvedReviewer = 'claude';
    run.nativeAttempt = {
      schema: 'pack-review-native-attempt/v1',
      reviewer: 'claude',
      invocationOrdinal: 1,
      startedAtUtc: firstStartedAt,
      effectiveBudgetMs: 30 * 60_000,
      wrapperPid: firstPid,
      processGroupId: firstPid,
      childPid: firstPid,
      childProcessGroupId: firstPid,
      childStartedAtUtc: firstStartedAt,
    };

    process.kill(-firstPid, 'SIGKILL');
    await firstResult;

    let resolveFallbackPid!: (pid: number) => void;
    const fallbackPidReady = new Promise<number>((resolve) => { resolveFallbackPid = resolve; });
    const fallbackResult = runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      allowEmptyStdout: true,
      onSpawn: resolveFallbackPid,
    });
    const fallbackPid = await fallbackPidReady;
    try {
      run.nativeAttempt = {
        schema: 'pack-review-native-attempt/v1',
        reviewer: 'claude',
        invocationOrdinal: 2,
        startedAtUtc: fallbackStartedAt,
        effectiveBudgetMs: 30 * 60_000,
        wrapperPid: fallbackPid,
        processGroupId: fallbackPid,
        childPid: fallbackPid,
        childProcessGroupId: fallbackPid,
        childStartedAtUtc: fallbackStartedAt,
      };

      expect(observeNativePackReviewAttempt(run, Date.parse(fallbackStartedAt) + 14 * 60_000))
        .toMatchObject({
          reviewer: 'claude',
          state: 'running',
          replacementEligible: false,
          nativeReplacementCeilingMs: 15 * 60_000,
        });
      expect(observeNativePackReviewAttempt(run, Date.parse(fallbackStartedAt) + 15 * 60_000))
        .toMatchObject({
          reviewer: 'claude',
          state: 'running',
          replacementEligible: true,
          nativeReplacementCeilingMs: 15 * 60_000,
        });
    } finally {
      try { process.kill(-fallbackPid, 'SIGKILL'); } catch { /* already gone */ }
      await fallbackResult;
    }
  });
  it('keeps native replacement conservative when no process-group binding is observable', () => {
    const run = gptRun('2026-08-30T00:00:00.000Z');
    run.reviewRound = undefined;
    run.resolvedReviewer = 'claude';
    run.nativeAttempt = {
      schema: 'pack-review-native-attempt/v1',
      reviewer: 'claude',
      invocationOrdinal: 2,
      startedAtUtc: '2026-08-30T00:00:00.000Z',
      effectiveBudgetMs: 30 * 60_000,
      wrapperPid: process.pid,
    };
    expect(observeNativePackReviewAttempt(run, Date.parse('2026-08-30T00:20:00.000Z')))
      .toMatchObject({ state: 'observation_unavailable', replacementEligible: false });
  });
});

describe('Issue #1826 logical-round smoke independence', () => {
  it('admits T3 round 2 on a fixed new head without requiring a second worker smoke', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-1826-round2-smoke-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);
    const head1 = '1'.repeat(40);
    const head2 = '2'.repeat(40);
    const prNumber = 1826;
    const issueBody = [
      '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```',
      '```smoke-test-plan\nscenarios:\n  - action: exact head smoke | expected: PASS\n```',
    ].join('\n\n');
    const options = { storeRoot };
    const initial = initializePackReviewAuthority({
      prNumber,
      headSha: head1,
      tier: 'T3',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options,
    });
    const smokeStarted = commitSmokeOrderingTransition({
      prNumber,
      expectedTransitionSeq: initial.transitionSeq,
      actor: 'worker-owned',
      headSha: head1,
      status: 'started',
      options,
    });
    commitSmokeOrderingTransition({
      prNumber,
      expectedTransitionSeq: smokeStarted.transitionSeq,
      actor: 'worker-owned',
      headSha: head1,
      status: 'passed',
      options,
    });

    const round1 = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber,
      headSha: head1,
      claimMode: 'preacquired',
      fixtureCurrentPrHeadSha: head1,
      fixturePostReviewHeadSha: head1,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #1826',
      fixturePostReviewPrBody: 'Closes #1826',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: 1826,
      fixtureIssueBody: issueBody,
      fixtureReviewStdout: JSON.stringify({
        verdict: 'findings',
        findingCount: 1,
        findings: [{ severity: 'blocking', title: 'round one finding' }],
      }),
      fixtureGithubReviewId: 182601,
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });
    expect(round1).toMatchObject({ ok: true, created: true });
    expect(readPackReviewAuthority(prNumber, options)?.cycle?.consumedRoundOrdinals).toEqual([1]);

    const round2 = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber,
      headSha: head2,
      claimMode: 'preacquired',
      fixtureCurrentPrHeadSha: head2,
      fixturePostReviewHeadSha: head2,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #1826',
      fixturePostReviewPrBody: 'Closes #1826',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: 1826,
      fixtureIssueBody: issueBody,
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 182602,
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });

    expect(round2).toMatchObject({ ok: true, created: true });
    const finalAuthority = readPackReviewAuthority(prNumber, options);
    expect(finalAuthority?.cycle?.consumedRoundOrdinals).toEqual([1, 2]);
    expect(finalAuthority?.cycle?.reviewStageComplete).toBe(true);
    expect(finalAuthority?.smokeOrdering?.workerOwned?.headSha).toBe(head1);
  });
});
describe('Issue #1647 authoritative tier resolution', () => {
  it('uses the canonical default for a legal Issue without a complexity-tier fence', () => {
    expect(parseAuthoritativeTier('# Firefighter repair\n\nNo tier is required.')).toBe('T2');
  });

  it('uses the canonical default for an explicit no-tier Issue', () => {
    expect(parseAuthoritativeTier('```complexity-tier\nskip-line: true\n```')).toBe('T2');
  });

  it('continues to reject an invalid complexity-tier fence', () => {
    expect(() => parseAuthoritativeTier('```complexity-tier\ntier: T4\n```'))
      .toThrow('authoritative Issue tier is invalid');
  });

  it('rejects an unterminated complexity-tier fence instead of defaulting', () => {
    expect(() => parseAuthoritativeTier('```complexity-tier\ntier: T3'))
      .toThrow('authoritative Issue tier is invalid');
  });

  it('allows pack-review to produce a verdict for a firefighter Issue without a tier fence', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-1647-tierless-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber: 1647,
      headSha: HEAD,
      fixtureCurrentPrHeadSha: HEAD,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #1647',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixturePostReviewHeadSha: HEAD,
      fixturePostReviewPrBody: 'Closes #1647',
      fixtureIssueBody: '# Firefighter repair\n\nNo complexity tier is required.',
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 1647,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });

    expect(result).toMatchObject({ ok: true, created: true, reused: false });
  });
});
