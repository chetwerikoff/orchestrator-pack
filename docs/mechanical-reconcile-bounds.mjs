/**
 * Shared reconcile transport envelope + bounded-state helpers (Issue #339).
 * Vitest: scripts/mechanical-reconcile-bounds.test.ts
 */
import { createHash } from 'node:crypto';

/** Observed OS pipe/stdout buffer wedge boundary (incident position 65536). */
export const MECHANICAL_PIPE_BUFFER_BYTES = 65_536;

/** Maximum serialised parent↔child round-trip payload (bytes, UTF-8). */
export const MECHANICAL_TRANSPORT_ENVELOPE_BYTES = 2 * 1024 * 1024;

/** Persisted state ceiling with headroom below the transport envelope. */
export const MECHANICAL_STORAGE_CEILING_BYTES = Math.floor(
  MECHANICAL_TRANSPORT_ENVELOPE_BYTES * 0.65,
);

/** Worst-case encoding/transform expansion factor for ceiling↔envelope checks. */
export const MECHANICAL_ENCODING_EXPANSION_FACTOR = 1.35;

export const FENCE_LIFECYCLE_PENDING = 'pending';
export const FENCE_LIFECYCLE_COMPLETED = 'completed';
export const FENCE_LIFECYCLE_FAILED_UNCERTAIN = 'failed-uncertain';

export const DISPATCH_OUTCOME_IN_FLIGHT = 'dispatch_in_flight';
export const DISPATCH_OUTCOME_DISPATCHED = 'dispatched';
export const DISPATCH_OUTCOME_SEND_FAILED = 'send_failed';
export const DISPATCH_OUTCOME_UNKNOWN = 'dispatch_unknown';

export const SUBMIT_STATE_SUBMITTED = 'submitted';
export const SUBMIT_STATE_ESCALATED = 'escalated';

export const FAILED_DELIVERY_UNRESOLVED = 'unresolved';
export const FAILED_DELIVERY_RESOLVED = 'resolved';
export const FAILED_DELIVERY_AUDITED_CLOSED = 'audited_closed';

/** Terminal delivery retention after which dedupe/retry fences are provably stale. */
export const SUBMIT_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Dispatch journal terminal retention (matches submit horizon). */
export const DISPATCH_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Audit ring size (existing behaviour, explicit for reservation accounting). */
export const MECHANICAL_AUDIT_RETAIN = 200;

const RESERVED_META_KEYS = new Set(['_recovery', '_bounds', '_compaction']);

