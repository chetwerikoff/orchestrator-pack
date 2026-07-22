import {
  AO_PASTE_CHAR_THRESHOLD,
  admitDispatchJournalRecord as canonicalAdmitDispatchJournalRecord,
  classifyDeliveryPath,
  DELIVERY_PATH_PENDING_DRAFT,
  DELIVERY_PATH_SELF_SUBMITTED,
  deriveMessageShape,
  DISPATCH_OUTCOME_DISPATCHED,
  DISPATCH_OUTCOME_IN_FLIGHT,
  DISPATCH_OUTCOME_SEND_FAILED,
  DISPATCH_OUTCOME_UNKNOWN,
  DRAFT_STATE_AUTO_SUBMITTED,
  DRAFT_STATE_DRAFT_PRESENT,
  finalizeDispatchJournalRecord as canonicalFinalizeDispatchJournalRecord,
} from './terminalized/worker-message-dispatch-observe.ts';

export {
  AO_PASTE_CHAR_THRESHOLD,
  classifyDeliveryPath,
  DELIVERY_PATH_PENDING_DRAFT,
  DELIVERY_PATH_SELF_SUBMITTED,
  deriveMessageShape,
  DISPATCH_OUTCOME_DISPATCHED,
  DISPATCH_OUTCOME_IN_FLIGHT,
  DISPATCH_OUTCOME_SEND_FAILED,
  DISPATCH_OUTCOME_UNKNOWN,
  DRAFT_STATE_AUTO_SUBMITTED,
  DRAFT_STATE_DRAFT_PRESENT,
};

export const CANONICAL_DISPATCH_SOURCE_BLOB_SHA = 'ffae6481d77e47b6bfded236a7f19b1d1fa5dfc5' as const;

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
  } as unknown as DispatchJournalRecord;
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

/** Typed facade over the terminalized canonical admission implementation. */
export function admitDispatchJournalRecord(
  journal: DispatchJournal,
  record: DispatchJournalRecord,
  nowMs = Date.now(),
): CanonicalAdmitResult {
  return canonicalAdmitDispatchJournalRecord(journal, record, nowMs) as CanonicalAdmitResult;
}

/** Typed facade over the terminalized canonical finalization implementation. */
export function finalizeDispatchJournalRecord(
  journal: DispatchJournal,
  deliveryId: string,
  dispatchOutcome: string,
  nowMs = Date.now(),
  draftState = '',
): CanonicalFinalizeResult {
  return canonicalFinalizeDispatchJournalRecord(
    journal,
    deliveryId,
    dispatchOutcome,
    nowMs,
    draftState,
  ) as CanonicalFinalizeResult;
}
