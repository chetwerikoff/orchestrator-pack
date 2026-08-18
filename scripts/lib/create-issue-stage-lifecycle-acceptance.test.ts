import { describe, expect, it } from 'vitest';
import { validateLifecycleAcceptanceTopology } from './create-issue-stage-lifecycle-acceptance.ts';
import { validateTerminalOneShotBodyBinding } from './create-issue-final-acceptance-contract.ts';

const intake = {
  schema: 'tier-intake/v1',
  producer: 'flow-manager',
  taskIdentity: 'issue:1439',
  kind: 'fresh',
  priorTier: 'T2',
  firstRevision: 'r01',
} as const;

function partialReview(missing: string[] = ['03']) {
  const slots = ['01', '02', '03'];
  return {
    schema: 'stage-completeness-receipt/v1',
    tier: 'T2',
    stage: 'architectural-review',
    stageAttemptId: 'review-1',
    stageSequence: 1,
    outcome: 'partial',
    reviewerCardinality: 3,
    invocations: slots.map((slot) => missing.includes(slot)
      ? {
          invocationId: `invocation-${slot}`,
          reviewerSlot: slot,
          attemptOrdinal: 1,
          terminal: true,
          terminalClassification: 'incident',
          retryClass: 'retry-forbidden',
          sendCount: 1,
        }
      : {
          invocationId: `invocation-${slot}`,
          reviewerSlot: slot,
          attemptOrdinal: 1,
          terminal: true,
          terminalClassification: 'complete',
          retryClass: 'none',
          sendCount: 1,
          capture: { captureIdentity: `capture-${slot}` },
        }),
    reviewLane: {
      finalRequiredSlots: slots,
      sourceVerdicts: Object.fromEntries(slots.map((slot) => [slot, missing.includes(slot) ? 'unparseable' : 'accept'])),
      sourceVerdictEvidence: Object.fromEntries(slots.map((slot) => [slot, { producerEvidenceIdentity: `evidence-${slot}` }])),
    },
  };
}

const terminal = {
  schema: 'stage-completeness-receipt/v1',
  tier: 'T2',
  stage: 'architectural',
  stageAttemptId: 'terminal-once',
  stageSequence: 2,
  sourceRevision: 'r01',
  outcome: 'complete',
  reviewerCardinality: 1,
};

describe('lifecycle acceptance policy', () => {
  it('accepts a three-source stage settled partial with exactly one evidence-backed unobservable slot', () => {
    const result = validateLifecycleAcceptanceTopology([partialReview(), terminal], intake, 'T2');
    expect(result).toEqual(expect.objectContaining({ ok: true, errors: [] }));
  });

  it('fails closed when two slots are missing and names the existing operator waiver seam', () => {
    const result = validateLifecycleAcceptanceTopology([partialReview(['02', '03']), terminal], intake, 'T2');
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('explicit operator waiver through the existing waiver seam is required');
  });

  it('allows one post-terminal correction without rearming terminal GPT', () => {
    const errors: string[] = [];
    validateTerminalOneShotBodyBinding(
      '<!-- source-revision: r01 -->\nterminal-reviewed body',
      '<!-- source-revision: r02 -->\ncorrected body',
      'r02',
      [terminal],
      errors,
    );
    expect(errors).toEqual([]);
  });

  it('rejects a second terminal receipt on the corrected revision', () => {
    const errors: string[] = [];
    validateTerminalOneShotBodyBinding(
      '<!-- source-revision: r01 -->\nterminal-reviewed body',
      '<!-- source-revision: r02 -->\ncorrected body',
      'r02',
      [terminal, { ...terminal, stageAttemptId: 'terminal-rearmed', stageSequence: 3, sourceRevision: 'r02' }],
      errors,
    );
    expect(errors.join('\n')).toContain('exactly one original terminal receipt');
  });
});
