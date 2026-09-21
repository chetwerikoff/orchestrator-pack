import { createHash } from 'node:crypto';
import {
  CYCLE_SCHEMA,
  FINAL_SCHEMA,
  JOURNAL_MARKER_PREFIX,
  STAGE_SCHEMA,
} from './create-issue-stage-record-types.ts';
import type {
  CanonicalLineage,
  CycleEventLogical,
  FinalEventLogical,
  JournalLogical,
  LineageDiagnostic,
  ParsedJournalEvent,
  PartialMissingSourceWitness,
  PublicActor,
  StageEventLogical,
  TrustedComment,
} from './create-issue-stage-record-types.ts';
import {
  isReviewLaneEvidence,
  isReviewLaneRouting,
  reviewLaneWaivedMissingSlots,
} from './review-lane-record.ts';

const MARKER_RE = new RegExp(
  `<!--\\s*${JOURNAL_MARKER_PREFIX}:([^:]+):([^\\s]+)\\s*-->`,
  'i',
);

export function buildMarker(schema: string, eventKey: string): string {
  return `<!-- ${JOURNAL_MARKER_PREFIX}:${schema}:${eventKey} -->`;
}

function isKnownSchema(value: unknown): value is typeof CYCLE_SCHEMA | typeof STAGE_SCHEMA | typeof FINAL_SCHEMA {
  return value === CYCLE_SCHEMA || value === STAGE_SCHEMA || value === FINAL_SCHEMA;
}

export const PUBLIC_ACTORS = new Set<PublicActor>([
  'opencode-flow-manager',
  'cursor-flow-manager',
  'codex-flow-manager',
  'other-flow-manager',
]);

export const INVALID_PUBLIC_ACTOR_POISON_COMMENT_ID = 5757262517;

export function isInvalidPublicActorPoisonTrustDiagnostic(diagnostic: LineageDiagnostic): boolean {
  return diagnostic.commentId === INVALID_PUBLIC_ACTOR_POISON_COMMENT_ID
    && (diagnostic.code === 'foreign-comment' || diagnostic.code === 'edited-comment');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isPublicActor(value: unknown): value is PublicActor {
  return typeof value === 'string' && PUBLIC_ACTORS.has(value as PublicActor);
}

function isPartialMissingSourceWitness(value: unknown): value is PartialMissingSourceWitness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.reviewerSlot === 'string'
    && /^\d{2}$/.test(row.reviewerSlot)
    && isNonEmptyString(row.invocationId)
    && isNonEmptyString(row.evidenceIdentity)
    && isNonEmptyString(row.reason);
}

function parsePartialMissingSources(value: unknown): PartialMissingSourceWitness[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !isPartialMissingSourceWitness(item))) return null;
  const slots = value.map((item) => item.reviewerSlot);
  if (new Set(slots).size !== slots.length) return null;
  return value;
}

function isJournalPayload(value: Record<string, unknown>): boolean {
  if (!isKnownSchema(value.schema) || !isNonEmptyString(value['event-key'])) {
    return false;
  }
  if (value.schema === CYCLE_SCHEMA) {
    return isNonEmptyString(value['cycle-id'])
      && isNonEmptyString(value['predecessor-cycle-id'])
      && isNonEmptyString(value['source-revision'])
      && isNonEmptyString(value.tier)
      && isPublicActor(value['public-actor'])
      && (value['routed-lane'] === undefined || isReviewLaneRouting(value['routed-lane']));
  }
  if (value.schema === STAGE_SCHEMA) {
    const partialMissingSources = parsePartialMissingSources(value['partial-missing-sources']);
    return isNonEmptyString(value['cycle-id'])
      && isNonEmptyString(value.stage)
      && isNonEmptyString(value.tier)
      && isNonEmptyString(value['source-revision'])
      && isNonEmptyString(value['stage-attempt-id'])
      && isNonEmptyString(value['policy-version'])
      && isNonEmptyString(value['tier-transition'])
      && Number.isInteger(value['source-count'])
      && Number.isInteger(value['required-source-count'])
      && ['complete', 'partial', 'blocked', 'incident'].includes(String(value['settled-outcome']))
      && ['verified', 'waived', 'not-applicable'].includes(String(value['producer-evidence']))
      && partialMissingSources !== null
      && (value['settled-outcome'] === 'partial' || partialMissingSources.length === 0);
  }
  return isNonEmptyString(value['cycle-id'])
    && isNonEmptyString(value.tier)
    && isNonEmptyString(value['source-revision'])
    && value.outcome === 'accepted'
    && isNonEmptyString(value['contract-version'])
    && isPublicActor(value['public-actor']);
}

