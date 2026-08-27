import type {
  CanonicalLineage,
  ConsumableStageReceipt,
  PartialMissingSourceWitness,
  ProducerEvidence,
  ReviewLaneEvidence,
  SettledOutcome,
  StageEventLogical,
  StageReceiptCycleBinding,
} from './create-issue-stage-record-types.ts';
import { reviewLaneWaivedMissingSlots, validateReviewLaneRecord } from './review-lane-record.ts';
import { STAGE_SCHEMA } from './create-issue-stage-record-types.ts';
import { deriveCanonicalCycleLineage } from './create-issue-stage-record-lineage.ts';
import { REVIEW_LANE_ROUTING_POLICY_VERSION } from './review-lane-routing.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const VALID_OUTCOMES = new Set<SettledOutcome>(['complete', 'partial', 'blocked', 'incident']);
const LEGACY_POLICY_VERSIONS = new Set(['single-source/v1', 'triple-source/v1']);

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

function parsePartialMissingSources(value: unknown, errors: string[]): PartialMissingSourceWitness[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push('partialMissingSources must be an array');
    return [];
  }
  const result: PartialMissingSourceWitness[] = [];
  const slots = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`partialMissingSources[${index}] must be an object`);
      continue;
    }
    const reviewerSlot = nonEmpty(item.reviewerSlot) ? item.reviewerSlot.trim() : '';
    const invocationId = nonEmpty(item.invocationId) ? item.invocationId.trim() : '';
    const evidenceIdentity = nonEmpty(item.evidenceIdentity) ? item.evidenceIdentity.trim() : '';
    const reason = nonEmpty(item.reason) ? item.reason.trim() : '';
    if (!/^\d{2}$/.test(reviewerSlot)) errors.push(`partialMissingSources[${index}].reviewerSlot must be NN`);
    if (!invocationId) errors.push(`partialMissingSources[${index}].invocationId is required`);
    if (!evidenceIdentity) errors.push(`partialMissingSources[${index}].evidenceIdentity is required`);
    if (!reason) errors.push(`partialMissingSources[${index}].reason is required`);
    if (slots.has(reviewerSlot)) errors.push(`partialMissingSources repeats reviewerSlot ${reviewerSlot}`);
    slots.add(reviewerSlot);
    if (/^\d{2}$/.test(reviewerSlot) && invocationId && evidenceIdentity && reason) {
      result.push({ reviewerSlot, invocationId, evidenceIdentity, reason });
    }
  }
  return result;
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
  const reviewLane = value.reviewLane === undefined ? undefined : value.reviewLane;
  const partialMissingSources = parsePartialMissingSources(value.partialMissingSources, errors);

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
  if (outcome !== 'partial' && partialMissingSources.length > 0) {
    errors.push('partialMissingSources is valid only for partial settlement');
  }
  if (outcome === 'partial' && partialMissingSources.length === 0) {
    errors.push('partial settlement requires at least one journaled missing-source witness');
  }
  if (outcome === 'partial' && partialMissingSources.length >= 2 && producerEvidence !== 'waived') {
    errors.push('partial settlement with two or more missing-source witnesses requires explicit operator waiver');
  }
  const routedPolicy = policyVersion === REVIEW_LANE_ROUTING_POLICY_VERSION;
  if (!routedPolicy && reviewLane !== undefined) {
    errors.push('legacy stage policy cannot carry reviewLane evidence');
  }
  if (!routedPolicy && !LEGACY_POLICY_VERSIONS.has(policyVersion)) {
    errors.push(`unsupported stage policy version: ${policyVersion}`);
  }
  if (routedPolicy && reviewLane === undefined) {
    errors.push('review-lane evidence is required for review-lane-routing/v1');
  }
  const waivedMissingSlots = reviewLaneWaivedMissingSlots(stage, policyVersion, producerEvidence, partialMissingSources);
  if (reviewLane !== undefined) {
    const routed = validateReviewLaneRecord(reviewLane, waivedMissingSlots);
    errors.push(...routed.errors);
    const routedRecord = isRecord(reviewLane) ? reviewLane : null;
    if (routedPolicy && routed.ok && routedRecord && isRecord(routedRecord.routing) && isRecord(routedRecord.sourceVerdicts)) {
      if (routedRecord.routing.stageAttemptId !== stageAttemptId) {
        errors.push('stageAttemptId disagrees with routed evidence');
      }
      if (routedRecord.routing.sourceRevision !== sourceRevision) {
        errors.push('sourceRevision disagrees with routed evidence');
      }
      if (reviewerCardinality !== routedRecord.routing.reviewerCardinality) {
        errors.push('reviewerCardinality disagrees with routed topology');
      }
      if (completedSourceCount !== Object.keys(routedRecord.sourceVerdicts).length) {
        errors.push('completed source count disagrees with routed sourceVerdicts');
      }
      if (outcome === 'complete' && isRecord(routedRecord.settlement) && routedRecord.settlement.ok !== true) {
        errors.push('complete receipt cannot contain an unsettled routed record');
      }
    }
  }

  if (errors.length > 0 || cycleBinding === null) return { receipt: null, errors };

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
      partialMissingSources,
      reviewLane: reviewLane as ReviewLaneEvidence | undefined,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function receiptLabel(path: string | undefined, index: number, receipt: ConsumableStageReceipt): string {
  return `${path ?? `stage receipt ${index + 1}`} (stage=${receipt.stage}, attempt=${receipt.stageAttemptId}, cycle=${receipt.cycleId}, revision=${receipt.sourceRevision})`;
}

