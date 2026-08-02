import { describe, expect, it } from 'vitest';
import {
  buildReviewLaneRouting,
  classifyReviewLaneDeclaration,
  normalizeReviewLaneDeclaration,
  type ReviewLaneAuthorDeclaration,
} from './review-lane-routing.ts';
import { parseConsumableStageReceipt } from './create-issue-stage-record-receipt.ts';
import { validateReviewLaneRecord } from './review-lane-record.ts';
import { createMockGhState, createMockTransport, makeTempDir } from './create-issue-stage-record-test-helpers.ts';
import { startReviewCycle } from './create-issue-stage-record-core.ts';

const declaration = (entries: ReviewLaneAuthorDeclaration['entries']): ReviewLaneAuthorDeclaration => ({
  schema: 'review-lane-change-set/v1',
  owner: 'issue-author',
  entries,
});

const issueBody = `revision r01

\`\`\`review-lane-change-set
schema: review-lane-change-set/v1
owner: issue-author
entries:
- kind: exact
  path: docs/review-lanes.md
  behaviors: [documentation-only]
\`\`\``;

function routedFixture() {
  const input = normalizeReviewLaneDeclaration(declaration([
    { kind: 'family', path: 'scripts/lib/review-lane-*.ts', behaviors: ['pure-review-lane-selection'] },
  ]));
  const classification = classifyReviewLaneDeclaration(declaration([
    { kind: 'family', path: 'scripts/lib/review-lane-*.ts', behaviors: ['pure-review-lane-selection'] },
  ]));
  if (input.status !== 'usable') throw new Error('routing fixture input must be usable');
  const routing = buildReviewLaneRouting(input, classification, 'r01', 'attempt-1');
  const settlement = {
    ok: true,
    conflictDecision: 'no-conflict' as const,
    finalRequiredSlots: ['01', '02'],
    slotCensus: [
      { slot: '01', state: 'activated' as const },
      { slot: '02', state: 'activated' as const },
      { slot: '03', state: 'not-activated' as const },
    ],
    errors: [],
  };
  return {
    routing,
    finalRequiredSlots: ['01', '02'],
    sourceVerdicts: { '01': 'accept' as const, '02': 'accept' as const },
    conflictDecision: 'no-conflict' as const,
    settlement,
  };
}

describe('review-lane production activation', () => {
  it('routes before cycle publication and returns the immutable evidence', () => {
    const state = createMockGhState({ issue: { title: 't', body: issueBody, labels: [] } });
    const result = startReviewCycle(createMockTransport(state), {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      stageAttemptId: 'attempt-1',
      workdir: makeTempDir(),
    });
    expect(result.ok).toBe(true);
    expect(result.reviewLaneRouting?.stageAttemptId).toBe('attempt-1');
    expect(state.comments[0]?.body).toContain('routed-lane');
  });

  it('does not publish a cycle when pre-attempt routing cannot be produced', () => {
    const state = createMockGhState({ issue: { title: 't', body: 'revision r01 without declaration', labels: [] } });
    const result = startReviewCycle(createMockTransport(state), {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      stageAttemptId: 'attempt-1',
      workdir: makeTempDir(),
    });
    expect(result.ok).toBe(false);
    expect(state.comments).toHaveLength(0);
  });

  it('rejects a new-policy receipt with no routed evidence', () => {
    const receipt = {
      tier: 'T2',
      stage: 'architectural',
      cycleId: 'cycle-1',
      stageAttemptId: 'attempt-1',
      policyVersion: 'review-lane-routing/v1',
      sourceRevision: 'r01',
      outcome: 'complete',
      reviewerCardinality: 1,
      completedSourceCount: 1,
      cycleBinding: { cycleId: 'cycle-1', sourceRevision: 'r01', boundBeforeLaunch: true },
      producerEvidence: 'not-applicable',
      tierTransition: 'none',
    };
    expect(parseConsumableStageReceipt(receipt).receipt).toBeNull();
  });

  it('rejects partial routed evidence and contradictory source counts', () => {
    const routed = routedFixture();
    expect(validateReviewLaneRecord({ routing: routed.routing })).toMatchObject({ ok: false });
    expect(validateReviewLaneRecord({
      ...routed,
      routing: {
        ...routed.routing,
        initiallyActivatedSlots: ['01', '03'],
      },
    })).toMatchObject({ ok: false });
    const valid = parseConsumableStageReceipt({
      tier: 'T2',
      stage: 'architectural',
      cycleId: 'cycle-1',
      stageAttemptId: 'attempt-1',
      policyVersion: 'review-lane-routing/v1',
      sourceRevision: 'r01',
      outcome: 'complete',
      reviewerCardinality: 3,
      completedSourceCount: 2,
      cycleBinding: { cycleId: 'cycle-1', sourceRevision: 'r01', boundBeforeLaunch: true },
      producerEvidence: 'not-applicable',
      tierTransition: 'none',
      reviewLane: routed,
    });
    expect(valid.receipt).not.toBeNull();
    const parsed = parseConsumableStageReceipt({
      tier: 'T2',
      stage: 'architectural',
      cycleId: 'cycle-1',
      stageAttemptId: 'attempt-1',
      policyVersion: 'review-lane-routing/v1',
      sourceRevision: 'r01',
      outcome: 'complete',
      reviewerCardinality: 3,
      completedSourceCount: 3,
      cycleBinding: { cycleId: 'cycle-1', sourceRevision: 'r01', boundBeforeLaunch: true },
      producerEvidence: 'not-applicable',
      tierTransition: 'none',
      reviewLane: routed,
    });
    expect(parsed.receipt).toBeNull();
    expect(parsed.errors.join('\n')).toMatch(/completed source count|review-lane/);
  });
});
