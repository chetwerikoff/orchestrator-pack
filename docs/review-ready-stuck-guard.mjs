/**
 * Review-ready worker stuck guard (Issue #174).
 * Vitest: scripts/review-ready-stuck-guard.test.ts
 */
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import {
  DELIVERY_STATE_ESCALATED,
  DELIVERY_STATE_UNCONFIRMED,
  getReportState,
  getReportTimestampMs,
  sessionOwnsRunHead,
} from './review-finding-delivery-confirm.mjs';

export { DELIVERY_STATE_ESCALATED, DELIVERY_STATE_UNCONFIRMED };
import { isRuntimeAlive } from './session-runtime-liveness.mjs';
import {
  findSessionById,
  getReportHeadSha,
  getSessionIdentifier,
  getStoredReportHeadSha,
  isLiveWorkerSession,
  normalizeSha,
  reportCoversHead,
  resolveHeadCommittedAtMs,
  sessionMatchesIdentifier,
  sessionMatchesPr,
  toArray,
} from './review-trigger-reconcile.mjs';

export { isRuntimeAlive } from './session-runtime-liveness.mjs';

export { getReportHeadSha, getStoredReportHeadSha, reportCoversHead };

/** Default bounded grace after first false stuck for (session, PR head). */
export const DEFAULT_GRACE_MINUTES = 15;
export const DEFAULT_GRACE_MS = DEFAULT_GRACE_MINUTES * 60 * 1000;

/** Operator override documented in orchestratorRules / runbook. */
export const GRACE_MINUTES_ENV_VAR = 'AO_REVIEW_READY_STUCK_GRACE_MINUTES';

/** Pack merge-contract check names (fallback when branch protection is unset). */
export const PACK_MERGE_CONTRACT_CHECK_NAMES = [
  'verify orchestrator-pack structure',
  'pr scope guard',
  'run pack contract tests',
  'self-architect lint',
];

/** Session AO statuses that indicate a false stuck (activity probe). */
export const FALSE_STUCK_SESSION_STATUSES = new Set(['stuck', 'probe_failure']);

/** Blind recovery forbidden on review-ready guard path (PR #97 split-brain). */
export const BLIND_RECOVERY_FORBIDDEN = [/\bao\s+spawn\b/i, /--claim-pr\b/i];

/** @typedef {{ name?: string, state?: string, conclusion?: string, status?: string }} CiCheck */
/** @typedef {{ number?: number, headRefOid?: string }} OpenPr */
/** @typedef {{ id?: string, prNumber?: number, targetSha?: string, status?: string, findingCount?: number, linkedSessionId?: string }} ReviewRun */
/** @typedef {{ name?: string, sessionId?: string, id?: string, role?: string, prNumber?: number | null, pr?: string | null, ownedHeadSha?: string, headRefOid?: string, status?: string, runtime?: string, reports?: Array<Record<string, unknown>> }} AoSession */
/** @typedef {{ firstFalseStuckAtMs?: number }} GraceRecord */
/** @typedef {{ snapshots?: Record<string, GraceRecord> }} GraceTrackingState */
/** @typedef {{ reachabilityFailed?: boolean, deliveryEscalated?: boolean, floodNotCleared?: boolean }} UnreachabilityEvidence */

/**
 * @param {unknown} value
 * @param {number} defaultValue
 * @param {number} [min]
 */
function resolveBoundedPositiveNumber(value, defaultValue, min = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(min, parsed);
}

/**
 * Resolve grace window: JSON `graceMs` overrides env minutes, then default.
 *
 * @param {{ graceMs?: number }} [config]
 */
export function resolveGraceMs(config = {}) {
  const explicitMs = Number(config.graceMs);
  if (Number.isFinite(explicitMs) && explicitMs > 0) {
    return resolveBoundedPositiveNumber(explicitMs, DEFAULT_GRACE_MS);
  }

  const env = typeof process !== 'undefined' ? process.env?.[GRACE_MINUTES_ENV_VAR] : undefined;
  if (env !== undefined && String(env).trim() !== '') {
    const minutes = resolveBoundedPositiveNumber(
      env,
      DEFAULT_GRACE_MINUTES,
      1,
    );
    return minutes * 60 * 1000;
  }

  return DEFAULT_GRACE_MS;
}

/**
 * @param {string | undefined} raw
 */
export function normalizeCiState(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase();
}

/**
 * @param {CiCheck} check
 */
export function isCiCheckSuccess(check) {
  const state = normalizeCiState(check?.state ?? check?.conclusion ?? check?.status);
  return state === 'success' || state === 'neutral' || state === 'skipped';
}

/**
 * @param {CiCheck} check
 */