function buildJournalLogical(parsed: Record<string, unknown>): JournalLogical | null {
  if (!isKnownSchema(parsed.schema) || !isNonEmptyString(parsed['event-key']) || !isJournalPayload(parsed)) {
    return null;
  }
  const eventKey = parsed['event-key'];
  if (parsed.schema === CYCLE_SCHEMA) {
    const cycleId = parsed['cycle-id'];
    const predecessorCycleId = parsed['predecessor-cycle-id'];
    const sourceRevision = parsed['source-revision'];
    const tier = parsed.tier;
    const publicActor = parsed['public-actor'];
    const routedLane = parsed['routed-lane'];
    if (!isNonEmptyString(cycleId)
      || !isNonEmptyString(predecessorCycleId)
      || !isNonEmptyString(sourceRevision)
      || !isNonEmptyString(tier)
      || !isPublicActor(publicActor)) {
      return null;
    }
    if (routedLane !== undefined && !isReviewLaneRouting(routedLane)) return null;
    const logical: CycleEventLogical = {
      schema: CYCLE_SCHEMA,
      'event-key': eventKey,
      'cycle-id': cycleId,
      'predecessor-cycle-id': predecessorCycleId,
      'source-revision': sourceRevision,
      tier,
      'public-actor': publicActor,
      'routed-lane': routedLane,
    };
    return logical;
  }
  if (parsed.schema === STAGE_SCHEMA) {
    const cycleId = parsed['cycle-id'];
    const stage = parsed.stage;
    const tier = parsed.tier;
    const sourceRevision = parsed['source-revision'];
    const stageAttemptId = parsed['stage-attempt-id'];
    const policyVersion = parsed['policy-version'];
    const tierTransition = parsed['tier-transition'];
    const settledOutcome = parsed['settled-outcome'];
    const sourceCount = parsed['source-count'];
    const requiredSourceCount = parsed['required-source-count'];
    const producerEvidence = parsed['producer-evidence'];
    const routedLane = parsed['routed-lane'];
    const partialMissingSources = parsePartialMissingSources(parsed['partial-missing-sources']);
    if (!isNonEmptyString(cycleId)
      || !isNonEmptyString(stage)
      || !isNonEmptyString(tier)
      || !isNonEmptyString(sourceRevision)
      || !isNonEmptyString(stageAttemptId)
      || !isNonEmptyString(policyVersion)
      || !isNonEmptyString(tierTransition)
      || (settledOutcome !== 'complete' && settledOutcome !== 'partial' && settledOutcome !== 'blocked' && settledOutcome !== 'incident')
      || typeof sourceCount !== 'number' || !Number.isInteger(sourceCount)
      || typeof requiredSourceCount !== 'number' || !Number.isInteger(requiredSourceCount)
      || (producerEvidence !== 'verified' && producerEvidence !== 'waived' && producerEvidence !== 'not-applicable')
      || partialMissingSources === null
      || (settledOutcome !== 'partial' && partialMissingSources.length > 0)) {
      return null;
    }
    const waivedMissingSlots = reviewLaneWaivedMissingSlots(stage, policyVersion, producerEvidence, partialMissingSources);
    if (policyVersion === 'review-lane-routing/v1') {
      if (!isReviewLaneEvidence(routedLane, waivedMissingSlots)) return null;
    } else if (routedLane !== undefined && !isReviewLaneEvidence(routedLane, waivedMissingSlots)) {
      return null;
    }
    const logical: StageEventLogical = {
      schema: STAGE_SCHEMA,
      'event-key': eventKey,
      'cycle-id': cycleId,
      stage,
      tier,
      'source-revision': sourceRevision,
      'stage-attempt-id': stageAttemptId,
      'policy-version': policyVersion,
      'settled-outcome': settledOutcome,
      'source-count': sourceCount,
      'required-source-count': requiredSourceCount,
      'producer-evidence': producerEvidence,
      'tier-transition': tierTransition,
      ...(partialMissingSources.length > 0 ? { 'partial-missing-sources': partialMissingSources } : {}),
      'routed-lane': routedLane,
    };
    return logical;
  }
  const cycleId = parsed['cycle-id'];
  const tier = parsed.tier;
  const sourceRevision = parsed['source-revision'];
  const contractVersion = parsed['contract-version'];
  const publicActor = parsed['public-actor'];
  if (!isNonEmptyString(cycleId)
    || !isNonEmptyString(tier)
    || !isNonEmptyString(sourceRevision)
    || !isNonEmptyString(contractVersion)
    || !isPublicActor(publicActor)
    || parsed.outcome !== 'accepted') {
    return null;
  }
  const logical: FinalEventLogical = {
    schema: FINAL_SCHEMA,
    'event-key': eventKey,
    'cycle-id': cycleId,
    tier,
    'source-revision': sourceRevision,
    outcome: 'accepted',
    'contract-version': contractVersion,
    'public-actor': publicActor,
  };
  return logical;
}

