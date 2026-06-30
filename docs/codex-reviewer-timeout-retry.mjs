/**
 * Shared timeout/no-verdict retry and escalation helpers (Issue #461).
 */

import {
  findFailedOrCancelledRunForHead,
  normalizeSha,
  toArray,
} from './review-trigger-reconcile.mjs';

export const TIMEOUT_NO_VERDICT_FAILURE_CLASS = 'timeout_no_verdict';
export const REPEATED_TIMEOUT_ESCALATION_REASON = 'repeated_timeout_no_verdict';
export const REVIEWER_EVIDENCE_PREFIX = 'reviewer-evidence:';
export const DEFAULT_TIMEOUT_RETRY_MAX = 1;

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseNonNegativeInt(raw, fallback) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function resolveTimeoutRetryMax(env = process.env) {
  return parseNonNegativeInt(env.AO_CODEX_REVIEW_TIMEOUT_RETRY_MAX, DEFAULT_TIMEOUT_RETRY_MAX);
}

/**
 * @param {string} text
 */
export function extractReviewerEvidenceFromText(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REVIEWER_EVIDENCE_PREFIX)) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed.slice(REVIEWER_EVIDENCE_PREFIX.length));
      if (parsed?.reviewer && typeof parsed.reviewer.effectiveBudgetMs === 'number') {
        return parsed;
      }
    } catch {
      // ignore malformed marker lines
    }
  }
  return null;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | null | undefined} run
 */
export function extractReviewerFailureClass(run) {
  const direct = run?.reviewer?.failureClass ?? run?.failureClass;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const termination = String(run?.terminationReason ?? '');
  const evidence = extractReviewerEvidenceFromText(termination);
  const fromEvidence = evidence?.reviewer?.failureClass;
  if (typeof fromEvidence === 'string' && fromEvidence.trim()) {
    return fromEvidence.trim();
  }
  if (/timeout before verdict/i.test(termination)) {
    return TIMEOUT_NO_VERDICT_FAILURE_CLASS;
  }
  return null;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} headSha
 * @param {string} failureClass
 */
export function countSameHeadFailuresByClass(runs, prNumber, headSha, failureClass) {
  const head = normalizeSha(headSha);
  return toArray(runs).filter((run) => {
    const status = String(run?.status ?? '').toLowerCase();
    if (status !== 'failed' && status !== 'cancelled') {
      return false;
    }
    if (Number(run?.prNumber) !== prNumber || normalizeSha(run?.targetSha) !== head) {
      return false;
    }
    return extractReviewerFailureClass(run) === failureClass;
  }).length;
}

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

export { resolveFailedRunRetryEligibility } from './autonomous-review-retry.mjs';
