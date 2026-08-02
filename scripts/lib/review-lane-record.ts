import type { ReviewLaneRouting, ReviewLaneSettlement } from './review-lane-routing.ts';

export interface ReviewLaneRecordValidation {
  ok: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRouting(value: unknown): value is ReviewLaneRouting {
  if (!isRecord(value)) return false;
  if (value.schema !== 'review-lane-routing/v1' || value.routingPolicyIdentity !== 'review-lane-routing/v1') return false;
  if (value.topology !== 'fixed/v1' && value.topology !== 'conditional-third/v1') return false;
  if (value.lane !== 'normal' && value.lane !== 'disputed') return false;
  if (value.policyVersion !== 'review-lane-routing/v1') return false;
  if (!nonEmpty(value.cardinalityConfigIdentity) || !nonEmpty(value.sourceRevision) || !nonEmpty(value.stageAttemptId)) return false;
  if (!nonEmpty(value.laneInputIdentity) || !nonEmpty(value.classifierIdentity)) return false;
  const possibleSlots = value.possibleSlots;
  const initiallyActivatedSlots = value.initiallyActivatedSlots;
  if (!Array.isArray(possibleSlots) || possibleSlots.length !== value.reviewerCardinality) return false;
  if (!Array.isArray(initiallyActivatedSlots)) return false;
  if (possibleSlots.some((slot) => typeof slot !== 'string' || !/^\d{2}$/.test(slot))) return false;
  if (initiallyActivatedSlots.some((slot) => !possibleSlots.includes(slot))) return false;
  if (value.topology === 'conditional-third/v1') {
    if (possibleSlots.join(',') !== '01,02,03' || initiallyActivatedSlots.join(',') !== '01,02') return false;
    if (value.conditionalActivationRule !== 'material-verdict-conflict/v1') return false;
  } else if (value.conditionalActivationRule !== null) {
    return false;
  }
  return true;
}

function isSettlement(value: unknown): value is ReviewLaneSettlement {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || !Array.isArray(value.finalRequiredSlots)
    || !Array.isArray(value.slotCensus) || !Array.isArray(value.errors)) return false;
  if (value.conflictDecision !== 'no-conflict'
    && value.conflictDecision !== 'conflict-requires-slot-03'
    && value.conflictDecision !== 'blocked-initial-source') return false;
  return value.finalRequiredSlots.every((slot) => typeof slot === 'string')
    && value.errors.every((error) => typeof error === 'string')
    && value.slotCensus.every((row) => isRecord(row)
      && typeof row.slot === 'string'
      && (row.state === 'activated' || row.state === 'not-activated'));
}

export function validateReviewLaneRecord(value: unknown): ReviewLaneRecordValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['routed review record must be an object'] };
  const routing = value.routing;
  if (!isRouting(routing)) errors.push('routed review record is missing a complete immutable routing record');
  if (value.settlement !== undefined && !isSettlement(value.settlement)) errors.push('routed review record has malformed settlement');
  if (value.finalRequiredSlots !== undefined
    && (!Array.isArray(value.finalRequiredSlots) || value.finalRequiredSlots.some((slot) => typeof slot !== 'string'))) {
    errors.push('routed review record has malformed finalRequiredSlots');
  }
  if (value.sourceVerdicts !== undefined
    && (!isRecord(value.sourceVerdicts)
      || Object.values(value.sourceVerdicts).some((verdict) => !['accept', 'material-findings', 'blocked', 'refused', 'unparseable'].includes(String(verdict))))) {
    errors.push('routed review record has malformed sourceVerdicts');
  }
  if (value.conflictDecision !== undefined
    && value.conflictDecision !== 'no-conflict'
    && value.conflictDecision !== 'conflict-requires-slot-03'
    && value.conflictDecision !== 'blocked-initial-source') {
    errors.push('routed review record has malformed conflictDecision');
  }
  return { ok: errors.length === 0, errors };
}
