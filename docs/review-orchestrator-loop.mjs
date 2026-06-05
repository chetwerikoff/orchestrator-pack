/**
 * LLM-orchestrator review-loop predicates (Issue #189).
 * Coverage identity matches docs/review-trigger-reconcile.mjs (Issue #163).
 * Vitest: scripts/review-orchestrator-loop.test.ts
 */
import {
  findSessionById,
  hasFailedOrCancelledOnHead,
  isHeadCovered,
  isRunCoveringHead,
  normalizeSha,
} from './review-trigger-reconcile.mjs';
import { evaluateHeadReadyForReview } from './review-head-ready.mjs';

export {
  evaluateHeadReadyForReview,
  hasReadyForReviewForHead,
  preRunHeadReadyRecheck,
} from './review-head-ready.mjs';

/** @typedef {{ id?: string, prNumber?: number | null, targetSha?: string, status?: string, findingCount?: number, linkedSessionId?: string, reviewerSessionId?: string, terminationReason?: string }} ReviewRun */
/** @typedef {{ name?: string, sessionId?: string, id?: string, role?: string, prNumber?: number | null, pr?: string | null, status?: string }} AoSession */

export {
  COVERED_TERMINAL_REVIEW_STATUSES,
  IN_FLIGHT_REVIEW_STATUSES,
  hasFailedOrCancelledOnHead,
  isHeadCovered,
  isRunCoveringHead,
  normalizeSha,
} from './review-trigger-reconcile.mjs';

/**
 * Plain uncovered path: no covered/in-flight run; not failed/cancelled discipline.
 *
 * @param {ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} headSha
 */
export function shouldStartReviewRunOnUncoveredPath(runs, prNumber, headSha) {
  if (isHeadCovered(runs, prNumber, headSha)) {
    return { start: false, reason: 'head_covered' };
  }
  if (hasFailedOrCancelledOnHead(runs, prNumber, headSha)) {
    return {
      start: false,
      reason: 'failed_or_cancelled_use_retry_discipline',
    };
  }
  return { start: true, reason: 'uncovered_head' };
}

/**
 * Issue #195 — full head-ready predicate for all review-trigger paths.
 *
 * @param {object} input
 * @param {ReviewRun[]} input.reviewRuns
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {AoSession | null} [input.session]
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} [input.ciChecks]
 * @param {string[]} [input.requiredCheckNames]
 * @param {boolean} [input.requiredCheckLookupFailed]
 * @param {number} [input.degradedCiAttempts]
 */
export function shouldStartReviewRun(input) {
  const decision = evaluateHeadReadyForReview(input);
  return {
    start: decision.eligible,
    reason: decision.reason,
    route: decision.route,
  };
}

/**
 * Pre-run re-check: second read immediately before ao review run.
 *
 * @param {object} input
 * @param {ReviewRun[]} input.runsAtTurnStart
 * @param {ReviewRun[]} input.runsImmediatelyBeforeRun
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {AoSession | null} [input.session]
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} [input.ciChecksAtStart]
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} [input.ciChecksBeforeRun]
 * @param {string[]} [input.requiredCheckNamesAtStart]
 * @param {string[]} [input.requiredCheckNamesBeforeRun]
 * @param {boolean} [input.requiredCheckLookupFailedAtStart]
 * @param {boolean} [input.requiredCheckLookupFailedBeforeRun]
 */
export function evaluateReviewRunWithRecheck({
  runsAtTurnStart,
  runsImmediatelyBeforeRun,
  prNumber,
  headSha,
  session = null,
  ciChecksAtStart = [],
  ciChecksBeforeRun = [],
  requiredCheckNamesAtStart = [],
  requiredCheckNamesBeforeRun = [],
  requiredCheckLookupFailedAtStart = false,
  requiredCheckLookupFailedBeforeRun = false,
}) {
  if (session) {
    const atStart = shouldStartReviewRun({
      reviewRuns: runsAtTurnStart,
      prNumber,
      headSha,
      session,
      ciChecks: ciChecksAtStart,
      requiredCheckNames: requiredCheckNamesAtStart,
      requiredCheckLookupFailed: requiredCheckLookupFailedAtStart,
    });
    if (!atStart.start) {
      return { emitReviewRun: false, reason: atStart.reason };
    }
    const beforeRun = shouldStartReviewRun({
      reviewRuns: runsImmediatelyBeforeRun,
      prNumber,
      headSha,
      session,
      ciChecks: ciChecksBeforeRun,
      requiredCheckNames: requiredCheckNamesBeforeRun,
      requiredCheckLookupFailed: requiredCheckLookupFailedBeforeRun,
    });
    if (!beforeRun.start) {
      return {
        emitReviewRun: false,
        reason: `pre_run_recheck_${beforeRun.reason}`,
      };
    }
    return { emitReviewRun: true, reason: 'head_ready_after_recheck' };
  }

  const atStart = shouldStartReviewRunOnUncoveredPath(
    runsAtTurnStart,
    prNumber,
    headSha,
  );
  if (!atStart.start) {
    return { emitReviewRun: false, reason: atStart.reason };
  }
  const beforeRun = shouldStartReviewRunOnUncoveredPath(
    runsImmediatelyBeforeRun,
    prNumber,
    headSha,
  );
  if (!beforeRun.start) {
    return {
      emitReviewRun: false,
      reason: `pre_run_recheck_${beforeRun.reason}`,
    };
  }
  return { emitReviewRun: true, reason: 'uncovered_after_recheck' };
}

