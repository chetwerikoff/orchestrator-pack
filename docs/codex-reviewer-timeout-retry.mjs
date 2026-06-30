/**
 * Shared timeout/no-verdict retry and escalation helpers (Issue #461).
 */

import {
  TIMEOUT_NO_VERDICT_FAILURE_CLASS,
  REPEATED_TIMEOUT_ESCALATION_REASON,
  resolveTimeoutRetryMax,
  extractReviewerEvidenceFromText,
  extractReviewerFailureClass,
  countSameHeadFailuresByClass,
} from './reviewer-failure-evidence-markers.mjs';
import { findFailedOrCancelledRunForHead } from './review-trigger-reconcile.mjs';

export {
  TIMEOUT_NO_VERDICT_FAILURE_CLASS,
  REPEATED_TIMEOUT_ESCALATION_REASON,
  REVIEWER_EVIDENCE_PREFIX,
  DEFAULT_TIMEOUT_RETRY_MAX,
  resolveTimeoutRetryMax,
  extractReviewerEvidenceFromText,
  extractReviewerFailureClass,
  countSameHeadFailuresByClass,
} from './reviewer-failure-evidence-markers.mjs';

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} reviewRuns
 * @param {number} prNumber
 * @param {string} headSha
 * @param {{ maxRetries?: number }} [options]
 */
export function evaluateTimeoutRetryEligibility(reviewRuns, prNumber, headSha, options = {}) {
  const failedRun = findFailedOrCancelledRunForHead(reviewRuns, prNumber, headSha);
  if (!failedRun) {
    return {
      failureClass: null,
      retryEligible: true,
      escalationReason: null,
      timeoutFailureCount: 0,
    };
  }

  const failureClass = extractReviewerFailureClass(failedRun);
  if (failureClass !== TIMEOUT_NO_VERDICT_FAILURE_CLASS) {
    return {
      failureClass,
      retryEligible: failedRun.retryEligible === true,
      escalationReason: null,
      timeoutFailureCount: 0,
    };
  }

  const timeoutFailureCount = countSameHeadFailuresByClass(
    reviewRuns,
    prNumber,
    headSha,
    TIMEOUT_NO_VERDICT_FAILURE_CLASS,
  );
  const maxRetries = Number(options.maxRetries ?? resolveTimeoutRetryMax());
  const retryEligible = timeoutFailureCount <= maxRetries;
  return {
    failureClass,
    retryEligible,
    escalationReason: retryEligible ? null : REPEATED_TIMEOUT_ESCALATION_REASON,
    timeoutFailureCount,
  };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | null | undefined} run
 */
export function buildTimeoutRetryObserved(run) {
  const evidence = extractReviewerEvidenceFromText(String(run?.terminationReason ?? ''));
  return {
    effectiveBudgetMs: evidence?.reviewer?.effectiveBudgetMs ?? run?.reviewer?.effectiveBudgetMs,
    testBudgetDecision: evidence?.reviewer?.testBudgetDecision ?? run?.reviewer?.testBudgetDecision,
    failureClass: extractReviewerFailureClass(run),
    escalationReason: evidence?.reviewer?.escalationReason ?? run?.reviewer?.escalationReason,
  };
}
