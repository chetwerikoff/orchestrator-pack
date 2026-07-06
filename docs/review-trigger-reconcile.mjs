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
import { buildReviewTriggerInvocation } from './ao-0-10-review-api.mjs';
import {
  COVERED_TERMINAL_REVIEW_STATUSES,
  collectSessionIdentifiers,
  getSessionIdentifier,
  IN_FLIGHT_REVIEW_STATUSES,
  isHeadCovered,
  isLiveWorkerSession,
  isRunCoveringHead,
  NON_LIVE_WORKER_SESSION_STATUSES,
  normalizeSha,
  toArray,
} from './review-reconcile-primitives.mjs';
import {
  buildNoStartDecisionRecord,
  degradedCiTrackingKey,
  evaluateHeadReadyForReview,
  findFreshReadyForReviewHandoff,
  findLatestAcceptedReportForHead,
  formatDecisionRecordForLog,
  hasReadyForReviewForHead,
  mergeWorkerDeliveriesFromPlanInput,
  preRunHeadReadyRecheck,
  resolveMaxDegradedCiAttempts,
} from './review-head-ready.mjs';
import {
  coalesceSuppressAudit,
  commitOwnerCyclePatch,
  commitReviewStartedCycleState,
  evaluateWorkerIterationCycleForPr,
  evaluateQuiescentFallbackNudgePrecedence,
  mergeSharedWorkerIterationCycleState,
  NUDGE_EXPIRY_MS,
  CYCLE_SURFACE_READY_FOR_REVIEW,
} from './worker-iteration-cycle.mjs';
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

export {
  COVERED_TERMINAL_REVIEW_STATUSES,
  IN_FLIGHT_REVIEW_STATUSES,
  NON_LIVE_WORKER_SESSION_STATUSES,
  collectSessionIdentifiers,
  getSessionIdentifier,
  isHeadCovered,
  isLiveWorkerSession,
  isRunCoveringHead,
  normalizeSha,
  toArray,
} from './review-reconcile-primitives.mjs';

/** Shell fragments the reconcile entrypoint must never invoke (PR #97 split-brain). */
export const FORBIDDEN_LIFECYCLE_PATTERNS = MECHANICAL_FORBIDDEN_REVIEW_MECHANICAL;

/** Strict resolver defers to legacy report binding; quiescence must still fail closed. */
export const AMBIGUOUS_IMPLICIT_HEAD_OWNER_REASON = 'ambiguous_implicit_head_owner';

const FAILED_OR_CANCELLED = new Set(['failed', 'cancelled']);

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
 */
function sortRunsByRecency(runs) {
  return [...toArray(runs)].sort((a, b) => {
    const aMs = Date.parse(String(a?.createdAt ?? a?.startedAt ?? '')) || 0;
    const bMs = Date.parse(String(b?.createdAt ?? b?.startedAt ?? '')) || 0;
    if (bMs !== aMs) {
      return bMs - aMs;
    }
    return String(b?.id ?? b?.runId ?? '').localeCompare(String(a?.id ?? a?.runId ?? ''));
  });
}

/**
 * Latest failed/cancelled row for the current-head key (matches coverage latest-row axis).
 *
 * @param {ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} headSha
 */
