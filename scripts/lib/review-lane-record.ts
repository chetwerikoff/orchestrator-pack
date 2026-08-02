import type { ReviewLaneEvidence } from './create-issue-stage-record-types.ts';
import { normalizeMaterialVerdict, settleReviewLane, type ReviewLaneRouting, type ReviewLaneSettlement, type ReviewLaneSourceVerdict, type ReviewLaneSourceVerdictEvidence } from './review-lane-routing.ts';

export interface ReviewLaneRecordValidation {
  ok: boolean;
  errors: string[];
}

export function validateReviewLaneRouting(value: unknown): ReviewLaneRecordValidation {
  return isRouting(value)
    ? { ok: true, errors: [] }
    : { ok: false, errors: ['routed review record has malformed immutable routing'] };
}

export function isReviewLaneRouting(value: unknown): value is ReviewLaneRouting {
  return isRouting(value);
}

export function isReviewLaneEvidence(value: unknown): value is ReviewLaneEvidence {
  return validateReviewLaneRecord(value).ok;
}

export function sameReviewLaneRouting(left: ReviewLaneRouting, right: ReviewLaneRouting): boolean {
  return left.schema === right.schema
    && left.routingPolicyIdentity === right.routingPolicyIdentity
    && left.lane === right.lane
    && left.topology === right.topology
    && left.policyVersion === right.policyVersion
    && left.reviewerCardinality === right.reviewerCardinality
    && left.cardinalityConfigIdentity === right.cardinalityConfigIdentity
    && left.sourceRevision === right.sourceRevision
    && left.stageAttemptId === right.stageAttemptId
    && left.laneInputIdentity === right.laneInputIdentity
    && left.classifierIdentity === right.classifierIdentity
    && left.conditionalActivationRule === right.conditionalActivationRule
    && sameSlots(left.possibleSlots, right.possibleSlots)
    && sameSlots(left.initiallyActivatedSlots, right.initiallyActivatedSlots);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sameSlots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((slot, index) => slot === right[index]);
}

function isRouting(value: unknown): value is ReviewLaneRouting {
  if (!isRecord(value)) return false;
  if (value.schema !== 'review-lane-routing/v1' || value.routingPolicyIdentity !== 'review-lane-routing/v1') return false;
  if (value.topology !== 'fixed/v1' && value.topology !== 'conditional-third/v1') return false;
  if (value.lane !== 'normal' && value.lane !== 'disputed') return false;
  if (value.policyVersion !== 'review-lane-routing/v1') return false;
  const reviewerCardinality = value.reviewerCardinality;
  if (typeof reviewerCardinality !== 'number' || !Number.isInteger(reviewerCardinality) || reviewerCardinality < 1) return false;
  if (!nonEmpty(value.cardinalityConfigIdentity) || !nonEmpty(value.sourceRevision) || !nonEmpty(value.stageAttemptId)) return false;
  if (!nonEmpty(value.laneInputIdentity) || !nonEmpty(value.classifierIdentity)) return false;
  const possibleSlots = value.possibleSlots;
  const initiallyActivatedSlots = value.initiallyActivatedSlots;
  if (!Array.isArray(possibleSlots) || possibleSlots.length !== reviewerCardinality) return false;
  if (!Array.isArray(initiallyActivatedSlots)) return false;
  if (possibleSlots.some((slot) => typeof slot !== 'string' || !/^\d{2}$/.test(slot))) return false;
  if (new Set(possibleSlots).size !== possibleSlots.length || new Set(initiallyActivatedSlots).size !== initiallyActivatedSlots.length) return false;
  const expectedPossible = Array.from({ length: reviewerCardinality }, (_, index) => String(index + 1).padStart(2, '0'));
  if (!sameSlots(possibleSlots, expectedPossible)) return false;
  if (initiallyActivatedSlots.some((slot) => !possibleSlots.includes(slot))) return false;
  if (value.topology === 'conditional-third/v1') {
    if (value.lane !== 'disputed' || !sameSlots(possibleSlots, ['01', '02', '03']) || !sameSlots(initiallyActivatedSlots, ['01', '02'])) return false;
    if (value.conditionalActivationRule !== 'material-verdict-conflict/v1') return false;
  } else {
    if (value.conditionalActivationRule !== null) return false;
    if (value.lane === 'normal' && !sameSlots(possibleSlots, ['01'])) return false;
    if (value.lane === 'normal' && !sameSlots(initiallyActivatedSlots, ['01'])) return false;
    if (value.lane === 'disputed' && (!sameSlots(possibleSlots, ['01', '02', '03']) || !sameSlots(initiallyActivatedSlots, ['01', '02', '03']))) return false;
  }
  return true;
}

