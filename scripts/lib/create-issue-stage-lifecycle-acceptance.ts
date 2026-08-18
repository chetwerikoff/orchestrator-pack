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

function lifecycleStage(value: unknown): LifecycleReviewStage | null {
  if (value === 'competitive' || value === 'architectural-review' || value === 'architectural-lens' || value === 'architectural') return value;
  return null;
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

function requiredSlotsForReceipt(
  receipt: Record<string, unknown>,
  reviewerCardinality: number,
  stage: LifecycleReviewStage,
  errors: string[],
): string[] {
  const configured = canonicalSlots(reviewerCardinality);
  const lane = record(receipt.reviewLane) ? receipt.reviewLane : null;
  if (!lane) return configured;
  if (!Array.isArray(lane.finalRequiredSlots) || lane.finalRequiredSlots.length === 0) {
    errors.push(`${stage} reviewLane finalRequiredSlots is missing or malformed`);
    return configured;
  }
  const observed = lane.finalRequiredSlots.filter((slot): slot is string => typeof slot === 'string' && /^\d{2}$/.test(slot));
  if (observed.length !== lane.finalRequiredSlots.length
    || new Set(observed).size !== observed.length
    || observed.some((slot) => !configured.includes(slot))) {
    errors.push(`${stage} reviewLane finalRequiredSlots is outside configured slots ${configured.join(',')}`);
    return configured;
  }
  return observed;
}

function invocationCredentialed(invocation: Record<string, unknown> | undefined): boolean {
  if (!invocation || !record(invocation.capture)) return false;
  return invocation.terminalClassification === 'complete' || record(invocation.artifactAuthority);
}

const POSSIBLE_OR_ACTUAL_SEND_FAILURES = new Set([
  'post-send-failure',
  'output-conflict',
  'incident',
]);

function invocationProvesUnobservable(invocation: Record<string, unknown>): boolean {
  const invocationId = stringValue(invocation.invocationId);
  return Boolean(
    invocationId
    && invocation.terminal === true
    && invocation.sendCount === 1
    && invocation.retryClass === 'retry-forbidden'
    && POSSIBLE_OR_ACTUAL_SEND_FAILURES.has(String(invocation.terminalClassification)),
  );
}

function partialWitnessesBySlot(
  receipt: Record<string, unknown>,
  stage: LifecycleReviewStage,
  errors: string[],
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(receipt.partialMissingSources)) return result;
  for (const [index, value] of receipt.partialMissingSources.entries()) {
    if (!record(value)) {
      errors.push(`${stage} partialMissingSources[${index}] must be an object`);
      continue;
    }
    const slot = stringValue(value.reviewerSlot);
    const invocationId = stringValue(value.invocationId);
    const evidenceIdentity = stringValue(value.evidenceIdentity);
    const reason = stringValue(value.reason);
    if (!slot || !/^\d{2}$/.test(slot) || !invocationId || !evidenceIdentity || !reason) {
      errors.push(`${stage} partialMissingSources[${index}] must name reviewerSlot, invocationId, evidenceIdentity, and reason`);
      continue;
    }
    if (result.has(slot)) {
      errors.push(`${stage} partialMissingSources repeats reviewer slot ${slot}`);
      continue;
    }
    result.set(slot, value);
  }
  return result;
}

export interface StageCredentialingResult {
  credentialed: boolean;
  errors: string[];
  credentialingCaptures: unknown[];
  missingSlots: string[];
}

