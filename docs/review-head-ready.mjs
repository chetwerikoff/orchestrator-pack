/**
 * Canonical "head ready for review" predicate (Issue #195).
 * Shared by report-driven triggers, ROUND PROGRESSION, and review-trigger-reconcile.
 * Vitest: scripts/review-head-ready.test.ts
 */
import {
  classifyRequiredCiLevel,
  findLatestReportForHead,
  getStoredReportHeadSha,
  PACK_MERGE_CONTRACT_CHECK_NAMES,
} from './review-ready-stuck-guard.mjs';
import { getReportState } from './review-finding-delivery-confirm.mjs';
import {
  getSessionActivity,
  isDeliveryConsumed,
  isSessionStreaming,
  mergeDeliveryRecords,
  selectSurvivingDelivery,
} from './worker-message-dispatch-observe.mjs';
import { parseLastActivityAgeMs } from './review-reconcile-primitives.mjs';
import {
  evaluateQuiescentFallbackNudgePrecedence,
  evaluateWorkerIterationCycleForPr,
  mergeSharedWorkerIterationCycleState,
} from './worker-iteration-cycle.mjs';
import {
  AMBIGUOUS_IMPLICIT_HEAD_OWNER_REASON,
  collectSessionIdentifiers,
  findCoveringRunForHead,
  findFailedOrCancelledRunForHead,
  findSessionById,
  getReportTimestampMs,
  getSessionIdentifier,
  hasFailedOrCancelledOnHead,
  isHeadCovered,
  isLiveWorkerSession,
  normalizeSha,
  reportCoversHead,
  resolveHeadCommittedAtMs,
  resolveReconcileEvaluationSession,
  toArray,
} from './review-trigger-reconcile.mjs';

/** Sustained-quiescence debounce — tied to review-ready stuck grace (Issue #174 / #261). */
export const QUIESCENCE_DEBOUNCE_MS = 15 * 60 * 1000;

/** Report states that imply the worker is still mid-hand-off (Issue #261 row 2). */
export const ACTIVELY_WORKING_REPORT_STATES = new Set([
  'working',
  'fixing_ci',
  'started',
  'pr_created',
  'addressing_reviews',
]);

/** Session AO statuses that imply the worker has not gone quiescent yet. */
export const ACTIVELY_WORKING_SESSION_STATUSES = new Set([
  'working',
  'fixing_ci',
  'started',
  'pr_created',
  'addressing_reviews',
]);

export const QUIESCENT_HANDOFF_START_REASON = 'quiescent_worker_handoff_fallback';

export { hasFailedOrCancelledOnHead } from './review-trigger-reconcile.mjs';

/** Bounded orchestrator/reconciler re-attempts when required-check visibility is degraded. */
export const DEFAULT_DEGRADED_CI_MAX_ATTEMPTS = 3;

export const DEGRADED_CI_MAX_ATTEMPTS_ENV = 'AO_REVIEW_DEGRADED_CI_MAX_ATTEMPTS';

/** @typedef {'fresh-by-monotonic-order' | 'stale-only' | 'no-report' | 'ambiguous/incomplete-fail-closed'} ReadyForReviewFreshnessBasis */

export const FRESHNESS_BASIS_FRESH = 'fresh-by-monotonic-order';
export const FRESHNESS_BASIS_STALE_ONLY = 'stale-only';
export const FRESHNESS_BASIS_NO_REPORT = 'no-report';
export const FRESHNESS_BASIS_AMBIGUOUS = 'ambiguous/incomplete-fail-closed';

/** States that open a new worker iteration relative to prior hand-offs (Issue #352). */
const ITERATION_BOUNDARY_STATES = new Set([
  'working',
  'fixing_ci',
  'addressing_reviews',
  'pr_created',
  'started',
]);

/** States that precede a genuine hand-off within the current iteration segment. */
const HANDOFF_PRECURSOR_STATES = new Set([
  'working',
  'fixing_ci',
  'addressing_reviews',
  'pr_created',
  'started',
]);

/**
 * @typedef {object} ReadyForReviewFreshnessClassification
 * @property {ReadyForReviewFreshnessBasis} freshnessBasis
 * @property {Record<string, unknown> | null} freshHandoffReport
 * @property {boolean} [hasOlderStaleReadyReports]
 */

/** @typedef {'green' | 'pending' | 'red' | 'degraded'} ReviewTriggerCiLevel */

/**
 * @param {unknown} value
 * @param {number} defaultValue
 */
