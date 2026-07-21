export const CANONICAL_DISPATCH_SOURCE_BLOB_SHA = 'ffae6481d77e47b6bfded236a7f19b1d1fa5dfc5' as const;
export const AO_PASTE_CHAR_THRESHOLD = 200;
export const DISPATCH_OUTCOME_DISPATCHED = 'dispatched' as const;
export const DISPATCH_OUTCOME_SEND_FAILED = 'send_failed' as const;
export const DISPATCH_OUTCOME_IN_FLIGHT = 'dispatch_in_flight' as const;
export const DISPATCH_OUTCOME_UNKNOWN = 'dispatch_unknown' as const;
export const DRAFT_STATE_AUTO_SUBMITTED = 'auto_submitted' as const;
export const DRAFT_STATE_DRAFT_PRESENT = 'draft_present' as const;
export const DELIVERY_PATH_PENDING_DRAFT = 'pending-draft' as const;
export const DELIVERY_PATH_SELF_SUBMITTED = 'self-submitted' as const;

const FENCE_LIFECYCLE_PENDING = 'pending' as const;
const FENCE_LIFECYCLE_COMPLETED = 'completed' as const;
const FENCE_LIFECYCLE_FAILED_UNCERTAIN = 'failed-uncertain' as const;
const DISPATCH_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MECHANICAL_TRANSPORT_ENVELOPE_BYTES = 2 * 1024 * 1024;
const MECHANICAL_STORAGE_CEILING_BYTES = Math.floor(MECHANICAL_TRANSPORT_ENVELOPE_BYTES * 0.65);
export const MECHANICAL_PERSISTED_STORE_CEILING_BYTES = Math.floor(MECHANICAL_STORAGE_CEILING_BYTES / 2);
const RESERVED_META_KEYS = new Set(['_recovery', '_bounds', '_compaction']);

export interface NotificationMessageShape {
  charLength: number;
  lineCount: number;
  multiline: boolean;
  deliveryPath: typeof DELIVERY_PATH_PENDING_DRAFT | typeof DELIVERY_PATH_SELF_SUBMITTED;
}

export interface DispatchJournalRecord extends Record<string, unknown> {
  deliveryId: string;
  sessionId: string;
  deliveredAtMs: number;
  source: string;
  sourceKey: string;
  deliveryPath: string;
  messageShape: { charLength: number; lineCount: number };
  dispatchOutcome: string;
  draftState: string;
  deterministicKey?: string;
  findingsHash?: string;
}

export type DispatchJournal = Record<string, unknown>;

type CanonicalAdmitResult =
  | { ok: true; journal: DispatchJournal; record: DispatchJournalRecord }
  | { ok: false; reason: string; journal: DispatchJournal; backpressure?: boolean };

type CanonicalFinalizeResult =
  | {
    ok: true;
    journal: DispatchJournal;
    record: DispatchJournalRecord;
    evicted: boolean;
  }
  | { ok: false; reason: string; journal: DispatchJournal };

function trimString(value: unknown): string {
  return String(value ?? '').trim();
}

function estimateSerializedUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function interpretDispatchFenceLifecycle(record: Record<string, unknown>): string {
  const explicit = trimString(record.fenceLifecycle);
  if (explicit === FENCE_LIFECYCLE_PENDING) return FENCE_LIFECYCLE_PENDING;
  if (explicit === FENCE_LIFECYCLE_FAILED_UNCERTAIN) return FENCE_LIFECYCLE_FAILED_UNCERTAIN;
  if (explicit === FENCE_LIFECYCLE_COMPLETED) return FENCE_LIFECYCLE_COMPLETED;
  const outcome = trimString(record.dispatchOutcome);
  if (outcome === DISPATCH_OUTCOME_IN_FLIGHT
    || outcome === DISPATCH_OUTCOME_UNKNOWN
    || (outcome === DISPATCH_OUTCOME_DISPATCHED && trimString(record.draftState) === 'unknown')) {
    return FENCE_LIFECYCLE_PENDING;
  }
  return FENCE_LIFECYCLE_COMPLETED;
}

function isDispatchJournalEntryEvictable(record: Record<string, unknown>, nowMs: number): boolean {
  const deliveryId = trimString(record.deliveryId ?? record.id);
  if (!deliveryId || deliveryId.startsWith('_')) return false;
  if (interpretDispatchFenceLifecycle(record) === FENCE_LIFECYCLE_PENDING) return false;
  const deliveredAt = Number(record.deliveredAtMs ?? 0);
  if (!deliveredAt || nowMs - deliveredAt < DISPATCH_JOURNAL_RETENTION_MS) return false;
  return trimString(record.dispatchOutcome) !== DISPATCH_OUTCOME_IN_FLIGHT;
}

function compactDispatchJournal(journal: DispatchJournal, nowMs: number): {
  journal: DispatchJournal;
  evicted: string[];
} {
  const next = { ...journal };
  const evicted: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (RESERVED_META_KEYS.has(key)) continue;
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    if (isDispatchJournalEntryEvictable(record, nowMs)) {
      delete next[key];
      evicted.push(key);
    }
  }
  return { journal: next, evicted };
}

function withPendingDispatchFence(record: DispatchJournalRecord): DispatchJournalRecord {
  return { ...record, fenceLifecycle: FENCE_LIFECYCLE_PENDING };
}

