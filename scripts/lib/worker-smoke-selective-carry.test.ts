import { readFileSync } from 'node:fs';
// @vitest-pre-topology-seconds 1
// @vitest-ci-lane light
import { describe, expect, it } from 'vitest';
import {
  evaluateWorkerSmokeMainMergeCarry,
  formatSmokeReportComment,
  planWorkerSmokeSelectiveRetry,
  SMOKE_REPORT_PRODUCER,
  type SmokeReport,
  type WorkerSmokeCommentRecord,
  type WorkerSmokeTrustedTarget,
} from './worker-smoke-core.ts';

const ISSUE = 2213;
const PR = 2300;
const EARLIER_HEAD = '1'.repeat(40);
const CURRENT_HEAD = '2'.repeat(40);
const MERGE_BASE = '3'.repeat(40);
const MAIN_HEAD = '4'.repeat(40);
const PATCH_ID = '5'.repeat(40);
const TRUSTED_ACTOR = 'pack-publisher';
const ACTION = 'exercise independent smoke scenario';
const EXPECTED = 'scenario executes unless an eligible earlier-head carry exists';

function issueBody(): string {
  return [
    '```behavior-kind',
    'action-producing',
    '```',
    '',
    '```smoke-test-plan',
    'scenarios:',
    '  - action: ' + ACTION + ' | expected: ' + EXPECTED,
    '```',
  ].join('\n');
}

function passReport(headSha: string): SmokeReport {
  return {
    result: 'PASS',
    issueNumber: ISSUE,
    prNumber: PR,
    headSha,
    scenarios: [{
      action: ACTION,
      expected: EXPECTED,
      observed: 'scenario executed',
      outcome: 'pass',
    }],
    limitations: [],
    trackedFilesUnmodified: true,
    terminalCleanup: 'closed_owned_handle',
    environmentNotes: ['smoke-execution=executed'],
    producer: SMOKE_REPORT_PRODUCER,
    orcaExecutable: 'runtime-adapter',
    terminalHandle: 'smoke-terminal-1',
  };
}

function comment(id: number, report: SmokeReport): WorkerSmokeCommentRecord {
  const timestamp = new Date(Date.UTC(2026, 8, 28, 0, 0, 0, id)).toISOString();
  return {
    id,
    body: formatSmokeReportComment(report),
    created_at: timestamp,
    updated_at: timestamp,
    user: { login: TRUSTED_ACTOR },
  };
}

function target(headSha = CURRENT_HEAD): WorkerSmokeTrustedTarget {
  return {
    repositorySlug: 'chetwerikoff/orchestrator-pack',
    issueNumber: ISSUE,
    prNumber: PR,
    headSha,
    resolvedIssueNumber: ISSUE,
    resolvedPrNumber: PR,
    liveHeadSha: headSha,
    issueBodyMatchesTarget: true,
    trustedPublisherLogin: TRUSTED_ACTOR,
    commentCensusComplete: true,
    commentSnapshotStable: true,
  };
}

describe('Issue #2213 actor-sensitive selective smoke carry', () => {
  it('does not carry the only same-head worker-owned PASS into an independent run', () => {
    const comments = [comment(1, passReport(CURRENT_HEAD))];
    const common = {
      issueBody: issueBody(),
      prBody: '',
      comments,
      target: target(),
      isAncestor: () => true,
    };

    const workerOwned = planWorkerSmokeSelectiveRetry({
      ...common,
      smokeActor: 'worker-owned',
      workerOwnedPassHeadShas: [CURRENT_HEAD],
    });
    expect(workerOwned.carried).toHaveLength(1);
    expect(workerOwned.attemptPlan.scenarios).toHaveLength(0);

    const independent = planWorkerSmokeSelectiveRetry({
      ...common,
      smokeActor: 'independent',
      workerOwnedPassHeadShas: [CURRENT_HEAD],
    });
    expect(independent.carried).toHaveLength(0);
    expect(independent.attemptPlan.scenarios).toEqual([
      { action: ACTION, expected: EXPECTED },
    ]);
  });

  it('keeps an earlier independent PASS eligible for the existing clean main-merge carry', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody(),
      prBody: '',
      comments: [
        comment(1, passReport(EARLIER_HEAD)),
        comment(2, passReport(CURRENT_HEAD)),
      ],
      target: target(),
      isAncestor: (ancestorSha, descendantSha) =>
        ancestorSha === EARLIER_HEAD && descendantSha === CURRENT_HEAD,
      smokeActor: 'independent',
      workerOwnedPassHeadShas: [CURRENT_HEAD],
    });

    expect(selection.attemptPlan.scenarios).toHaveLength(0);
    expect(selection.carried).toHaveLength(1);
    expect(selection.carried[0]?.sourceHeadSha).toBe(EARLIER_HEAD);

    expect(evaluateWorkerSmokeMainMergeCarry({
      sourceHeadSha: EARLIER_HEAD,
      destinationHeadSha: CURRENT_HEAD,
      mergeBaseSha: MERGE_BASE,
      destinationBaseSha: MAIN_HEAD,
      sourcePatchId: PATCH_ID,
      destinationPatchId: PATCH_ID,
      mainPaths: ['docs/main-only-change.md'],
      protectedPaths: ['scripts/lib/worker-smoke-core.ts'],
      cleanMainMerge: true,
      descendant: true,
      hasConflictResolution: false,
    }, CURRENT_HEAD, EARLIER_HEAD)).toMatchObject({
      allowed: true,
      mainPaths: ['docs/main-only-change.md'],
    });
  });
});

describe('Issue #2319 retired smoke execution caller removal', () => {
  it('does not invoke progress, cancellation, selective carry, or nested-run machinery from the active worker', () => {
    const source = readFileSync('scripts/worker-smoke-run.ts', 'utf8');
    expect(source).not.toContain('runSmokeAttempt');
    expect(source).not.toContain('buildSmokeProgressWriterCommand');
    expect(source).not.toContain('writeSmokeCancelRequest');
    expect(source).not.toContain('inspectSmokeProgress');
    expect(source).not.toContain('planWorkerSmokeSelectiveRetry(');
    expect(source).not.toContain('deriveMainMergeCarryProof');
  });
});