function samePartialMissingSources(
  left: readonly PartialMissingSourceWitness[],
  right: readonly PartialMissingSourceWitness[] | undefined,
): boolean {
  if (!right || left.length !== right.length) return left.length === 0 && (right?.length ?? 0) === 0;
  return left.every((witness, index) => {
    const other = right[index];
    return other?.reviewerSlot === witness.reviewerSlot
      && other.invocationId === witness.invocationId
      && other.evidenceIdentity === witness.evidenceIdentity
      && other.reason === witness.reason;
  });
}

function stageEventMismatches(
  receipt: ConsumableStageReceipt,
  event: StageEventLogical,
): string[] {
  const mismatches: string[] = [];
  if (event['cycle-id'] !== receipt.cycleId) mismatches.push('cycle');
  if (event.stage !== receipt.stage) mismatches.push('stage');
  if (event.tier !== receipt.tier) mismatches.push('tier');
  if (event['source-revision'] !== receipt.sourceRevision) mismatches.push('sourceRevision');
  if (event['stage-attempt-id'] !== receipt.stageAttemptId) mismatches.push('stageAttemptId');
  if (event['policy-version'] !== receipt.policyVersion) mismatches.push('policyVersion');
  if (event['settled-outcome'] !== receipt.outcome) mismatches.push('settledOutcome');
  if (event['source-count'] !== receipt.completedSourceCount) mismatches.push('sourceCount');
  if (event['required-source-count'] !== receipt.reviewerCardinality) mismatches.push('requiredSourceCount');
  if (event['producer-evidence'] !== receipt.producerEvidence) mismatches.push('producerEvidence');
  if (event['tier-transition'] !== receipt.tierTransition) mismatches.push('tierTransition');
  if (!samePartialMissingSources(receipt.partialMissingSources, event['partial-missing-sources'])) mismatches.push('partialMissingSources');
  return mismatches;
}

export interface HistoricalReceiptValidationInput {
  receiptValues: readonly unknown[];
  receiptPaths?: readonly string[];
  cycleId: string;
  issueRevision: string;
  lineage: CanonicalLineage;
}

/**
 * Final acceptance consumes receipts already admitted by publish-stage. Their
 * source revision may be historical, but only along the canonical cycle chain.
 * The strict current-cycle validator above remains the publish-stage contract.
 */