function advanceDispatchFenceLifecycle(
  record: Record<string, unknown>,
  dispatchOutcome: string,
): DispatchJournalRecord {
  const outcome = trimString(dispatchOutcome);
  const uncertain = outcome === DISPATCH_OUTCOME_SEND_FAILED || outcome === DISPATCH_OUTCOME_UNKNOWN;
  return {
    ...record,
    dispatchOutcome: outcome,
    fenceLifecycle: uncertain ? FENCE_LIFECYCLE_FAILED_UNCERTAIN : FENCE_LIFECYCLE_COMPLETED,
  } as DispatchJournalRecord;
}

function worstCaseDispatchJournalRecord(record: DispatchJournalRecord): DispatchJournalRecord {
  return {
    ...record,
    fenceLifecycle: FENCE_LIFECYCLE_COMPLETED,
    dispatchOutcome: DISPATCH_OUTCOME_DISPATCHED,
    draftState: DRAFT_STATE_DRAFT_PRESENT,
    messageShape: { charLength: 4096, lineCount: 64 },
    auditNote: 'x'.repeat(512),
  };
}

function evaluateDispatchJournalAdmission(
  journal: DispatchJournal,
  candidateRecord: DispatchJournalRecord,
  ceilingBytes = MECHANICAL_PERSISTED_STORE_CEILING_BYTES,
): { ok: true } | { ok: false; reason: string; backpressure?: boolean } {
  const deliveryId = trimString(candidateRecord.deliveryId);
  if (!deliveryId) return { ok: false, reason: 'invalid_delivery_id' };
  const pendingBytes = estimateSerializedUtf8Bytes({ ...journal, [deliveryId]: candidateRecord });
  const terminalBytes = estimateSerializedUtf8Bytes({
    ...journal,
    [deliveryId]: worstCaseDispatchJournalRecord(candidateRecord),
  });
  if (pendingBytes > ceilingBytes || terminalBytes > ceilingBytes) {
    return { ok: false, reason: 'over_capacity', backpressure: true };
  }
  return { ok: true };
}

export function classifyDeliveryPath(shape: {
  charLength?: number;
  lineCount?: number;
  multiline?: boolean;
}): NotificationMessageShape['deliveryPath'] {
  const charLength = Number(shape.charLength ?? 0);
  const lineCount = Number(shape.lineCount ?? 0);
  const multiline = Boolean(shape.multiline) || lineCount > 1;
  return multiline || charLength > AO_PASTE_CHAR_THRESHOLD
    ? DELIVERY_PATH_PENDING_DRAFT
    : DELIVERY_PATH_SELF_SUBMITTED;
}

/** Exact TypeScript port of the canonical deleted docs classifier. */
export function deriveMessageShape(message: string, senderSessionId = ''): NotificationMessageShape {
  const text = String(message ?? '');
  const prefix = senderSessionId ? `[from ${senderSessionId}] ` : '';
  const effective = prefix ? `${prefix}${text}` : text;
  const lineCount = effective.length === 0 ? 0 : effective.split('\n').length;
  return {
    charLength: effective.length,
    lineCount,
    multiline: lineCount > 1,
    deliveryPath: classifyDeliveryPath({
      charLength: effective.length,
      lineCount,
      multiline: lineCount > 1,
    }),
  };
}

/**
 * Exact bounded admission semantics ported from docs/worker-message-dispatch-observe.mjs
 * blob CANONICAL_DISPATCH_SOURCE_BLOB_SHA before that estate row is terminalized.
 */
export function admitDispatchJournalRecord(
  journal: DispatchJournal,
  record: DispatchJournalRecord,
  nowMs = Date.now(),
): CanonicalAdmitResult {
  let nextJournal = compactDispatchJournal(journal ?? {}, nowMs).journal;
  const pendingRecord = withPendingDispatchFence(record);
  const admission = evaluateDispatchJournalAdmission(nextJournal, pendingRecord);
  if (!admission.ok) {
    return {
      ok: false,
      reason: admission.reason,
      backpressure: Boolean(admission.backpressure),
      journal: nextJournal,
    };
  }
  const deliveryId = trimString(pendingRecord.deliveryId);
  nextJournal = { ...nextJournal, [deliveryId]: pendingRecord };
  return { ok: true, journal: nextJournal, record: pendingRecord };
}

/** Exact canonical finalization, fence transition, and terminal compaction semantics. */
export function finalizeDispatchJournalRecord(
  journal: DispatchJournal,
  deliveryId: string,
  dispatchOutcome: string,
  nowMs = Date.now(),
  draftState = '',
): CanonicalFinalizeResult {
  const nextJournal = { ...(journal ?? {}) };
  const key = trimString(deliveryId);
  const current = nextJournal[key];
  if (!key || !current || typeof current !== 'object' || Array.isArray(current)) {
    return { ok: false, reason: 'not_found', journal: nextJournal };
  }
  let record = advanceDispatchFenceLifecycle(current as Record<string, unknown>, dispatchOutcome);
  const resolvedDraftState = trimString(draftState);
  if (resolvedDraftState) record = { ...record, draftState: resolvedDraftState };
  nextJournal[key] = record;
  const compacted = compactDispatchJournal(nextJournal, nowMs);
  return { ok: true, journal: compacted.journal, record, evicted: !compacted.journal[key] };
}