function resolvePositiveInt(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

/**
 * @param {{ maxDegradedCiAttempts?: number }} [config]
 */
export function resolveMaxDegradedCiAttempts(config = {}) {
  const explicit = Number(config.maxDegradedCiAttempts);
  if (Number.isFinite(explicit) && explicit > 0) {
    return resolvePositiveInt(explicit, DEFAULT_DEGRADED_CI_MAX_ATTEMPTS);
  }
  const env =
    typeof process !== 'undefined' ? process.env?.[DEGRADED_CI_MAX_ATTEMPTS_ENV] : undefined;
  if (env !== undefined && String(env).trim() !== '') {
    return resolvePositiveInt(env, DEFAULT_DEGRADED_CI_MAX_ATTEMPTS);
  }
  return DEFAULT_DEGRADED_CI_MAX_ATTEMPTS;
}

/**
 * Required CI for review trigger: green/pending eligible; red defers; degraded withholds.
 *
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} checks
 * @param {{ requiredCheckNames?: string[], requiredCheckLookupFailed?: boolean }} [options]
 * @returns {ReviewTriggerCiLevel}
 */
export function classifyRequiredCiForReviewTrigger(checks, options = {}) {
  if (options.requiredCheckLookupFailed) {
    return 'degraded';
  }

  const list = toArray(checks);
  const branchRequired = toArray(options.requiredCheckNames)
    .map((name) => String(name ?? '').trim())
    .filter(Boolean);
  const effectiveRequired =
    branchRequired.length > 0 ? branchRequired : PACK_MERGE_CONTRACT_CHECK_NAMES;
  const normalizedEffective = effectiveRequired.map((name) => name.toLowerCase());

  const scope = list.filter((check) =>
    normalizedEffective.includes(String(check?.name ?? '').toLowerCase()),
  );
  if (scope.length === 0) {
    return 'degraded';
  }
  const matchedRequired = new Set(
    scope.map((check) => String(check?.name ?? '').toLowerCase()),
  );
  const hasMissingRequired = normalizedEffective.some((name) => !matchedRequired.has(name));
  if (hasMissingRequired) {
    return 'degraded';
  }

  const level = classifyRequiredCiLevel(scope, {
    requiredCheckNames: effectiveRequired,
    requiredCheckLookupFailed: options.requiredCheckLookupFailed,
  });
  if (level === 'green' || level === 'pending') {
    return level;
  }
  return 'red';
}

/**
 * @param {Record<string, unknown> | null | undefined} report
 */
export function isWorkerDegradedCiHandoff(report) {
  if (!report) {
    return false;
  }
  if (report.degradedCiEscalation === true || report.handoffKind === 'degraded_ci') {
    return true;
  }
  const state = getReportState(report);
  if (state !== 'completed') {
    return false;
  }
  const note = String(
    report.note ?? report.message ?? report.reason ?? report.detail ?? '',
  ).toLowerCase();
  if (!note) {
    return false;
  }
  return (
    note.includes('degraded') ||
    note.includes('required check') ||
    note.includes('ci visibility') ||
    note.includes('missing check') ||
    note.includes('checks missing') ||
    note.includes('never triggered')
  );
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} headSha
 * @param {{ headCommittedAtMs?: number }} [options]
 */
export function findLatestAcceptedReportForHead(session, headSha, options = {}) {
  return findLatestReportForHead(session, headSha, options);
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} headSha
 * @param {{ headCommittedAtMs?: number }} [options]
 */
/**
 * Normalize AO 0.9.x session reports into chronological emission order.
 * Live `ao status --json` stores newest-first; fixtures may be oldest-first.
 *
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null | undefined} session
 */
export function enumerateReportsInEmissionOrder(session) {
  const reports = toArray(session?.reports);
  if (reports.length <= 1) {
    return reports.map((report, emissionIndex) => ({ report, emissionIndex }));
  }
  const firstMs = getReportTimestampMs(reports[0]);
  const secondMs = getReportTimestampMs(reports[1]);
  if (firstMs <= 0 || secondMs <= 0) {
    return null;
  }
  const newestFirst = firstMs >= secondMs;
  const ordered = newestFirst ? [...reports].reverse() : [...reports];
  return ordered.map((report, emissionIndex) => ({ report, emissionIndex }));
}

/**
 * @param {Array<{ report: Record<string, unknown>, emissionIndex: number }>} stream
 */
function selectAcceptedEmissionStream(stream) {
  return stream.filter(({ report }) => report?.accepted !== false);
}

/**
 * @param {Array<{ report: Record<string, unknown>, emissionIndex: number }>} stream
 * @param {number} fromIndex
 * @param {number} toIndex
 */
function segmentHasHandoffPrecursor(stream, fromIndex, toIndex) {
  if (toIndex <= fromIndex) {
    return false;
  }
  for (let i = fromIndex; i < toIndex; i++) {
    if (HANDOFF_PRECURSOR_STATES.has(getReportState(stream[i]?.report))) {
      return true;
    }
  }
  return false;
}

/**
 * Classify whether the current head has a fresh ready_for_review hand-off using
 * monotonic report emission order relative to iteration boundaries (Issue #352).
 *
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null | undefined} session
 * @param {string} headSha
 * @param {{ headCommittedAtMs?: number }} [options]
 * @returns {ReadyForReviewFreshnessClassification}
 */
export function classifyReadyForReviewFreshness(session, headSha, options = {}) {
  const target = normalizeSha(headSha);
  if (!target || !session) {
    return { freshnessBasis: FRESHNESS_BASIS_NO_REPORT, freshHandoffReport: null };
  }

  const emission = enumerateReportsInEmissionOrder(session);
  if (emission === null) {
    return { freshnessBasis: FRESHNESS_BASIS_AMBIGUOUS, freshHandoffReport: null };
  }
  const stream = selectAcceptedEmissionStream(emission);
  if (stream.length === 0) {
    return { freshnessBasis: FRESHNESS_BASIS_NO_REPORT, freshHandoffReport: null };
  }

  const owned = normalizeSha(session?.ownedHeadSha ?? session?.headRefOid);
  const hasReady = stream.some(
    ({ report }) => getReportState(report) === 'ready_for_review',
  );

  if (owned && owned !== target) {
    return {
      freshnessBasis: hasReady ? FRESHNESS_BASIS_STALE_ONLY : FRESHNESS_BASIS_NO_REPORT,
      freshHandoffReport: null,
    };
  }

  let lastBoundaryIndex = -1;
  for (let i = 0; i < stream.length; i++) {
    if (ITERATION_BOUNDARY_STATES.has(getReportState(stream[i]?.report))) {
      lastBoundaryIndex = i;
    }
  }

  /** @type {Record<string, unknown> | null} */
  let freshHandoffReport = null;
  let freshIndex = -1;

  for (let i = stream.length - 1; i >= 0; i--) {
    const report = stream[i]?.report;
    if (getReportState(report) !== 'ready_for_review') {
      continue;
    }
    if (lastBoundaryIndex >= 0 && i <= lastBoundaryIndex) {
      break;
    }
    let boundaryAfter = false;
    for (let j = i + 1; j < stream.length; j++) {
      if (ITERATION_BOUNDARY_STATES.has(getReportState(stream[j]?.report))) {
        boundaryAfter = true;
        break;
      }
    }
    if (boundaryAfter) {
      continue;
    }
    const stored = getStoredReportHeadSha(report);
    if (stored && stored !== target) {
      continue;
    }
    if (!stored && !reportCoversHead(report, target, options)) {
      continue;
    }
    freshHandoffReport = report;
    freshIndex = i;
    break;
  }

  if (!freshHandoffReport) {
    if (lastBoundaryIndex >= 0) {
      for (let i = lastBoundaryIndex + 1; i < stream.length; i++) {
        if (getReportState(stream[i]?.report) === 'ready_for_review') {
          return {
            freshnessBasis: FRESHNESS_BASIS_AMBIGUOUS,
            freshHandoffReport: null,
            hasOlderStaleReadyReports: true,
          };
        }
      }
    }
    return {
      freshnessBasis: hasReady ? FRESHNESS_BASIS_STALE_ONLY : FRESHNESS_BASIS_NO_REPORT,
      freshHandoffReport: null,
    };
  }

  const hasOlderStaleReadyReports = stream.some(
    ({ report }, index) =>
      index < freshIndex && getReportState(report) === 'ready_for_review',
  );

  if (lastBoundaryIndex >= 0) {
    const precursorStart = Math.max(0, lastBoundaryIndex);
    if (!segmentHasHandoffPrecursor(stream, precursorStart, freshIndex)) {
      return {
        freshnessBasis: FRESHNESS_BASIS_AMBIGUOUS,
        freshHandoffReport: null,
        hasOlderStaleReadyReports,
      };
    }
  }

  return {
    freshnessBasis: FRESHNESS_BASIS_FRESH,
    freshHandoffReport,
    hasOlderStaleReadyReports,
  };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} headSha
 * @param {{ headCommittedAtMs?: number }} [options]
 */
export function findFreshReadyForReviewHandoff(session, headSha, options = {}) {
  const classification = classifyReadyForReviewFreshness(session, headSha, options);
  return classification.freshnessBasis === FRESHNESS_BASIS_FRESH
    ? classification.freshHandoffReport
    : null;
}

export function hasReadyForReviewForHead(session, headSha, options = {}) {
  return (
    classifyReadyForReviewFreshness(session, headSha, options).freshnessBasis ===
    FRESHNESS_BASIS_FRESH
  );
}

/**
 * @param {string | undefined | null} lastActivity
 */
export { parseLastActivityAgeMs };

/**
 * @param {object} input
 */
export function mergeWorkerDeliveriesFromPlanInput(input = {}) {
  const explicit = toArray(input.workerDeliveries).filter(
    (entry) => entry != null && typeof entry === 'object',
  );
  const hasSynthesisSources =
    input.aoEvents != null ||
    input.dispatchJournal != null ||
    input.reviewRuns != null;
  const synthesized = hasSynthesisSources
    ? mergeDeliveryRecords({
        aoEvents: toArray(input.aoEvents),
        dispatchJournal: input.dispatchJournal ?? {},
        reviewRuns: toArray(input.reviewRuns),
        reactionMessages: input.reactionMessages ?? {},
        nowMs: Number(input.nowMs) || Date.now(),
      })
    : [];

  if (explicit.length === 0) {
    return synthesized;
  }
  if (synthesized.length === 0) {
    return explicit;
  }

  const byId = new Map();
  const withoutId = [];
  for (const row of [...explicit, ...synthesized]) {
    const id = String(row.deliveryId ?? '');
    if (!id) {
      withoutId.push(row);
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, row);
    }
  }
  return [...byId.values(), ...withoutId].sort(
    (a, b) => Number(a.deliveredAtMs) - Number(b.deliveredAtMs),
  );
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} sessionId
 * @param {Array<Record<string, unknown>>} workerDeliveries
 */