export function isCiCheckPending(check) {
  const state = normalizeCiState(check?.state ?? check?.status);
  return state === 'pending' || state === 'queued' || state === 'in_progress' || state === 'waiting';
}

/**
 * @param {CiCheck} check
 */
export function isCiCheckFailure(check) {
  const state = normalizeCiState(check?.state ?? check?.conclusion ?? check?.status);
  return (
    state === 'failure' ||
    state === 'failed' ||
    state === 'error' ||
    state === 'cancelled' ||
    state === 'timed_out' ||
    state === 'action_required'
  );
}

/**
 * @param {CiCheck[]} checks
 * @param {{ requiredCheckNames?: string[] }} [options]
 */
export function isMergeContractCiGreen(checks, options = {}) {
  const list = toArray(checks);
  if (list.length === 0) {
    return false;
  }

  const required =
    options.requiredCheckNames?.length > 0
      ? options.requiredCheckNames
      : PACK_MERGE_CONTRACT_CHECK_NAMES;

  const normalizedRequired = required.map((name) => name.toLowerCase());
  const matched = new Set();

  for (const check of list) {
    const name = String(check?.name ?? '').toLowerCase();
    if (!name || !normalizedRequired.includes(name)) {
      continue;
    }
    if (isCiCheckPending(check) || isCiCheckFailure(check)) {
      return false;
    }
    if (isCiCheckSuccess(check)) {
      matched.add(name);
    }
  }

  return normalizedRequired.every((name) => matched.has(name));
}

/**
 * Latest worker report for a PR head, optionally filtered by reportState.
 *
 * @param {AoSession} session
 * @param {string} headSha
 * @param {{ matchStates?: Set<string>, headCommittedAtMs?: number }} [options]
 */
export function findLatestReportForHead(session, headSha, options = {}) {
  const target = normalizeSha(headSha);
  if (!target) {
    return null;
  }

  const matchStates = options.matchStates;
  const bindingOptions = { headCommittedAtMs: options.headCommittedAtMs };
  let best = null;
  let bestMs = -1;

  for (const report of toArray(session?.reports)) {
    const state = getReportState(report);
    if (matchStates && !matchStates.has(state)) {
      continue;
    }
    if (!reportCoversHead(report, target, bindingOptions)) {
      continue;
    }
    const ts = getReportTimestampMs(report);
    if (ts >= bestMs) {
      bestMs = ts;
      best = report;
    }
  }

  return best;
}

/**
 * @param {AoSession} session
 * @param {string} headSha
 * @param {{ headCommittedAtMs?: number }} [options]
 */
export function findLastReadyForReviewReport(session, headSha, options = {}) {
  return findLatestReportForHead(session, headSha, {
    matchStates: new Set(['ready_for_review']),
    headCommittedAtMs: options.headCommittedAtMs,
  });
}

/**
 * Only a clean (finished) review run grants review-ready protection.
 *
 * @param {ReviewRun} run
 * @param {number} prNumber
 * @param {string} headSha
 * @param {string} sessionId
 */
export function isCoveringCleanRun(run, prNumber, headSha, sessionId) {
  const status = String(run?.status ?? '').toLowerCase();
  if (status !== 'clean') {
    return false;
  }
  if (Number(run?.findingCount ?? 0) !== 0) {
    return false;
  }
  if (Number(run?.prNumber) !== prNumber) {
    return false;
  }
  if (normalizeSha(run?.targetSha) !== normalizeSha(headSha)) {
    return false;
  }
  const linked = String(run?.linkedSessionId ?? '').trim();
  if (!linked) {
    return false;
  }
  return linked === sessionId;
}

/**
 * @param {ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} headSha
 * @param {string} sessionId
 * @param {AoSession[]} sessions
 */
export function findCoveringCleanRun(runs, prNumber, headSha, sessionId, sessions) {
  const session = findSessionById(sessions, sessionId);
  for (const run of toArray(runs)) {
    if (isCoveringCleanRun(run, prNumber, headSha, sessionId)) {
      return run;
    }
    if (
      session &&
      isCoveringCleanRun(run, prNumber, headSha, getSessionIdentifier(session) ?? '')
    ) {
      return run;
    }
    const linked = String(run?.linkedSessionId ?? '').trim();
    if (
      session &&
      linked &&
      sessionMatchesIdentifier(session, linked) &&
      isCoveringCleanRun(run, prNumber, headSha, linked)
    ) {
      return run;
    }
  }
  return null;
}

/**
 * @param {string} sessionId
 * @param {string} headSha
 */
export function graceTrackingKey(sessionId, headSha) {
  return `${String(sessionId).trim()}:${normalizeSha(headSha)}`;
}

/**
 * @param {GraceTrackingState} tracking
 * @param {string} sessionId
 * @param {string} headSha
 * @param {number} nowMs
 */
