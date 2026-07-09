/**
 * Events-optional consumer signal recovery helpers (Issue #700).
 * Vitest: scripts/events-optional-consumer-signal-recovery.test.ts
 */
import { toArray } from './review-reconcile-primitives.mjs';

export const SIGNAL_SOURCES = Object.freeze({
  reviewTrigger: 'openPrs+reviewRuns+reportState',
  deliveryConfirm: 'sessionReviewsDeliveredStatus+packJournal',
  ciGreenWake: 'openPrs+checks+ownerResolver',
  workerSubmit: 'packDispatchJournal+reviewRuns',
  ciFailureNotification: 'pendingEpisodeStore+liveSession',
});

/**
 * @param {string} surface
 * @param {string} source
 */
export function formatSignalSourceLog(surface, source) {
  const surfaceText = surface ? ` surface=${surface}` : '';
  const sourceText = source ? ` source=${source}` : '';
  return `signal_source${surfaceText}${sourceText}`;
}

/**
 * @param {string} surface
 * @param {string} [key]
 */
export function formatJournalWriteDegradedLog(surface, key = '') {
  const surfaceText = surface ? ` surface=${surface}` : '';
  const keyText = key ? ` key=${key}` : '';
  return `journal_write_degraded${surfaceText}${keyText}`;
}

/**
 * AO 0.10.2 session-reviews delivery datum: latestRun.status === 'delivered' (no deliveredAt on wire).
 *
 * @param {Record<string, unknown>} run
 */
export function isSessionReviewsDeliveredRun(run) {
  const latestRunStatus = String(run?.latestRunStatus ?? run?.status ?? '').toLowerCase();
  return latestRunStatus === 'delivered';
}

/**
 * @param {Record<string, unknown>} run
 * @param {(iso?: string) => number | null} [parseIsoMs]
 */
export function resolveDeliveredRunObservedAtMs(run, parseIsoMs) {
  const parse = parseIsoMs ?? defaultParseIsoMs;
  const deliveredAtMs = parse(run?.deliveredAt);
  if (deliveredAtMs != null) {
    return deliveredAtMs;
  }
  if (isSessionReviewsDeliveredRun(run)) {
    return (
      parse(run?.updatedAt) ??
      parse(run?.completedAt) ??
      parse(run?.createdAt) ??
      null
    );
  }
  return parse(run?.updatedAt) ?? null;
}

/**
 * @param {string | undefined} iso
 */
function defaultParseIsoMs(iso) {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {Record<string, Record<string, unknown>>} journal
 */
export function hasReactionDispatchJournalEntries(journal = {}) {
  for (const entry of Object.values(journal ?? {})) {
    if (String(entry?.source ?? '') === 'reaction') {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} transitionId
 * @param {Record<string, { sessionId?: string, sentAtMs?: number, message?: string }>} pendingJournal
 */
export function shouldSuppressNudgeForPendingJournal(transitionId, pendingJournal = {}) {
  return Boolean(pendingJournal?.[transitionId]);
}

/**
 * @param {Array<Record<string, unknown>>} reviewRuns
 */
export function reviewRunsLackAoWireDeliveredAt(reviewRuns) {
  return toArray(reviewRuns).every((run) => run?.deliveredAt == null);
}
