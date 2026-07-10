/**
 * AO 0.10 review producer contract — normalized run rows for pack reconcile scripts (Issues #626, #625).
 * Maps GET /api/v1/sessions/{id}/reviews PRReviewState + latestRun to status+verdict vocabulary.
 * Vitest: scripts/review-producer-contract.test.ts
 */
import {
  isLegacyDeliveredReviewStatus,
  isLegacyUndeliveredReviewStatus,
  normalizeLegacyReviewRunStatus,
  readLegacySentFindingCount,
  toArray,
  normalizeSha,
} from './review-reconcile-primitives.mjs';

/** Engine-level PR review statuses (AO 0.10 PRReviewState.status). */
export const PR_REVIEW_STATUSES = [
  'needs_review',
  'running',
  'up_to_date',
  'changes_requested',
  'ineligible',
];

/** Board column statuses (v0.9.2 enum consumed by #214). */
export const BOARD_COLUMN_STATUSES = [
  'queued',
  'reviewing',
  'triage',
  'waiting',
  'clean',
  'failed',
  'outdated',
];

/** Terminal covered statuses for head idempotency (#189) — do not start a new review. */
export const COVERED_TERMINAL_PR_REVIEW_STATUSES = new Set(['up_to_date', 'changes_requested']);

/** In-flight engine + latestRun statuses. */
export const IN_FLIGHT_PR_REVIEW_STATUSES = new Set(['needs_review', 'running']);

export const IN_FLIGHT_LATEST_RUN_STATUSES = new Set(['queued', 'preparing', 'running']);

export const REMOVED_REPORT_RECEIPT_SURFACES = [
  'ao report',
  'ao status --reports',
  '.agent-report-audit',
  '/sessions/{id}/reports',
];

export function assertNoRemovedReportReceiptSurface(value) {
  const text = String(value ?? '').toLowerCase();
  for (const surface of REMOVED_REPORT_RECEIPT_SURFACES) {
    if (text.includes(surface.toLowerCase())) {
      throw new Error(`removed report receipt surface: ${surface}`);
    }
  }
  return true;
}

/** Post-cutover daemon composite readers forbidden for status decisions (Issue #720). */
export const REMOVED_DECISION_STATUS_SURFACES = [
  'Get-AoStatusSessionsWithReports',
  'Get-AoStatusSessionsWithReportsIncludingTerminated',
];

export function assertNoDaemonStatusDecisionRead(value) {
  const text = String(value ?? '');
  for (const surface of REMOVED_DECISION_STATUS_SURFACES) {
    if (text.includes(surface)) {
      throw new Error(`daemon status decision read forbidden: ${surface}`);
    }
  }
  return true;
}

/**
 * @typedef {{
 *   id?: string,
 *   runId?: string,
 *   prNumber?: number,
 *   prUrl?: string,
 *   targetSha?: string,
 *   linkedSessionId?: string,
 *   projectId?: string,
 *   prReviewStatus?: string,
 *   latestRunStatus?: string,
 *   verdict?: string,
 *   deliveredAt?: string | null,
 *   body?: string,
 *   findingCount?: number,
 *   openFindingCount?: number,
 *   deliveredFindingCount?: number,
 *   status?: string,
 *   githubReviewId?: string | number | null,
 *   batchId?: string,
 *   createdAt?: string,
 *   updatedAt?: string,
 *   completedAt?: string,
 *   retryEligible?: boolean,
 *   retryCount?: number,
 * }} NormalizedReviewRun
 */

/**
 * @param {unknown} latestRun
 */
export function resolveFailureDetail(latestRun) {
  if (!latestRun || typeof latestRun !== 'object') {
    return '';
  }
  const status = String(latestRun.status ?? '').toLowerCase();
  if (status !== 'failed' && status !== 'cancelled') {
    return '';
  }
  const legacyTerminationKey = 'termination' + 'Reason';
  return String(latestRun.body ?? latestRun[legacyTerminationKey] ?? '').trim();
}

/**
 * Row `status` must surface terminal latestRun failure even when PRReviewState.status is stale in-flight.
 *
 * @param {string} prReviewStatus
 * @param {string} latestRunStatus
 */
export function resolveNormalizedRowStatus(prReviewStatus, latestRunStatus) {
  const latest = String(latestRunStatus ?? '').toLowerCase();
  if (latest === 'failed' || latest === 'cancelled') {
    return latest;
  }
  if (IN_FLIGHT_LATEST_RUN_STATUSES.has(latest)) {
    return latest;
  }
  const pr = String(prReviewStatus ?? '').toLowerCase();
  return pr || latest;
}

