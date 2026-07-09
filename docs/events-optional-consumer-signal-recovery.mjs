/**
 * Events-optional consumer signal recovery helpers (Issue #700).
 * Vitest: scripts/events-optional-consumer-signal-recovery.test.ts
 */
import { toArray } from './review-reconcile-primitives.mjs';

/** Follow-up for worker-ack receipt on AO 0.10.2 (ao report / status --reports removed). */
export const REPORT_RECEIPT_SURFACE_FOLLOWUP = 'pack-worker-report-store';

export const SIGNAL_SOURCES = Object.freeze({
  reviewTrigger: 'openPrs+reviewRuns',
  deliveryConfirm: 'sessionReviewsDeliveredStatus+packJournal+sessionStatus',
  ciGreenWake: 'openPrs+checks+ownerResolver',
  workerSubmit: 'packDispatchJournal+reviewRuns',
  ciFailureNotification: 'pendingEpisodeStore+liveSession',
});

/** Dead on AO 0.10.2 — must not appear in live signal-source bindings. */
export const DEAD_AO_SIGNAL_SURFACES = Object.freeze([
  'ao report',
  'ao status --reports',
  '/sessions/{id}/reports',
]);

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
 * AO 0.10.2 removed ao report and `ao status --reports`; worker-ack via reportState is descoped.
 *
 * @param {string} surface
 * @param {string} [followup]
 */
export function formatReportReceiptSurfaceRemovedLog(
  surface,
  followup = REPORT_RECEIPT_SURFACE_FOLLOWUP,
) {
  const surfaceText = surface ? ` surface=${surface}` : '';
  const followupText = followup ? ` followup=${followup}` : '';
  return `report_receipt_surface_removed${surfaceText}${followupText}`;
}

/**
 * @param {string} source
 */
export function assertLiveSignalSourceBinding(source) {
  const normalized = String(source ?? '').toLowerCase();
  for (const dead of DEAD_AO_SIGNAL_SURFACES) {
    if (normalized.includes(String(dead).toLowerCase())) {
      throw new Error(`dead AO 0.10.2 signal surface in binding: ${dead}`);
    }
  }
}

/**
 * Pack store rows are the live AO 0.10.2 worker-ack source; report-full fixtures remain test-only.
 *
 * @param {Record<string, unknown>} session
 */
export function sessionHasLegacyReportReceiptSurface(session) {
  const kind = String(session?.reportSnapshotKind ?? '').toLowerCase();
  if (kind === 'pack-worker-report-store') {
    return toArray(session?.reports).length > 0;
  }
  if (kind === 'fixture-report-full' || kind === 'fixture-session-reports') {
    return toArray(session?.reports).length > 0;
  }
  return toArray(session?.reports).some((report) => {
    const state = String(report?.reportState ?? report?.report_state ?? '').trim();
    return state.length > 0;
  });
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
 * @param {string} deliveryId
 * @param {Record<string, { claimKey?: string, submittedAtMs?: number, sessionId?: string }>} pendingOutcomes
 */
export function shouldSuppressSubmitForPendingOutcome(deliveryId, pendingOutcomes = {}) {
  return Boolean(pendingOutcomes?.[deliveryId]);
}

/**
 * @param {Array<Record<string, unknown>>} reviewRuns
 */
export function reviewRunsLackAoWireDeliveredAt(reviewRuns) {
  return toArray(reviewRuns).every((run) => run?.deliveredAt == null);
}