export function extractMarker(body: string): { schema: string; eventKey: string } | null {
  const match = body.match(MARKER_RE);
  if (!match) return null;
  const schema = match[1]?.trim() ?? '';
  const eventKey = match[2]?.trim() ?? '';
  if (!schema || !eventKey) return null;
  return { schema, eventKey };
}

export function serializeCommentBody(
  logical: JournalLogical,
  delivery?: { delivery?: 'immediate' | 'delayed'; deliveryFailureClass?: string; firstFailureAt?: string },
): string {
  const marker = buildMarker(logical.schema, logical['event-key']);
  const payload = canonicalizeLogical(logical);
  if (delivery?.delivery) payload.delivery = delivery.delivery;
  if (delivery?.deliveryFailureClass) payload['delivery-failure-class'] = delivery.deliveryFailureClass;
  if (delivery?.firstFailureAt) payload['first-failure-at'] = delivery.firstFailureAt;
  return `${marker}\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

export interface InvalidPublicActorCycleObservation {
  eventKey: string;
  cycleId: string;
  predecessorCycleId: string;
  sourceRevision: string;
  tier: string;
  invalidPublicActor: string;
}

export interface RecoveredInvalidPublicActorPoisonWitness {
  poisonCommentId: number;
  poisonCycleId: string;
  predecessorCycleId: string;
  sourceRevision: string;
  tier: string;
  invalidPublicActor: string;
  successorCommentId: number;
  successorCycleId: string;
}

export function parseInvalidPublicActorCycleBody(body: string): InvalidPublicActorCycleObservation | null {
  const marker = extractMarker(body);
  if (!marker || marker.schema !== CYCLE_SCHEMA) return null;
  const fence = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!fence) return null;
  try {
    const parsed = JSON.parse(fence[1] ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const eventKey = record['event-key'];
    const cycleId = record['cycle-id'];
    const predecessorCycleId = record['predecessor-cycle-id'];
    const sourceRevision = record['source-revision'];
    const tier = record.tier;
    const publicActor = record['public-actor'];
    const routedLane = record['routed-lane'];
    if (record.schema !== CYCLE_SCHEMA
      || marker.eventKey !== eventKey
      || !isNonEmptyString(eventKey)
      || !isNonEmptyString(cycleId)
      || eventKey !== cycleId
      || !isNonEmptyString(predecessorCycleId)
      || !isNonEmptyString(sourceRevision)
      || !isNonEmptyString(tier)
      || !isNonEmptyString(publicActor)
      || isPublicActor(publicActor)
      || (routedLane !== undefined && !isReviewLaneRouting(routedLane))) {
      return null;
    }
    return {
      eventKey,
      cycleId,
      predecessorCycleId,
      sourceRevision,
      tier,
      invalidPublicActor: publicActor,
    };
  } catch {
    return null;
  }
}

function compareJournalOrder(
  left: { createdAt: string; id: number },
  right: { createdAt: string; id: number },
): number {
  const leftAt = Date.parse(left.createdAt);
  const rightAt = Date.parse(right.createdAt);
  if (leftAt !== rightAt) return leftAt - rightAt;
  return left.id - right.id;
}

function canonicalCycleChain(lineage: CanonicalLineage): ParsedJournalEvent[] | null {
  const head = lineage.head;
  if (!head || head.logical.schema !== CYCLE_SCHEMA) return [];
  const byCycleId = new Map<string, ParsedJournalEvent>();
  for (const event of lineage.eventsByKey.values()) {
    if (event.logical.schema !== CYCLE_SCHEMA) continue;
    const cycleId = event.logical['cycle-id'];
    const existing = byCycleId.get(cycleId);
    if (existing && existing.eventKey !== event.eventKey) return null;
    byCycleId.set(cycleId, event);
  }
  const reversed: ParsedJournalEvent[] = [];
  const visited = new Set<string>();
  let current = head.logical['cycle-id'];
  while (current !== 'none') {
    if (visited.has(current)) return null;
    visited.add(current);
    const event = byCycleId.get(current);
    if (!event || event.logical.schema !== CYCLE_SCHEMA) return null;
    reversed.push(event);
    current = event.logical['predecessor-cycle-id'];
  }
  return reversed.reverse();
}

export function resolveRecoveredInvalidPublicActorPoisonWitness(input: {
  comments: TrustedComment[];
  parsedDiagnostics: LineageDiagnostic[];
  lineage: CanonicalLineage;
}): RecoveredInvalidPublicActorPoisonWitness | null {
  const malformed = input.parsedDiagnostics.filter((diagnostic) => diagnostic.code === 'malformed-marker');
  if (malformed.length !== 1 || malformed[0]?.commentId === undefined) return null;
  const poisonComment = input.comments.find((comment) => comment.id === malformed[0]!.commentId);
  if (!poisonComment) return null;
  const poison = parseInvalidPublicActorCycleBody(poisonComment.body);
  if (!poison) return null;

  const chain = canonicalCycleChain(input.lineage);
  if (!chain) return null;
  const beforePoison = chain.filter((event) => compareJournalOrder(
    { createdAt: event.createdAt, id: event.commentId },
    { createdAt: poisonComment.createdAt, id: poisonComment.id },
  ) < 0);
  const predecessorEvent = beforePoison.at(-1);
  const expectedPredecessor = predecessorEvent?.logical.schema === CYCLE_SCHEMA
    ? predecessorEvent.logical['cycle-id']
    : 'none';
  if (poison.predecessorCycleId !== expectedPredecessor) return null;

  const successor = chain.find((event) => compareJournalOrder(
    { createdAt: event.createdAt, id: event.commentId },
    { createdAt: poisonComment.createdAt, id: poisonComment.id },
  ) > 0);
  if (!successor || successor.logical.schema !== CYCLE_SCHEMA) return null;
  if (successor.logical['cycle-id'] === poison.cycleId
    || successor.logical['predecessor-cycle-id'] !== expectedPredecessor
    || successor.logical['source-revision'] !== poison.sourceRevision
    || successor.logical.tier !== poison.tier
    || !isPublicActor(successor.logical['public-actor'])) {
    return null;
  }

  return {
    poisonCommentId: poisonComment.id,
    poisonCycleId: poison.cycleId,
    predecessorCycleId: poison.predecessorCycleId,
    sourceRevision: poison.sourceRevision,
    tier: poison.tier,
    invalidPublicActor: poison.invalidPublicActor,
    successorCommentId: successor.commentId,
    successorCycleId: successor.logical['cycle-id'],
  };
}

export function parseLogicalFromCommentBody(body: string): JournalLogical | null {
  const marker = extractMarker(body);
  if (!marker) return null;
  const fence = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!fence) return null;
  try {
    const parsed = JSON.parse(fence[1] ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!isKnownSchema(marker.schema) || record.schema !== marker.schema) return null;
    if (typeof record['event-key'] !== 'string' || record['event-key'] !== marker.eventKey) return null;
    return buildJournalLogical(record);
  } catch {
    return null;
  }
}

export function logicalFingerprint(logical: JournalLogical): string {
  const canonical = canonicalizeLogical(logical);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function canonicalizeLogical(logical: JournalLogical): Record<string, unknown> {
  const out = canonicalizeLogicalRecord(logical);
  const keys = Object.keys(out).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of keys) sorted[key] = out[key];
  return sorted;
}

function canonicalizeLogicalRecord(logical: JournalLogical): Record<string, unknown> {
  switch (logical.schema) {
    case CYCLE_SCHEMA:
      return {
        schema: logical.schema,
        'event-key': logical['event-key'],
        'cycle-id': logical['cycle-id'],
        'predecessor-cycle-id': logical['predecessor-cycle-id'],
        'source-revision': logical['source-revision'],
        tier: logical.tier,
        'public-actor': logical['public-actor'],
        'routed-lane': logical['routed-lane'],
      };
    case STAGE_SCHEMA:
      return {
        schema: logical.schema,
        'event-key': logical['event-key'],
        'cycle-id': logical['cycle-id'],
        stage: logical.stage,
        tier: logical.tier,
        'source-revision': logical['source-revision'],
        'stage-attempt-id': logical['stage-attempt-id'],
        'policy-version': logical['policy-version'],
        'settled-outcome': logical['settled-outcome'],
        'source-count': logical['source-count'],
        'required-source-count': logical['required-source-count'],
        'producer-evidence': logical['producer-evidence'],
        'tier-transition': logical['tier-transition'],
        'partial-missing-sources': logical['partial-missing-sources'],
        'routed-lane': logical['routed-lane'],
      };
    case FINAL_SCHEMA:
      return {
        schema: logical.schema,
        'event-key': logical['event-key'],
        'cycle-id': logical['cycle-id'],
        tier: logical.tier,
        'source-revision': logical['source-revision'],
        outcome: logical.outcome,
        'contract-version': logical['contract-version'],
        'public-actor': logical['public-actor'],
      };
    default:
      return {};
  }
}

export function logicalEventsEqual(a: JournalLogical, b: JournalLogical): boolean {
  return logicalFingerprint(a) === logicalFingerprint(b);
}