function trimString(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 */
export function estimateSerializedUtf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

/**
 * @param {number} storageBytes
 */
export function maxChildOutputBytesForStorage(storageBytes) {
  return Math.floor(storageBytes * MECHANICAL_ENCODING_EXPANSION_FACTOR);
}

/**
 * @param {number} childOutputBytes
 */
export function storageBytesWithinTransportEnvelope(childOutputBytes) {
  return childOutputBytes <= MECHANICAL_TRANSPORT_ENVELOPE_BYTES;
}

/**
 * Legacy / version-skew-safe fence lifecycle interpretation.
 * @param {Record<string, unknown> | null | undefined} record
 */
export function interpretDispatchFenceLifecycle(record) {
  const explicit = trimString(record?.fenceLifecycle);
  if (explicit === FENCE_LIFECYCLE_PENDING) return FENCE_LIFECYCLE_PENDING;
  if (explicit === FENCE_LIFECYCLE_FAILED_UNCERTAIN) return FENCE_LIFECYCLE_FAILED_UNCERTAIN;
  if (explicit === FENCE_LIFECYCLE_COMPLETED) return FENCE_LIFECYCLE_COMPLETED;

  const outcome = trimString(record?.dispatchOutcome);
  if (
    outcome === DISPATCH_OUTCOME_IN_FLIGHT ||
    outcome === DISPATCH_OUTCOME_UNKNOWN ||
    (outcome === DISPATCH_OUTCOME_DISPATCHED && trimString(record?.draftState) === 'unknown')
  ) {
    return FENCE_LIFECYCLE_PENDING;
  }
  return FENCE_LIFECYCLE_COMPLETED;
}

/**
 * @param {Record<string, unknown> | null | undefined} record
 */
export function interpretSubmitTrackingLifecycle(record) {
  const explicit = trimString(record?.fenceLifecycle);
  if (explicit) return explicit;
  const terminal = trimString(record?.terminalState);
  if (terminal === SUBMIT_STATE_SUBMITTED) return FENCE_LIFECYCLE_COMPLETED;
  if (terminal === SUBMIT_STATE_ESCALATED) {
    const failed = record?.failedDelivery;
    const unresolved = trimString(failed?.unresolvedState) === FAILED_DELIVERY_UNRESOLVED;
    return unresolved ? FENCE_LIFECYCLE_FAILED_UNCERTAIN : FENCE_LIFECYCLE_COMPLETED;
  }
  if (record?.claimed || record?.provisionalClaimKey) return FENCE_LIFECYCLE_PENDING;
  return FENCE_LIFECYCLE_PENDING;
}

/**
 * @param {Record<string, unknown>} record
 * @param {number} nowMs
 */
export function isSubmitDeliveryEvictable(record, nowMs) {
  const deliveryId = trimString(record?.deliveryId);
  if (!deliveryId) return false;

  const lifecycle = interpretSubmitTrackingLifecycle(record);
  if (lifecycle === FENCE_LIFECYCLE_PENDING) return false;

  const terminal = trimString(record?.terminalState);
  if (!terminal) return false;

  if (terminal === SUBMIT_STATE_ESCALATED) {
    const failed = record?.failedDelivery;
    if (trimString(failed?.unresolvedState) === FAILED_DELIVERY_UNRESOLVED) return false;
  }

  if (record?.claimed || record?.provisionalClaimKey || record?.provisionalClaimSinceMs) {
    return false;
  }

  const anchorMs = Math.max(
    Number(record?.consumedAtMs ?? 0),
    Number(record?.escalatedAtMs ?? 0),
    Number(record?.lastSubmitAtMs ?? 0),
    Number(record?.firstObservedAtMs ?? 0),
  );
  if (!anchorMs || nowMs - anchorMs < SUBMIT_DELIVERY_RETENTION_MS) return false;
  return true;
}

/**
 * @param {Record<string, unknown>} record
 * @param {number} nowMs
 */
export function isFailedDeliveryEvictable(record, nowMs) {
  const unresolved = trimString(record?.unresolvedState);
  if (unresolved === FAILED_DELIVERY_UNRESOLVED) {
    return false;
  }
  const resolvedAt = Number(record?.resolvedAtMs ?? record?.lastFailedAtMs ?? 0);
  if (!resolvedAt || nowMs - resolvedAt < SUBMIT_DELIVERY_RETENTION_MS) return false;
  return true;
}

/**
 * @param {Record<string, unknown>} record
 * @param {number} nowMs
 */
export function isDispatchJournalEntryEvictable(record, nowMs) {
  const deliveryId = trimString(record?.deliveryId ?? record?.id);
  if (!deliveryId || deliveryId.startsWith('_')) return false;
  if (record?.adoptionProbe === true) return false;
  if (trimString(record?.source) === 'adoption-probe') return false;

  const lifecycle = interpretDispatchFenceLifecycle(record);
  if (lifecycle === FENCE_LIFECYCLE_PENDING) return false;
  if (lifecycle === FENCE_LIFECYCLE_FAILED_UNCERTAIN) return false;

  const deliveredAt = Number(record?.deliveredAtMs ?? 0);
  if (!deliveredAt || nowMs - deliveredAt < DISPATCH_JOURNAL_RETENTION_MS) return false;

  const outcome = trimString(record?.dispatchOutcome);
  if (outcome === DISPATCH_OUTCOME_IN_FLIGHT || outcome === DISPATCH_OUTCOME_UNKNOWN) {
    return false;
  }
  return true;
}

/**
 * @param {Record<string, Record<string, unknown>>} map
 * @param {(record: Record<string, unknown>, nowMs: number) => boolean} predicate
 * @param {number} nowMs
 */
export function pruneMapByPredicate(map, predicate, nowMs) {
  const next = { ...(map ?? {}) };
  /** @type {string[]} */
  const evicted = [];
  for (const [key, record] of Object.entries(next)) {
    if (RESERVED_META_KEYS.has(key)) continue;
    if (predicate(record ?? {}, nowMs)) {
      delete next[key];
      evicted.push(key);
    }
  }
  return { map: next, evicted };
}

/**
 * @param {Record<string, unknown>} tracking
 * @param {number} nowMs
 */
export function compactWorkerMessageSubmitTracking(tracking, nowMs) {
  const deliveries = { ...(tracking?.deliveries ?? {}) };
  const failedDeliveries = { ...(tracking?.failedDeliveries ?? {}) };

  const deliveryPrune = pruneMapByPredicate(deliveries, isSubmitDeliveryEvictable, nowMs);
  const failedPrune = pruneMapByPredicate(
    failedDeliveries,
    isFailedDeliveryEvictable,
    nowMs,
  );

  const audit = Array.isArray(tracking?.audit) ? tracking.audit.slice(-MECHANICAL_AUDIT_RETAIN) : [];

  return {
    tracking: {
      ...tracking,
      deliveries: deliveryPrune.map,
      failedDeliveries: failedPrune.map,
      audit,
      lastTickMs: tracking?.lastTickMs ?? null,
    },
    evicted: [...deliveryPrune.evicted, ...failedPrune.evicted],
  };
}

/**
 * @param {Record<string, unknown>} journal
 * @param {number} nowMs
 */
export function compactDispatchJournal(journal, nowMs) {
  const next = { ...(journal ?? {}) };
  /** @type {string[]} */
  const evicted = [];
  for (const [key, record] of Object.entries(next)) {
    if (RESERVED_META_KEYS.has(key)) continue;
    if (isDispatchJournalEntryEvictable(record ?? {}, nowMs)) {
      delete next[key];
      evicted.push(key);
    }
  }
  return { journal: next, evicted };
}

/**
 * @param {Record<string, unknown>} journal
 * @param {Record<string, unknown>} candidateRecord
 */
export function worstCaseDispatchJournalRecord(record) {
  return {
    ...record,
    fenceLifecycle: FENCE_LIFECYCLE_COMPLETED,
    dispatchOutcome: DISPATCH_OUTCOME_DISPATCHED,
    draftState: 'draft_present',
    messageShape: { charLength: 4096, lineCount: 64 },
    auditNote: 'x'.repeat(512),
  };
}

/**
 * @param {Record<string, unknown>} journal
 * @param {Record<string, unknown>} candidateRecord
 * @param {number} [ceilingBytes]
 */
export function evaluateDispatchJournalAdmission(journal, candidateRecord, ceilingBytes = MECHANICAL_STORAGE_CEILING_BYTES) {
  const baseJournal = { ...(journal ?? {}) };
  const currentBytes = estimateSerializedUtf8Bytes(baseJournal);
  const deliveryId = trimString(candidateRecord?.deliveryId);
  if (!deliveryId) {
    return {
      ok: false,
      reason: 'invalid_delivery_id',
      currentBytes,
      ceilingBytes,
    };
  }

  const pendingJournal = { ...baseJournal, [deliveryId]: candidateRecord };
  const pendingJournalBytes = estimateSerializedUtf8Bytes(pendingJournal);
  const terminalJournal = {
    ...baseJournal,
    [deliveryId]: worstCaseDispatchJournalRecord(candidateRecord),
  };
  const terminalJournalBytes = estimateSerializedUtf8Bytes(terminalJournal);

  if (pendingJournalBytes > ceilingBytes || terminalJournalBytes > ceilingBytes) {
    return {
      ok: false,
      reason: 'over_capacity',
      backpressure: true,
      currentBytes,
      admittedBytes: pendingJournalBytes,
      terminalJournalBytes,
      ceilingBytes,
    };
  }

  return {
    ok: true,
    currentBytes,
    admittedBytes: pendingJournalBytes,
    terminalJournalBytes,
    ceilingBytes,
  };
}

/**
 * @param {Record<string, unknown>} tracking
 * @param {number} [ceilingBytes]
 */
export function evaluateSubmitTrackingCapacity(tracking, ceilingBytes = MECHANICAL_STORAGE_CEILING_BYTES) {
  const bytes = estimateSerializedUtf8Bytes(tracking ?? {});
  return {
    ok: bytes <= ceilingBytes,
    bytes,
    ceilingBytes,
    overCapacity: bytes > ceilingBytes,
  };
}

/**
 * Converge oversized-but-compactable tracking/journal on cold start.
 * @param {object} input
 * @param {Record<string, unknown>} input.tracking
 * @param {Record<string, unknown>} [input.journal]
 * @param {number} input.nowMs
 */
export function convergeOversizedReconcileState(input) {
  const { tracking, journal, nowMs } = input;
  let nextTracking = { ...(tracking ?? {}) };
  let nextJournal = journal ? { ...journal } : null;
  /** @type {string[]} */
  const evicted = [];

  let capacity = evaluateSubmitTrackingCapacity(nextTracking);
  if (capacity.overCapacity) {
    const compacted = compactWorkerMessageSubmitTracking(nextTracking, nowMs);
    nextTracking = compacted.tracking;
    evicted.push(...compacted.evicted);
    capacity = evaluateSubmitTrackingCapacity(nextTracking);
  }

  if (nextJournal) {
    let journalBytes = estimateSerializedUtf8Bytes(nextJournal);
    if (journalBytes > MECHANICAL_STORAGE_CEILING_BYTES) {
      const compactedJournal = compactDispatchJournal(nextJournal, nowMs);
      nextJournal = compactedJournal.journal;
      evicted.push(...compactedJournal.evicted);
      journalBytes = estimateSerializedUtf8Bytes(nextJournal);
    }
    if (journalBytes > MECHANICAL_STORAGE_CEILING_BYTES) {
      return {
        ok: false,
        reason: 'journal_over_capacity_non_evictable',
        tracking: nextTracking,
        journal: nextJournal,
        evicted,
        overCapacity: true,
      };
    }
  }

  if (capacity.overCapacity) {
    return {
      ok: false,
      reason: 'tracking_over_capacity_non_evictable',
      tracking: nextTracking,
      journal: nextJournal,
      evicted,
      overCapacity: true,
    };
  }

  return {
    ok: true,
    tracking: nextTracking,
    journal: nextJournal,
    evicted,
    overCapacity: false,
  };
}

/**
 * @param {string} text
 */
export function parseCompleteJsonText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    throw new Error('empty_child_output');
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`malformed_child_output:${message}`);
  }
}

