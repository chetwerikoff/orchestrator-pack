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
import {
  buildNoStartDecisionRecord,
  degradedCiTrackingKey,
  evaluateHeadReadyForReview,
  formatDecisionRecordForLog,
  preRunHeadReadyRecheck,
  resolveMaxDegradedCiAttempts,
} from './review-head-ready.mjs';
/** @typedef {{ number: number, headRefOid: string, headCommittedAt?: string | number, headCommitCommittedAt?: string | number, head_commit_committed_at?: string | number }} OpenPr */
/** @typedef {{ id?: string, runId?: string, prNumber?: number, targetSha?: string, status?: string, findingCount?: number, openFindingCount?: number, sentFindingCount?: number, terminationReason?: string, retryEligible?: boolean, retryCount?: number }} ReviewRun */
/** @typedef {{ name?: string, sessionId?: string, id?: string, role?: string, prNumber?: number | null, pr?: string | null, ownedHeadSha?: string, headRefOid?: string, status?: string, reports?: Array<Record<string, unknown>> }} AoSession */
/** @typedef {{ prNumber?: number, checks?: Array<{ name?: string, state?: string, conclusion?: string, status?: string }> }} CiChecksByPrRow */
/** @typedef {{ prNumber?: number, requiredCheckNames?: string[] }} RequiredCheckNamesRow */
/** @typedef {{ prNumber?: number, failed?: boolean }} RequiredCheckLookupFailedRow */
/** @typedef {{ attempts?: number, lastAttemptMs?: number }} DegradedCiRecord */
/** @typedef {{ degradedCi?: Record<string, DegradedCiRecord> }} DegradedCiTrackingState */
/** @typedef {Parameters<typeof planReconcileActions>[0]} PlanReconcileInput */
/** @typedef {ReturnType<typeof planReconcileActions>[number]} ReconcileAction */

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

const FAILED_OR_CANCELLED = new Set(['failed', 'cancelled']);

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
 * @param {ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} headSha
 */
export function hasFailedOrCancelledOnHead(runs, prNumber, headSha) {
  return Boolean(findFailedOrCancelledRunForHead(runs, prNumber, headSha));
}

/**
 * @param {ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} headSha
 */
export function findFailedOrCancelledRunForHead(runs, prNumber, headSha) {
  const head = normalizeSha(headSha);
  return (
    toArray(runs).find((run) => {
      const status = String(run?.status ?? '').toLowerCase();
      return (
        Number(run?.prNumber) === prNumber &&
        normalizeSha(run?.targetSha) === head &&
        FAILED_OR_CANCELLED.has(status)
      );
    }) ?? null
  );
}

/**
 * @param {ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} headSha
 */