function isSettlement(value: unknown, routing: ReviewLaneRouting): value is ReviewLaneSettlement {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || !Array.isArray(value.finalRequiredSlots)
    || !Array.isArray(value.slotCensus) || !Array.isArray(value.errors)) return false;
  if (value.conflictDecision !== 'no-conflict'
    && value.conflictDecision !== 'conflict-requires-slot-03'
    && value.conflictDecision !== 'blocked-initial-source') return false;
  if (!value.finalRequiredSlots.every((slot) => typeof slot === 'string')
    || !value.errors.every((error) => typeof error === 'string')) return false;
  if (value.ok !== (value.errors.length === 0)) return false;
  const expectedFinal = value.conflictDecision === 'conflict-requires-slot-03'
    ? routing.possibleSlots : routing.initiallyActivatedSlots;
  if (!sameSlots(value.finalRequiredSlots, expectedFinal)) return false;
  if (value.slotCensus.length !== routing.possibleSlots.length) return false;
  const activated = new Set([
    ...routing.initiallyActivatedSlots,
    ...(value.conflictDecision === 'conflict-requires-slot-03' ? ['03'] : []),
  ]);
  const censusSlots = value.slotCensus.map((row) => isRecord(row) ? row.slot : undefined);
  if (!censusSlots.every((slot): slot is string => typeof slot === 'string')
    || new Set(censusSlots).size !== routing.possibleSlots.length
    || !sameSlots(censusSlots, routing.possibleSlots)) return false;
  return value.slotCensus.every((row) => isRecord(row)
    && (row.state === 'activated') === activated.has(String(row.slot))
    && (row.state === 'activated' || row.state === 'not-activated'));
}

function isSourceVerdictEvidence(value: unknown): value is ReviewLaneSourceVerdictEvidence {
  if (!isRecord(value) || !nonEmpty(value.producerEvidenceIdentity) || !nonEmpty(value.terminalClassification)) return false;
  if (value.captureVerified !== undefined && typeof value.captureVerified !== 'boolean') return false;
  if (value.digestMatches !== undefined && typeof value.digestMatches !== 'boolean') return false;
  if (value.captureIdentity !== undefined && !nonEmpty(value.captureIdentity)) return false;
  return true;
}

function sourceVerdictEvidenceMap(value: unknown): Record<string, ReviewLaneSourceVerdict> | null {
  if (!isRecord(value)) return null;
  const derived: Record<string, ReviewLaneSourceVerdict> = {};
  const producerIdentities = new Set<string>();
  for (const [slot, evidence] of Object.entries(value)) {
    if (!isSourceVerdictEvidence(evidence) || producerIdentities.has(evidence.producerEvidenceIdentity)) return null;
    producerIdentities.add(evidence.producerEvidenceIdentity);
    derived[slot] = normalizeMaterialVerdict(evidence);
  }
  return derived;
}