/**
 * @param {unknown} latestRun
 * @param {string} prReviewStatus
 */
export function deriveDeliveredFindingCount(latestRun, prReviewStatus) {
  const latestStatus = String(latestRun?.status ?? '').toLowerCase();
  const deliveredAt = latestRun?.deliveredAt;
  if (!deliveredAt && latestStatus !== 'delivered') {
    return 0;
  }
  const deliveredFindingCount = Number(latestRun?.deliveredFindingCount);
  if (Number.isFinite(deliveredFindingCount) && deliveredFindingCount >= 0) {
    return deliveredFindingCount;
  }
  const findingCount = Number(latestRun?.findingCount);
  if (Number.isFinite(findingCount) && findingCount >= 0) {
    return findingCount;
  }
  if (prReviewStatus === 'changes_requested') {
    return 1;
  }
  return 0;
}

/**
 * @param {NormalizedReviewRun} run
 */
export function isDeliveredChangesRequested(run) {
  const rawStatus = String(run?.prReviewStatus ?? run?.status ?? '').toLowerCase();
  if (isLegacyUndeliveredReviewStatus(rawStatus)) {
    return false;
  }
  if (isLegacyDeliveredReviewStatus(rawStatus)) {
    return true;
  }
  const status = normalizeLegacyReviewRunStatus(rawStatus);
  if (status !== 'changes_requested') {
    return false;
  }
  const latestRunStatus = String(run?.latestRunStatus ?? '').toLowerCase();
  if (latestRunStatus === 'delivered') {
    return true;
  }
  if (run?.deliveredAt) {
    return true;
  }
  const sentLegacy = readLegacySentFindingCount(run);
  return Number.isFinite(sentLegacy) && sentLegacy > 0;
}

/**
 * @param {NormalizedReviewRun} run
 */
export function isUndeliveredChangesRequested(run) {
  const rawStatus = String(run?.prReviewStatus ?? run?.status ?? '').toLowerCase();
  const openFindingCount = Number(run?.openFindingCount ?? 0);
  if (Number.isFinite(openFindingCount) && openFindingCount > 0 && !isDeliveredChangesRequested(run)) {
    return true;
  }
  if (isLegacyUndeliveredReviewStatus(rawStatus)) {
    const sent = readLegacySentFindingCount(run);
    return !Number.isFinite(sent) || sent <= 0;
  }
  if (isLegacyDeliveredReviewStatus(rawStatus)) {
    return false;
  }
  const status = normalizeLegacyReviewRunStatus(rawStatus);
  return status === 'changes_requested' && !isDeliveredChangesRequested(run);
}

/**
 * @param {NormalizedReviewRun} run
 */
export function isPendingWorkerDeliveryConfirmation(run) {
  if (!isDeliveredChangesRequested(run)) {
    return false;
  }
  const delivered = Number(run?.deliveredFindingCount ?? 0);
  if (Number.isFinite(delivered) && delivered > 0) {
    return true;
  }
  const sentLegacy = readLegacySentFindingCount(run);
  return Number.isFinite(sentLegacy) && sentLegacy > 0;
}

/**
 * Map engine PRReviewState + latestRun to board column (producer-owned, #626).
 *
 * @param {object} input
 * @param {string} [input.prReviewStatus]
 * @param {unknown} [input.latestRun]
 * @param {string} [input.headSha]
 * @param {string} [input.entryHeadSha]
 */
export function mapEngineStateToBoardStatus({ prReviewStatus, latestRun, headSha, entryHeadSha }) {
  const engineStatus = String(prReviewStatus ?? '').toLowerCase();
  const latest = latestRun && typeof latestRun === 'object' ? latestRun : null;
  const latestStatus = String(latest?.status ?? '').toLowerCase();
  const runHead = normalizeSha(latest?.targetSha ?? entryHeadSha ?? headSha);
  const currentHead = normalizeSha(entryHeadSha ?? headSha);
  if (runHead && currentHead && runHead !== currentHead) {
    return 'outdated';
  }
  if (engineStatus === 'ineligible') {
    return 'outdated';
  }
  if (latestStatus === 'failed' || latestStatus === 'cancelled') {
    return 'failed';
  }
  if (engineStatus === 'running' || IN_FLIGHT_LATEST_RUN_STATUSES.has(latestStatus)) {
    return 'reviewing';
  }
  if (engineStatus === 'needs_review' && !latest) {
    return 'queued';
  }
  if (engineStatus === 'up_to_date' || String(latest?.verdict ?? '').toLowerCase() === 'approved') {
    return 'clean';
  }
  if (engineStatus === 'changes_requested') {
    return latest?.deliveredAt || String(latest?.status ?? '').toLowerCase() === 'delivered'
      ? 'triage'
      : 'waiting';
  }
  return 'queued';
}

