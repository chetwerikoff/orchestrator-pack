/**
 * AO-attributed worker message delivery observation (Issue #232).
 * Vitest: scripts/worker-message-submit-reconcile.test.ts
 *
 * Builds delivery records from AO events, pack dispatch journal, and review-run
 * state — never from pane text. Human keystrokes carry no AO dispatch record.
 */
import { readStdinJson, resolveBoundedInt, runStdinJsonCli } from './review-mechanical-cli.mjs';
import {
  advanceDispatchFenceLifecycle,
  compactDispatchJournal,
  evaluateDispatchJournalAdmission,
  interpretDispatchFenceLifecycle,
  withPendingDispatchFence,
} from './mechanical-reconcile-bounds.mjs';
import { isRuntimeFieldLive } from './session-runtime-liveness.mjs';
import { isLiveWorkerSession, normalizeSha, toArray } from './review-trigger-reconcile.mjs';
import {
  getEventTimestampMs,
  resolveEventSessionId,
} from './terminal-flood-detect.mjs';
import {
  getReportState,
  getReportTimestampMs,
  getReviewRunId,
  parseIsoMs,
  REVIEW_ROUND_REPORT_STATES,
} from './review-finding-delivery-confirm.mjs';
import { isDeliveredChangesRequested } from './review-producer-contract.mjs';


/** AO tmux paste path threshold (matches AO 0.9.2 sendMessage). */
export const AO_PASTE_CHAR_THRESHOLD = 200;

export const DELIVERY_PATH_PENDING_DRAFT = 'pending-draft';
export const DELIVERY_PATH_SELF_SUBMITTED = 'self-submitted';
export const DELIVERY_PATH_UNKNOWN = 'unknown';

export const DISPATCH_OUTCOME_DISPATCHED = 'dispatched';
export const DISPATCH_OUTCOME_SEND_FAILED = 'send_failed';
export const DISPATCH_OUTCOME_IN_FLIGHT = 'dispatch_in_flight';
export const DISPATCH_OUTCOME_UNKNOWN = 'dispatch_unknown';

export const DRAFT_STATE_DRAFT_PRESENT = 'draft_present';
export const DRAFT_STATE_AUTO_SUBMITTED = 'auto_submitted';
export const DRAFT_STATE_UNKNOWN = 'unknown';

export const DISPATCH_SOURCE_REACTION = 'reaction';
export const DISPATCH_SOURCE_PACK_SEND = 'pack-send';
export const DISPATCH_SOURCE_REVIEW_SEND = 'review-send';
export const DISPATCH_SOURCE_AO_SEND = 'ao-send';
export const DISPATCH_SOURCE_RESTORE_RETRY = 'restore-retry';

/**
 * @param {object} shape
 * @param {number} [shape.charLength]
 * @param {number} [shape.lineCount]
 * @param {boolean} [shape.multiline]
 */
export function classifyDeliveryPath(shape) {
  const charLength = Number(shape?.charLength ?? 0);
  const lineCount = Number(shape?.lineCount ?? 0);
  const multiline = Boolean(shape?.multiline) || lineCount > 1;
  if (multiline || charLength > AO_PASTE_CHAR_THRESHOLD) {
    return DELIVERY_PATH_PENDING_DRAFT;
  }
  return DELIVERY_PATH_SELF_SUBMITTED;
}

/**
 * @param {string} message
 * @param {string} [senderSessionId]
 */
