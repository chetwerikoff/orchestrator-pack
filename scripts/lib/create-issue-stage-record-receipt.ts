import type {
  ConsumableStageReceipt,
  ProducerEvidence,
  SettledOutcome,
  StageReceiptCycleBinding,
} from './create-issue-stage-record-types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const VALID_OUTCOMES = new Set<SettledOutcome>(['complete', 'partial', 'blocked', 'incident']);

export function parseCycleBinding(value: unknown): StageReceiptCycleBinding | null {
  if (!isRecord(value)) return null;
  if (!nonEmpty(value.cycleId)) return null;
  if (!nonEmpty(value.sourceRevision)) return null;
  if (value.boundBeforeLaunch !== true) return null;
  return {
    cycleId: value.cycleId.trim(),
    sourceRevision: value.sourceRevision.trim(),
    boundBeforeLaunch: true,
  };
}

export function parseConsumableStageReceipt(value: unknown): {
  receipt: ConsumableStageReceipt | null;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { receipt: null, errors: ['stage receipt must be an object'] };
  }
  const tier = nonEmpty(value.tier) ? value.tier.trim() : '';
  const stage = nonEmpty(value.stage) ? value.stage.trim() : '';
  const cycleId = nonEmpty(value.cycleId) ? value.cycleId.trim() : '';
  const stageAttemptId = nonEmpty(value.stageAttemptId) ? value.stageAttemptId.trim() : '';
  const policyVersion = nonEmpty(value.policyVersion) ? value.policyVersion.trim() : '';
  const sourceRevision = nonEmpty(value.sourceRevision) ? value.sourceRevision.trim() : '';
  const outcome = value.outcome;
  const reviewerCardinality = Number(value.reviewerCardinality);
  const completedSourceCount = Number(
    value.completedSourceCount
      ?? value.sourceCount
      ?? (Array.isArray(value.credentialingCaptures) ? value.credentialingCaptures.length : undefined),
  );
  const cycleBinding = parseCycleBinding(value.cycleBinding);
  const producerEvidence = value.producerEvidence
    ?? (stage === 'architectural-lens'
      ? (isRecord(value.claude) && value.claude.kind === 'capture' ? 'verified' : 'waived')
      : 'not-applicable');
  const tierTransition = nonEmpty(value.tierTransition) ? value.tierTransition.trim() : 'none';

  if (!tier) errors.push('missing tier');
  if (!stage) errors.push('missing stage');
  if (!cycleId) errors.push('missing cycleId');
  if (!stageAttemptId) errors.push('missing stageAttemptId');
  if (!policyVersion) errors.push('missing policyVersion');
  if (!sourceRevision) errors.push('missing sourceRevision');
  if (!VALID_OUTCOMES.has(outcome as SettledOutcome)) errors.push('invalid settled outcome');
  if (!Number.isInteger(reviewerCardinality) || reviewerCardinality < 1) errors.push('invalid reviewerCardinality');
  if (!Number.isInteger(completedSourceCount) || completedSourceCount < 0) errors.push('invalid completed source count');
  if (!cycleBinding) errors.push('missing or invalid cycleBinding witness');
  else if (cycleBinding.cycleId !== cycleId) errors.push('cycleBinding cycleId mismatch');
  else if (cycleBinding.sourceRevision !== sourceRevision) errors.push('cycleBinding sourceRevision mismatch');
  if (producerEvidence !== 'verified' && producerEvidence !== 'waived' && producerEvidence !== 'not-applicable') {
    errors.push('invalid producerEvidence');
  }

  if (errors.length > 0) return { receipt: null, errors };

  return {
    receipt: {
      tier,
      stage,
      cycleId,
      stageAttemptId,
      policyVersion,
      sourceRevision,
      outcome: outcome as SettledOutcome,
      reviewerCardinality,
      completedSourceCount,
      cycleBinding,
      producerEvidence: producerEvidence as ProducerEvidence,
      tierTransition,
    },
    errors: [],
  };
}

export function validateReceiptMatchesCycle(
  receipt: ConsumableStageReceipt,
  cycleId: string,
  sourceRevision: string,
): string[] {
  const errors: string[] = [];
  if (receipt.cycleId !== cycleId) errors.push('stage receipt cycleId does not match canonical cycle head');
  if (receipt.sourceRevision !== sourceRevision) errors.push('stage receipt sourceRevision does not match canonical cycle revision');
  if (!receipt.cycleBinding.boundBeforeLaunch) errors.push('stage receipt lacks pre-launch cycle binding witness');
  if (receipt.cycleBinding.cycleId !== cycleId) errors.push('stage receipt cycleBinding is cross-cycle or rebound');
  if (receipt.cycleBinding.sourceRevision !== sourceRevision) errors.push('stage receipt cycleBinding revision mismatch');
  return errors;
}

export function readEvidenceWaiverProducerEvidence(
  waiverPath: string | undefined,
  readJson: (path: string) => unknown,
): ProducerEvidence {
  if (!waiverPath) return 'not-applicable';
  try {
    const value = readJson(waiverPath);
    if (!isRecord(value) || !nonEmpty(value.schema) || !String(value.schema).includes('waiver')) {
      return 'not-applicable';
    }
    return 'waived';
  } catch {
    return 'not-applicable';
  }
}
