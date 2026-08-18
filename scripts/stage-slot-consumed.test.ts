import { describe, expect, it } from 'vitest';
import { admitStageLaunch, STAGE_SLOT_CONSUMED } from './lib/create-issue-stage-lifecycle.ts';

const intake = {
  schema: 'tier-intake/v1',
  producer: 'flow-manager',
  taskIdentity: 'issue:1439',
  kind: 'fresh',
  priorTier: 'T3',
  firstRevision: 'r01',
  competitiveDecision: 'skipped',
  competitiveRationale: 'the option space is already bounded by grounded analysis',
} as const;

describe('stage-slot-consumed', () => {
  it('refuses a second settled launch before a new attempt can be minted', () => {
    const result = admitStageLaunch({
      issueNumber: 1439,
      tier: 'T3',
      stage: 'architectural-review',
      sourceRevision: 'r03',
      issueBody: '<!-- source-revision: r03 -->\nrepaired body',
      intake,
      receiptValues: [{
        schema: 'stage-completeness-receipt/v1',
        tier: 'T3',
        taskIdentity: 'issue:1439',
        episodeFirstRevision: 'r01',
        reviewEpisodeId: 'issue:1439@r01',
        stage: 'architectural-review',
        stageAttemptId: '9886473e-3531-419d-97d9-f0b9257b6217',
        stageSequence: 1,
        sourceRevision: 'r01',
        outcome: 'partial',
      }],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(STAGE_SLOT_CONSUMED);
    expect(result.consumingStageAttemptId).toBe('9886473e-3531-419d-97d9-f0b9257b6217');
  });
});
