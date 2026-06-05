/**
 * State-derived review-trigger reconciliation (Issue #163).
 * Vitest: scripts/review-trigger-reconcile.test.ts
 */
import {
  evaluateMechanicalTickInterval,
  findForbiddenCommandPatterns,
  MECHANICAL_FORBIDDEN_REVIEW_MECHANICAL,
  readStdinJson,
  runStdinJsonCli,
} from './review-mechanical-cli.mjs';
/** @typedef {{ number: number, headRefOid: string }} OpenPr */
/** @typedef {{ prNumber?: number, targetSha?: string, status?: string, findingCount?: number, openFindingCount?: number, sentFindingCount?: number }} ReviewRun */
/** @typedef {{ name?: string, sessionId?: string, id?: string, role?: string, prNumber?: number | null, pr?: string | null, status?: string }} AoSession */

/** Default cadence: 10 minutes (low-frequency; tens of minutes). */
export const DEFAULT_RECONCILE_INTERVAL_MS = 10 * 60 * 1000;

export const IN_FLIGHT_REVIEW_STATUSES = new Set([
  'queued',
  'preparing',
  'running',
  'reviewing',
]);

export const COVERED_TERMINAL_REVIEW_STATUSES = new Set([
  'clean',
  'needs_triage',
  'waiting_update',
]);

/**
 * Worker session statuses that must not receive ao review run (orphan / dead session).
 * Aligns with orchestrator-diagnose.ps1 terminal workers and recovery runbook orphan signals.
 */
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

/** Shell fragments the reconcile entrypoint must never invoke (PR #97 split-brain). */
export const FORBIDDEN_LIFECYCLE_PATTERNS = MECHANICAL_FORBIDDEN_REVIEW_MECHANICAL;

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
  const status = String(run?.status ?? '').toLowerCase();
  if (status === 'outdated') {
    return false;
  }
  if (IN_FLIGHT_REVIEW_STATUSES.has(status)) {
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
 * True when needle matches any stable session identifier field (name, sessionId, id).
 * Review runs may store linkedSessionId as sessionId while status rows also carry name.
 *
 * @param {AoSession} session
 * @param {string} needle
 */
export function sessionMatchesIdentifier(session, needle) {
  const id = String(needle ?? '').trim();
  if (!id) {
    return false;
  }
  for (const field of [session?.name, session?.sessionId, session?.id]) {
    const value = String(field ?? '').trim();
    if (value && value === id) {
      return true;
    }
  }
  return false;
}

/**
 * @param {AoSession[]} sessions
 * @param {string} sessionId
 */
export function findSessionById(sessions, sessionId) {
  const needle = String(sessionId ?? '').trim();
  if (!needle) {
    return null;
  }
  for (const session of toArray(sessions)) {
    if (sessionMatchesIdentifier(session, needle)) {
      return session;
    }
  }
  return null;
}

/**
 * @param {AoSession} session
 * @param {number} prNumber
 */
export function sessionMatchesPr(session, prNumber) {
  if (Number(session?.prNumber) === prNumber) {
    return true;
  }
  const prField = String(session?.pr ?? '');
  return Boolean(
    prField && (prField === String(prNumber) || prField === `#${prNumber}`),
  );
}

/**
 * @param {AoSession[]} sessions
 * @param {number} prNumber
 * @param {{ ownsHead?: (session: AoSession) => boolean }} [options]
 */
export function resolveWorkerSessionId(sessions, prNumber, options = {}) {
  const ownsHead = options.ownsHead;
  const workers = sessions.filter((s) => {
    const role = String(s?.role ?? '').toLowerCase();
    return (role === 'worker' || role === 'coding') && isLiveWorkerSession(s);
  });

  for (const session of workers) {
    if (!sessionMatchesPr(session, prNumber)) {
      continue;
    }
    if (ownsHead && !ownsHead(session)) {
      continue;
    }
    const identifier = getSessionIdentifier(session);
    if (identifier) {
      return identifier;
    }
  }

  return null;
}

/**
 * @param {object} input
 * @param {OpenPr[]} input.openPrs
 * @param {ReviewRun[]} input.reviewRuns
 * @param {AoSession[]} input.sessions
 */
export function planReconcileActions({ openPrs, reviewRuns, sessions }) {
  /** @type {Array<{ type: 'start_review', prNumber: number, headSha: string, sessionId: string } | { type: 'skip', prNumber: number, headSha: string, reason: string }>} */
  const actions = [];
  const prList = toArray(openPrs);
  const runList = toArray(reviewRuns);
  const sessionList = toArray(sessions);

  for (const pr of prList) {
    const prNumber = Number(pr?.number);
    const headSha = String(pr?.headRefOid ?? '');
    if (!prNumber || !headSha) {
      continue;
    }

    if (isHeadCovered(runList, prNumber, headSha)) {
      continue;
    }

    const sessionId = resolveWorkerSessionId(sessionList, prNumber);
    if (!sessionId) {
      actions.push({
        type: 'skip',
        prNumber,
        headSha,
        reason: 'no_worker_session',
      });
      continue;
    }

    actions.push({
      type: 'start_review',
      prNumber,
      headSha,
      sessionId,
    });
  }

  return actions;
}

/**
 * @param {object} input
 * @param {number} input.nowMs
 * @param {number | undefined} input.lastTickMs
 * @param {number} input.intervalMs
 */
export function evaluateReconcileInterval({ nowMs, lastTickMs, intervalMs }) {
  return evaluateMechanicalTickInterval({
    nowMs,
    lastTickMs,
    intervalMs,
    defaultIntervalMs: DEFAULT_RECONCILE_INTERVAL_MS,
  });
}

/**
 * @param {string[]} commandLines
 */
export function findForbiddenLifecycleCommands(commandLines) {
  return findForbiddenCommandPatterns(commandLines, FORBIDDEN_LIFECYCLE_PATTERNS);
}

/**
 * @param {string} sessionId
 * @param {string} reviewCommand
 */
export function buildReviewRunArgv(sessionId, reviewCommand) {
  return ['review', 'run', sessionId, '--execute', '--command', reviewCommand];
}

runStdinJsonCli('review-trigger-reconcile.mjs', {
  plan: () => planReconcileActions(readStdinJson()),
  interval: () => {
    const payload = readStdinJson();
    return evaluateReconcileInterval({
      nowMs: Number(payload.nowMs) || Date.now(),
      lastTickMs: payload.lastTickMs,
      intervalMs: Number(payload.intervalMs) || DEFAULT_RECONCILE_INTERVAL_MS,
    });
  },
});