/**
 * @param {ReviewRun} run
 */
export function getRunLinkedSessionId(run) {
  return String(run?.linkedSessionId ?? run?.reviewerSessionId ?? '').trim();
}

/**
 * @param {AoSession} session
 */
export function resolveSessionPrNumber(session) {
  const direct = Number(session?.prNumber);
  if (direct > 0) {
    return { resolved: true, prNumber: direct };
  }
  const prField = String(session?.pr ?? '').trim();
  if (!prField) {
    return { resolved: false, reason: 'ambiguous_pr_metadata' };
  }
  const normalized = prField.startsWith('#') ? prField.slice(1) : prField;
  const parsed = Number(normalized);
  if (!parsed || Number.isNaN(parsed)) {
    return { resolved: false, reason: 'ambiguous_pr_metadata' };
  }
  return { resolved: true, prNumber: parsed };
}

/**
 * @param {ReviewRun} run
 * @param {AoSession[]} sessions
 */
export function resolveRunPrViaLinkedSession(run, sessions) {
  const linkedId = getRunLinkedSessionId(run);
  if (!linkedId) {
    return { resolved: false, reason: 'linked_session_missing' };
  }
  const session = findSessionById(sessions, linkedId);
  if (!session) {
    return { resolved: false, reason: 'linked_session_missing' };
  }
  const pr = resolveSessionPrNumber(session);
  if (!pr.resolved) {
    return { resolved: false, reason: pr.reason ?? 'ambiguous_pr_metadata' };
  }
  return {
    resolved: true,
    prNumber: pr.prNumber,
    session,
    linkedId,
  };
}

/**
 * Linked id absent from ao status while other worker sessions exist (restore race).
 *
 * @param {ReviewRun} run
 * @param {AoSession[]} sessions
 */
export function hasRestoredSessionIdMismatch(run, sessions) {
  const linkedId = getRunLinkedSessionId(run);
  if (!linkedId || findSessionById(sessions, linkedId)) {
    return false;
  }
  return sessions.some((session) => {
    const role = String(session?.role ?? '').toLowerCase();
    return role === 'worker' || role === 'coding';
  });
}

/**
 * @param {number} prNumber
 * @param {Set<number> | number[] | Record<string, boolean>} mergedPrNumbers
 */
export function isPrMergedOnGitHub(prNumber, mergedPrNumbers) {
  if (mergedPrNumbers instanceof Set) {
    return mergedPrNumbers.has(prNumber);
  }
  if (Array.isArray(mergedPrNumbers)) {
    return mergedPrNumbers.includes(prNumber);
  }
  return Boolean(mergedPrNumbers?.[String(prNumber)] ?? mergedPrNumbers?.[prNumber]);
}

/**
 * MERGED PR terminal for prNumber-less runs (Issue #54 residual, Issue #189).
 *
 * @param {ReviewRun} run
 * @param {AoSession[]} sessions
 * @param {Set<number> | number[] | Record<string, boolean>} mergedPrNumbers
 */
export function evaluatePrNumberLessMergedRun(run, sessions, mergedPrNumbers) {
  if (Number(run?.prNumber) > 0) {
    return { action: 'use_run_pr_number', terminal: false };
  }
  if (hasRestoredSessionIdMismatch(run, sessions)) {
    return {
      action: 'inaction_fail_closed',
      terminal: false,
      reason: 'restored_session_id_mismatch',
    };
  }
  const resolution = resolveRunPrViaLinkedSession(run, sessions);
  if (!resolution.resolved) {
    return {
      action: 'inaction_fail_closed',
      terminal: false,
      reason: resolution.reason ?? 'linked_session_missing',
    };
  }
  if (isPrMergedOnGitHub(resolution.prNumber, mergedPrNumbers)) {
    return {
      action: 'inaction_merged_terminal',
      terminal: true,
      prNumber: resolution.prNumber,
      reason: 'merged_pr_via_linked_session',
    };
  }
  return { action: 'not_merged', terminal: false, prNumber: resolution.prNumber };
}

/**
 * Orchestrator inaction on a review run (no send / no new round / no lifecycle).
 *
 * @param {ReviewRun} run
 * @param {AoSession[]} sessions
 * @param {Set<number> | number[] | Record<string, boolean>} mergedPrNumbers
 */
export function shouldOrchestratorActOnRun(run, sessions, mergedPrNumbers) {
  const merged = evaluatePrNumberLessMergedRun(run, sessions, mergedPrNumbers);
  if (merged.terminal || merged.action === 'inaction_fail_closed') {
    return { act: false, ...merged };
  }
  const prNumber = Number(run?.prNumber);
  if (prNumber > 0 && isPrMergedOnGitHub(prNumber, mergedPrNumbers)) {
    return {
      act: false,
      terminal: true,
      action: 'inaction_merged_terminal',
      prNumber,
      reason: 'merged_pr_on_run',
    };
  }
  return { act: true, action: 'may_proceed' };
}
