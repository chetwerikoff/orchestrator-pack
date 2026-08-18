import {
  canonicalStageTopology,
  parseLifecycleTierIntake,
  type LifecycleReviewStage,
  type LifecycleTierIntakeV1,
} from './create-issue-stage-lifecycle.ts';

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finalInvocationBySlot(receipt: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(receipt.invocations)) return result;
  const ordered = receipt.invocations
    .filter(record)
    .sort((left, right) => Number(left.attemptOrdinal ?? 0) - Number(right.attemptOrdinal ?? 0));
  for (const invocation of ordered) {
    const slot = stringValue(invocation.reviewerSlot);
    if (slot) result.set(slot, invocation);
  }
  return result;
}

function requiredSlots(receipt: Record<string, unknown>, cardinality: number): string[] {
  const lane = record(receipt.reviewLane) ? receipt.reviewLane : null;
  if (lane && Array.isArray(lane.finalRequiredSlots)) {
    const slots = lane.finalRequiredSlots.filter((slot): slot is string => typeof slot === 'string' && /^\d{2}$/.test(slot));
    if (slots.length > 0) return slots;
  }
  return Array.from({ length: cardinality }, (_, index) => String(index + 1).padStart(2, '0'));
}

function invocationCredentialed(invocation: Record<string, unknown> | undefined): boolean {
  if (!invocation || !record(invocation.capture)) return false;
  return invocation.terminalClassification === 'complete' || record(invocation.artifactAuthority);
}

function reviewLaneProvesUnobservable(
  receipt: Record<string, unknown>,
  slot: string,
  invocation: Record<string, unknown>,
): boolean {
  const lane = record(receipt.reviewLane) ? receipt.reviewLane : null;
  const sourceVerdicts = lane && record(lane.sourceVerdicts) ? lane.sourceVerdicts : null;
  const evidence = lane && record(lane.sourceVerdictEvidence) ? lane.sourceVerdictEvidence : null;
  const verdict = sourceVerdicts?.[slot];
  const slotEvidence = evidence && record(evidence[slot]) ? evidence[slot] as Record<string, unknown> : null;
  const invocationId = stringValue(invocation.invocationId);
  const producerEvidenceIdentity = stringValue(slotEvidence?.producerEvidenceIdentity);
  return Boolean(
    invocationId
    && producerEvidenceIdentity
    && invocation.terminal === true
    && invocation.retryClass === 'retry-forbidden'
    && (verdict === 'blocked' || verdict === 'refused' || verdict === 'unparseable'),
  );
}

export interface LifecycleAcceptanceResult {
  ok: boolean;
  errors: string[];
  expectedStages: LifecycleReviewStage[];
}

export function validateLifecycleAcceptanceTopology(
  receiptValues: readonly unknown[],
  intakeValue: unknown,
  tierValue?: string,
): LifecycleAcceptanceResult {
  const errors: string[] = [];
  const intake = parseLifecycleTierIntake(intakeValue);
  const records = receiptValues.filter(record);
  if (!intake) return { ok: false, errors: ['canonical tier-intake/v1 is missing or malformed'], expectedStages: [] };
  if (records.length !== receiptValues.length) errors.push('stage receipt inventory contains a malformed receipt');
  const observedTier = tierValue ?? stringValue(records[0]?.tier) ?? intake.priorTier;
  if (observedTier !== 'T1' && observedTier !== 'T2' && observedTier !== 'T3') {
    return { ok: false, errors: [...errors, 'review episode tier is unresolved'], expectedStages: [] };
  }
  if (intake.priorTier !== observedTier) errors.push(`tier-intake priorTier ${intake.priorTier} does not match receipt tier ${observedTier}`);

  let topology;
  try {
    topology = canonicalStageTopology(observedTier, intake as LifecycleTierIntakeV1);
  } catch (error) {
    return {
      ok: false,
      errors: [...errors, error instanceof Error ? error.message : String(error)],
      expectedStages: [],
    };
  }
  const expectedStages = topology.stages.map((entry) => entry.stage);
  const byStage = new Map<LifecycleReviewStage, Record<string, unknown>[]>();
  for (const receipt of records) {
    const stage = stringValue(receipt.stage) as LifecycleReviewStage | null;
    if (!stage || !expectedStages.includes(stage)) {
      errors.push(`stage ${stage ?? '<missing>'} is outside canonical ${observedTier} topology`);
      continue;
    }
    const list = byStage.get(stage) ?? [];
    list.push(receipt);
    byStage.set(stage, list);
  }

  const progressed = new Set<LifecycleReviewStage>();
  let priorSequence = 0;
  for (const entry of topology.stages) {
    const candidates = byStage.get(entry.stage) ?? [];
    if (candidates.length !== 1) {
      errors.push(`${entry.stage} requires exactly one settled Issue-lifetime stageAttemptId; observed ${candidates.length}`);
      continue;
    }
    const receipt = candidates[0]!;
    const sequence = Number(receipt.stageSequence);
    if (!Number.isInteger(sequence) || sequence <= priorSequence) errors.push(`${entry.stage} stageSequence is out of canonical order`);
    priorSequence = Number.isInteger(sequence) ? sequence : priorSequence;
    for (const predecessor of expectedStages.slice(0, expectedStages.indexOf(entry.stage))) {
      if (!progressed.has(predecessor)) errors.push(`${entry.stage} settled before predecessor ${predecessor} successfully settled`);
    }

    if (receipt.outcome === 'complete') {
      progressed.add(entry.stage);
      continue;
    }
    if (receipt.outcome !== 'partial') {
      errors.push(`${entry.stage} outcome ${String(receipt.outcome)} consumes the stage slot but cannot credential progression/final acceptance`);
      continue;
    }
    if (entry.reviewerCardinality !== 3) {
      errors.push(`${entry.stage} partial settlement is valid only for a canonical three-source stage`);
      continue;
    }
    const slots = requiredSlots(receipt, entry.reviewerCardinality);
    const finals = finalInvocationBySlot(receipt);
    const missing = slots.filter((slot) => !invocationCredentialed(finals.get(slot)));
    if (missing.length === 0) {
      errors.push(`${entry.stage} partial settlement has no missing source`);
      continue;
    }
    if (missing.length >= 2) {
      errors.push(`${entry.stage} partial settlement is missing ${missing.length} slots; explicit operator waiver through the existing waiver seam is required`);
      continue;
    }
    const missingSlot = missing[0]!;
    const invocation = finals.get(missingSlot);
    if (!invocation) {
      errors.push(`${entry.stage} partial missing slot ${missingSlot} lacks its invocation identity/evidence`);
      continue;
    }
    if (!reviewLaneProvesUnobservable(receipt, missingSlot, invocation)) {
      errors.push(`${entry.stage} partial missing slot ${missingSlot} is not journal/evidence-backed as unobservable with resend forbidden`);
      continue;
    }
    const completed = slots.filter((slot) => invocationCredentialed(finals.get(slot))).length;
    if (completed !== 2) {
      errors.push(`${entry.stage} partial settlement must retain exactly two credentialed sources; observed ${completed}`);
      continue;
    }
    progressed.add(entry.stage);
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)], expectedStages };
}
