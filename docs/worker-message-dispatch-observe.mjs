/**
 * AO-attributed worker message delivery observation (Issue #232).
 * Vitest: scripts/worker-message-submit-reconcile.test.ts
 *
 * Builds delivery records from AO events, pack dispatch journal, and review-run
 * state — never from pane text. Human keystrokes carry no AO dispatch record.
 */
import { readStdinJson, resolveBoundedInt, runStdinJsonCli } from './review-mechanical-cli.mjs';
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

/** AO tmux paste path threshold (matches AO 0.9.2 sendMessage). */
export const AO_PASTE_CHAR_THRESHOLD = 200;

export const DELIVERY_PATH_PENDING_DRAFT = 'pending-draft';
export const DELIVERY_PATH_SELF_SUBMITTED = 'self-submitted';

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
  return parseIsoMs(run?.sentAt) ?? parseIsoMs(run?.updatedAt) ?? null;
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
    if (!Object.prototype.hasOwnProperty.call(reactionMessages, reactionKey)) {
      continue;
    }
    const message = reactionMessages[reactionKey];
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
  return deliveries;
}

/**
 * @param {Record<string, Record<string, unknown>>} journal
 */
export function extractJournalDeliveries(journal) {
  /** @type {Array<Record<string, unknown>>} */
  const deliveries = [];
  for (const [deliveryId, record] of Object.entries(journal ?? {})) {
    if (!record || typeof record !== 'object') {
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
      restoreRetry: Boolean(record.restoreRetry),
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
    const sentCount = Number(run?.sentFindingCount ?? 0);
    if (sentCount <= 0) {
      continue;
    }
    const status = String(run?.status ?? '').trim();
    if (!['waiting_update', 'sent_to_agent'].includes(status)) {
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
  const byId = new Map();
  for (const row of [
    ...journalDeliveries,
    ...extractReactionDeliveries(toArray(aoEvents), reactionMessages ?? {}),
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
 * @param {Record<string, unknown>} session
 */
export function getSessionActivity(session) {
  return String(session?.activity ?? '').trim().toLowerCase();
}

/**
 * @param {Record<string, unknown>} session
 * @param {Record<string, unknown>} delivery
 * @param {number} deliveredAtMs
 */
export function isDeliveryConsumed(session, delivery, deliveredAtMs) {
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
    if (
      ['working', 'fixing_ci', 'ready_for_review', 'addressing_reviews', 'completed'].includes(
        state,
      ) &&
      delivery.source !== DISPATCH_SOURCE_REVIEW_SEND
    ) {
      const note = String(report?.note ?? '');
      if (note.length > 0 || state !== 'working') {
        return true;
      }
    }
  }
  return false;
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
export function selectSurvivingDelivery(deliveries, sessionId) {
  const forSession = getSessionDeliveriesNewestFirst(deliveries, sessionId);
  if (forSession.length === 0) {
    return null;
  }
  const latest = forSession[0];
  if (String(latest.deliveryPath) !== DELIVERY_PATH_PENDING_DRAFT) {
    return null;
  }
  return latest;
}

/**
 * @param {Array<Record<string, unknown>>} deliveries
 * @param {string} sessionId
 */
export function findOverwrittenDeliveries(deliveries, sessionId) {
  const forSession = getSessionDeliveriesNewestFirst(deliveries, sessionId);
  if (forSession.length <= 1) {
    return [];
  }
  const latestId = String(forSession[0]?.deliveryId ?? '');
  return forSession.filter((d) => {
    if (String(d.deliveryPath) !== DELIVERY_PATH_PENDING_DRAFT) {
      return false;
    }
    return String(d.deliveryId) !== latestId;
  });
}

runStdinJsonCli('worker-message-dispatch-observe.mjs', {
  merge() {
    const payload = readStdinJson();
    return mergeDeliveryRecords(payload);
  },
  classify() {
    const payload = readStdinJson();
    return deriveMessageShape(payload.message, payload.senderSessionId);
  },
});