export function getGraceAnchorMs(tracking, sessionId, headSha, nowMs) {
  const key = graceTrackingKey(sessionId, headSha);
  const existing = tracking?.snapshots?.[key]?.firstFalseStuckAtMs;
  if (existing && existing > 0) {
    return existing;
  }
  return nowMs;
}

/**
 * @param {number} anchorMs
 * @param {number} nowMs
 * @param {number} graceMs
 */
export function isWithinGrace(anchorMs, nowMs, graceMs) {
  return nowMs - anchorMs < graceMs;
}

/**
 * @param {UnreachabilityEvidence} evidence
 */
export function hasAffirmativeUnreachability(evidence) {
  return Boolean(
    evidence?.reachabilityFailed ||
      evidence?.deliveryEscalated ||
      evidence?.floodNotCleared,
  );
}

/**
 * @param {object} input
 * @param {AoSession} input.session
 * @param {OpenPr} input.openPr
 * @param {ReviewRun[]} input.reviewRuns
 * @param {CiCheck[]} input.ciChecks
 * @param {AoSession[]} [input.sessions]
 */
export function classifyReviewReadySnapshot({
  session,
  openPr,
  reviewRuns,
  ciChecks,
  sessions = [],
}) {
  const prNumber = Number(openPr?.number ?? session?.prNumber);
  const headSha = normalizeSha(openPr?.headRefOid);
  const sessionId = getSessionIdentifier(session);
  const reasons = [];

  if (!prNumber || !headSha || !sessionId) {
    return {
      reviewReady: false,
      reasons: ['missing_snapshot_ids'],
      prNumber: prNumber || 0,
      headSha: headSha || '',
      sessionId: sessionId || '',
      readyReport: null,
      cleanRun: null,
    };
  }

  if (!sessionMatchesPr(session, prNumber)) {
    reasons.push('session_not_linked_to_pr');
  }

  if (!sessionOwnsRunHead(session, prNumber, headSha, [openPr])) {
    reasons.push('session_does_not_own_current_head');
  }

  if (!isLiveWorkerSession(session)) {
    reasons.push('session_not_live');
  }

  if (!isRuntimeAlive(session)) {
    reasons.push('runtime_not_alive');
  }

  if (!isMergeContractCiGreen(ciChecks)) {
    reasons.push('ci_not_green');
  }

  const headCommittedAtMs = resolveHeadCommittedAtMs([openPr], prNumber);
  const readyReport = findLastReadyForReviewReport(session, headSha, { headCommittedAtMs });
  if (!readyReport) {
    reasons.push('no_ready_for_review_for_head');
  }

  const cleanRun = findCoveringCleanRun(
    reviewRuns,
    prNumber,
    headSha,
    sessionId,
    sessions.length ? sessions : [session],
  );
  if (!cleanRun) {
    reasons.push('no_covering_clean_run');
  }

  const reviewReady = reasons.length === 0;
  return {
    reviewReady,
    reasons,
    prNumber,
    headSha,
    sessionId,
    readyReport,
    cleanRun,
  };
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} input.deliveryTracking
 * @param {string} input.runId
 */
export function isDeliveryEscalatedForUnreachability(input) {
  const state = input?.deliveryTracking?.runs?.[input.runId]?.deliveryState;
  return state === DELIVERY_STATE_ESCALATED || state === DELIVERY_STATE_UNCONFIRMED;
}

/**
 * @param {string[]} commandLines
 */
export function findBlindRecoveryViolations(commandLines) {
  /** @type {Array<{ command: string, pattern: string }>} */
  const violations = [];
  for (const command of commandLines ?? []) {
    const line = String(command ?? '');
    for (const pattern of BLIND_RECOVERY_FORBIDDEN) {
      if (pattern.test(line)) {
        violations.push({ command: line, pattern: pattern.source });
      }
    }
  }
  return violations;
}

/**
 * @param {object} input
 * @param {AoSession} input.session
 * @param {OpenPr} input.openPr
 * @param {ReviewRun[]} input.reviewRuns
 * @param {CiCheck[]} input.ciChecks
 * @param {AoSession[]} [input.sessions]
 * @param {GraceTrackingState} [input.tracking]
 * @param {UnreachabilityEvidence} [input.unreachability]
 * @param {number} input.nowMs
 * @param {number} [input.graceMs]
 * @param {Record<string, unknown>} [input.deliveryTracking]
 */
