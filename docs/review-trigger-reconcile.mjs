/**
 * State-derived review-trigger reconciliation (Issue #163).
 * Vitest: scripts/review-trigger-reconcile.test.ts
 */
import { readFileSync } from 'node:fs';
/** @typedef {{ number: number, headRefOid: string }} OpenPr */
/** @typedef {{ prNumber?: number, targetSha?: string, status?: string, findingCount?: number, openFindingCount?: number, sentFindingCount?: number }} ReviewRun */
/** @typedef {{ name?: string, role?: string, prNumber?: number | null, pr?: string | null, status?: string }} AoSession */

/** Default cadence: 20 minutes (low-frequency; tens of minutes). */
export const DEFAULT_RECONCILE_INTERVAL_MS = 20 * 60 * 1000;

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
export const FORBIDDEN_LIFECYCLE_PATTERNS = [
  /\bao\s+spawn\b/i,
  /--claim-pr\b/i,
  /\bao\s+session\s+kill\b/i,
  /\bao\s+send\b/i,
];

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
 * @param {AoSession[]} sessions
 * @param {number} prNumber
 */
export function resolveWorkerSessionId(sessions, prNumber) {
  const workers = sessions.filter((s) => {
    const role = String(s?.role ?? '').toLowerCase();
    return (role === 'worker' || role === 'coding') && isLiveWorkerSession(s);
  });

  for (const session of workers) {
    if (Number(session?.prNumber) === prNumber && session?.name) {
      return String(session.name);
    }
    const prField = String(session?.pr ?? '');
    if (prField && (prField === String(prNumber) || prField === `#${prNumber}`)) {
      if (session?.name) {
        return String(session.name);
      }
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

  for (const pr of openPrs ?? []) {
    const prNumber = Number(pr?.number);
    const headSha = String(pr?.headRefOid ?? '');
    if (!prNumber || !headSha) {
      continue;
    }

    if (isHeadCovered(reviewRuns ?? [], prNumber, headSha)) {
      continue;
    }

    const sessionId = resolveWorkerSessionId(sessions ?? [], prNumber);
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
  const interval = Math.max(1, Number(intervalMs) || DEFAULT_RECONCILE_INTERVAL_MS);
  if (!lastTickMs || lastTickMs <= 0) {
    return { ok: true, intervalMs: interval };
  }
  if (nowMs - lastTickMs >= interval) {
    return { ok: true, intervalMs: interval };
  }
  return { ok: false, reason: 'interval_not_elapsed', intervalMs: interval };
}

/**
 * @param {string[]} commandLines
 */
export function findForbiddenLifecycleCommands(commandLines) {
  /** @type {Array<{ command: string, pattern: string }>} */
  const violations = [];
  for (const command of commandLines ?? []) {
    const line = String(command ?? '');
    for (const pattern of FORBIDDEN_LIFECYCLE_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ command: line, pattern: pattern.source });
      }
    }
  }
  return violations;
}

/**
 * @param {string} sessionId
 * @param {string} reviewCommand
 */
export function buildReviewRunArgv(sessionId, reviewCommand) {
  return ['review', 'run', sessionId, '--execute', '--command', reviewCommand];
}

function readStdinJson() {
  const text = readFileSync(0, 'utf8').trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const isCli =
  process.argv[1] &&
  (process.argv[1].endsWith('review-trigger-reconcile.mjs') ||
    process.argv[1].endsWith('review-trigger-reconcile.js'));

if (isCli) {
  const sub = process.argv[2];
  if (sub === 'plan') {
    printJson(planReconcileActions(readStdinJson()));
    process.exit(0);
  }
  if (sub === 'interval') {
    const payload = readStdinJson();
    printJson(
      evaluateReconcileInterval({
        nowMs: Number(payload.nowMs) || Date.now(),
        lastTickMs: payload.lastTickMs,
        intervalMs: Number(payload.intervalMs) || DEFAULT_RECONCILE_INTERVAL_MS,
      }),
    );
    process.exit(0);
  }
  console.error('Usage: node review-trigger-reconcile.mjs <plan|interval>');
  process.exit(2);
}
