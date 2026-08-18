import { describe, expect, it } from 'vitest';
import {
  STAGE_ORDER_VIOLATION,
  STAGE_SLOT_CONSUMED,
  TERMINAL_BUNDLE_UNAVAILABLE,
  admitStageLaunch,
  canonicalStageTopology,
  type LifecycleTierIntakeV1,
  type TerminalBundleV1,
} from './create-issue-stage-lifecycle.ts';

const intake = (overrides: Partial<LifecycleTierIntakeV1> = {}): LifecycleTierIntakeV1 => ({
  schema: 'tier-intake/v1',
  producer: 'flow-manager',
  taskIdentity: 'issue:1439',
  kind: 'fresh',
  priorTier: 'T3',
  firstRevision: 'r01',
  competitiveDecision: 'skipped',
  competitiveRationale: 'one bounded implementation topology remains after architecture review',
  ...overrides,
});

function receipt(stage: string, stageAttemptId: string, stageSequence: number, outcome = 'complete') {
  return {
    schema: 'stage-completeness-receipt/v1',
    taskIdentity: 'issue:1439',
    episodeFirstRevision: 'r01',
    reviewEpisodeId: 'issue:1439@r01',
    stage,
    stageAttemptId,
    stageSequence,
    sourceRevision: 'r01',
    outcome,
  };
}

function bundle(predecessorStage: TerminalBundleV1['predecessorStage'], sourceRevision = 'r02'): TerminalBundleV1 {
  return {
    schema: 'create-issue-terminal-input-bundle/v1',
    reviewEpisodeId: 'issue:1439@r01',
    sourceRevision,
    predecessorStage,
    currentIssue: {
      sourceRevision,
      body: `<!-- source-revision: ${sourceRevision} -->\nbody`,
    },
    rejectPartition: [],
    protectedM3: [],
    authorM4: [],
    reviewEconomics: { rawFindingCount: 0, distinctFindingCount: 0, processedDistinctCount: 0 },
  };
}

describe('Issue #1439 canonical stage lifecycle', () => {
  it('freezes one fixed topology per tier and honors a T3 competitive skip', () => {
    expect(canonicalStageTopology('T1', intake({ priorTier: 'T1' })).stages.map((entry) => [entry.stage, entry.reviewerCardinality])).toEqual([
      ['architectural', 1],
    ]);
    expect(canonicalStageTopology('T2', intake({ priorTier: 'T2' })).stages.map((entry) => [entry.stage, entry.reviewerCardinality])).toEqual([
      ['architectural-review', 3],
      ['architectural', 1],
    ]);
    expect(canonicalStageTopology('T3', intake()).stages.map((entry) => [entry.stage, entry.reviewerCardinality])).toEqual([
      ['architectural-review', 3],
      ['architectural-lens', 1],
      ['architectural', 1],
    ]);
    expect(canonicalStageTopology('T3', intake({ competitiveDecision: 'required' })).stages[0]).toMatchObject({
      stage: 'competitive', reviewerCardinality: 3,
    });
  });

  it('refuses a consumed semantic stage slot with the consuming attempt id across revisions', () => {
    const result = admitStageLaunch({
      issueNumber: 1439,
      tier: 'T3',
      stage: 'architectural-review',
      sourceRevision: 'r02',
      issueBody: '<!-- source-revision: r02 -->\nrepaired body',
      intake: intake(),
      receiptValues: [receipt('architectural-review', 'attempt-review-1', 1, 'partial')],
    });
    expect(result).toMatchObject({
      ok: false,
      code: STAGE_SLOT_CONSUMED,
      consumingStageAttemptId: 'attempt-review-1',
    });
  });

  it('refuses wrong-order launch without consuming the requested stage', () => {
    const result = admitStageLaunch({
      issueNumber: 1439,
      tier: 'T3',
      stage: 'architectural',
      sourceRevision: 'r01',
      issueBody: '<!-- source-revision: r01 -->\nbody',
      intake: intake(),
      receiptValues: [],
    });
    expect(result).toMatchObject({
      ok: false,
      code: STAGE_ORDER_VIOLATION,
      expectedStage: 'architectural-review',
      predecessorStage: null,
    });
  });

  it('treats complete, partial, blocked, and incident as permanently settled slots', () => {
    for (const outcome of ['complete', 'partial', 'blocked', 'incident']) {
      const result = admitStageLaunch({
        issueNumber: 1439,
        tier: 'T2',
        stage: 'architectural-review',
        sourceRevision: 'r02',
        issueBody: '<!-- source-revision: r02 -->\nbody',
        intake: intake({ priorTier: 'T2', competitiveDecision: undefined, competitiveRationale: undefined }),
        receiptValues: [receipt('architectural-review', `attempt-${outcome}`, 1, outcome)],
      });
      expect(result.code).toBe(STAGE_SLOT_CONSUMED);
    }
  });

  it('blocks terminal stages until the exact current bundle is composable', () => {
    const withoutBundle = admitStageLaunch({
      issueNumber: 1439,
      tier: 'T3',
      stage: 'architectural-lens',
      sourceRevision: 'r02',
      issueBody: '<!-- source-revision: r02 -->\nbody',
      intake: intake(),
      receiptValues: [receipt('architectural-review', 'attempt-review-1', 1)],
    });
    expect(withoutBundle.code).toBe(TERMINAL_BUNDLE_UNAVAILABLE);

    const admitted = admitStageLaunch({
      issueNumber: 1439,
      tier: 'T3',
      stage: 'architectural-lens',
      sourceRevision: 'r02',
      issueBody: '<!-- source-revision: r02 -->\nbody',
      intake: intake(),
      receiptValues: [receipt('architectural-review', 'attempt-review-1', 1)],
      terminalBundle: bundle('architectural-review'),
    });
    expect(admitted.ok).toBe(true);
  });

  it('keeps the terminal GPT slot one-shot after a finding correction revision', () => {
    const result = admitStageLaunch({
      issueNumber: 1439,
      tier: 'T1',
      stage: 'architectural',
      sourceRevision: 'r02',
      issueBody: '<!-- source-revision: r02 -->\nterminal finding repaired',
      intake: intake({ priorTier: 'T1', competitiveDecision: undefined, competitiveRationale: undefined }),
      receiptValues: [receipt('architectural', 'terminal-once', 1)],
      terminalBundle: bundle(null),
    });
    expect(result).toMatchObject({
      ok: false,
      code: STAGE_SLOT_CONSUMED,
      consumingStageAttemptId: 'terminal-once',
    });
  });
});
