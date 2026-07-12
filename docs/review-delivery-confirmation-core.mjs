import { evaluateMechanicalTickInterval, resolveBoundedInt } from './review-mechanical-cli.mjs';
import {
  findForbiddenLifecycleCommands,
  findSessionById,
  isLiveWorkerSession,
  normalizeSha,
  sessionMatchesIdentifier,
  sessionOwnsRunHead,
  toArray,
} from './review-trigger-reconcile.mjs';
import {
  resolveBindingRepoSlug,
  resolvePrSessionBindingCachePath,
  resolvePrSessionBindingForConsumer,
} from './pr-session-binding-cache.mjs';
import { isPendingWorkerDeliveryConfirmation } from './review-producer-contract.mjs';
import {
  resolveDeliveredRunObservedAtMs,
  sessionHasLegacyReportReceiptSurface,
} from './events-optional-consumer-signal-recovery.mjs';
import {
  findPackWorkerAckReportAfterDelivery,
  PACK_WORKER_REPORT_STORE_SURFACE,
} from './worker-report-store.mjs';

export { resolvePrSessionBindingForConsumer, sessionOwnsRunHead };
export { findForbiddenLifecycleCommands as findForbiddenDeliveryLifecycleCommands };

export const DEFAULT_CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_REDELIVERIES = 2;
export const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000;
export const REVIEW_ROUND_REPORT_STATES = new Set([
  'addressing_reviews',
  'fixing_ci',
  'ready_for_review',
]);
export const DELIVERY_STATE_CONFIRMED = 'confirmed';
export const DELIVERY_STATE_ESCALATED = 'escalated';
export const DELIVERY_STATE_UNCONFIRMED = 'unconfirmed';
export const PENDING_SENT_DELIVERY_STATUSES = new Set(['changes_requested']);
export const OPERATOR_REMEDY_TEXT =
  'Inspect the worker session terminal (flooded input channel is a known failure mode). ' +
  'Do not re-drive delivery into a dead linked session — use ao session claim-pr with a live worker, ' +
  'reviewer-workspace-preflight if needed, then restart review on the live session. ' +
  'See docs/orchestrator-recovery-runbook.md (Review finding delivery unconfirmed).';

export function getReviewRunId(run) {
  const id = String(run?.id ?? run?.reviewerSessionId ?? '').trim();
  return id || null;
}

export function isPendingSentDeliveryRun(run) {
  return isPendingWorkerDeliveryConfirmation(run);
}

export function parseIsoMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function resolveSendObservedAtMs(run, fallbackMs) {
  return resolveDeliveredRunObservedAtMs(run, parseIsoMs) ?? fallbackMs;
}

export function getReportState(report) {
  return String(report?.reportState ?? report?.report_state ?? '').toLowerCase();
}

export function getReportTimestampMs(report) {
  return parseIsoMs(report?.reportedAt) ?? parseIsoMs(report?.timestamp) ??
    parseIsoMs(report?.createdAt) ?? 0;
}

export function findReviewRoundReportAfterSend(session, sendObservedAtMs) {
  for (const report of toArray(session?.reports)) {
    if (REVIEW_ROUND_REPORT_STATES.has(getReportState(report)) &&
        getReportTimestampMs(report) > sendObservedAtMs) {
      return report;
    }
  }
  return null;
}

export function isLinkedSessionLiveOwner(run, sessions, openPrs, options = {}) {
  const linkedId = String(run?.linkedSessionId ?? '').trim();
  if (!linkedId) return false;
  const session = findSessionById(sessions, linkedId);
  if (!session || !isLiveWorkerSession(session)) return false;
  const prNumber = Number(run?.prNumber);
  if (!prNumber) return false;

  const headSha = String(run?.targetSha ?? '');
  const resolution = resolvePrSessionBindingForConsumer({
    cachePath: options.cachePath ?? resolvePrSessionBindingCachePath(),
    repoSlug: resolveBindingRepoSlug(options, openPrs),
    prNumber,
    headSha,
    sessions,
    openPrs,
    nowMs: options.nowMs ?? Date.now(),
    writeBackfill: options.writeBackfill ?? true,
    isLive: (candidate) => isLiveWorkerSession(candidate),
  });
  return Boolean(
    resolution.sessionId &&
    !resolution.failClosed &&
    resolution.sessionId === linkedId &&
    sessionOwnsRunHead(session, prNumber, headSha, openPrs),
  );
}

