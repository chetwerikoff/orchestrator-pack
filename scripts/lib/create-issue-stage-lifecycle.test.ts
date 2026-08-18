import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STAGE_AUTHORITY_INVALID,
  STAGE_ORDER_VIOLATION,
  STAGE_SLOT_CONSUMED,
  TERMINAL_BUNDLE_UNAVAILABLE,
  admitStageLaunch,
  canonicalStageTopology,
  composeTerminalBundle,
  type LifecycleReviewTier,
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

function receipt(
  stage: string,
  stageAttemptId: string,
  stageSequence: number,
  outcome = 'complete',
  tier: LifecycleReviewTier = 'T3',
  sourceRevision = 'r01',
) {
  const triple = stage === 'competitive' || stage === 'architectural-review';
  const reviewerCardinality = triple ? 3 : 1;
  const completedSourceCount = outcome === 'complete' ? reviewerCardinality : Math.max(0, reviewerCardinality - 1);
  const cycleId = `cycle-${stageSequence}`;
  return {
    schema: 'stage-completeness-receipt/v1',
    tier,
    taskIdentity: 'issue:1439',
    episodeFirstRevision: 'r01',
    reviewEpisodeId: 'issue:1439@r01',
    stage,
    stageAttemptId,
    stageSequence,
    cycleId,
    policyVersion: triple ? 'triple-source/v1' : 'single-source/v1',
    reviewerCardinality,
    completedSourceCount,
    sourceRevision,
    outcome,
    producerEvidence: stage === 'architectural-lens' ? 'verified' : 'not-applicable',
    tierTransition: 'none',
    cycleBinding: { cycleId, sourceRevision, boundBeforeLaunch: true },
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
    expect(canonicalStageTopology('T1', intake({ priorTier: 'T1' })).stages.map((entry) => [entry.stage, entry.reviewerCardinality, entry.policyVersion])).toEqual([
      ['architectural', 1, 'single-source/v1'],
    ]);
    expect(canonicalStageTopology('T2', intake({ priorTier: 'T2' })).stages.map((entry) => [entry.stage, entry.reviewerCardinality, entry.policyVersion])).toEqual([
      ['architectural-review', 3, 'triple-source/v1'],
      ['architectural', 1, 'single-source/v1'],
    ]);
    expect(canonicalStageTopology('T3', intake()).stages.map((entry) => [entry.stage, entry.reviewerCardinality, entry.policyVersion])).toEqual([
      ['architectural-review', 3, 'triple-source/v1'],
      ['architectural-lens', 1, 'single-source/v1'],
      ['architectural', 1, 'single-source/v1'],
    ]);
    expect(canonicalStageTopology('T3', intake({ competitiveDecision: 'required' })).stages[0]).toMatchObject({
      stage: 'competitive', reviewerCardinality: 3, policyVersion: 'triple-source/v1',
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

  it('fails closed on malformed canonical receipt authority before stage admission', () => {
    const malformed = receipt('architectural-review', 'attempt-review-1', 1);
    delete (malformed as { cycleBinding?: unknown }).cycleBinding;
    const result = admitStageLaunch({
      issueNumber: 1439,
      tier: 'T3',
      stage: 'architectural-lens',
      sourceRevision: 'r02',
      issueBody: '<!-- source-revision: r02 -->\nbody',
      intake: intake(),
      receiptValues: [malformed],
      terminalBundle: bundle('architectural-review'),
    });
    expect(result.code).toBe(STAGE_AUTHORITY_INVALID);
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

  it('rejects receipt order that disagrees with the canonical topology', () => {
    const result = admitStageLaunch({
      issueNumber: 1439,
      tier: 'T3',
      stage: 'architectural',
      sourceRevision: 'r03',
      issueBody: '<!-- source-revision: r03 -->\nbody',
      intake: intake(),
      receiptValues: [
        receipt('architectural-lens', 'attempt-lens', 1, 'complete', 'T3', 'r02'),
        receipt('architectural-review', 'attempt-review', 2, 'complete', 'T3', 'r01'),
      ],
      terminalBundle: bundle('architectural-lens', 'r03'),
    });
    expect(result.code).toBe(STAGE_ORDER_VIOLATION);
    expect(result.message).toContain('canonical topology requires architectural-review');
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
        receiptValues: [receipt('architectural-review', `attempt-${outcome}`, 1, outcome, 'T2')],
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
      receiptValues: [receipt('architectural', 'terminal-once', 1, 'complete', 'T1')],
      terminalBundle: bundle(null),
    });
    expect(result).toMatchObject({
      ok: false,
      code: STAGE_SLOT_CONSUMED,
      consumingStageAttemptId: 'terminal-once',
    });
  });
});

describe('Issue #1439 terminal bundle binding', () => {
  const body = '<!-- source-revision: r01 -->\nbody';

  function writeBundleArtifacts(
    reviewDir: string,
    authorOverrides: Record<string, unknown> = {},
    ledgerOverrides: Record<string, unknown> = {},
  ): void {
    const author = {
      schema: 'create-issue-author-dispositions/v1',
      reviewEpisodeId: 'issue:1439@r01',
      sourceRevision: 'r01',
      predecessorStage: null,
      draft: body,
      findings: [],
      ...authorOverrides,
    };
    writeFileSync(join(reviewDir, 'author-dispositions.json'), JSON.stringify(author));
    writeFileSync(join(reviewDir, 'finding-disposition-ledger.json'), JSON.stringify({
      version: 2,
      reviewEpisodeId: 'issue:1439@r01',
      sourceRevision: 'r01',
      predecessorStage: null,
      draft: body,
      counts: { rawFindingCount: 0, distinctFindingCount: 0, processedDistinctCount: 0 },
      findings: [],
      ...ledgerOverrides,
    }));
  }

  it('composes explicit empty governed values with current producer bindings', () => {
    const reviewDir = mkdtempSync(join(tmpdir(), 'opk-terminal-bundle-'));
    try {
      writeBundleArtifacts(reviewDir);
      const result = composeTerminalBundle({
        reviewDir,
        reviewEpisodeId: 'issue:1439@r01',
        sourceRevision: 'r01',
        predecessorStage: null,
        issueBody: body,
      });
      expect(result).toMatchObject({
        reviewEpisodeId: 'issue:1439@r01',
        sourceRevision: 'r01',
        predecessorStage: null,
        rejectPartition: [],
        protectedM3: [],
        authorM4: [],
        reviewEconomics: {
          rawFindingCount: 0,
          reviewEpisodeId: 'issue:1439@r01',
          sourceRevision: 'r01',
          predecessorStage: null,
          evidenceBasis: 'receipt-backed-finding-ledger/v1',
        },
      });
    } finally {
      rmSync(reviewDir, { recursive: true, force: true });
    }
  });

  it('refuses a stale producer-owned sourceRevision instead of re-binding it', () => {
    const reviewDir = mkdtempSync(join(tmpdir(), 'opk-terminal-bundle-'));
    try {
      writeBundleArtifacts(reviewDir, { sourceRevision: 'r00' });
      expect(() => composeTerminalBundle({
        reviewDir,
        reviewEpisodeId: 'issue:1439@r01',
        sourceRevision: 'r01',
        predecessorStage: null,
        issueBody: body,
      })).toThrow('author dispositions sourceRevision binding is stale');
    } finally {
      rmSync(reviewDir, { recursive: true, force: true });
    }
  });

  it('refuses a stale finding-ledger binding instead of promoting its economics to current', () => {
    const reviewDir = mkdtempSync(join(tmpdir(), 'opk-terminal-bundle-'));
    try {
      writeBundleArtifacts(reviewDir, {}, { sourceRevision: 'r00' });
      expect(() => composeTerminalBundle({
        reviewDir,
        reviewEpisodeId: 'issue:1439@r01',
        sourceRevision: 'r01',
        predecessorStage: null,
        issueBody: body,
      })).toThrow('finding disposition ledger sourceRevision binding is stale');
    } finally {
      rmSync(reviewDir, { recursive: true, force: true });
    }
  });

  it('refuses an absent author-disposition producer artifact', () => {
    const reviewDir = mkdtempSync(join(tmpdir(), 'opk-terminal-bundle-'));
    try {
      writeFileSync(join(reviewDir, 'finding-disposition-ledger.json'), JSON.stringify({
        version: 2,
        reviewEpisodeId: 'issue:1439@r01',
        sourceRevision: 'r01',
        predecessorStage: null,
        draft: body,
        counts: { rawFindingCount: 0, distinctFindingCount: 0, processedDistinctCount: 0 },
        findings: [],
      }));
      expect(() => composeTerminalBundle({
        reviewDir,
        reviewEpisodeId: 'issue:1439@r01',
        sourceRevision: 'r01',
        predecessorStage: null,
        issueBody: body,
      })).toThrow('missing author dispositions');
    } finally {
      rmSync(reviewDir, { recursive: true, force: true });
    }
  });
});
