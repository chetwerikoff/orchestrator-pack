/**
 * AO 0.10 session-scoped review HTTP primitives (Issue #623).
 * Capture-backed shapes: tests/external-output-references/variants/ao-0-10-review-api/
 */

import { readStdinJson, runStdinJsonCli, toArray } from './review-mechanical-cli.mjs';
import {
  flattenSessionReviewsToNormalizedRuns,
  attachProjectIdToNormalizedRuns,
} from './review-producer-contract.mjs';

/** @typedef {{ id?: string, runId?: string, status?: string, targetSha?: string, prNumber?: number, linkedSessionId?: string, createdAt?: string, updatedAt?: string }} ReviewRun */
/** @typedef {{ prNumber?: number, headSha?: string, prUrl?: string, latestRun?: ReviewRun | null }} PRReviewState */

export const AO_REVIEW_TRIGGER_PATH = '/api/v1/sessions/{sessionId}/reviews/trigger';
export const AO_REVIEW_LIST_PATH = '/api/v1/sessions/{sessionId}/reviews';
export const AO_PROJECT_CONFIG_PATH = '/api/v1/projects/{projectId}/config';

export const REMOVED_AO_REVIEW_SUBCOMMANDS = new Set(['send', 'execute']);

export const IN_FLIGHT_LATEST_RUN_STATUSES = new Set(['queued', 'preparing', 'running']);

/**
 * @param {string} sessionId
 */
export function buildReviewTriggerPath(sessionId) {
  const id = String(sessionId ?? '').trim();
  if (!id) {
    throw new Error('session id is required for review trigger');
  }
  return `/api/v1/sessions/${encodeURIComponent(id)}/reviews/trigger`;
}

/**
 * @param {string} sessionId
 */
export function buildReviewListPath(sessionId) {
  const id = String(sessionId ?? '').trim();
  if (!id) {
    throw new Error('session id is required for review list');
  }
  return `/api/v1/sessions/${encodeURIComponent(id)}/reviews`;
}

/**
 * Legacy 0.9 argv shape retained for migration guards only — not for live trigger.
 * @param {string} sessionId
 * @param {string} reviewCommand
 */
export function buildLegacyReviewRunArgv(sessionId, reviewCommand) {
  return ['review', 'run', sessionId, '--execute', '--command', reviewCommand];
}

/**
 * @param {string} sessionId
 */
export function buildReviewTriggerInvocation(sessionId) {
  return {
    method: 'POST',
    path: buildReviewTriggerPath(sessionId),
    shimArgv: ['ao-review', 'run', sessionId],
  };
}

/**
 * @param {unknown} value
 */
export function normalizeSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!sha) return '';
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/**
 * Flatten AO 0.10 GET /reviews payload into normalized producer run rows.
 * @param {unknown} payload
 * @param {string} [linkedSessionId]
 * @returns {import('./review-producer-contract.mjs').NormalizedReviewRun[]}
 */
export function flattenSessionReviewsToRuns(payload, linkedSessionId = '') {
  return flattenSessionReviewsToNormalizedRuns(payload, linkedSessionId);
}

/**
 * @param {ReviewRun[]} runs
 * @param {string} projectId
 */
export function attachProjectIdToRuns(runs, projectId) {
  return attachProjectIdToNormalizedRuns(runs, projectId);
}

/**
 * @param {object} input
 * @param {PRReviewState[]} [input.reviews]
 * @param {string} [input.headSha]
 * @param {number} [input.prNumber]
 */
export function findRunningLatestRunForHead({ reviews, headSha, prNumber }) {
  const head = normalizeSha(headSha);
  const pr = Number(prNumber);
  for (const entry of toArray(reviews)) {
    if (Number.isFinite(pr) && Number(entry?.prNumber) !== pr) continue;
    const entryHead = normalizeSha(entry?.headSha ?? entry?.latestRun?.targetSha);
    if (head && entryHead && entryHead !== head) continue;
    const latest = entry?.latestRun;
    if (!latest || typeof latest !== 'object') continue;
    const status = String(latest.status ?? '').toLowerCase();
    if (IN_FLIGHT_LATEST_RUN_STATUSES.has(status)) {
      return {
        blocked: true,
        reason: 'review_running_for_current_head',
        status,
        runId: String(latest.id ?? latest.runId ?? ''),
        targetSha: String(latest.targetSha ?? entry?.headSha ?? ''),
        prNumber: Number(entry?.prNumber ?? pr),
      };
    }
  }
  return { blocked: false, reason: 'no_running_latest_run' };
}

/**
 * @param {object} input
 * @param {unknown} [input.listPayload]
 * @param {string} [input.headSha]
 * @param {number} [input.prNumber]
 */
export function evaluateReviewBeforeCleanupGate({ listPayload, headSha, prNumber }) {
  const reviews = toArray(listPayload?.reviews);
  const gate = findRunningLatestRunForHead({ reviews, headSha, prNumber });
  return {
    ...gate,
    proceed: !gate.blocked,
    httpStatus: gate.blocked ? 409 : 200,
  };
}

/**
 * @param {unknown} triggerPayload
 * @param {number} httpStatus
 */
export function classifyReviewTriggerResponse(triggerPayload, httpStatus) {
  const status = Number(httpStatus) || 0;
  const reviews = toArray(triggerPayload?.reviews);
  const minted = status === 201 || status === 200;
  return {
    ok: minted,
    httpStatus: status,
    reused: status === 200,
    created: status === 201,
    reviewerHandleId: String(triggerPayload?.reviewerHandleId ?? ''),
    reviewCount: reviews.length,
  };
}

/**
 * @param {unknown} configPayload
 * @param {string} [expectedHarness]
 */
export function evaluateProjectReviewerHarness(configPayload, expectedHarness = 'codex') {
  const reviewers = toArray(configPayload?.reviewers ?? configPayload?.config?.reviewers);
  const harness = String(reviewers[0]?.harness ?? '').trim();
  const expected = String(expectedHarness ?? '').trim();
  return {
    ok: Boolean(harness),
    harness,
    matchesExpected: expected ? harness === expected : true,
    reviewers,
  };
}

/**
 * @param {string[]} commandLines
 */
export function findForbiddenLegacyReviewRunCommands(commandLines) {
  /** @type {Array<{ command: string, pattern: string }>} */
  const violations = [];
  for (const command of commandLines ?? []) {
    const line = String(command ?? '');
    if (/\bao\s+review\s+run\b/i.test(line)) {
      violations.push({ command: line, pattern: 'legacy review-run CLI' });
    }
  }
  return violations;
}

runStdinJsonCli('ao-0-10-review-api.mjs', {
  'flatten-runs': () => {
    const payload = readStdinJson();
    return {
      runs: flattenSessionReviewsToRuns(payload.payload, String(payload.linkedSessionId ?? '')),
    };
  },
  'cleanup-gate': () => {
    const payload = readStdinJson();
    return evaluateReviewBeforeCleanupGate(payload);
  },
  'trigger-classify': () => {
    const payload = readStdinJson();
    return classifyReviewTriggerResponse(payload.payload, Number(payload.httpStatus));
  },
  'harness-eval': () => {
    const payload = readStdinJson();
    return evaluateProjectReviewerHarness(payload.payload, String(payload.expectedHarness ?? 'codex'));
  },
  forbidden: () => {
    const payload = readStdinJson();
    return findForbiddenLegacyReviewRunCommands(toArray(payload.commands));
  },
});