export function deriveMessageShape(message, senderSessionId = '') {
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
 * @param {string} sessionId
 * @param {number} deliveredAtMs
 * @param {string} source
 * @param {string} [sourceKey]
 */
export function buildDeliveryId(sessionId, deliveredAtMs, source, sourceKey = '') {
  const sid = String(sessionId ?? '').trim();
  const src = String(source ?? '').trim();
  const key = String(sourceKey ?? '').trim();
  if (!sid || !deliveredAtMs || !src) {
    return null;
  }
  return `${sid}:${deliveredAtMs}:${src}${key ? `:${key}` : ''}`;
}

/**
 * @param {Record<string, unknown>} run
 */
export function resolveReviewSendObservedAtMs(run) {
  return parseIsoMs(run?.deliveredAt) ?? parseIsoMs(run?.updatedAt) ?? null;
}

/**
 * @param {string} sessionId
 * @param {string} runId
 * @param {number | null} [observedAtMs]
 */
export function buildReviewSendDeliveryId(sessionId, runId, observedAtMs = null) {
  const sid = String(sessionId ?? '').trim();
  const rid = String(runId ?? '').trim();
  if (!sid || !rid) {
    return null;
  }
  const ms = Number(observedAtMs ?? 0);
  if (ms > 0) {
    return buildDeliveryId(sid, ms, DISPATCH_SOURCE_REVIEW_SEND, rid);
  }
  return `${sid}:${DISPATCH_SOURCE_REVIEW_SEND}:${rid}`;
}

/**
 * @param {Record<string, unknown>} event
 */
export function isReactionSendSucceededEvent(event) {
  const kind = String(event?.kind ?? '');
  if (kind !== 'reaction.action_succeeded') {
    return false;
  }
  const data = event?.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false;
  }
  return String(data.action ?? '') === 'send-to-agent';
}

/**
 * @param {Array<Record<string, unknown>>} events
 * @param {Record<string, string>} [reactionMessages]
 */
export function extractReactionDeliveries(events, reactionMessages = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const deliveries = [];
  /** @type {Array<Record<string, unknown>>} */
  const audits = [];
  for (const event of toArray(events)) {
    if (!isReactionSendSucceededEvent(event)) {
      continue;
    }
    const sessionId = resolveEventSessionId(event);
    const deliveredAtMs = getEventTimestampMs(event);
    if (!sessionId || !deliveredAtMs) {
      continue;
    }
    const data = event.data;
    const reactionKey =
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? String(data.reactionKey ?? '').trim()
        : '';
    if (!reactionKey) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(reactionMessages, reactionKey)) {
      audits.push({
        reason: 'reaction_message_unresolved',
        reactionKey,
        sessionId,
        deliveredAtMs,
      });
      continue;
    }
    const message = String(reactionMessages[reactionKey] ?? '').trim();
    if (!message) {
      audits.push({
        reason: 'reaction_message_unresolved',
        reactionKey,
        sessionId,
        deliveredAtMs,
      });
      continue;
    }
    const shape = deriveMessageShape(message);
    const deliveryId = buildDeliveryId(
      sessionId,
      deliveredAtMs,
      DISPATCH_SOURCE_REACTION,
      reactionKey || 'send',
    );
    if (!deliveryId) {
      continue;
    }
    deliveries.push({
      deliveryId,
      sessionId,
      deliveredAtMs,
      source: DISPATCH_SOURCE_REACTION,
      sourceKey: reactionKey,
      deliveryPath: shape.deliveryPath,
      messageShape: {
        charLength: shape.charLength,
        lineCount: shape.lineCount,
      },
    });
  }
  return { deliveries, audits };
}

/**
 * @param {Record<string, Record<string, unknown>>} journal
 */
