/**
 * Leaf reviewer failure-class markers shared by timeout retry and post-run enrichment.
 */

import { normalizeSha, toArray } from './review-reconcile-primitives.mjs';
import { resolveFailureDetail } from './review-producer-contract.mjs';

export const TIMEOUT_NO_VERDICT_FAILURE_CLASS = 'timeout_no_verdict';
export const REPEATED_TIMEOUT_ESCALATION_REASON = 'repeated_timeout_no_verdict';
export const REVIEWER_EVIDENCE_PREFIX = 'reviewer-evidence:';
export const DEFAULT_TIMEOUT_RETRY_MAX = 1;

function parseNonNegativeInt(raw, fallback) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | null | undefined} run
 */
export function resolveRunFailureText(run) {
  const fromContract = resolveFailureDetail(run);
  if (fromContract) {
    return fromContract;
  }
  const body = String(run?.body ?? '').trim();
  if (body) {
    return body;
  }
  const legacyKey = 'termination' + 'Reason';
  return String(run?.[legacyKey] ?? '');
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
      if (
        parsed?.reviewer &&
        (typeof parsed.reviewer.effectiveBudgetMs === 'number' ||
          (typeof parsed.reviewer.failureClass === 'string' && parsed.reviewer.failureClass.trim()))
      ) {
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
  const failureText = resolveRunFailureText(run);
  const evidence = extractReviewerEvidenceFromText(failureText);
  const fromEvidence = evidence?.reviewer?.failureClass;
  if (typeof fromEvidence === 'string' && fromEvidence.trim()) {
    return fromEvidence.trim();
  }
  if (/timeout before verdict/i.test(failureText)) {
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