export function findFailedOrCancelledRunForHead(runs, prNumber, headSha) {
  const head = normalizeSha(headSha);
  const failedRows = toArray(runs).filter((run) => {
    const status = String(run?.status ?? '').toLowerCase();
    return (
      Number(run?.prNumber) === prNumber &&
      normalizeSha(run?.targetSha) === head &&
      FAILED_OR_CANCELLED.has(status)
    );
  });
  return sortRunsByRecency(failedRows)[0] ?? null;
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
 * Live worker sessions linked to a PR (any liveness).
 *
 * @param {AoSession[]} sessions
 * @param {number} prNumber
 */
export function listWorkersForPr(sessions, prNumber) {
  return toArray(sessions).filter((session) => {
    const role = String(session?.role ?? '').toLowerCase();
    return (role === 'worker' || role === 'coding') && sessionMatchesPr(session, prNumber);
  });
}

/**
 * Fail-closed owner resolution for quiescence fallback (Issue #261).
 * Returns exactly one live head owner, or a visible defer reason.
 *
 * @param {AoSession[]} sessions
 * @param {number} prNumber
 * @param {string} headSha
 * @param {OpenPr[]} [openPrs]
 */
export function resolveStrictHeadOwningWorkerSession(sessions, prNumber, headSha, openPrs = []) {
  const prList = toArray(openPrs);
  const workers = listWorkersForPr(sessions, prNumber);
  const explicitOwners = workers.filter((session) =>
    sessionExplicitlyOwnsHead(session, headSha),
  );
  const liveExplicitOwners = explicitOwners.filter((session) =>
    isLiveWorkerSession(session),
  );

  if (liveExplicitOwners.length === 1) {
    return {
      sessionId: getSessionIdentifier(liveExplicitOwners[0]),
      reason: 'resolved',
      failClosed: false,
    };
  }

  if (liveExplicitOwners.length > 1) {
    return {
      sessionId: null,
      reason: 'ambiguous_head_owner',
      failClosed: true,
    };
  }

  if (explicitOwners.some((session) => !isLiveWorkerSession(session))) {
    return {
      sessionId: null,
      reason: 'no_live_review_target',
      failClosed: true,
    };
  }

  const implicitOwners = workers.filter(
    (session) =>
      !sessionExplicitlyOwnsHead(session, headSha) &&
      sessionOwnsRunHead(session, prNumber, headSha, prList),
  );
  const liveImplicitOwners = implicitOwners.filter((session) =>
    isLiveWorkerSession(session),
  );

  if (liveImplicitOwners.length > 1) {
    return {
      sessionId: null,
      reason: AMBIGUOUS_IMPLICIT_HEAD_OWNER_REASON,
      failClosed: false,
    };
  }

  if (liveImplicitOwners.length === 1) {
    return {
      sessionId: getSessionIdentifier(liveImplicitOwners[0]),
      reason: 'resolved',
      failClosed: false,
    };
  }

  if (implicitOwners.some((session) => !isLiveWorkerSession(session))) {
    return {
      sessionId: null,
      reason: 'no_live_review_target',
      failClosed: true,
    };
  }

  return {
    sessionId: null,
    reason: 'no_worker_session',
    failClosed: false,
  };
}

/**
 * Resolve the worker session used for reconcile eligibility and review starts.
 * Prefer the strict head owner when resolved; never fall back to legacy selection
 * when strict resolution fails closed.
 *
 * @param {AoSession[]} sessions
 * @param {number} prNumber
 * @param {string} headSha
 * @param {OpenPr[]} [openPrs]
 */
export function resolveReconcileEvaluationSession(sessions, prNumber, headSha, openPrs = []) {
  const sessionList = toArray(sessions);
  const prList = toArray(openPrs);
  const ownerResolution = resolveStrictHeadOwningWorkerSession(
    sessionList,
    prNumber,
    headSha,
    prList,
  );

  if (ownerResolution.failClosed) {
    return {
      ownerResolution,
      sessionId: null,
      session: null,
    };
  }

  if (ownerResolution.sessionId) {
    const sessionId = ownerResolution.sessionId;
    return {
      ownerResolution,
      sessionId,
      session: findSessionById(sessionList, sessionId),
    };
  }

  const sessionId = resolveHeadOwningWorkerSessionId(
    sessionList,
    prNumber,
    headSha,
    prList,
  );
  return {
    ownerResolution,
    sessionId,
    session: sessionId ? findSessionById(sessionList, sessionId) : null,
  };
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
export function getCiChecksForPr(ciChecksByPr, prNumber) {
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
export function getRequiredCheckNamesForPr(requiredByPr, prNumber) {
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
export function getRequiredCheckLookupFailedForPr(lookupFailedByPr, prNumber) {
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
 * Persist ready_for_review settle debounce so later ticks do not reset startedAtMs.
 *
 * @param {Record<string, unknown>} cycleState
 * @param {Record<string, unknown>} cycleEval
 * @param {number} prNumber
 * @param {string} sessionId
 * @param {string} headSha
 * @param {number} nowMs
 */
function commitReadyForReviewDebounceIfWaiting(cycleState, cycleEval, prNumber, sessionId, headSha, nowMs) {
  if (
    !cycleEval.cycle ||
    !cycleEval.readyDebounce?.waiting ||
    cycleEval.readyDebounce?.settled
  ) {
    return cycleState;
  }
  const debouncePatch = {
    debounce: {
      ...(cycleEval.cycle.debounce ?? {}),
      [CYCLE_SURFACE_READY_FOR_REVIEW]: {
        startedAtMs: cycleEval.readyDebounce.startedAtMs ?? nowMs,
        handoffHeadSha: cycleEval.readyDebounce.handoffHeadSha ?? normalizeSha(headSha),
      },
    },
  };
  return commitOwnerCyclePatch(
    cycleState,
    cycleEval.repoId,
    prNumber,
    sessionId,
    { ...cycleEval.cycle, ...debouncePatch },
  );
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
 * @param {Array<Record<string, unknown>>} [input.workerDeliveries]
 * @param {Array<Record<string, unknown>>} [input.aoEvents]
 * @param {Record<string, Record<string, unknown>>} [input.dispatchJournal]
 * @param {Record<string, string>} [input.reactionMessages]
 * @param {Record<string, unknown>} [input.cycleState]
 * @param {Record<string, unknown>} [input.sharedCycleState]
 * @param {Record<string, { sessionId?: string, sentAtMs?: number }>} [input.legacyNudged]
 * @param {string} [input.repoRoot]
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
  workerDeliveries,
  aoEvents,
  dispatchJournal,
  reactionMessages,
  cycleState,
  sharedCycleState,
  legacyNudged,
  repoRoot,
}) {
  /** @type {Array<{ type: 'start_review', prNumber: number, headSha: string, sessionId: string, startReason?: string, quiescenceBasis?: Record<string, unknown> } | { type: 'skip', prNumber: number, headSha: string, reason: string } | { type: 'escalate_degraded_ci', prNumber: number, headSha: string, reason: string, message: string } | { type: 'track_degraded_ci', prNumber: number, headSha: string, attempts: number, lastAttemptMs: number }>} */
  const actions = [];
  const prList = toArray(openPrs);
  const runList = toArray(reviewRuns);
  const sessionList = toArray(sessions);
  const maxDegradedAttempts = resolveMaxDegradedCiAttempts();
  const sharedNudged = legacyNudged ?? tracking?.legacyNudged ?? null;
  let nextCycleState = mergeSharedWorkerIterationCycleState(
    { ...(cycleState ?? tracking?.cycleState ?? {}) },
    sharedCycleState ?? tracking?.sharedCycleState ?? {},
  );
  const mergedDeliveries = mergeWorkerDeliveriesFromPlanInput({
    workerDeliveries,
    aoEvents,
    dispatchJournal,
    reviewRuns: runList,
    reactionMessages,
    nowMs,
  });

  for (const pr of prList) {
    const prNumber = Number(pr?.number);
    const headSha = String(pr?.headRefOid ?? '');
    if (!prNumber || !headSha) {
      continue;
    }

    const { ownerResolution, sessionId, session } = resolveReconcileEvaluationSession(
      sessionList,
      prNumber,
      headSha,
      prList,
    );
    const ciChecks = getCiChecksForPr(ciChecksByPr, prNumber);
    const requiredCheckNames = getRequiredCheckNamesForPr(requiredCheckNamesByPr, prNumber);
    const requiredCheckLookupFailed = getRequiredCheckLookupFailedForPr(
      requiredCheckLookupFailedByPr,
      prNumber,
    );
    const degradedCiAttempts = getDegradedCiAttempts(tracking, prNumber, headSha);
    const headCommittedAtMs = resolveHeadCommittedAtMs(prList, prNumber);
    const reportBindingOptions = { headCommittedAtMs };
    const handoffAccepted = hasReadyForReviewForHead(session, headSha, reportBindingOptions);
    const handoffReportedAtMs = handoffAccepted
      ? getReportTimestampMs(
          findFreshReadyForReviewHandoff(session, headSha, reportBindingOptions) ?? {},
        )
      : 0;
    const cycleEval = evaluateWorkerIterationCycleForPr({
      cycleState: nextCycleState,
      repoRoot,
      prNumber,
      headSha,
      ownerSessionId: sessionId ?? '',
      ownerResolutionFailClosed: Boolean(ownerResolution?.failClosed),
      reviewRuns: runList,
      session,
      workerDeliveries: mergedDeliveries,
      nowMs,
      headCommittedAtMs,
      handoffAccepted,
      handoffReportedAtMs,
      legacyNudged: sharedNudged,
    });
    nextCycleState = cycleEval.state;

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
      ownerResolution,
      nowMs,
      workerDeliveries: mergedDeliveries,
      openPrs: prList,
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

      const isQuiescentFallback = decision.reason === 'quiescent_worker_handoff_fallback';
      if (isQuiescentFallback) {
        const nudgePrecedence = evaluateQuiescentFallbackNudgePrecedence(cycleEval, nowMs);
        if (nudgePrecedence.blocked) {
          actions.push({
            type: 'skip',
            prNumber,
            headSha,
            reason: nudgePrecedence.reason,
            record: buildNoStartDecisionRecord({
              ...decisionRecordBase,
              reason: nudgePrecedence.reason,
            }),
          });
          continue;
        }
      }

      if (!cycleEval.reviewGate.allow) {
        const blockers = cycleEval.reviewGate.blockers;
        let cycle = cycleEval.cycle;
        if (cycle) {
          cycle = {
            ...cycle,
            suppressAudit: coalesceSuppressAudit(
              cycle,
              isQuiescentFallback ? 'quiescent_fallback' : 'ready_for_review',
              headSha,
              blockers,
            ),
          };
          nextCycleState = commitOwnerCyclePatch(
            nextCycleState,
            cycleEval.repoId,
            prNumber,
            sessionId,
            cycle,
          );
        }
        if (
          handoffAccepted &&
          cycleEval.readyDebounce?.waiting &&
          !cycleEval.readyDebounce?.settled
        ) {
          nextCycleState = commitReadyForReviewDebounceIfWaiting(
            nextCycleState,
            cycleEval,
            prNumber,
            sessionId,
            headSha,
            nowMs,
          );
        }
        actions.push({
          type: 'skip',
          prNumber,
          headSha,
          reason: cycleEval.reviewGate.deferReason,
          record: buildNoStartDecisionRecord({
            ...decisionRecordBase,
            reason: cycleEval.reviewGate.deferReason,
            failedComponents: blockers,
          }),
        });
        continue;
      }

      if (
        handoffAccepted &&
        cycleEval.readyDebounce.waiting &&
        !cycleEval.readyDebounce.settled
      ) {
        nextCycleState = commitReadyForReviewDebounceIfWaiting(
          nextCycleState,
          cycleEval,
          prNumber,
          sessionId,
          headSha,
          nowMs,
        );
        actions.push({
          type: 'skip',
          prNumber,
          headSha,
          reason: 'ready_for_review_debounce_pending',
          record: buildNoStartDecisionRecord({
            ...decisionRecordBase,
            reason: 'ready_for_review_debounce_pending',
          }),
        });
        continue;
      }

      const startAction = {
        type: 'start_review',
        prNumber,
        headSha,
        sessionId,
        ownerCycle: {
          repoId: cycleEval.repoId,
          cycle: cycleEval.cycle ?? {},
          isQuiescentFallback,
        },
      };
      if (isQuiescentFallback) {
        startAction.startReason = decision.reason;
        if (decision.quiescenceBasis) {
          startAction.quiescenceBasis = decision.quiescenceBasis;
        }
      }
      actions.push(startAction);
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

    if (
      decision.reason === 'no_worker_session' ||
      decision.reason === 'no_live_review_target' ||
      decision.reason === 'ambiguous_head_owner'
    ) {
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

  return { actions, cycleState: nextCycleState };
}

/**
 * @param {{ actions?: unknown[], cycleState?: Record<string, unknown> } | unknown[]} result
 */
export function unwrapReconcilePlanResult(result) {
  if (Array.isArray(result)) {
    return { actions: result, cycleState: {} };
  }
  return {
    actions: toArray(result?.actions),
    cycleState: result?.cycleState ?? {},
  };
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
export function buildReviewRunArgv(sessionId, reviewCommand = '') {
  void reviewCommand;
  return buildReviewTriggerInvocation(sessionId).shimArgv;
}

export function buildReviewTriggerPath(sessionId) {
  return buildReviewTriggerInvocation(sessionId).path;
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
  'commit-review-started': () => {
    const payload = readStdinJson();
    return {
      cycleState: commitReviewStartedCycleState(payload.cycleState ?? {}, {
        repoId: payload.repoId,
        prNumber: Number(payload.prNumber),
        ownerSessionId: String(payload.ownerSessionId ?? ''),
        cycle: payload.cycle,
        isQuiescentFallback: Boolean(payload.isQuiescentFallback),
      }),
    };
  },
});