export function validateReviewLaneRecord(value: unknown): ReviewLaneRecordValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['routed review record must be an object'] };
  for (const field of ['routing', 'finalRequiredSlots', 'sourceVerdicts', 'sourceVerdictEvidence', 'conflictDecision', 'settlement']) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) errors.push(`routed review record is missing ${field}`);
  }
  const routing = value.routing;
  if (!isRouting(routing)) {
    errors.push('routed review record is missing a complete immutable routing record');
  } else {
    const settlement = value.settlement;
    const finalRequiredSlots = value.finalRequiredSlots;
    const sourceVerdicts = value.sourceVerdicts;
    const conflictDecision = value.conflictDecision;
    let parsedSourceVerdicts: Record<string, ReviewLaneSourceVerdict> | null = null;
    if (isRecord(sourceVerdicts)
      && !Object.values(sourceVerdicts).some((verdict) => !['accept', 'material-findings', 'blocked', 'refused', 'unparseable'].includes(String(verdict)))) {
      parsedSourceVerdicts = {};
      for (const [slot, verdict] of Object.entries(sourceVerdicts)) {
        if (verdict === 'accept' || verdict === 'material-findings' || verdict === 'blocked' || verdict === 'refused' || verdict === 'unparseable') {
          parsedSourceVerdicts[slot] = verdict;
        }
      }
    }
    const derivedSourceVerdicts = sourceVerdictEvidenceMap(value.sourceVerdictEvidence);
    if (!derivedSourceVerdicts) {
      errors.push('routed review record has malformed source verdict producer evidence');
    } else if (parsedSourceVerdicts) {
      const evidenceSlots = Object.keys(derivedSourceVerdicts).sort();
      const verdictSlots = Object.keys(parsedSourceVerdicts).sort();
      if (evidenceSlots.length !== verdictSlots.length || evidenceSlots.some((slot, index) => slot !== verdictSlots[index] || derivedSourceVerdicts[slot] !== parsedSourceVerdicts[slot])) {
        errors.push('routed review record sourceVerdicts disagree with producer evidence');
      }
    }
    if (!isSettlement(settlement, routing)) errors.push('routed review record has malformed or inconsistent settlement');
    if (!Array.isArray(finalRequiredSlots) || !finalRequiredSlots.every((slot) => typeof slot === 'string')) {
      errors.push('routed review record has malformed finalRequiredSlots');
    } else if (isSettlement(settlement, routing) && !sameSlots(finalRequiredSlots, settlement.finalRequiredSlots)) {
      errors.push('routed review record finalRequiredSlots disagrees with settlement');
    }
    if (!isRecord(sourceVerdicts)
      || Object.values(sourceVerdicts).some((verdict) => !['accept', 'material-findings', 'blocked', 'refused', 'unparseable'].includes(String(verdict)))) {
      errors.push('routed review record has malformed sourceVerdicts');
    } else {
      const expectedVerdictSlots = [
        ...routing.initiallyActivatedSlots,
        ...(conflictDecision === 'conflict-requires-slot-03' ? ['03'] : []),
      ];
      const actualVerdictSlots = Object.keys(sourceVerdicts).sort();
      if (!sameSlots(actualVerdictSlots, [...expectedVerdictSlots].sort())) {
        errors.push('routed review record sourceVerdicts disagree with activated slots');
      }
    }
    if (parsedSourceVerdicts && isSettlement(settlement, routing)) {
      const expected = settleReviewLane(routing, parsedSourceVerdicts);
      const actual = settlement;
      const sameCensus = actual.slotCensus.length === expected.slotCensus.length
        && actual.slotCensus.every((row, index) => row.slot === expected.slotCensus[index]?.slot && row.state === expected.slotCensus[index]?.state);
      if (actual.ok !== expected.ok
        || actual.conflictDecision !== expected.conflictDecision
        || !sameSlots(actual.finalRequiredSlots, expected.finalRequiredSlots)
        || !sameCensus
        || !sameSlots(actual.errors, expected.errors)) {
        errors.push('routed review record settlement is not the exact result of routing and source verdicts');
      }
    }
    if (conflictDecision !== 'no-conflict'
      && conflictDecision !== 'conflict-requires-slot-03'
      && conflictDecision !== 'blocked-initial-source') {
      errors.push('routed review record has malformed conflictDecision');
    } else if (isSettlement(settlement, routing) && conflictDecision !== settlement.conflictDecision) {
      errors.push('routed review record conflictDecision disagrees with settlement');
    }
  }
  return { ok: errors.length === 0, errors };
}