export function hasPendingUnconsumedDelivery(session, sessionId, workerDeliveries = []) {
  if (!session) {
    return false;
  }
  const needles = collectSessionIdentifiers(session);
  const fallback = String(sessionId ?? '').trim();
  if (fallback && !needles.includes(fallback)) {
    needles.push(fallback);
  }
  if (needles.length === 0) {
    return false;
  }
  for (const needle of needles) {
    const surviving = selectSurvivingDelivery(toArray(workerDeliveries), needle);
    if (!surviving) {
      continue;
    }
    const deliveredAtMs = Number(surviving.deliveredAtMs ?? 0);
    if (!isDeliveryConsumed(session, surviving, deliveredAtMs)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} headSha
 * @param {number} nowMs
 * @param {{ headCommittedAtMs?: number, debounceMs?: number, workerDeliveries?: Array<Record<string, unknown>> }} [options]
 */
export function isWorkerActivelyWorking(session, headSha, nowMs, options = {}) {
  if (!session) {
    return false;
  }

  const debounceMs = Number(options.debounceMs) || QUIESCENCE_DEBOUNCE_MS;
  const reportBindingOptions = { headCommittedAtMs: options.headCommittedAtMs };
  const activity = getSessionActivity(session);
  const status = String(session?.status ?? '').toLowerCase();

  if (isSessionStreaming(session) || activity === 'active') {
    return true;
  }

  if (ACTIVELY_WORKING_SESSION_STATUSES.has(status) && activity !== 'idle') {
    return true;
  }

  const lastActivityAgeMs = parseLastActivityAgeMs(session?.lastActivity);
  if (lastActivityAgeMs != null && lastActivityAgeMs < debounceMs) {
    return true;
  }

  if (status === 'working' && activity !== 'idle') {
    return true;
  }

  const headCommittedAtMs = Number(options.headCommittedAtMs);
  if (
    Number.isFinite(headCommittedAtMs) &&
    headCommittedAtMs > 0 &&
    nowMs - headCommittedAtMs < debounceMs
  ) {
    return true;
  }

  const sessionId = getSessionIdentifier(session);
  if (
    sessionId &&
    hasPendingUnconsumedDelivery(session, sessionId, options.workerDeliveries)
  ) {
    return true;
  }

  let latestActiveReportMs = -1;
  for (const report of toArray(session?.reports)) {
    if (!reportCoversHead(report, headSha, reportBindingOptions)) {
      continue;
    }
    const state = getReportState(report);
    if (!ACTIVELY_WORKING_REPORT_STATES.has(state)) {
      continue;
    }
    latestActiveReportMs = Math.max(latestActiveReportMs, getReportTimestampMs(report));
  }
  if (latestActiveReportMs > 0 && nowMs - latestActiveReportMs < debounceMs) {
    return true;
  }

  return false;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} headSha
 * @param {number} nowMs
 * @param {{ headCommittedAtMs?: number, debounceMs?: number, workerDeliveries?: Array<Record<string, unknown>> }} [options]
 */
export function evaluateWorkerQuiescenceBasis(session, headSha, nowMs, options = {}) {
  const debounceMs = Number(options.debounceMs) || QUIESCENCE_DEBOUNCE_MS;
  const headCommittedAtMs = Number(options.headCommittedAtMs);
  const lastActivityAgeMs = parseLastActivityAgeMs(session?.lastActivity);
  const sessionId = getSessionIdentifier(session);
  const headStableMs =
    Number.isFinite(headCommittedAtMs) && headCommittedAtMs > 0
      ? nowMs - headCommittedAtMs
      : null;
  const pendingUnconsumedDelivery = Boolean(
    sessionId &&
      hasPendingUnconsumedDelivery(session, sessionId, options.workerDeliveries),
  );

  return {
    activity: getSessionActivity(session) || 'unknown',
    status: String(session?.status ?? ''),
    lastActivity: String(session?.lastActivity ?? ''),
    lastActivityAgeMs,
    headStableMs,
    pendingUnconsumedDelivery,
    debounceMs,
    live: isLiveWorkerSession(session),
  };
}

/**
 * @param {object} input
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} input.session
 * @param {string} input.headSha
 * @param {number} input.nowMs
 * @param {number} [input.headCommittedAtMs]
 * @param {Array<Record<string, unknown>>} [input.workerDeliveries]
 * @param {{ sessionId?: string | null, reason?: string, failClosed?: boolean }} [input.ownerResolution]
 */
export function evaluateQuiescentHandoffFallback({
  session,
  headSha,
  nowMs,
  headCommittedAtMs,
  workerDeliveries = [],
  ownerResolution = null,
}) {
  if (ownerResolution?.failClosed) {
    return {
      eligible: false,
      reason: String(ownerResolution.reason ?? 'owner_unresolved'),
      failClosed: true,
    };
  }

  if (!session || !isLiveWorkerSession(session)) {
    return { eligible: false, reason: 'no_live_review_target', failClosed: true };
  }

  const basis = evaluateWorkerQuiescenceBasis(session, headSha, nowMs, {
    headCommittedAtMs,
    workerDeliveries,
  });

  if (basis.pendingUnconsumedDelivery) {
    return {
      eligible: false,
      reason: 'pending_unconsumed_delivery',
      failClosed: false,
      basis,
    };
  }

  if (isWorkerActivelyWorking(session, headSha, nowMs, {
    headCommittedAtMs,
    workerDeliveries,
  })) {
    return {
      eligible: false,
      reason: 'worker_actively_working',
      failClosed: false,
      basis,
    };
  }

  if (basis.headStableMs == null || basis.headStableMs < basis.debounceMs) {
    return {
      eligible: false,
      reason: 'quiescence_debounce_pending',
      failClosed: false,
      basis,
    };
  }

  if (basis.lastActivityAgeMs != null && basis.lastActivityAgeMs < basis.debounceMs) {
    return {
      eligible: false,
      reason: 'quiescence_debounce_pending',
      failClosed: false,
      basis,
    };
  }

  return {
    eligible: true,
    reason: QUIESCENT_HANDOFF_START_REASON,
    failClosed: false,
    basis,
  };
}

/**
 * @param {number} prNumber
 * @param {string} headSha
 */
export function degradedCiTrackingKey(prNumber, headSha) {
  return `${prNumber}:${normalizeSha(headSha)}`;
}

/**
 * @param {object} input
 * @param {import('./review-trigger-reconcile.mjs').AoSession} input.session
 * @param {string} input.headSha
 * @param {{ headCommittedAtMs?: number }} input.reportBindingOptions
 * @param {number} input.degradedCiAttempts
 * @param {number} input.maxDegradedCiAttempts
 * @param {boolean} [input.pendingHandoff]
 */
function buildDegradedCiRetryDecision({
  session,
  headSha,
  reportBindingOptions,
  degradedCiAttempts,
  maxDegradedCiAttempts,
  pendingHandoff = false,
}) {
  const attempts = Math.max(0, Number(degradedCiAttempts) || 0);
  if (attempts >= maxDegradedCiAttempts) {
    return {
      eligible: false,
      reason: 'degraded_ci_escalate_operator',
      route: 'escalate_operator',
      degradedCiAttempts: attempts,
    };
  }
  const handoff = isWorkerDegradedCiHandoff(
    findLatestAcceptedReportForHead(session, headSha, reportBindingOptions),
  );
  return {
    eligible: false,
    reason: pendingHandoff
      ? 'degraded_ci_worker_handoff_pending_resolution'
      : handoff
        ? 'degraded_ci_worker_handoff'
        : 'degraded_ci_visibility',
    route: 'degraded_ci_retry',
    degradedCiAttempts: attempts + 1,
  };
}

/**
 * @param {object} input
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} input.reviewRuns
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} [input.session]
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} [input.ciChecks]
 * @param {string[]} [input.requiredCheckNames]
 * @param {boolean} [input.requiredCheckLookupFailed]
 * @param {number} [input.degradedCiAttempts]
 * @param {number} [input.maxDegradedCiAttempts]
 * @param {number} [input.headCommittedAtMs]
 * @param {{ sessionId?: string | null, reason?: string, failClosed?: boolean }} [input.ownerResolution]
 * @param {number} [input.nowMs]
 * @param {Array<Record<string, unknown>>} [input.workerDeliveries]
 */
export function evaluateHeadReadyForReview({
  reviewRuns,
  prNumber,
  headSha,
  session = null,
  ciChecks = [],
  requiredCheckNames = [],
  requiredCheckLookupFailed = false,
  degradedCiAttempts = 0,
  maxDegradedCiAttempts = resolveMaxDegradedCiAttempts(),
  headCommittedAtMs,
  ownerResolution = null,
  nowMs = Date.now(),
  workerDeliveries = [],
  allowFailedRetry = false,
}) {
  const reportBindingOptions = { headCommittedAtMs };
  if (!allowFailedRetry && hasFailedOrCancelledOnHead(reviewRuns, prNumber, headSha)) {
    return {
      eligible: false,
      reason: 'failed_or_cancelled_on_head',
      route: 'empty_review_trap',
    };
  }

  if (isHeadCovered(reviewRuns, prNumber, headSha)) {
    return { eligible: false, reason: 'head_covered', route: 'none' };
  }

  const ciLevel = classifyRequiredCiForReviewTrigger(ciChecks, {
    requiredCheckNames,
    requiredCheckLookupFailed,
  });

  if (ciLevel === 'red') {
    return {
      eligible: false,
      reason: 'ci_red_defer',
      route: 'defer',
    };
  }

  if (!session) {
    if (ownerResolution?.failClosed) {
      return {
        eligible: false,
        reason: String(ownerResolution.reason ?? 'no_live_review_target'),
        route: 'defer',
      };
    }
    return { eligible: false, reason: 'no_worker_session', route: 'none' };
  }

  const latestReport = findLatestAcceptedReportForHead(session, headSha, reportBindingOptions);
  const degradedHandoff = isWorkerDegradedCiHandoff(latestReport);
  const readyForReview = hasReadyForReviewForHead(session, headSha, reportBindingOptions);

  if (degradedHandoff && !readyForReview) {
    return buildDegradedCiRetryDecision({
      session,
      headSha,
      reportBindingOptions,
      degradedCiAttempts,
      maxDegradedCiAttempts,
      pendingHandoff: true,
    });
  }

  if (readyForReview) {
    if (ciLevel === 'degraded') {
      return buildDegradedCiRetryDecision({
        session,
        headSha,
        reportBindingOptions,
        degradedCiAttempts,
        maxDegradedCiAttempts,
      });
    }
    return {
      eligible: true,
      reason: 'head_ready_for_review',
      route: 'start_review',
      ciLevel,
      freshnessBasis: classifyReadyForReviewFreshness(session, headSha, reportBindingOptions)
        .freshnessBasis,
    };
  }

  if (ownerResolution?.reason === AMBIGUOUS_IMPLICIT_HEAD_OWNER_REASON) {
    return {
      eligible: false,
      reason: 'ambiguous_head_owner',
      route: 'defer',
    };
  }

  const quiescence = evaluateQuiescentHandoffFallback({
    session,
    headSha,
    nowMs,
    headCommittedAtMs,
    workerDeliveries,
    ownerResolution,
  });

  if (quiescence.eligible) {
    if (ciLevel === 'degraded') {
      return buildDegradedCiRetryDecision({
        session,
        headSha,
        reportBindingOptions,
        degradedCiAttempts,
        maxDegradedCiAttempts,
      });
    }
    return {
      eligible: true,
      reason: QUIESCENT_HANDOFF_START_REASON,
      route: 'start_review',
      ciLevel,
      quiescenceBasis: quiescence.basis,
    };
  }

  if (quiescence.failClosed) {
    return {
      eligible: false,
      reason: quiescence.reason,
      route: 'defer',
    };
  }

  return {
    eligible: false,
    reason: 'uncovered_not_ready',
    route: 'defer',
  };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[] | import('./review-trigger-reconcile.mjs').OpenPr} [openPrs]
 * @param {number} prNumber
 */
export function resolveCurrentPrHeadSha(openPrs, prNumber) {
  for (const pr of toArray(openPrs)) {
    if (Number(pr?.number) === prNumber) {
      return String(pr?.headRefOid ?? '');
    }
  }
  return '';
}

/**
 * Pre-run revalidation immediately before ao review run (widens #189 PRE-RUN COVERAGE RE-CHECK).
 *
 * @param {object} planned
 * @param {number} planned.prNumber
 * @param {string} planned.headSha
 * @param {object} fresh
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} [fresh.openPrs]
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} fresh.reviewRuns
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} fresh.sessions
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} [fresh.ciChecks]
 * @param {string[]} [fresh.requiredCheckNames]
 * @param {boolean} [fresh.requiredCheckLookupFailed]
 * @param {number} [fresh.nowMs]
 * @param {Array<Record<string, unknown>>} [fresh.workerDeliveries]
 * @param {{ sessionId?: string | null, reason?: string, failClosed?: boolean }} [fresh.ownerResolution]
 * @param {Record<string, unknown>} [fresh.cycleState]
 * @param {Record<string, unknown>} [fresh.sharedCycleState]
 * @param {Record<string, { sessionId?: string, sentAtMs?: number }>} [fresh.legacyNudged]
 * @param {string} [fresh.repoRoot]
 */
export function preRunHeadReadyRecheck(planned, fresh) {
  const prNumber = Number(planned?.prNumber);
  const plannedHead = normalizeSha(String(planned?.headSha ?? ''));
  const currentHead = normalizeSha(resolveCurrentPrHeadSha(fresh?.openPrs, prNumber));
  const nowMs = Number(fresh?.nowMs) || Date.now();
  const workerDeliveries = mergeWorkerDeliveriesFromPlanInput({
    workerDeliveries: fresh?.workerDeliveries,
    aoEvents: fresh?.aoEvents,
    dispatchJournal: fresh?.dispatchJournal,
    reviewRuns: fresh?.reviewRuns,
    reactionMessages: fresh?.reactionMessages,
    nowMs,
  });

  if (!plannedHead || !currentHead) {
    return {
      emitReviewRun: false,
      reason: 'pre_run_recheck_head_unresolved',
      decision: {
        eligible: false,
        reason: 'head_unresolved',
        route: 'none',
      },
    };
  }

  if (plannedHead !== currentHead) {
    return {
      emitReviewRun: false,
      reason: 'pre_run_recheck_head_advanced',
      decision: {
        eligible: false,
        reason: 'head_advanced_since_plan',
        route: 'none',
      },
    };
  }

  const resolved =
    fresh?.ownerResolution != null
      ? {
          ownerResolution: fresh.ownerResolution,
          session:
            fresh.ownerResolution.sessionId && !fresh.ownerResolution.failClosed
              ? findSessionById(
                  toArray(fresh.sessions),
                  String(fresh.ownerResolution.sessionId),
                )
              : null,
        }
      : resolveReconcileEvaluationSession(
          toArray(fresh.sessions),
          prNumber,
          currentHead,
          toArray(fresh.openPrs),
        );
  const ownerResolution = resolved.ownerResolution;
  const session = resolved.session;

  if (ownerResolution?.failClosed) {
    const reason = String(ownerResolution.reason ?? 'owner_unresolved');
    return {
      emitReviewRun: false,
      reason: `pre_run_recheck_${reason}`,
      decision: {
        eligible: false,
        reason,
        route: 'none',
      },
    };
  }

  const plannedSessionId = String(planned?.sessionId ?? '');
  if (
    ownerResolution.sessionId &&
    plannedSessionId &&
    plannedSessionId !== ownerResolution.sessionId
  ) {
    return {
      emitReviewRun: false,
      reason: 'pre_run_recheck_owner_drift',
      decision: {
        eligible: false,
        reason: 'owner_drift_since_plan',
        route: 'none',
      },
    };
  }

  const sessionForRecheck =
    plannedSessionId
      ? findSessionById(toArray(fresh.sessions), plannedSessionId)
      : session;

  const reviewRuns = toArray(fresh.reviewRuns);
  const failedRun = findFailedOrCancelledRunForHead(reviewRuns, prNumber, currentHead);
  const failedRetryEligible =
    failedRun != null &&
    !isHeadCovered(reviewRuns, prNumber, currentHead) &&
    (failedRun.retryEligible ?? failedRun.retryCount == null) !== false;

  const decision = evaluateHeadReadyForReview({
    reviewRuns,
    prNumber,
    headSha: currentHead,
    session: sessionForRecheck ?? null,
    ciChecks: toArray(fresh.ciChecks),
    requiredCheckNames: toArray(fresh.requiredCheckNames),
    requiredCheckLookupFailed: Boolean(fresh.requiredCheckLookupFailed),
    degradedCiAttempts: Number(fresh.degradedCiAttempts ?? 0),
    maxDegradedCiAttempts: resolveMaxDegradedCiAttempts(fresh),
    headCommittedAtMs: resolveHeadCommittedAtMs(fresh?.openPrs, prNumber),
    ownerResolution,
    nowMs,
    workerDeliveries,
    allowFailedRetry: failedRetryEligible,
  });

  const startReason = String(planned?.startReason ?? '');
  if (decision.eligible && startReason === 'quiescent_worker_handoff_fallback') {
    const ownerSessionId = String(
      plannedSessionId || ownerResolution?.sessionId || getSessionIdentifier(sessionForRecheck) || '',
    );
    const mergedCycleState = mergeSharedWorkerIterationCycleState(
      { ...(fresh?.cycleState ?? {}) },
      fresh?.sharedCycleState ?? {},
    );
    const cycleEval = evaluateWorkerIterationCycleForPr({
      cycleState: mergedCycleState,
      repoRoot: fresh?.repoRoot ?? '',
      prNumber,
      headSha: currentHead,
      ownerSessionId,
      reviewRuns,
      session: sessionForRecheck ?? null,
      workerDeliveries,
      nowMs,
      headCommittedAtMs: resolveHeadCommittedAtMs(fresh?.openPrs, prNumber),
      handoffAccepted: false,
      legacyNudged: fresh?.legacyNudged ?? null,
    });
    const nudgePrecedence = evaluateQuiescentFallbackNudgePrecedence(cycleEval, nowMs);
    if (nudgePrecedence.blocked) {
      return {
        emitReviewRun: false,
        reason: `pre_run_recheck_${nudgePrecedence.reason}`,
        decision: {
          eligible: false,
          reason: nudgePrecedence.reason,
          route: 'none',
        },
      };
    }
  }

  return {
    emitReviewRun: decision.eligible,
    reason: decision.eligible
      ? failedRetryEligible
        ? 'failed_retry_after_recheck'
        : 'head_ready_after_recheck'
      : `pre_run_recheck_${decision.reason}`,
    decision,
  };
}

/**
 * Stale ready_for_review on an older head does not authorize the current head.
 *
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} currentHeadSha
 * @param {{ headCommittedAtMs?: number }} [options]
 */
export function hasStaleReadyForReviewOnOlderHead(session, currentHeadSha, options = {}) {
  return (
    classifyReadyForReviewFreshness(session, currentHeadSha, options).freshnessBasis ===
    FRESHNESS_BASIS_STALE_ONLY
  );
}

/**
 * Enumerable not-ready components for defer records (Issue #212).
 * Documented precedence for `primary` — stable, not evaluation-order incidental.
 */
export const NOT_READY_COMPONENT_PRECEDENCE = [
  'failed_or_cancelled_on_head',
  'degraded_ci_handoff',
  'no_ready_for_review',
  'stale_report_binding',
  'ci_red',
  'ci_degraded',
  'ci_not_yet_observed',
];

/**
 * @param {string[]} components
 */
export function choosePrimaryNotReadyComponent(components) {
  for (const candidate of NOT_READY_COMPONENT_PRECEDENCE) {
    if (components.includes(candidate)) {
      return candidate;
    }
  }
  return components[0] ?? 'unknown';
}

/**
 * @param {Record<string, unknown> | null | undefined} report
 */
export function resolveReportRoute(report) {
  if (!report) {
    return 'none';
  }
  if (isWorkerDegradedCiHandoff(report)) {
    return 'degraded_ci';
  }
  const state = getReportState(report);
  if (state === 'ready_for_review') {
    return 'ready_for_review';
  }
  if (state) {
    return state;
  }
  return 'other';
}

/**
 * Latest `ready_for_review` report bound to a head other than the current one.
 *
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} currentHeadSha
 * @param {{ headCommittedAtMs?: number }} [options]
 */
export function findLatestStaleReadyForReviewReport(session, currentHeadSha, options = {}) {
  const current = normalizeSha(currentHeadSha);
  if (!current) {
    return null;
  }

  let best = null;
  let bestMs = -1;
  for (const report of toArray(session?.reports)) {
    if (getReportState(report) !== 'ready_for_review') {
      continue;
    }
    const stored = getStoredReportHeadSha(report);
    const isStale =
      (stored && stored !== current) ||
      (!stored &&
        Number.isFinite(Number(options.headCommittedAtMs)) &&
        Number(options.headCommittedAtMs) > 0 &&
        getReportTimestampMs(report) > 0 &&
        Number(options.headCommittedAtMs) > getReportTimestampMs(report));
    if (!isStale) {
      continue;
    }
    const ms = getReportTimestampMs(report);
    if (ms >= bestMs) {
      bestMs = ms;
      best = report;
    }
  }
  return best;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} headSha
 * @param {{ headCommittedAtMs?: number }} [options]
 */
function findLatestReportBoundToHead(session, headSha, options = {}) {
  return findLatestReportForHead(session, headSha, options);
}

/**
 * Evaluate every head-ready component that is not satisfied (metadata only).
 *
 * @param {object} input
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} input.session
 * @param {string} input.headSha
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} input.ciChecks
 * @param {string[]} input.requiredCheckNames
 * @param {boolean} input.requiredCheckLookupFailed
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} input.reviewRuns
 * @param {number} input.prNumber
 * @param {number} [input.headCommittedAtMs]
 */
export function collectFailedNotReadyComponents({
  session,
  headSha,
  ciChecks = [],
  requiredCheckNames = [],
  requiredCheckLookupFailed = false,
  reviewRuns = [],
  prNumber,
  headCommittedAtMs,
}) {
  const reportBindingOptions = { headCommittedAtMs };
  /** @type {string[]} */
  const failed = [];

  if (hasFailedOrCancelledOnHead(reviewRuns, prNumber, headSha)) {
    failed.push('failed_or_cancelled_on_head');
    return failed;
  }

  if (!session) {
    return failed;
  }

  const classification = classifyReadyForReviewFreshness(
    session,
    headSha,
    reportBindingOptions,
  );
  const latestReport = findLatestReportBoundToHead(session, headSha, reportBindingOptions);
  const readyForReview = classification.freshnessBasis === FRESHNESS_BASIS_FRESH;
  const degradedHandoff = isWorkerDegradedCiHandoff(latestReport);

  if (classification.freshnessBasis === FRESHNESS_BASIS_STALE_ONLY) {
    failed.push('no_ready_for_review');
    failed.push('stale_report_binding');
  } else if (
    classification.freshnessBasis === FRESHNESS_BASIS_NO_REPORT ||
    classification.freshnessBasis === FRESHNESS_BASIS_AMBIGUOUS
  ) {
    failed.push('no_ready_for_review');
  }
  if (degradedHandoff) {
    failed.push('degraded_ci_handoff');
  }

  const ciLevel = classifyRequiredCiForReviewTrigger(ciChecks, {
    requiredCheckNames,
    requiredCheckLookupFailed,
  });
  if (ciLevel === 'red') {
    failed.push('ci_red');
  } else if (ciLevel === 'degraded') {
    const checksEmpty = toArray(ciChecks).length === 0;
    if (checksEmpty && !requiredCheckLookupFailed) {
      failed.push('ci_not_yet_observed');
    } else {
      failed.push('ci_degraded');
    }
  }

  return failed;
}

/**
 * @param {object} input
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} [input.session]
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} [input.ciChecks]
 * @param {string[]} [input.requiredCheckNames]
 * @param {boolean} [input.requiredCheckLookupFailed]
 * @param {number} [input.headCommittedAtMs]
 */
export function buildReportCiObserved({
  prNumber,
  headSha,
  session = null,
  ciChecks = [],
  requiredCheckNames = [],
  requiredCheckLookupFailed = false,
  headCommittedAtMs,
}) {
  const currentHeadSha = normalizeSha(headSha);
  const reportBindingOptions = { headCommittedAtMs };
  const latestReportOnCurrentHead = session
    ? findLatestReportBoundToHead(session, currentHeadSha, reportBindingOptions)
    : null;
  const staleReadyReport = session
    ? findLatestStaleReadyForReviewReport(session, currentHeadSha, reportBindingOptions)
    : null;

  let reportBoundHeadSha = '';
  let reportRoute = 'none';
  if (latestReportOnCurrentHead) {
    const stored = getStoredReportHeadSha(latestReportOnCurrentHead);
    reportBoundHeadSha = stored || currentHeadSha;
    reportRoute = resolveReportRoute(latestReportOnCurrentHead);
  } else if (staleReadyReport) {
    const stored = getStoredReportHeadSha(staleReadyReport);
    reportBoundHeadSha = stored || 'stale_sha_less_handoff';
    reportRoute = 'ready_for_review';
  }

  const ciLevel = classifyRequiredCiForReviewTrigger(ciChecks, {
    requiredCheckNames,
    requiredCheckLookupFailed,
  });
  const effectiveRequired =
    toArray(requiredCheckNames).length > 0
      ? toArray(requiredCheckNames)
      : PACK_MERGE_CONTRACT_CHECK_NAMES;
  const requiredCheckSource =
    toArray(requiredCheckNames).length > 0 ? 'branch_protection' : 'pack_merge_contract_fallback';

  const classification = session
    ? classifyReadyForReviewFreshness(session, currentHeadSha, reportBindingOptions)
    : { freshnessBasis: FRESHNESS_BASIS_NO_REPORT };
  /** @type {Record<string, unknown>} */
  const observed = {
    freshnessBasis: classification.freshnessBasis,
    prNumber,
    currentHeadSha,
    reportBoundHeadSha: reportBoundHeadSha || 'none',
    reportRoute,
    ciLevel,
    requiredCheckSource,
    requiredCheckNames: effectiveRequired,
    requiredCheckLookupFailed: Boolean(requiredCheckLookupFailed),
  };

  if (staleReadyReport) {
    const stored = getStoredReportHeadSha(staleReadyReport);
    observed.staleReadyForReviewHeadSha = stored || 'stale_sha_less_handoff';
    observed.staleReadyForReviewRoute = 'ready_for_review';
  }

  return observed;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | null} run
 * @param {number} prNumber
 * @param {string} headSha
 */
export function buildCoveredSkipObserved(run, prNumber, headSha) {
  const normalizedHead = normalizeSha(headSha);
  return {
    prNumber,
    currentHeadSha: normalizedHead,
    coveringRunId: String(run?.id ?? run?.runId ?? ''),
    coveringRunStatus: String(run?.status ?? ''),
    headMatch: normalizeSha(run?.targetSha) === normalizedHead,
    prMatch: Number(run?.prNumber) === prNumber,
  };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | null} run
 * @param {number} prNumber
 * @param {string} headSha
 */
export function buildFailedCancelledObserved(run, prNumber, headSha) {
  return {
    prNumber,
    currentHeadSha: normalizeSha(headSha),
    runId: String(run?.id ?? run?.runId ?? ''),
    status: String(run?.status ?? ''),
    terminationReason: String(run?.terminationReason ?? ''),
    retryEligible: run?.retryEligible ?? run?.retryCount == null,
  };
}

/**
 * Branch-complete no-start decision record (metadata only; Issue #212).
 *
 * @param {object} input
 * @param {string} input.reason
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} input.reviewRuns
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} [input.session]
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} [input.ciChecks]
 * @param {string[]} [input.requiredCheckNames]
 * @param {boolean} [input.requiredCheckLookupFailed]
 * @param {number} [input.headCommittedAtMs]
 */
export function buildNoStartDecisionRecord({
  reason,
  prNumber,
  headSha,
  reviewRuns,
  session = null,
  ciChecks = [],
  requiredCheckNames = [],
  requiredCheckLookupFailed = false,
  headCommittedAtMs,
}) {
  const normalizedHead = normalizeSha(headSha);

  // Match evaluateHeadReadyForReview: failed/cancelled before coverage (#212 / EMPTY REVIEW TRAP).
  if (reason === 'failed_or_cancelled_on_head' || hasFailedOrCancelledOnHead(reviewRuns, prNumber, headSha)) {
    const failedRun = findFailedOrCancelledRunForHead(reviewRuns, prNumber, headSha);
    return {
      branch: 'failed_or_cancelled',
      reason: 'failed_or_cancelled_on_head',
      primary: 'failed_or_cancelled_on_head',
      failedComponents: ['failed_or_cancelled_on_head'],
      observed: buildFailedCancelledObserved(failedRun, prNumber, normalizedHead),
    };
  }

  if (reason === 'head_covered' || isHeadCovered(reviewRuns, prNumber, headSha)) {
    const coveringRun = findCoveringRunForHead(reviewRuns, prNumber, headSha);
    return {
      branch: 'head_covered',
      reason: 'head_covered',
      primary: 'head_covered',
      failedComponents: [],
      observed: buildCoveredSkipObserved(coveringRun, prNumber, normalizedHead),
    };
  }

  if (reason === 'no_worker_session') {
    return {
      branch: 'no_worker_session',
      reason: 'no_worker_session',
      primary: 'no_worker_session',
      failedComponents: ['no_worker_session'],
      observed: buildReportCiObserved({
        prNumber,
        headSha: normalizedHead,
        session: null,
        ciChecks,
        requiredCheckNames,
        requiredCheckLookupFailed,
        headCommittedAtMs,
      }),
    };
  }

  if (reason === 'no_live_review_target' || reason === 'ambiguous_head_owner') {
    return {
      branch: reason,
      reason,
      primary: reason,
      failedComponents: [reason],
      observed: buildReportCiObserved({
        prNumber,
        headSha: normalizedHead,
        session,
        ciChecks,
        requiredCheckNames,
        requiredCheckLookupFailed,
        headCommittedAtMs,
      }),
    };
  }

  if (reason === 'ready_for_review_debounce_pending') {
    const classification = classifyReadyForReviewFreshness(session, normalizedHead, {
      headCommittedAtMs,
    });
    return {
      branch: 'ready_for_review_debounce_pending',
      reason,
      primary: 'ready_for_review_debounce_pending',
      failedComponents: ['ready_for_review_debounce_pending'],
      observed: {
        ...buildReportCiObserved({
          prNumber,
          headSha: normalizedHead,
          session,
          ciChecks,
          requiredCheckNames,
          requiredCheckLookupFailed,
          headCommittedAtMs,
        }),
        freshnessBasis: classification.freshnessBasis,
      },
    };
  }

  const classification = classifyReadyForReviewFreshness(session, normalizedHead, {
    headCommittedAtMs,
  });
  const failedComponents = collectFailedNotReadyComponents({
    session,
    headSha: normalizedHead,
    ciChecks,
    requiredCheckNames,
    requiredCheckLookupFailed,
    reviewRuns,
    prNumber,
    headCommittedAtMs,
  });
  const primary = choosePrimaryNotReadyComponent(failedComponents);
  const observed = {
    ...buildReportCiObserved({
      prNumber,
      headSha: normalizedHead,
      session,
      ciChecks,
      requiredCheckNames,
      requiredCheckLookupFailed,
      headCommittedAtMs,
    }),
    freshnessBasis: classification.freshnessBasis,
  };

  return {
    branch: 'uncovered_not_ready',
    reason,
    primary,
    failedComponents,
    observed,
  };
}

/**
 * @param {ReturnType<typeof buildNoStartDecisionRecord>} record
 */
export function formatDecisionRecordForLog(record) {
  return JSON.stringify({
    branch: record.branch,
    primary: record.primary,
    failedComponents: record.failedComponents,
    observed: record.observed,
  });
}