export function extractJournalDeliveries(journal) {
  /** @type {Array<Record<string, unknown>>} */
  const deliveries = [];
  const recovery = journal?._recovery;
  if (recovery && recovery.fenceTrusted === false) {
    deliveries.push({
      deliveryId: `corrupt-dispatch-journal:${String(recovery.quarantined ?? 'unknown')}`,
      sessionId: 'operator',
      deliveredAtMs: Number(Date.now()),
      source: 'dispatch-journal',
      deliveryPath: DELIVERY_PATH_UNKNOWN,
      dispatchOutcome: DISPATCH_OUTCOME_UNKNOWN,
      draftState: DRAFT_STATE_UNKNOWN,
      corruptObservation: true,
      corruptionReason: String(recovery.reason ?? 'corrupt_dispatch_journal'),
    });
    return deliveries;
  }
  for (const [deliveryId, record] of Object.entries(journal ?? {})) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    if (record.adoptionProbe) {
      continue;
    }
    const sessionId = String(record.sessionId ?? '').trim();
    const deliveredAtMs = Number(record.deliveredAtMs ?? 0);
    const deliveryPath = String(record.deliveryPath ?? '').trim();
    if (!sessionId || !deliveredAtMs || !deliveryId) {
      continue;
    }
    deliveries.push({
      deliveryId,
      sessionId,
      deliveredAtMs,
      source: String(record.source ?? DISPATCH_SOURCE_PACK_SEND),
      sourceKey: String(record.sourceKey ?? ''),
      deliveryPath: deliveryPath || DELIVERY_PATH_PENDING_DRAFT,
      messageShape: record.messageShape ?? {},
      dispatchOutcome: String(record.dispatchOutcome ?? DISPATCH_OUTCOME_DISPATCHED),
      draftState: String(record.draftState ?? (deliveryPath === DELIVERY_PATH_SELF_SUBMITTED ? DRAFT_STATE_AUTO_SUBMITTED : DRAFT_STATE_DRAFT_PRESENT)),
      restoreRetry: Boolean(record.restoreRetry),
      ...(record.corruptObservation ? { corruptObservation: true } : {}),
      ...(record.corruptionReason ? { corruptionReason: String(record.corruptionReason) } : {}),
      ...(record.backendKey ? { backendKey: String(record.backendKey).trim() } : {}),
      ...(record.dispatchSignature
        ? { dispatchSignature: String(record.dispatchSignature).trim() }
        : {}),
      ...(record.runtimeFingerprint
        ? { runtimeFingerprint: String(record.runtimeFingerprint).trim() }
        : {}),
      ...(record.tmuxFingerprint
        ? { tmuxFingerprint: String(record.tmuxFingerprint).trim() }
        : {}),
      ...(typeof record.busyDispatchAllowed === 'boolean'
        ? { busyDispatchAllowed: Boolean(record.busyDispatchAllowed) }
        : {}),
      ...(record.draftIdentity ? { draftIdentity: String(record.draftIdentity).trim() } : {}),
      ...(record.draftIdentityStatus
        ? { draftIdentityStatus: String(record.draftIdentityStatus).trim() }
        : {}),
      ...(record.draftIdentityUnprovable ? { draftIdentityUnprovable: true } : {}),
      ...(record.draftFreshness ? { draftFreshness: String(record.draftFreshness).trim() } : {}),
      ...(typeof record.drainSettled === 'boolean'
        ? { drainSettled: Boolean(record.drainSettled) }
        : {}),
      ...(record.observability ? { observability: String(record.observability).trim() } : {}),
      ...(record.reviewRunId ? { reviewRunId: String(record.reviewRunId).trim() } : {}),
      ...(Number(record.prNumber ?? 0) > 0 ? { prNumber: Number(record.prNumber) } : {}),
      ...(record.headSha ? { headSha: String(record.headSha).trim() } : {}),
      ...(Number(record.deliverySequence ?? 0) > 0
        ? { deliverySequence: Number(record.deliverySequence) }
        : {}),
      ...(record.consumptionObserved === true ? { consumptionObserved: true } : {}),
      ...(record.consumedAfterFlushObserved === true ||
      record.consumed_after_flush_observed === true
        ? { consumedAfterFlushObserved: true }
        : {}),
      ...(trimObservationString(record.consumptionEvidence)
        ? { consumptionEvidence: trimObservationString(record.consumptionEvidence) }
        : record.consumed_after_flush_observed === true
          ? { consumptionEvidence: 'consumed_after_flush_observed' }
          : {}),
    });
  }
  return deliveries;
}

/**
 * @param {Array<Record<string, unknown>>} reviewRuns
 * @param {number} nowMs
 */
