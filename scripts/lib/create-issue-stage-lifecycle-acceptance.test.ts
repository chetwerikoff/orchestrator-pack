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

function coreReceipt(input: {
  stage: 'architectural-review' | 'architectural';
  stageAttemptId: string;
  stageSequence: number;
  policyVersion: 'triple-source/v1' | 'single-source/v1';
  reviewerCardinality: number;
  completedSourceCount: number;
  outcome: 'complete' | 'partial';
}) {
  const cycleId = `cycle-${input.stageSequence}`;
  return {
    schema: 'stage-completeness-receipt/v1',
    tier: 'T2',
    taskIdentity: 'issue:1439',
    episodeFirstRevision: 'r01',
    reviewEpisodeId: 'issue:1439@r01',
    stage: input.stage,
    stageAttemptId: input.stageAttemptId,
    stageSequence: input.stageSequence,
    cycleId,
    policyVersion: input.policyVersion,
    reviewerCardinality: input.reviewerCardinality,
    completedSourceCount: input.completedSourceCount,
    sourceRevision: 'r01',
    outcome: input.outcome,
    producerEvidence: 'not-applicable',
    tierTransition: 'none',
    cycleBinding: { cycleId, sourceRevision: 'r01', boundBeforeLaunch: true },
  };
}

function partialReview(
  missing: string[] = ['03'],
  options: { includeJournal?: boolean; waived?: boolean } = {},
) {
  const slots = ['01', '02', '03'];
  const includeJournal = options.includeJournal ?? true;
  return {
    ...coreReceipt({
      stage: 'architectural-review',
      stageAttemptId: 'review-1',
      stageSequence: 1,
      policyVersion: 'triple-source/v1',
      reviewerCardinality: 3,
      completedSourceCount: 3 - missing.length,
      outcome: 'partial',
    }),
    producerEvidence: options.waived ? 'waived' : 'not-applicable',
    partialMissingSources: includeJournal
      ? missing.map((slot) => ({
          reviewerSlot: slot,
          invocationId: `invocation-${slot}`,
          evidenceIdentity: `terminal-result-${slot}`,
          reason: 'possible-or-actual send completed without observable reviewer artifact; blind resend forbidden',
        }))
      : [],
    invocations: slots.map((slot) => missing.includes(slot)
      ? {
          invocationId: `invocation-${slot}`,
          terminalResultIdentity: `terminal-result-${slot}`,
          reviewerSlot: slot,
          attemptOrdinal: 1,
          terminal: true,
          terminalClassification: 'incident',
          retryClass: 'retry-forbidden',
          sendCount: 1,
        }
      : {
          invocationId: `invocation-${slot}`,
          terminalResultIdentity: `terminal-result-${slot}`,
          reviewerSlot: slot,
          attemptOrdinal: 1,
          terminal: true,
          terminalClassification: 'complete',
          retryClass: 'none',
          sendCount: 1,
          capture: { captureIdentity: `capture-${slot}` },
        }),
  };
}

const terminal = coreReceipt({
  stage: 'architectural',
  stageAttemptId: 'terminal-once',
  stageSequence: 2,
  policyVersion: 'single-source/v1',
  reviewerCardinality: 1,
  completedSourceCount: 1,
  outcome: 'complete',
});

describe('lifecycle acceptance policy', () => {
  it('accepts a three-source stage settled partial with exactly one journaled possible-or-actual send failure', () => {
    const result = validateLifecycleAcceptanceTopology([partialReview(), terminal], intake, 'T2');
    expect(result).toEqual(expect.objectContaining({ ok: true, errors: [] }));
  });

  it('fails closed when the exact missing-source journal witness is absent', () => {
    const result = validateLifecycleAcceptanceTopology([
      partialReview(['03'], { includeJournal: false }),
      terminal,
    ], intake, 'T2');
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('partial journal witnesses must equal missing slots exactly');
  });

  it('fails closed when two slots are missing without the existing operator waiver seam', () => {
    const result = validateLifecycleAcceptanceTopology([partialReview(['02', '03']), terminal], intake, 'T2');
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('explicit operator waiver through the existing waiver seam is required');
  });

  it('accepts two missing slots only when the existing operator waiver seam is consumed', () => {
    const result = validateLifecycleAcceptanceTopology([
      partialReview(['02', '03'], { waived: true }),
      terminal,
    ], intake, 'T2');
    expect(result).toEqual(expect.objectContaining({ ok: true, errors: [] }));
  });

  it('rejects a missing slot that does not prove possible-or-actual send', () => {
    const review = partialReview();
    (review.invocations[2] as { sendCount: number }).sendCount = 0;
    const result = validateLifecycleAcceptanceTopology([review, terminal], intake, 'T2');
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('possible-or-actual send with resend forbidden');
  });

  it('rejects a journal witness bound to the wrong terminal-result identity', () => {
    const review = partialReview();
    review.partialMissingSources[0]!.evidenceIdentity = 'terminal-result-other';
    const result = validateLifecycleAcceptanceTopology([review, terminal], intake, 'T2');
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('journal witness does not bind terminal evidence');
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
