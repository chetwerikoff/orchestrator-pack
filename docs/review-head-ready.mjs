/**
 * Canonical "head ready for review" predicate (Issue #195).
 * Shared by report-driven triggers, ROUND PROGRESSION, and review-trigger-reconcile.
 * Vitest: scripts/review-head-ready.test.ts
 */
import { classifyRequiredCiLevel } from './ci-green-wake-reconcile.mjs';
import { getReportState } from './review-finding-delivery-confirm.mjs';
import {
  findLatestReportForHead,
  getReportHeadSha,
  PACK_MERGE_CONTRACT_CHECK_NAMES,
} from './review-ready-stuck-guard.mjs';
import {
  findSessionById,
  hasFailedOrCancelledOnHead,
  isHeadCovered,
  normalizeSha,
  toArray,
} from './review-trigger-reconcile.mjs';

export { hasFailedOrCancelledOnHead } from './review-trigger-reconcile.mjs';

/** Bounded orchestrator/reconciler re-attempts when required-check visibility is degraded. */
export const DEFAULT_DEGRADED_CI_MAX_ATTEMPTS = 3;

export const DEGRADED_CI_MAX_ATTEMPTS_ENV = 'AO_REVIEW_DEGRADED_CI_MAX_ATTEMPTS';

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
 */
export function findLatestAcceptedReportForHead(session, headSha) {
  return findLatestReportForHead(session, headSha);
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} headSha
 */
export function hasReadyForReviewForHead(session, headSha) {
  const latest = findLatestAcceptedReportForHead(session, headSha);
  if (!latest) {
    return false;
  }
  return getReportState(latest) === 'ready_for_review';
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
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} input.reviewRuns
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} [input.session]
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} [input.ciChecks]
 * @param {string[]} [input.requiredCheckNames]
 * @param {boolean} [input.requiredCheckLookupFailed]
 * @param {number} [input.degradedCiAttempts]
 * @param {number} [input.maxDegradedCiAttempts]
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
}) {
  if (hasFailedOrCancelledOnHead(reviewRuns, prNumber, headSha)) {
    return {
      eligible: false,
      reason: 'failed_or_cancelled_on_head',
      route: 'empty_review_trap',
    };
  }

  if (isHeadCovered(reviewRuns, prNumber, headSha)) {
    return { eligible: false, reason: 'head_covered', route: 'none' };
  }

  if (!session) {
    return { eligible: false, reason: 'no_worker_session', route: 'none' };
  }

  const latestReport = findLatestAcceptedReportForHead(session, headSha);
  const degradedHandoff = isWorkerDegradedCiHandoff(latestReport);
  const readyForReview = hasReadyForReviewForHead(session, headSha);

  if (!readyForReview && !degradedHandoff) {
    return {
      eligible: false,
      reason: 'uncovered_not_ready',
      route: 'defer',
    };
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

  if (ciLevel === 'degraded') {
    const attempts = Math.max(0, Number(degradedCiAttempts) || 0);
    if (attempts >= maxDegradedCiAttempts) {
      return {
        eligible: false,
        reason: 'degraded_ci_escalate_operator',
        route: 'escalate_operator',
        degradedCiAttempts: attempts,
      };
    }
    return {
      eligible: false,
      reason: degradedHandoff ? 'degraded_ci_worker_handoff' : 'degraded_ci_visibility',
      route: 'degraded_ci_retry',
      degradedCiAttempts: attempts + 1,
    };
  }

  if (!readyForReview && degradedHandoff) {
    return {
      eligible: false,
      reason: 'degraded_ci_worker_handoff_pending_resolution',
      route: 'degraded_ci_retry',
      degradedCiAttempts: Math.max(0, Number(degradedCiAttempts) || 0) + 1,
    };
  }

  return {
    eligible: true,
    reason: 'head_ready_for_review',
    route: 'start_review',
    ciLevel,
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
 */
export function preRunHeadReadyRecheck(planned, fresh) {
  const prNumber = Number(planned?.prNumber);
  const plannedHead = normalizeSha(String(planned?.headSha ?? ''));
  const currentHead = normalizeSha(resolveCurrentPrHeadSha(fresh?.openPrs, prNumber));
  const session = findSessionById(toArray(fresh.sessions), String(planned?.sessionId ?? ''));

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

  const decision = evaluateHeadReadyForReview({
    reviewRuns: toArray(fresh.reviewRuns),
    prNumber,
    headSha: currentHead,
    session: session ?? null,
    ciChecks: toArray(fresh.ciChecks),
    requiredCheckNames: toArray(fresh.requiredCheckNames),
    requiredCheckLookupFailed: Boolean(fresh.requiredCheckLookupFailed),
    degradedCiAttempts: Number(fresh.degradedCiAttempts ?? 0),
    maxDegradedCiAttempts: resolveMaxDegradedCiAttempts(fresh),
  });

  return {
    emitReviewRun: decision.eligible,
    reason: decision.eligible ? 'head_ready_after_recheck' : `pre_run_recheck_${decision.reason}`,
    decision,
  };
}

/**
 * Stale ready_for_review on an older head does not authorize the current head.
 *
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} currentHeadSha
 */
export function hasStaleReadyForReviewOnOlderHead(session, currentHeadSha) {
  const current = normalizeSha(currentHeadSha);
  if (!current) {
    return false;
  }

  let foundStale = false;
  for (const report of toArray(session?.reports)) {
    if (getReportState(report) !== 'ready_for_review') {
      continue;
    }
    const reportHead = getReportHeadSha(report);
    if (reportHead && reportHead !== current) {
      foundStale = true;
    }
  }
  return foundStale;
}