export function extractReviewFindingDeliveries(reviewRuns, nowMs) {
  /** @type {Array<Record<string, unknown>>} */
  const deliveries = [];
  for (const run of toArray(reviewRuns)) {
    const deliveredCount = Number(run?.deliveredFindingCount ?? 0);
    if (deliveredCount <= 0) {
      continue;
    }
    if (!isDeliveredChangesRequested(run)) {
      continue;
    }
    const runId = getReviewRunId(run);
    const sessionId = String(run?.linkedSessionId ?? '').trim();
    if (!runId || !sessionId) {
      continue;
    }
    const observedAtMs = resolveReviewSendObservedAtMs(run);
    const deliveryId = buildReviewSendDeliveryId(sessionId, runId, observedAtMs);
    if (!deliveryId) {
      continue;
    }
    deliveries.push({
      deliveryId,
      sessionId,
      deliveredAtMs: observedAtMs ?? 0,
      source: DISPATCH_SOURCE_REVIEW_SEND,
      sourceKey: runId,
      deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
      messageShape: { charLength: 500, lineCount: 10 },
      prNumber: Number(run?.prNumber ?? 0),
      headSha: normalizeSha(run?.targetSha),
    });
  }
  return deliveries;
}

/**
 * @param {Array<Record<string, unknown>>} journalDeliveries
 */
function journalReviewSendDeliveredAtBySourceKey(journalDeliveries) {
  /** @type {Map<string, number>} */
  const byKey = new Map();
  for (const row of journalDeliveries) {
    if (String(row.source ?? '') !== DISPATCH_SOURCE_REVIEW_SEND) {
      continue;
    }
    const key = String(row.sourceKey ?? '').trim();
    const deliveredAtMs = Number(row.deliveredAtMs ?? 0);
    if (!key || !deliveredAtMs) {
      continue;
    }
    const prior = byKey.get(key) ?? 0;
    if (deliveredAtMs > prior) {
      byKey.set(key, deliveredAtMs);
    }
  }
  return byKey;
}

/**
 * @param {object} input
 */
export function mergeDeliveryRecords(input) {
  const {
    aoEvents,
    dispatchJournal,
    reviewRuns,
    reactionMessages,
    nowMs,
  } = input;
  const journalDeliveries = extractJournalDeliveries(dispatchJournal ?? {});
  const journalReviewSendAt = journalReviewSendDeliveredAtBySourceKey(journalDeliveries);
  const reviewRunDeliveries = extractReviewFindingDeliveries(
    toArray(reviewRuns),
    nowMs,
  ).filter((row) => {
    const key = String(row.sourceKey ?? '').trim();
    if (!key) {
      return true;
    }
    const journalAt = journalReviewSendAt.get(key);
    if (!journalAt) {
      return true;
    }
    const runAt = Number(row.deliveredAtMs ?? 0);
    return runAt > journalAt;
  });
  const reactionObservation = extractReactionDeliveries(
    toArray(aoEvents),
    reactionMessages ?? {},
  );
  const byId = new Map();
  for (const row of [
    ...journalDeliveries,
    ...reactionObservation.deliveries,
    ...reviewRunDeliveries,
  ]) {
    const id = String(row.deliveryId ?? '');
    if (!id) {
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, row);
    }
  }
  return [...byId.values()].sort(
    (a, b) => Number(a.deliveredAtMs) - Number(b.deliveredAtMs),
  );
}

/**
 * @param {object} input
 */
export function observeReactionDeliveries(input) {
  const deliveries = mergeDeliveryRecords(input);
  const reactionObservation = extractReactionDeliveries(
    toArray(input.aoEvents),
    input.reactionMessages ?? {},
  );
  return {
    deliveries,
    reactionAudits: reactionObservation.audits,
  };
}

/**
 * @param {Record<string, unknown>} session
 */
export function getSessionActivity(session) {
  return String(session?.activity ?? '').trim().toLowerCase();
}

function trimObservationString(value) {
  return String(value ?? '').trim();
}

function reportCorrelatesToDelivery(report, deliveryId) {
  const note = String(report?.note ?? '');
  return Boolean(deliveryId) && note.includes(deliveryId);
}

