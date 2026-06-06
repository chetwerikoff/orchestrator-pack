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
  findCoveringRunForHead,
  findFailedOrCancelledRunForHead,
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
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} headSha
 */
function findLatestReportBoundToHead(session, headSha) {
  const target = normalizeSha(headSha);
  if (!target) {
    return null;
  }
  let best = null;
  let bestMs = -1;
  for (const report of toArray(session?.reports)) {
    const reportHead = getReportHeadSha(report);
    if (!reportHead || reportHead !== target) {
      continue;
    }
    const ts = Date.parse(
      String(
        report?.reportedAt ??
          report?.timestamp ??
          report?.createdAt ??
          report?.reported_at ??
          report?.created_at ??
          '',
      ),
    );
    const ms = Number.isFinite(ts) ? ts : 0;
    if (ms >= bestMs) {
      bestMs = ms;
      best = report;
    }
  }
  return best;
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
 */
export function collectFailedNotReadyComponents({
  session,
  headSha,
  ciChecks = [],
  requiredCheckNames = [],
  requiredCheckLookupFailed = false,
  reviewRuns = [],
  prNumber,
}) {
  /** @type {string[]} */
  const failed = [];

  if (hasFailedOrCancelledOnHead(reviewRuns, prNumber, headSha)) {
    failed.push('failed_or_cancelled_on_head');
    return failed;
  }

  if (!session) {
    return failed;
  }

  const latestReport = findLatestReportBoundToHead(session, headSha);
  const readyForReview = hasReadyForReviewForHead(session, headSha);
  const degradedHandoff = isWorkerDegradedCiHandoff(latestReport);

  if (!readyForReview) {
    failed.push('no_ready_for_review');
  }
  if (hasStaleReadyForReviewOnOlderHead(session, headSha)) {
    failed.push('stale_report_binding');
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
 */
export function buildReportCiObserved({
  prNumber,
  headSha,
  session = null,
  ciChecks = [],
  requiredCheckNames = [],
  requiredCheckLookupFailed = false,
}) {
  const currentHeadSha = normalizeSha(headSha);
  const latestReport = session ? findLatestReportBoundToHead(session, currentHeadSha) : null;
  const reportBoundHeadSha = latestReport ? getReportHeadSha(latestReport) : '';
  const reportRoute = resolveReportRoute(latestReport);
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

  return {
    prNumber,
    currentHeadSha,
    reportBoundHeadSha: reportBoundHeadSha || 'none',
    reportRoute,
    ciLevel,
    requiredCheckSource,
    requiredCheckNames: effectiveRequired,
    requiredCheckLookupFailed: Boolean(requiredCheckLookupFailed),
  };
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
}) {
  const normalizedHead = normalizeSha(headSha);

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
      }),
    };
  }

  const failedComponents = collectFailedNotReadyComponents({
    session,
    headSha: normalizedHead,
    ciChecks,
    requiredCheckNames,
    requiredCheckLookupFailed,
    reviewRuns,
    prNumber,
  });
  const primary = choosePrimaryNotReadyComponent(failedComponents);
  const observed = buildReportCiObserved({
    prNumber,
    headSha: normalizedHead,
    session,
    ciChecks,
    requiredCheckNames,
    requiredCheckLookupFailed,
  });

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