export function planStuckGuardReaction({
  session,
  openPr,
  reviewRuns,
  ciChecks,
  sessions,
  tracking,
  unreachability,
  nowMs,
  graceMs,
  deliveryTracking,
}) {
  const classification = classifyReviewReadySnapshot({
    session,
    openPr,
    reviewRuns,
    ciChecks,
    sessions,
  });

  const status = String(session?.status ?? '').toLowerCase();
  const isFalseStuck = FALSE_STUCK_SESSION_STATUSES.has(status);

  if (!isFalseStuck) {
    return {
      classification,
      action: { type: 'allow_normal', reason: 'not_false_stuck_status' },
      graceAnchorMs: null,
      graceDeadlineMs: null,
    };
  }

  if (!classification.reviewReady) {
    return {
      classification,
      action: { type: 'allow_normal', reason: 'not_review_ready_snapshot' },
      graceAnchorMs: null,
      graceDeadlineMs: null,
    };
  }

  const resolvedGraceMs = resolveGraceMs({ graceMs });
  const anchorMs = getGraceAnchorMs(
    tracking ?? { snapshots: {} },
    classification.sessionId,
    classification.headSha,
    nowMs,
  );
  const deadlineMs = anchorMs + resolvedGraceMs;
  const withinGrace = isWithinGrace(anchorMs, nowMs, resolvedGraceMs);

  const deliveryRunId = String(classification.cleanRun?.id ?? '').trim();
  const deliveryEscalated =
    unreachability?.deliveryEscalated ||
    (deliveryRunId &&
      isDeliveryEscalatedForUnreachability({
        deliveryTracking,
        runId: deliveryRunId,
      }));

  const evidence = {
    reachabilityFailed: Boolean(unreachability?.reachabilityFailed),
    deliveryEscalated: Boolean(deliveryEscalated),
    floodNotCleared: Boolean(unreachability?.floodNotCleared),
  };

  if (hasAffirmativeUnreachability(evidence)) {
    return {
      classification,
      action: {
        type: 'recycle_escalate',
        reason: 'affirmative_unreachable_within_or_after_grace',
        evidence,
        forbidBlindRecovery: true,
      },
      graceAnchorMs: anchorMs,
      graceDeadlineMs: deadlineMs,
    };
  }

  if (withinGrace) {
    return {
      classification,
      action: {
        type: 'hold_grace',
        reason: 'review_ready_false_stuck_grace',
        forbidImmediateLifecycle: true,
      },
      graceAnchorMs: anchorMs,
      graceDeadlineMs: deadlineMs,
    };
  }

  return {
    classification,
    action: {
      type: 'allow_normal',
      reason: 'grace_expired_no_affirmative_unreachable',
    },
    graceAnchorMs: anchorMs,
    graceDeadlineMs: deadlineMs,
  };
}

/**
 * Pre-shield snapshot recheck (Issue #250 AC11).
 *
 * @param {object} planned
 * @param {string} planned.sessionId
 * @param {number} planned.prNumber
 * @param {string} planned.headSha
 * @param {object} fresh
 * @param {AoSession[]} fresh.sessions
 * @param {OpenPr[]} fresh.openPrs
 * @param {ReviewRun[]} fresh.reviewRuns
 * @param {CiCheck[]} fresh.ciChecks
 */
export function preShieldRecheck(planned, fresh) {
  const { sessionId, prNumber, headSha } = planned;
  const sessionList = toArray(fresh.sessions);
  const session = findSessionById(sessionList, sessionId);
  if (!session) {
    return { ok: false, reason: 'session_missing_at_shield' };
  }
  if (getSessionIdentifier(session) !== sessionId) {
    return { ok: false, reason: 'session_id_changed' };
  }

  const openPr = toArray(fresh.openPrs).find((pr) => Number(pr?.number) === prNumber);
  if (!openPr) {
    return { ok: false, reason: 'open_pr_missing_at_shield' };
  }
  if (normalizeSha(openPr.headRefOid) !== normalizeSha(headSha)) {
    return { ok: false, reason: 'head_changed_at_shield' };
  }

  const classification = classifyReviewReadySnapshot({
    session,
    openPr,
    reviewRuns: toArray(fresh.reviewRuns),
    ciChecks: toArray(fresh.ciChecks),
    sessions: sessionList,
  });

  if (!classification.reviewReady) {
    return { ok: false, reason: `recheck_failed:${classification.reasons.join(',')}` };
  }
  if (classification.sessionId !== sessionId) {
    return { ok: false, reason: 'session_id_changed' };
  }
  if (classification.headSha !== normalizeSha(headSha)) {
    return { ok: false, reason: 'head_changed_at_shield' };
  }

  return { ok: true, reason: 'ok' };
}

runStdinJsonCli('review-ready-stuck-guard.mjs', {
  classify: () => {
    const payload = readStdinJson();
    return classifyReviewReadySnapshot(payload);
  },
  plan: () => {
    const payload = readStdinJson();
    return planStuckGuardReaction(payload);
  },
});