/**
 * @param {unknown} entry
 * @param {string} [linkedSessionId]
 * @returns {NormalizedReviewRun | null}
 */
export function normalizePrReviewStateRow(entry, linkedSessionId = '') {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const prNumber = Number(entry.prNumber);
  const headSha = String(entry.headSha ?? entry.targetSha ?? '');
  const prReviewStatus = String(entry.status ?? '').toLowerCase();
  const latestRun = entry.latestRun ?? null;
  if (!latestRun || typeof latestRun !== 'object') {
    if (!prReviewStatus) {
      return null;
    }
    return {
      id: '',
      prNumber: Number.isFinite(prNumber) ? prNumber : undefined,
      prUrl: String(entry.prUrl ?? ''),
      targetSha: headSha,
      linkedSessionId: linkedSessionId || undefined,
      prReviewStatus,
      status: prReviewStatus,
      deliveredFindingCount: 0,
    };
  }
  const id = String(latestRun.id ?? latestRun.runId ?? '').trim();
  const latestRunStatus = String(latestRun.status ?? '').toLowerCase();
  const verdict = String(latestRun.verdict ?? '').toLowerCase();
  const deliveredAt = latestRun.deliveredAt ?? null;
  const deliveredFindingCount = deriveDeliveredFindingCount(
    {
      ...latestRun,
      deliveredFindingCount: latestRun.deliveredFindingCount ?? entry.deliveredFindingCount,
      findingCount: latestRun.findingCount ?? entry.findingCount,
    },
    prReviewStatus,
  );
  const failureDetail = resolveFailureDetail(latestRun);
  /** @type {NormalizedReviewRun} */
  const row = {
    id,
    runId: id || undefined,
    prNumber: Number.isFinite(prNumber) ? prNumber : Number(latestRun.prNumber),
    prUrl: String(entry.prUrl ?? ''),
    targetSha: String(latestRun.targetSha ?? headSha),
    linkedSessionId: String(latestRun.linkedSessionId ?? linkedSessionId ?? ''),
    prReviewStatus: prReviewStatus || latestRunStatus,
    latestRunStatus,
    verdict: verdict || undefined,
    deliveredAt,
    body: failureDetail || String(latestRun.body ?? '') || undefined,
    findingCount: Number.isFinite(Number(latestRun.findingCount)) ? Number(latestRun.findingCount) : undefined,
    openFindingCount: Number.isFinite(Number(latestRun.openFindingCount))
      ? Number(latestRun.openFindingCount)
      : undefined,
    deliveredFindingCount,
    status: resolveNormalizedRowStatus(prReviewStatus, latestRunStatus),
    githubReviewId: latestRun.githubReviewId ?? null,
    batchId: latestRun.batchId ? String(latestRun.batchId) : undefined,
    createdAt: latestRun.createdAt ? String(latestRun.createdAt) : undefined,
    updatedAt: latestRun.updatedAt ? String(latestRun.updatedAt) : undefined,
    completedAt: latestRun.completedAt ? String(latestRun.completedAt) : undefined,
    retryEligible: latestRun.retryEligible,
    retryCount: latestRun.retryCount,
  };
  return row;
}

/**
 * Flatten AO 0.10 GET /reviews payload into normalized producer rows.
 *
 * @param {unknown} payload
 * @param {string} [linkedSessionId]
 * @returns {NormalizedReviewRun[]}
 */
export function flattenSessionReviewsToNormalizedRuns(payload, linkedSessionId = '') {
  const reviews = toArray(payload?.reviews);
  /** @type {NormalizedReviewRun[]} */
  const runs = [];
  for (const entry of reviews) {
    const row = normalizePrReviewStateRow(entry, linkedSessionId);
    if (row?.id || row?.prReviewStatus) {
      runs.push(row);
    }
  }
  return runs;
}

/**
 * @param {NormalizedReviewRun[]} runs
 * @param {string} projectId
 */
export function attachProjectIdToNormalizedRuns(runs, projectId) {
  const project = String(projectId ?? '').trim();
  if (!project) {
    return runs;
  }
  return runs.map((run) => (run.projectId ? run : { ...run, projectId: project }));
}
