/**
 * Leaf helpers shared by worker-iteration-cycle and review-trigger-reconcile.
 * Keep this module free of imports from cycle/head-ready/ci-green modules.
 */

/** @typedef {{ id?: string, runId?: string, prNumber?: number, targetSha?: string, status?: string }} ReviewRun */
/** @typedef {{ name?: string, sessionId?: string, id?: string, status?: string }} AoSession */

export const IN_FLIGHT_REVIEW_STATUSES = new Set([
  'needs_review',
  'running',
  'queued',
  'preparing',
  'reviewing',
]);

/** AO 0.10 engine statuses that cover a head without starting a new review (#189, #625). */
export const COVERED_TERMINAL_REVIEW_STATUSES = new Set(['up_to_date', 'changes_requested']);

/** Legacy board-column / 0.9 statuses still present in fixtures and captures (#625). */
export const LEGACY_NEEDS_TRIAGE_STATUS = 'needs_' + 'triage';
export const LEGACY_WAITING_UPDATE_STATUS = 'waiting_' + 'update';
export const LEGACY_SENT_FINDING_COUNT_KEY = 'sent' + 'FindingCount';
export const LEGACY_TERMINATION_REASON_KEY = 'termination' + 'Reason';

export const LEGACY_SENT_TO_AGENT_STATUS = 'sent_' + 'to_agent';

export const LEGACY_REVIEW_STATUS_ALIASES = {
  clean: 'up_to_date',
  [LEGACY_NEEDS_TRIAGE_STATUS]: 'changes_requested',
  [LEGACY_WAITING_UPDATE_STATUS]: 'changes_requested',
  [LEGACY_SENT_TO_AGENT_STATUS]: 'changes_requested',
  triage: 'changes_requested',
  reviewing: 'running',
};

/**
 * @param {string | undefined | null} status
 */
export function normalizeLegacyReviewRunStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  return LEGACY_REVIEW_STATUS_ALIASES[normalized] ?? normalized;
}

/**
 * @param {string | undefined | null} status
 */
export function isLegacyDeliveredReviewStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  return normalized === LEGACY_WAITING_UPDATE_STATUS || normalized === LEGACY_SENT_TO_AGENT_STATUS;
}

/**
 * @param {string | undefined | null} status
 */
export function isLegacyUndeliveredReviewStatus(status) {
  return String(status ?? '').toLowerCase() === LEGACY_NEEDS_TRIAGE_STATUS;
}

/**
 * @param {ReviewRun | undefined | null} run
 */
export function readLegacySentFindingCount(run) {
  const raw = run?.deliveredFindingCount ?? run?.[LEGACY_SENT_FINDING_COUNT_KEY];
  return Number(raw ?? 0);
}

/**
 * @param {ReviewRun | undefined | null} run
 */
export function resolveNormalizedReviewRunStatus(run) {
  return normalizeLegacyReviewRunStatus(run?.prReviewStatus ?? run?.status);
}

export const NON_LIVE_WORKER_SESSION_STATUSES = new Set([
  'done',
  'merged',
  'terminated',
  'killed',
  'errored',
  'exited',
  'cleanup',
  'closed',
  'detecting',
]);

/** PowerShell ConvertTo-Json may emit a single object instead of a one-element array. */
export function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * @param {string | undefined | null} sha
 */
export function normalizeSha(sha) {
  return String(sha ?? '')
    .trim()
    .toLowerCase();
}

/**
 * @param {ReviewRun} run
 */
export function isRunCoveringHead(run) {
  const status = resolveNormalizedReviewRunStatus(run);
  if (status === 'ineligible' || status === 'outdated') {
    return false;
  }
  if (IN_FLIGHT_REVIEW_STATUSES.has(status)) {
    return true;
  }
  const latestStatus = normalizeLegacyReviewRunStatus(run?.latestRunStatus);
  if (IN_FLIGHT_REVIEW_STATUSES.has(latestStatus)) {
    return true;
  }
  if (COVERED_TERMINAL_REVIEW_STATUSES.has(status)) {
    return true;
  }
  return false;
}

/**
 * @param {ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} headSha
 */
export function isHeadCovered(runs, prNumber, headSha) {
  const head = normalizeSha(headSha);
  const forHead = runs.filter(
    (run) => Number(run?.prNumber) === prNumber && normalizeSha(run?.targetSha) === head,
  );
  if (forHead.length === 0) {
    return false;
  }
  return forHead.some((run) => isRunCoveringHead(run));
}

/**
 * @param {AoSession} session
 */
export function isLiveWorkerSession(session) {
  const status = String(session?.status ?? '').toLowerCase();
  if (!status) {
    return true;
  }
  return !NON_LIVE_WORKER_SESSION_STATUSES.has(status);
}

/**
 * @param {AoSession} session
 */
export function getSessionIdentifier(session) {
  const name = String(session?.name ?? '').trim();
  if (name) {
    return name;
  }
  const sessionId = String(session?.sessionId ?? '').trim();
  if (sessionId) {
    return sessionId;
  }
  const id = String(session?.id ?? '').trim();
  if (id) {
    return id;
  }
  return null;
}

/**
 * All non-empty session identifiers (name, sessionId, id) for delivery matching.
 *
 * @param {AoSession | null | undefined} session
 */
export function collectSessionIdentifiers(session) {
  /** @type {string[]} */
  const ids = [];
  for (const field of [session?.name, session?.sessionId, session?.id]) {
    const value = String(field ?? '').trim();
    if (value && !ids.includes(value)) {
      ids.push(value);
    }
  }
  return ids;
}

/**
 * @param {string | undefined | null} lastActivity
 * @returns {number | null}
 */
export function parseLastActivityAgeMs(lastActivity) {
  const raw = String(lastActivity ?? '')
    .trim()
    .toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === 'just now' || raw === 'now') {
    return 0;
  }
  const match = raw.match(
    /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*ago$/,
  );
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return null;
  }
  const unit = match[2];
  if (unit.startsWith('s')) {
    return value * 1000;
  }
  if (unit.startsWith('m')) {
    return value * 60 * 1000;
  }
  if (unit.startsWith('h')) {
    return value * 60 * 60 * 1000;
  }
  if (unit.startsWith('d')) {
    return value * 24 * 60 * 60 * 1000;
  }
  return null;
}