export function evaluateStageCredentialingSettlement(
  receiptValue: unknown,
  reviewerCardinality: number,
  stage: LifecycleReviewStage,
): StageCredentialingResult {
  const errors: string[] = [];
  if (!record(receiptValue)) {
    return { credentialed: false, errors: [`${stage} receipt is malformed`], credentialingCaptures: [], missingSlots: [] };
  }
  const receipt = receiptValue;
  const configured = canonicalSlots(reviewerCardinality);
  const required = requiredSlotsForReceipt(receipt, reviewerCardinality, stage, errors);
  const finals = finalInvocationBySlot(receipt);
  const extraSlots = [...finals.keys()].filter((slotName) => !configured.includes(slotName));
  if (extraSlots.length > 0) errors.push(`${stage} settlement contains non-canonical slots: ${extraSlots.join(',')}`);

  const credentialingCaptures: unknown[] = required.flatMap((slotName) => {
    const invocation = finals.get(slotName);
    return invocationCredentialed(invocation) && record(invocation?.capture)
      ? [invocation.capture]
      : [];
  });
  const missing = required.filter((slotName) => !invocationCredentialed(finals.get(slotName)));

  if (receipt.outcome === 'complete') {
    if (missing.length > 0) errors.push(`${stage} complete settlement is missing credentialed slots: ${missing.join(',')}`);
    return { credentialed: errors.length === 0, errors, credentialingCaptures, missingSlots: missing };
  }
  if (receipt.outcome !== 'partial') {
    errors.push(`${stage} outcome ${String(receipt.outcome)} consumes the stage slot but cannot credential progression/final acceptance`);
    return { credentialed: false, errors, credentialingCaptures, missingSlots: missing };
  }
  if (reviewerCardinality !== 3 || required.length !== 3) {
    errors.push(`${stage} partial settlement is valid only for a canonical three-slot stage`);
    return { credentialed: false, errors, credentialingCaptures, missingSlots: missing };
  }
  if (missing.length === 0) {
    errors.push(`${stage} partial settlement has no missing source`);
    return { credentialed: false, errors, credentialingCaptures, missingSlots: missing };
  }

  const witnesses = partialWitnessesBySlot(receipt, stage, errors);
  const witnessSlots = [...witnesses.keys()].sort();
  const expectedMissing = [...missing].sort();
  if (witnessSlots.length !== expectedMissing.length
    || witnessSlots.some((slotName, index) => slotName !== expectedMissing[index])) {
    errors.push(`${stage} partial journal witnesses must equal missing slots exactly: expected ${expectedMissing.join(',') || '<none>'}, got ${witnessSlots.join(',') || '<none>'}`);
  }
  for (const missingSlot of missing) {
    const invocation = finals.get(missingSlot);
    const witness = witnesses.get(missingSlot);
    if (!invocation) {
      errors.push(`${stage} partial missing slot ${missingSlot} lacks its invocation identity/evidence`);
      continue;
    }
    if (!invocationProvesUnobservable(invocation)) {
      errors.push(`${stage} partial missing slot ${missingSlot} is not a possible-or-actual send with resend forbidden`);
      continue;
    }
    const invocationId = stringValue(invocation.invocationId);
    const terminalResultIdentity = stringValue(invocation.terminalResultIdentity);
    if (!witness || stringValue(witness.invocationId) !== invocationId) {
      errors.push(`${stage} partial missing slot ${missingSlot} lacks a journal witness naming invocation ${invocationId ?? '<missing>'}`);
    }
    if (!terminalResultIdentity || stringValue(witness?.evidenceIdentity) !== terminalResultIdentity) {
      errors.push(`${stage} partial missing slot ${missingSlot} journal witness does not bind terminal evidence ${terminalResultIdentity ?? '<missing>'}`);
    }
  }
  if (missing.length >= 2 && receipt.producerEvidence !== 'waived') {
    errors.push(`${stage} partial settlement is missing ${missing.length} slots; explicit operator waiver through the existing waiver seam is required`);
  }
  if (missing.length === 1 && credentialingCaptures.length !== 2) {
    errors.push(`${stage} partial settlement must retain exactly two credentialed sources; observed ${credentialingCaptures.length}`);
  }

  return {
    credentialed: errors.length === 0,
    errors: [...new Set(errors)],
    credentialingCaptures,
    missingSlots: missing,
  };
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

  const records = receiptValues.map((value) => {
    const raw = record(value) ? value : null;
    const slot = parseSettledStageSlot(value);
    if (raw && !slot && raw.outcome === 'partial') {
      const stage = lifecycleStage(raw.stage);
      const reviewerCardinality = Number(raw.reviewerCardinality);
      if (stage && Number.isInteger(reviewerCardinality) && reviewerCardinality > 0) {
        errors.push(...evaluateStageCredentialingSettlement(raw, reviewerCardinality, stage).errors);
      }
    }
    return { raw, slot };
  });
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
    const { raw: receipt } = candidates[0]!;
    for (const predecessor of expectedStages.slice(0, expectedStages.indexOf(stage))) {
      if (!progressed.has(predecessor)) errors.push(`${stage} settled before predecessor ${predecessor} successfully settled`);
    }

    const credentialing = stage === 'architectural-lens'
      ? { credentialed: receipt.outcome === 'complete', errors: receipt.outcome === 'complete' ? [] : [`${stage} must complete`] }
      : evaluateStageCredentialingSettlement(receipt, topologyEntry.reviewerCardinality, stage);
    errors.push(...credentialing.errors);
    if (credentialing.credentialed) progressed.add(stage);
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)], expectedStages };
}