export function findCoveringRunForHead(runs, prNumber, headSha) {
  const head = normalizeSha(headSha);
  return (
    toArray(runs).find(
      (run) =>
        Number(run?.prNumber) === prNumber &&
        normalizeSha(run?.targetSha) === head &&
        isRunCoveringHead(run),
    ) ?? null
  );
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
 * Explicit head SHA stored on a report record (may be absent on AO 0.9.x).
 *
 * @param {Record<string, unknown>} report
 */
export function getStoredReportHeadSha(report) {
  const head =
    report?.headRefOid ??
    report?.head_ref_oid ??
    report?.forHeadSha ??
    report?.for_head_sha ??
    report?.prHeadSha ??
    report?.pr_head_sha;
  return normalizeSha(String(head ?? ''));
}

/** @deprecated Use getStoredReportHeadSha for observation; reportCoversHead for binding. */
export function getReportHeadSha(report) {
  return getStoredReportHeadSha(report);
}

/**
 * @param {Record<string, unknown>} report
 */
export function getReportTimestampMs(report) {
  const raw =
    report?.reportedAt ??
    report?.timestamp ??
    report?.createdAt ??
    report?.reported_at ??
    report?.created_at;
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Whether a worker report covers a PR head for binding (Issue #218).
 * Stored SHA matches when present; otherwise infer from head commit time vs report time.
 *
 * @param {Record<string, unknown>} report
 * @param {string} headSha
 * @param {{ headCommittedAtMs?: number }} [options]
 */
export function reportCoversHead(report, headSha, options = {}) {
  const target = normalizeSha(headSha);
  if (!target) {
    return false;
  }

  const stored = getStoredReportHeadSha(report);
  if (stored) {
    return stored === target;
  }

  const headCommittedAtMs = Number(options.headCommittedAtMs);
  const reportMs = getReportTimestampMs(report);
  if (!Number.isFinite(headCommittedAtMs) || headCommittedAtMs <= 0 || reportMs <= 0) {
    return false;
  }

  // Head commit must not be newer than the report — otherwise the hand-off is stale.
  return headCommittedAtMs <= reportMs;
}

/**
 * @param {OpenPr[] | OpenPr} [openPrs]
 * @param {number} prNumber
 */
export function resolveHeadCommittedAtMs(openPrs, prNumber) {
  for (const pr of toArray(openPrs)) {
    if (Number(pr?.number) !== prNumber) {
      continue;
    }
    const raw =
      pr?.headCommittedAt ?? pr?.headCommitCommittedAt ?? pr?.head_commit_committed_at;
    if (raw == null || raw === '') {
      return undefined;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    const parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * @param {AoSession} session
 * @param {string} headSha
 * @param {{ headCommittedAtMs?: number }} [options]
 */
function sessionHasReportForHead(session, headSha, options = {}) {
  const target = normalizeSha(headSha);
  if (!target) {
    return false;
  }
  for (const report of toArray(session?.reports)) {
    if (reportCoversHead(report, target, options)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {AoSession} session
 * @param {string} headSha
 */
function sessionExplicitlyOwnsHead(session, headSha) {
  const sessionHead = normalizeSha(session?.ownedHeadSha ?? session?.headRefOid);
  const target = normalizeSha(headSha);
  return Boolean(sessionHead && target && sessionHead === target);
}

/**
 * @param {AoSession} session
 * @param {number} prNumber
 * @param {string} headSha
 * @param {OpenPr[]} [openPrs]
 */
export function sessionOwnsRunHead(session, prNumber, headSha, openPrs = []) {
  if (!sessionMatchesPr(session, prNumber)) {
    return false;
  }

  const target = normalizeSha(headSha);
  if (!target) {
    return false;
  }

  const pr = toArray(openPrs).find((row) => Number(row?.number) === prNumber);
  const currentHead = normalizeSha(pr?.headRefOid);
  if (currentHead && currentHead !== target) {
    return false;
  }

  const sessionHead = normalizeSha(session?.ownedHeadSha ?? session?.headRefOid);
  if (sessionHead) {
    return sessionHead === target;
  }

  return Boolean(currentHead && currentHead === target);
}

/**
 * Pick the live worker session that owns the current PR head (not merely the first PR match).
 *
 * @param {AoSession[]} sessions
 * @param {number} prNumber
 * @param {string} headSha
 * @param {OpenPr[]} [openPrs]
 */
export function resolveHeadOwningWorkerSessionId(sessions, prNumber, headSha, openPrs = []) {
  const prList = toArray(openPrs);
  const target = normalizeSha(headSha);
  const headCommittedAtMs = resolveHeadCommittedAtMs(prList, prNumber);
  const reportBindingOptions = { headCommittedAtMs };
  const workers = toArray(sessions).filter((session) => {
    const role = String(session?.role ?? '').toLowerCase();
    return (
      (role === 'worker' || role === 'coding') &&
      isLiveWorkerSession(session) &&
      sessionMatchesPr(session, prNumber)
    );
  });

  const headBound = workers.filter(
    (session) =>
      sessionExplicitlyOwnsHead(session, headSha) ||
      sessionHasReportForHead(session, headSha, reportBindingOptions),
  );

  if (headBound.length === 1) {
    return getSessionIdentifier(headBound[0]);
  }

  if (headBound.length > 1) {
    let best = headBound[0];
    let bestMs = -1;
    for (const session of headBound) {
      let latestMs = -1;
      for (const report of toArray(session?.reports)) {
        if (!reportCoversHead(report, target, reportBindingOptions)) {
          continue;
        }
        latestMs = Math.max(latestMs, getReportTimestampMs(report));
      }
      if (latestMs > bestMs) {
        bestMs = latestMs;
        best = session;
      }
    }
    return getSessionIdentifier(best);
  }

  return resolveWorkerSessionId(sessions, prNumber, {
    ownsHead: (session) => sessionOwnsRunHead(session, prNumber, headSha, prList),
  });
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
 * @param {Record<string, Array<{ name?: string, state?: string, conclusion?: string, status?: string }>> | Array<CiChecksByPrRow> | undefined} ciChecksByPr
 * @param {number} prNumber
 */
function getCiChecksForPr(ciChecksByPr, prNumber) {
  if (!ciChecksByPr) {
    return [];
  }
  if (Array.isArray(ciChecksByPr)) {
    const row = ciChecksByPr.find((entry) => Number(entry?.prNumber) === prNumber);
    return toArray(row?.checks);
  }
  return toArray(ciChecksByPr[String(prNumber)]);
}

/**
 * @param {Record<string, string[]> | Array<RequiredCheckNamesRow> | undefined} requiredByPr
 * @param {number} prNumber
 */
function getRequiredCheckNamesForPr(requiredByPr, prNumber) {
  if (!requiredByPr) {
    return [];
  }
  if (Array.isArray(requiredByPr)) {
    const row = requiredByPr.find((entry) => Number(entry?.prNumber) === prNumber);
    return toArray(row?.requiredCheckNames)
      .map((name) => String(name ?? '').trim())
      .filter(Boolean);
  }
  return toArray(requiredByPr[String(prNumber)])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean);
}

/**
 * @param {Record<string, boolean> | Array<RequiredCheckLookupFailedRow> | undefined} lookupFailedByPr
 * @param {number} prNumber
 */
function getRequiredCheckLookupFailedForPr(lookupFailedByPr, prNumber) {
  if (!lookupFailedByPr) {
    return false;
  }
  if (Array.isArray(lookupFailedByPr)) {
    const row = lookupFailedByPr.find((entry) => Number(entry?.prNumber) === prNumber);
    return Boolean(row?.failed);
  }
  return Boolean(lookupFailedByPr[String(prNumber)]);
}

/**
 * @param {DegradedCiTrackingState | undefined} tracking
 * @param {number} prNumber
 * @param {string} headSha
 */
function getDegradedCiAttempts(tracking, prNumber, headSha) {
  const key = degradedCiTrackingKey(prNumber, headSha);
  const record = tracking?.degradedCi?.[key];
  return Number(record?.attempts ?? 0);
}

/**
 * @param {AoSession[]} sessions
 * @param {string} sessionId
 */
export function findSessionByIdForReconcile(sessions, sessionId) {
  return findSessionById(sessions, sessionId);
}

/**
 * @param {object} input
 * @param {OpenPr[]} input.openPrs
 * @param {ReviewRun[]} input.reviewRuns
 * @param {AoSession[]} input.sessions
 * @param {Record<string, CiCheck[]> | Array<CiChecksByPrRow>} [input.ciChecksByPr]
 * @param {Record<string, string[]> | Array<RequiredCheckNamesRow>} [input.requiredCheckNamesByPr]
 * @param {Record<string, boolean> | Array<RequiredCheckLookupFailedRow>} [input.requiredCheckLookupFailedByPr]
 * @param {DegradedCiTrackingState} [input.tracking]
 * @param {number} [input.nowMs]
 */
export function planReconcileActions({
  openPrs,
  reviewRuns,
  sessions,
  ciChecksByPr,
  requiredCheckNamesByPr,
  requiredCheckLookupFailedByPr,
  tracking,
  nowMs = Date.now(),
}) {
  /** @type {Array<{ type: 'start_review', prNumber: number, headSha: string, sessionId: string } | { type: 'skip', prNumber: number, headSha: string, reason: string } | { type: 'escalate_degraded_ci', prNumber: number, headSha: string, reason: string, message: string } | { type: 'track_degraded_ci', prNumber: number, headSha: string, attempts: number, lastAttemptMs: number }>} */
  const actions = [];
  const prList = toArray(openPrs);
  const runList = toArray(reviewRuns);
  const sessionList = toArray(sessions);
  const maxDegradedAttempts = resolveMaxDegradedCiAttempts();

  for (const pr of prList) {
    const prNumber = Number(pr?.number);
    const headSha = String(pr?.headRefOid ?? '');
    if (!prNumber || !headSha) {
      continue;
    }

    const sessionId = resolveHeadOwningWorkerSessionId(sessionList, prNumber, headSha, prList);
    const session = sessionId ? findSessionById(sessionList, sessionId) : null;
    const ciChecks = getCiChecksForPr(ciChecksByPr, prNumber);
    const requiredCheckNames = getRequiredCheckNamesForPr(requiredCheckNamesByPr, prNumber);
    const requiredCheckLookupFailed = getRequiredCheckLookupFailedForPr(
      requiredCheckLookupFailedByPr,
      prNumber,
    );
    const degradedCiAttempts = getDegradedCiAttempts(tracking, prNumber, headSha);
    const headCommittedAtMs = resolveHeadCommittedAtMs(prList, prNumber);

    const decision = evaluateHeadReadyForReview({
      reviewRuns: runList,
      prNumber,
      headSha,
      session,
      ciChecks,
      requiredCheckNames,
      requiredCheckLookupFailed,
      degradedCiAttempts,
      maxDegradedCiAttempts: maxDegradedAttempts,
      headCommittedAtMs,
    });

    const decisionRecordBase = {
      prNumber,
      headSha,
      reviewRuns: runList,
      session,
      ciChecks,
      requiredCheckNames,
      requiredCheckLookupFailed,
      headCommittedAtMs,
    };

    if (decision.eligible) {
      if (!sessionId) {
        actions.push({
          type: 'skip',
          prNumber,
          headSha,
          reason: 'no_worker_session',
          record: buildNoStartDecisionRecord({
            ...decisionRecordBase,
            reason: 'no_worker_session',
          }),
        });
        continue;
      }
      actions.push({
        type: 'start_review',
        prNumber,
        headSha,
        sessionId,
      });
      continue;
    }

    if (decision.route === 'escalate_operator') {
      actions.push({
        type: 'escalate_degraded_ci',
        prNumber,
        headSha,
        reason: decision.reason,
        message: buildDegradedCiEscalationMessage(prNumber, headSha),
      });
      continue;
    }

    if (decision.route === 'degraded_ci_retry') {
      actions.push({
        type: 'track_degraded_ci',
        prNumber,
        headSha,
        attempts: Number(decision.degradedCiAttempts ?? degradedCiAttempts + 1),
        lastAttemptMs: nowMs,
      });
    }

    if (decision.reason === 'no_worker_session') {
      actions.push({
        type: 'skip',
        prNumber,
        headSha,
        reason: 'no_worker_session',
        record: buildNoStartDecisionRecord({
          ...decisionRecordBase,
          reason: 'no_worker_session',
        }),
      });
      continue;
    }

    actions.push({
      type: 'skip',
      prNumber,
      headSha,
      reason: decision.reason,
      record: buildNoStartDecisionRecord({
        ...decisionRecordBase,
        reason: decision.reason,
      }),
    });
  }

  return actions;
}

/**
 * @param {number} prNumber
 * @param {string} headSha
 */
export { formatDecisionRecordForLog } from './review-head-ready.mjs';

export function buildDegradedCiEscalationMessage(prNumber, headSha) {
  return (
    `[review-trigger-reconcile] ESCALATION: required-check visibility unresolved for PR #${prNumber} ` +
    `(head ${normalizeSha(headSha)}). Operator remedy: inspect gh pr checks and branch protection for ` +
    `the head, resolve missing/unreadable required checks, then re-run reconciliation or start ` +
    `review manually when visibility is restored.`
  );
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
  preRunRecheck: () => {
    const payload = readStdinJson();
    return preRunHeadReadyRecheck(payload.planned, payload.fresh);
  },
});
