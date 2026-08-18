import {
  admissionStageSequence,
  canonicalStageTopology,
  parseLifecycleTierIntake,
  parseSettledStageSlot,
  type LifecycleReviewStage,
  type LifecycleTierIntakeV1,
  type SettledStageSlot,
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

function canonicalSlots(cardinality: number): string[] {
  return Array.from({ length: cardinality }, (_, index) => String(index + 1).padStart(2, '0'));
}

function validateLaneSlots(
  receipt: Record<string, unknown>,
  expected: readonly string[],
  stage: LifecycleReviewStage,
  errors: string[],
): void {
  const lane = record(receipt.reviewLane) ? receipt.reviewLane : null;
  if (!lane) return;
  if (!Array.isArray(lane.finalRequiredSlots)) {
    errors.push(`${stage} reviewLane finalRequiredSlots is missing or malformed`);
    return;
  }
  const observed = lane.finalRequiredSlots.filter((slot): slot is string => typeof slot === 'string');
  if (observed.length !== lane.finalRequiredSlots.length
    || observed.length !== expected.length
    || observed.some((slot, index) => slot !== expected[index])) {
    errors.push(`${stage} reviewLane finalRequiredSlots does not equal canonical ${expected.join(',')}`);
  }
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
  if (!intake) return { ok: false, errors: ['canonical tier-intake/v1 is missing or malformed'], expectedStages: [] };

  const records = receiptValues.map((value) => ({ raw: record(value) ? value : null, slot: parseSettledStageSlot(value) }));
  if (records.some((entry) => !entry.raw || !entry.slot)) errors.push('stage receipt inventory contains a malformed receipt');
  const valid = records.filter((entry): entry is { raw: Record<string, unknown>; slot: SettledStageSlot } => Boolean(entry.raw && entry.slot));
  const observedTier = tierValue ?? valid[0]?.slot.tier ?? intake.priorTier;
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
  const expectedStages = topology.stages.map((entry) => entry.stage as LifecycleReviewStage);
  const sequence = admissionStageSequence(topology, valid.map((entry) => entry.slot));
  errors.push(...sequence.errors);
  if (sequence.expectedStage !== null) errors.push(`final acceptance is missing required stage ${sequence.expectedStage}`);

  const byStage = new Map<LifecycleReviewStage, Array<{ raw: Record<string, unknown>; slot: SettledStageSlot }>>();
  for (const entry of valid) {
    if (!expectedStages.includes(entry.slot.stage)) {
      errors.push(`stage ${entry.slot.stage} is outside canonical ${observedTier} topology`);
      continue;
    }
    const list = byStage.get(entry.slot.stage) ?? [];
    list.push(entry);
    byStage.set(entry.slot.stage, list);
  }

  const progressed = new Set<LifecycleReviewStage>();
  for (const topologyEntry of topology.stages) {
    const stage = topologyEntry.stage as LifecycleReviewStage;
    const candidates = byStage.get(stage) ?? [];
    if (candidates.length !== 1) {
      errors.push(`${stage} requires exactly one settled Issue-lifetime stageAttemptId; observed ${candidates.length}`);
      continue;
    }
    const { raw: receipt, slot } = candidates[0]!;
    for (const predecessor of expectedStages.slice(0, expectedStages.indexOf(stage))) {
      if (!progressed.has(predecessor)) errors.push(`${stage} settled before predecessor ${predecessor} successfully settled`);
    }

    const required = canonicalSlots(topologyEntry.reviewerCardinality);
    validateLaneSlots(receipt, required, stage, errors);
    if (slot.outcome === 'complete') {
      progressed.add(stage);
      continue;
    }
    if (slot.outcome !== 'partial') {
      errors.push(`${stage} outcome ${slot.outcome} consumes the stage slot but cannot credential progression/final acceptance`);
      continue;
    }
    if (topologyEntry.reviewerCardinality !== 3) {
      errors.push(`${stage} partial settlement is valid only for a canonical three-source stage`);
      continue;
    }
    const finals = finalInvocationBySlot(receipt);
    const extraSlots = [...finals.keys()].filter((slotName) => !required.includes(slotName));
    if (extraSlots.length > 0) {
      errors.push(`${stage} partial settlement contains non-canonical slots: ${extraSlots.join(',')}`);
      continue;
    }
    const missing = required.filter((slotName) => !invocationCredentialed(finals.get(slotName)));
    if (missing.length === 0) {
      errors.push(`${stage} partial settlement has no missing source`);
      continue;
    }
    if (missing.length >= 2) {
      errors.push(`${stage} partial settlement is missing ${missing.length} slots; explicit operator waiver through the existing waiver seam is required`);
      continue;
    }
    const missingSlot = missing[0]!;
    const invocation = finals.get(missingSlot);
    if (!invocation) {
      errors.push(`${stage} partial missing slot ${missingSlot} lacks its invocation identity/evidence`);
      continue;
    }
    if (!reviewLaneProvesUnobservable(receipt, missingSlot, invocation)) {
      errors.push(`${stage} partial missing slot ${missingSlot} is not journal/evidence-backed as unobservable with resend forbidden`);
      continue;
    }
    const completed = required.filter((slotName) => invocationCredentialed(finals.get(slotName))).length;
    if (completed !== 2) {
      errors.push(`${stage} partial settlement must retain exactly two credentialed sources; observed ${completed}`);
      continue;
    }
    progressed.add(stage);
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)], expectedStages };
}
