// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPackReview } from './pack-review-runner.ts';
import { listPackReviewRuns } from './lib/pack-review-run-store.ts';
import {
  PACK_REVIEW_CAP_MAP_VERSION,
  PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
  commitPackReviewTerminal,
  commitPackReviewTriage,
  initializePackReviewAuthority,
  observePackReviewHead,
  readPackReviewAuthority,
  recordPackReviewPublication,
  reconcilePackReviewTier,
  settleLogicalPackReviewFindingsByStrictDescendant,
  type PackReviewAuthorityOptions,
} from './pack-review-state.ts';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

describe('Issue #2250 retire smoke ordering without removing pack-review cycle authority', () => {
  const roots: string[] = [];
  afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function authorityFixture(tier: 'T1' | 'T2' | 'T3' = 'T3') {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-no-smoke-ordering-'));
    roots.push(root);
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'test-config'));
    const options: PackReviewAuthorityOptions = { storeRoot: root };
    const authority = initializePackReviewAuthority({
      prNumber: 1436,
      headSha: HEAD,
      tier,
      capMapVersion: PACK_REVIEW_CAP_MAP_VERSION,
      options,
    });
    return { options, authority };
  }

  it('settles the existing pack-review without pre-review smoke ordering', async () => {
    const { options } = authorityFixture();
    const issueBody = [
      '```complexity-tier',
      'tier: T3',
      'advisory-prior: T3',
      '```',
      '',
      '```smoke-test-plan',
      'scenarios:',
      '  - action: exact head smoke | expected: PASS',
      '```',
    ].join('\n');
    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot: options.storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber: 1436,
      headSha: HEAD,
      fixtureCurrentPrHeadSha: HEAD,
      fixturePrState: 'OPEN',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: 1436,
      fixtureIssueBody: issueBody,
      fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => undefined,
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      claimMode: 'preacquired',
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot: options.storeRoot })).toHaveLength(1);
    const finalAuthority = readPackReviewAuthority(1436, options)!;
    expect(finalAuthority.cycle?.reviewStageComplete).toBe(true);
    expect(finalAuthority.cycle?.reviewStageComplete).toBe(true);
  });

  it('retains the production non-blocking pack-review disposition', async () => {
    const { options } = authorityFixture();
    const issueBody = [
      '```complexity-tier',
      'tier: T3',
      'advisory-prior: T3',
      '```',
      '',
      '```smoke-test-plan',
      'scenarios:',
      '  - action: exact head smoke | expected: PASS',
      '```',
    ].join('\n');
    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot: options.storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber: 1436,
      headSha: HEAD,
      fixtureCurrentPrHeadSha: HEAD,
      fixturePrState: 'OPEN',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: 1436,
      fixtureIssueBody: issueBody,
      fixtureReviewStdout: JSON.stringify({
        verdict: 'findings',
        findingCount: 1,
        findings: [{ severity: 'warning', title: 'non-blocking fixture finding' }],
      }),
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => undefined,
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      claimMode: 'preacquired',
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const finalAuthority = readPackReviewAuthority(1436, options)!;
    expect(finalAuthority.terminal?.reviewStatus).toBe('commented');
  });

  it('persists authoritative DEFER/BLOCK/PENDING cap triage without smoke admission', () => {
    for (const [verdict, source] of [
      ['DEFER', 'architect'],
      ['BLOCK', 'architect'],
      ['PENDING_OPERATOR', 'automatic'],
    ] as const) {
      const { options, authority } = authorityFixture('T1');
      const terminal = commitPackReviewTerminal({
        prNumber: 1436,
        expectedTransitionSeq: authority.transitionSeq,
        terminal: {
          schemaVersion: 1,
          terminalContractVersion: 2,
          terminalSource: 'normal',
          runId: `at-cap-${verdict}`,
          targetSha: HEAD,
          reviewVerdict: 'findings',
          findingCount: 1,
          findingsDigest: 'findings-digest',
        },
        status: 'changes_requested',
        findingCount: 1,
        options,
      });
      const triaged = commitPackReviewTriage({
        prNumber: 1436,
        expectedTransitionSeq: terminal.transitionSeq,
        triage: {
          verdict,
          source,
          findingSnapshotDigest: 'findings-snapshot',
          committedAtUtc: new Date().toISOString(),
        },
        options,
      });
      const published = recordPackReviewPublication({
        prNumber: 1436,
        expectedTransitionSeq: triaged.transitionSeq,
        publication: {
          headSha: HEAD,
          terminalRunId: `at-cap-${verdict}`,
          status: 'succeeded',
          publicationDigest: 'publication-digest',
          recordedAtUtc: new Date().toISOString(),
        },
        options,
      });
      expect(published.triage).toMatchObject({ verdict, source });
      expect(published.cycle?.frozenTier).toBe('T1');
      expect(published.smokeOrdering).toBeUndefined();
    }
  });

  it('completes a logical final-finding stage on a proven strict descendant', () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-logical-architect-final-'));
    roots.push(root);
    const options: PackReviewAuthorityOptions = { storeRoot: root };
    const authority = initializePackReviewAuthority({
      prNumber: 1826,
      headSha: HEAD,
      tier: 'T1',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options,
    });
    const terminal = commitPackReviewTerminal({
      prNumber: 1826,
      expectedTransitionSeq: authority.transitionSeq,
      terminal: {
        schemaVersion: 1,
        terminalContractVersion: 2,
        terminalSource: 'normal',
        runId: 'logical-final-findings',
        targetSha: HEAD,
        logicalRoundOrdinal: 1,
        reviewVerdict: 'findings',
        findingCount: 1,
        findingsDigest: 'logical-final-findings-digest',
      },
      status: 'changes_requested',
      findingCount: 1,
      options,
    });
    const published = recordPackReviewPublication({
      prNumber: 1826,
      expectedTransitionSeq: terminal.transitionSeq,
      publication: {
        headSha: HEAD,
        terminalRunId: 'logical-final-findings',
        status: 'succeeded',
        publicationDigest: 'logical-final-publication',
        recordedAtUtc: new Date().toISOString(),
      },
      options,
    });
    const fixHead = observePackReviewHead({
      prNumber: 1826,
      expectedTransitionSeq: published.transitionSeq,
      headSha: NEXT_HEAD,
      options,
    });
    expect(fixHead.cycle).toMatchObject({
      state: 'at_cap_continuation_required',
      consumedRoundOrdinals: [1],
    });
    expect(fixHead.publication).toBeUndefined();

    const settled = settleLogicalPackReviewFindingsByStrictDescendant({
      prNumber: 1826,
      expectedTransitionSeq: fixHead.transitionSeq,
      reviewedHeadSha: HEAD,
      currentHeadSha: NEXT_HEAD,
      reviewedHeadIsAncestor: true,
      options,
    });

    expect(settled.cycle).toMatchObject({
      state: 'closed',
      reviewStageComplete: true,
    });
    expect(settled.triage).toBeUndefined();
    expect(settled.cycle?.reviewStageComplete).toBe(true);
  });

  it('reconciles a persisted T2 cycle before T3 review admission', () => {
    const { options, authority } = authorityFixture('T2');
    const reconciled = reconcilePackReviewTier({
      prNumber: 1436,
      tier: 'T3',
      options,
    });
    expect(reconciled.transitionSeq).toBe(authority.transitionSeq + 1);
    expect(reconciled.cycle).toMatchObject({ state: 'open', frozenTier: 'T3', frozenCap: 4 });
  });


  it('has no executable smoke-ordering admission, transition, or scheduler start/observe authority', () => {
    const state = readFileSync('scripts/pack-review-state.ts', 'utf8');
    const worker = readFileSync('scripts/worker-smoke-run.ts', 'utf8');
    const runner = readFileSync('scripts/pack-review-runner.ts', 'utf8');
    for (const forbidden of [
      'export function assertPackReviewSmokeAdmission',
      'export function assertIndependentSmokeAdmission',
      'export function commitSmokeOrderingTransition',
      'export function smokeOrderingRequired',
    ]) expect(state).not.toContain(forbidden);
    for (const forbidden of [
      'selectSmokeAttempt', 'preAttemptPublication', 'planWorkerSmokeSelectiveRetry',
    ]) expect(worker).not.toContain(forbidden);
    for (const forbidden of [
      'beginSmokeOrdering', 'finishSmokeOrdering',
      'commitSmokeOrderingTransition', 'smokeOrderingRequired',
    ]) expect(worker).not.toContain(forbidden);
    expect(runner).not.toContain('assertPackReviewSmokeAdmission');
    expect(state).toContain('smokeOrdering?: PackReviewSmokeOrdering');
    expect(existsSync('scripts/pr2-foundation/post-review-smoke.ts')).toBe(false);
    expect(readFileSync('scripts/pr2-foundation/scheduler.ts', 'utf8')).not.toContain('reconcilePostReviewSmoke');
  });
});