export function validateHistoricalReceiptsAgainstLineage(
  input: HistoricalReceiptValidationInput,
): string[] {
  const errors: string[] = [];
  const { entries, errors: lineageErrors } = deriveCanonicalCycleLineage(input.lineage, input.cycleId);
  const chainById = new Map(entries.map((entry) => [entry.cycleId, entry]));
  for (const error of lineageErrors) errors.push(`canonical lineage: ${error}`);
  for (const diagnostic of input.lineage.diagnostics) {
    errors.push(`canonical lineage ${diagnostic.code}: ${diagnostic.message}`);
  }

  const records = input.receiptValues.flatMap((value, index) => {
    const parsed = parseConsumableStageReceipt(value);
    if (!parsed.receipt) {
      errors.push(...parsed.errors.map((error) => `${input.receiptPaths?.[index] ?? `stage receipt ${index + 1}`}: ${error}`));
      return [];
    }
    const raw = asRecord(value);
    if (!raw) return [];
    return [{ index, raw, receipt: parsed.receipt }];
  }).sort((left, right) => {
    const leftSequence = typeof left.raw.stageSequence === 'number' ? left.raw.stageSequence : Number.POSITIVE_INFINITY;
    const rightSequence = typeof right.raw.stageSequence === 'number' ? right.raw.stageSequence : Number.POSITIVE_INFINITY;
    return leftSequence - rightSequence;
  });

  const expectedEventKeys = new Set<string>();
  let previousPosition = -1;
  let terminalCount = 0;

  for (const record of records) {
    const { receipt, raw, index } = record;
    const label = receiptLabel(input.receiptPaths?.[index], index, receipt);
    const stageSequence = typeof raw.stageSequence === 'number' && Number.isInteger(raw.stageSequence)
      ? raw.stageSequence
      : null;
    if (stageSequence === null || stageSequence < 1) {
      errors.push(`${label}: stageSequence is required for historical lineage ordering`);
    }

    const cycle = chainById.get(receipt.cycleId);
    if (!cycle) {
      errors.push(`${label}: cycle is not on the canonical predecessor lineage`);
      continue;
    }
    if (receipt.sourceRevision !== cycle.sourceRevision) {
      errors.push(`${label}: receipt sourceRevision ${receipt.sourceRevision} does not match canonical cycle revision ${cycle.sourceRevision}`);
    }
    if (receipt.cycleBinding.cycleId !== receipt.cycleId || receipt.cycleBinding.sourceRevision !== receipt.sourceRevision) {
      errors.push(`${label}: cycleBinding does not preserve the admitted cycle and source revision`);
    }
    if (cycle.position < previousPosition) {
      errors.push(`${label}: stage order moves backward from canonical cycle position ${previousPosition} to ${cycle.position}`);
    }
    previousPosition = Math.max(previousPosition, cycle.position);

    const eventKey = `${receipt.cycleId}:${receipt.stage}:${receipt.stageAttemptId}`;
    expectedEventKeys.add(eventKey);
    const event = input.lineage.eventsByKey.get(eventKey);
    const duplicatePublication = input.lineage.diagnostics.some((diagnostic) => (
      diagnostic.code === 'duplicate-remote-event' && diagnostic.eventKey === eventKey
    ));
    if (!event || event.schema !== STAGE_SCHEMA) {
      // A predecessor receipt may have been admitted before the cycle advanced;
      // publish-stage must not re-admit it under the strict current-cycle contract.
      if (event || cycle.cycleId === input.cycleId) {
        errors.push(`${label}: no canonical published stage event ${eventKey}`);
      }
    } else {
      const logical = event.logical as StageEventLogical;
      const mismatches = stageEventMismatches(receipt, logical);
      if (mismatches.length > 0) {
        errors.push(`${label}: published stage event ${eventKey} mismatches ${mismatches.join(', ')}`);
      }
    }
    if (duplicatePublication) {
      errors.push(`${label}: published stage event ${eventKey} is duplicated in the canonical census`);
    }

    if (receipt.stage === 'architectural' && receipt.outcome === 'complete') {
      terminalCount += 1;
    }
  }

  for (const event of input.lineage.eventsByKey.values()) {
    if (event.schema !== STAGE_SCHEMA) continue;
    const logical = event.logical as StageEventLogical;
    if (chainById.has(logical['cycle-id']) && !expectedEventKeys.has(event.eventKey)) {
      errors.push(`canonical published stage event ${event.eventKey} is unrepresented by a stage receipt`);
    }
  }

  if (terminalCount !== 1) {
    errors.push(`final architectural terminal receipt count is ${terminalCount}; exactly one is required`);
  }
  // C6: the terminal GPT is one-shot. A bounded author correction may move the
  // live Issue to a successor canonical cycle/revision, but it must not re-arm
  // architectural. The original terminal receipt remains valid because its
  // own cycle/source binding is proven above and the caller separately verifies
  // the repaired live body + disposition/finding state.

  return [...new Set(errors)];
}

export interface EvidenceWaiverExpectation {
  readonly stage: string;
  readonly sourceRevision: string;
  readonly missingSlots: readonly string[];
}

export function readEvidenceWaiverProducerEvidence(
  waiverPath: string | undefined,
  readJson: (path: string) => unknown,
  expected?: EvidenceWaiverExpectation,
): ProducerEvidence {
  if (!waiverPath) return 'not-applicable';
  try {
    const value = readJson(waiverPath);
    if (!isRecord(value) || value.schema !== 'operator-stage-waiver/v1') {
      return 'not-applicable';
    }
    const stage = typeof value.stage === 'string' ? value.stage.trim() : '';
    const sourceRevision = typeof value.sourceRevision === 'string' ? value.sourceRevision.trim() : '';
    const missingSlots = Array.isArray(value.missingSlots)
      ? value.missingSlots.filter((slot): slot is string => typeof slot === 'string').map((slot) => slot.trim()).sort()
      : [];
    const expectedMissingSlots = expected?.missingSlots.map((slot) => slot.trim()).sort();
    if (
      stage !== 'architectural-review'
      || sourceRevision.length === 0
      || missingSlots.length !== 2
      || missingSlots[0] !== '02'
      || missingSlots[1] !== '03'
      || (expected !== undefined && (
        stage !== expected.stage
        || sourceRevision !== expected.sourceRevision
        || missingSlots.length !== expectedMissingSlots?.length
        || missingSlots.some((slot, index) => slot !== expectedMissingSlots?.[index])
      ))
    ) return 'not-applicable';
    return 'waived';
  } catch {
    return 'not-applicable';
  }
}