/**
 * @param {string} text
 * @param {number} [envelopeBytes]
 */
export function assertTransportEnvelope(text, envelopeBytes = MECHANICAL_TRANSPORT_ENVELOPE_BYTES) {
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8');
  if (bytes > envelopeBytes) {
    throw new Error(`transport_envelope_exceeded:${bytes}>${envelopeBytes}`);
  }
  return bytes;
}

/**
 * @param {Record<string, unknown>} record
 */
export function withPendingDispatchFence(record) {
  return {
    ...record,
    fenceLifecycle: FENCE_LIFECYCLE_PENDING,
  };
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} dispatchOutcome
 */
export function advanceDispatchFenceLifecycle(record, dispatchOutcome) {
  const outcome = trimString(dispatchOutcome);
  if (outcome === DISPATCH_OUTCOME_SEND_FAILED || outcome === DISPATCH_OUTCOME_UNKNOWN) {
    return { ...record, fenceLifecycle: FENCE_LIFECYCLE_FAILED_UNCERTAIN, dispatchOutcome: outcome };
  }
  return { ...record, fenceLifecycle: FENCE_LIFECYCLE_COMPLETED, dispatchOutcome: outcome };
}

/**
 * @param {Record<string, unknown>} payload
 */
export function stableTransportFingerprint(payload) {
  return createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex');
}