/**
 * Positive, per-delivery consumption evidence (Issue #602).
 * Submitted/busy-unknown/absent draft/generic progress alone are not receipt.
 *
 * @param {Record<string, unknown>} session
 * @param {Record<string, unknown>} delivery
 * @param {number} deliveredAtMs
 * @param {Record<string, unknown>} [record]
 */
export function hasPositiveConsumptionEvidence(session, delivery, deliveredAtMs, record = {}) {
  const deliveryId = trimObservationString(delivery?.deliveryId);
  const draftState = trimObservationString(delivery?.draftState);

  if (delivery?.corruptObservation) {
    return false;
  }
  if (
    draftState === 'absent' ||
    draftState === 'changed' ||
    draftState === DRAFT_STATE_UNKNOWN
  ) {
    return false;
  }

  if (
    delivery?.consumptionObserved === true ||
    delivery?.consumedAfterFlushObserved === true ||
    trimObservationString(delivery?.consumptionEvidence) === 'consumed_after_flush_observed'
  ) {
    return true;
  }

  if (delivery?.ambiguousSessionInflight) {
    const reports = toArray(session?.reports);
    return reports.some((report) => {
      const ts = getReportTimestampMs(report);
      return ts && ts > deliveredAtMs && reportCorrelatesToDelivery(report, deliveryId);
    });
  }

  const reports = toArray(session?.reports);
  for (const report of reports) {
    const ts = getReportTimestampMs(report);
    if (!ts || ts <= deliveredAtMs) {
      continue;
    }
    const state = getReportState(report);
    if (
      delivery.source === DISPATCH_SOURCE_REVIEW_SEND &&
      REVIEW_ROUND_REPORT_STATES.has(state)
    ) {
      return true;
    }
    if (delivery.source !== DISPATCH_SOURCE_REVIEW_SEND) {
      if (reportCorrelatesToDelivery(report, deliveryId)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {Record<string, unknown>} session
 * @param {Record<string, unknown>} delivery
 * @param {number} deliveredAtMs
 * @param {Record<string, unknown>} [record]
 */
export function isDeliveryConsumed(session, delivery, deliveredAtMs, record = {}) {
  return hasPositiveConsumptionEvidence(session, delivery, deliveredAtMs, record);
}

/**
 * @param {Record<string, unknown>} session
 */
export function isSessionStreaming(session) {
  return getSessionActivity(session) === 'active';
}

/**
 * @param {Record<string, unknown>} session
 */
export function isSessionAlive(session) {
  if (!isRuntimeFieldLive(session)) {
    return false;
  }
  return isLiveWorkerSession(session);
}

/**
 * @param {Array<Record<string, unknown>>} deliveries
 * @param {string} sessionId
 */
function getSessionDeliveriesNewestFirst(deliveries, sessionId) {
  const needle = String(sessionId ?? '').trim();
  return toArray(deliveries)
    .filter((d) => String(d.sessionId) === needle)
    .sort((a, b) => Number(b.deliveredAtMs) - Number(a.deliveredAtMs));
}

/**
 * @param {Array<Record<string, unknown>>} deliveries
 * @param {string} sessionId
 */
function isDispatchedDelivery(delivery) {
  return String(delivery?.dispatchOutcome ?? DISPATCH_OUTCOME_DISPATCHED) === DISPATCH_OUTCOME_DISPATCHED;
}

export function selectSurvivingDelivery(deliveries, sessionId) {
  const forSession = getSessionDeliveriesNewestFirst(deliveries, sessionId);
  const latestPendingDraft = forSession.find(
    (d) => String(d.deliveryPath) === DELIVERY_PATH_PENDING_DRAFT,
  );
  const latestPendingOutcome = String(
    latestPendingDraft?.dispatchOutcome ?? DISPATCH_OUTCOME_DISPATCHED,
  );
  if (
    latestPendingOutcome === DISPATCH_OUTCOME_IN_FLIGHT ||
    latestPendingOutcome === DISPATCH_OUTCOME_UNKNOWN
  ) {
    return null;
  }

  const effectiveForSession = forSession.filter(isDispatchedDelivery);
  if (effectiveForSession.length === 0) {
    return null;
  }
  const latestEffective = effectiveForSession[0];
  if (String(latestEffective.deliveryPath) !== DELIVERY_PATH_PENDING_DRAFT) {
    return null;
  }
  return latestEffective;
}

/**
 * @param {Array<Record<string, unknown>>} deliveries
 * @param {string} sessionId
 */
export function findOverwrittenDeliveries(deliveries, sessionId) {
  const effectiveForSession = getSessionDeliveriesNewestFirst(deliveries, sessionId).filter(isDispatchedDelivery);
  if (effectiveForSession.length <= 1) {
    return [];
  }
  const latestEffectiveId = String(effectiveForSession[0]?.deliveryId ?? '');
  return effectiveForSession.filter((d) => {
    if (String(d.deliveryPath) !== DELIVERY_PATH_PENDING_DRAFT) {
      return false;
    }
    return String(d.deliveryId) !== latestEffectiveId;
  });
}


/**
 * @param {Record<string, unknown>} journal
 * @param {Record<string, unknown>} record
 * @param {number} [nowMs]
 */
export function admitDispatchJournalRecord(journal, record, nowMs = Date.now()) {
  let nextJournal = { ...(journal ?? {}) };
  const compacted = compactDispatchJournal(nextJournal, nowMs);
  nextJournal = compacted.journal;
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
  const deliveryId = String(pendingRecord.deliveryId ?? '');
  nextJournal[deliveryId] = pendingRecord;
  return { ok: true, journal: nextJournal, record: pendingRecord };
}

/**
 * @param {Record<string, unknown>} journal
 * @param {string} deliveryId
 * @param {string} dispatchOutcome
 * @param {number} [nowMs]
 */
export function finalizeDispatchJournalRecord(
  journal,
  deliveryId,
  dispatchOutcome,
  nowMs = Date.now(),
  draftState = '',
) {
  const nextJournal = { ...(journal ?? {}) };
  const key = String(deliveryId ?? '').trim();
  if (!key || !nextJournal[key]) {
    return { ok: false, reason: 'not_found', journal: nextJournal };
  }
  let record = advanceDispatchFenceLifecycle(nextJournal[key], dispatchOutcome);
  const resolvedDraftState = String(draftState ?? '').trim();
  if (resolvedDraftState) {
    record = { ...record, draftState: resolvedDraftState };
  }
  nextJournal[key] = record;
  const compacted = compactDispatchJournal(nextJournal, nowMs);
  return { ok: true, journal: compacted.journal, record, evicted: !compacted.journal[key] };
}

export { interpretDispatchFenceLifecycle };

runStdinJsonCli('worker-message-dispatch-observe.mjs', {
  merge() {
    const payload = readStdinJson();
    return mergeDeliveryRecords(payload);
  },
  observe() {
    const payload = readStdinJson();
    return observeReactionDeliveries(payload);
  },
  classify() {
    const payload = readStdinJson();
    return deriveMessageShape(payload.message, payload.senderSessionId);
  },
  'journal-admit'() {
    const payload = readStdinJson();
    return admitDispatchJournalRecord(
      payload.journal ?? {},
      payload.record ?? {},
      Number(payload.nowMs ?? Date.now()),
    );
  },
  'journal-finalize'() {
    const payload = readStdinJson();
    return finalizeDispatchJournalRecord(
      payload.journal ?? {},
      String(payload.deliveryId ?? ''),
      String(payload.dispatchOutcome ?? ''),
      Number(payload.nowMs ?? Date.now()),
      String(payload.draftState ?? ''),
    );
  },
  'journal-compact'() {
    const payload = readStdinJson();
    const compacted = compactDispatchJournal(payload.journal ?? {}, Number(payload.nowMs ?? Date.now()));
    return { journal: compacted.journal, evicted: compacted.evicted };
  },
});