export function linkedRunSessionsMatch(sessions, linkedA, linkedB) {
  const a = String(linkedA ?? '').trim();
  const b = String(linkedB ?? '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const session = findSessionById(sessions, a) ?? findSessionById(sessions, b);
  return Boolean(
    session && sessionMatchesIdentifier(session, a) && sessionMatchesIdentifier(session, b),
  );
}

export function countAmbiguousUnconfirmedPeers(runs, tracking, target, sessions) {
  const prNumber = Number(target?.prNumber);
  const head = normalizeSha(target?.targetSha);
  const sessionId = String(target?.linkedSessionId ?? '').trim();
  const sessionList = toArray(sessions);
  if (!prNumber || !head || !sessionId) return 0;

  let count = 0;
  for (const run of toArray(runs)) {
    if (!isPendingSentDeliveryRun(run) || Number(run?.prNumber) !== prNumber ||
        normalizeSha(run?.targetSha) !== head ||
        !linkedRunSessionsMatch(sessionList, sessionId, String(run?.linkedSessionId ?? '').trim())) {
      continue;
    }
    const runId = getReviewRunId(run);
    if (!runId) continue;
    const state = tracking?.runs?.[runId]?.deliveryState ?? DELIVERY_STATE_UNCONFIRMED;
    if (state !== DELIVERY_STATE_CONFIRMED && state !== DELIVERY_STATE_ESCALATED) count += 1;
  }
  return count;
}

export function isDeliveryConfirmed(run, sessions, sendObservedAtMs, allRuns, tracking, openPrs) {
  const linkedId = String(run?.linkedSessionId ?? '').trim();
  if (!linkedId || countAmbiguousUnconfirmedPeers(allRuns, tracking, run, sessions) > 1 ||
      !isLinkedSessionLiveOwner(run, sessions, openPrs)) {
    return false;
  }
  const session = findSessionById(sessions, linkedId);
  if (!session || !sessionHasLegacyReportReceiptSurface(session)) return false;
  if (String(session?.reportSnapshotKind ?? '') === PACK_WORKER_REPORT_STORE_SURFACE) {
    return Boolean(findPackWorkerAckReportAfterDelivery(session, run, sendObservedAtMs));
  }
  return Boolean(findReviewRoundReportAfterSend(session, sendObservedAtMs));
}

export function pendingDeliveredRunsLackReportReceiptSurface(reviewRuns, sessions) {
  const sessionList = toArray(sessions);
  let hasPendingDelivered = false;
  for (const run of toArray(reviewRuns)) {
    if (!isPendingSentDeliveryRun(run)) continue;
    hasPendingDelivered = true;
    const linkedId = String(run?.linkedSessionId ?? '').trim();
    const session = linkedId ? findSessionById(sessionList, linkedId) : null;
    if (session && sessionHasLegacyReportReceiptSurface(session)) return false;
  }
  return hasPendingDelivered;
}

export function evaluateDeliveryTickInterval({ nowMs, lastTickMs, intervalMs }) {
  return evaluateMechanicalTickInterval({
    nowMs,
    lastTickMs,
    intervalMs,
    defaultIntervalMs: DEFAULT_TICK_INTERVAL_MS,
  });
}

export function getConfirmationAnchorMs(record, sendObservedAtMs) {
  return record?.lastRedeliveryAtMs > 0 ? record.lastRedeliveryAtMs : sendObservedAtMs;
}

export function resolveDeliveryConfig(config = {}) {
  return {
    confirmationWindowMs: resolveBoundedInt(
      config.confirmationWindowMs,
      DEFAULT_CONFIRMATION_WINDOW_MS,
      1,
    ),
    maxRedeliveries: resolveBoundedInt(config.maxRedeliveries, DEFAULT_MAX_REDELIVERIES, 0),
  };
}
