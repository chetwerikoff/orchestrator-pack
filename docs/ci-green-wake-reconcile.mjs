/**
 * State-derived CI-green worker wake (Issue #191).
 * Vitest: scripts/ci-green-wake-reconcile.test.ts
 */
import {
  evaluateMechanicalTickInterval,
  findForbiddenCommandPatterns,
  MECHANICAL_FORBIDDEN_SPAWN_CLAIM_KILL,
  readStdinJson,
  runStdinJsonCli,
} from './review-mechanical-cli.mjs';
import { getReportState, sessionOwnsRunHead } from './review-finding-delivery-confirm.mjs';
import {
  findLatestReportForHead,
  isCiCheckFailure,
  isCiCheckPending,
  isMergeContractCiGreen,
  isRuntimeAlive,
} from './review-ready-stuck-guard.mjs';
import {
  findSessionById,
  getSessionIdentifier,
  isLiveWorkerSession,
  normalizeSha,
  resolveWorkerSessionId,
  toArray,
} from './review-trigger-reconcile.mjs';
/** Default tick cadence: 1 minute (fast path; far below report-stale ~30m). */
export const DEFAULT_CI_GREEN_WAKE_INTERVAL_MS = 60 * 1000;

/** Worker report states eligible for CI-green nudge (pre-hand-off). */
export const PRE_HANDOFF_REPORT_STATES = new Set(['fixing_ci', 'working', 'pr_created']);

/** Post-hand-off states — no CI-green nudge (#174 / review loop). */
export const POST_HANDOFF_REPORT_STATES = new Set(['ready_for_review', 'addressing_reviews']);

/** Shell fragments forbidden on this path (PR #97 split-brain). ao send is required. */
export const FORBIDDEN_LIFECYCLE_PATTERNS = MECHANICAL_FORBIDDEN_SPAWN_CLAIM_KILL;

export const CI_GREEN_WAKE_MESSAGE =
  'Required CI is green for the current PR head. Continue your hand-off: verify gh pr checks for this head, then ao report ready_for_review when criteria are met. Do not stay idle waiting for report-stale.';

/** @typedef {'green' | 'red' | 'pending'} CiLevel */
/** @typedef {{ name?: string, state?: string, conclusion?: string, status?: string }} CiCheck */
/** @typedef {{ number?: number, headRefOid?: string }} OpenPr */
/** @typedef {{ name?: string, sessionId?: string, id?: string, role?: string, prNumber?: number | null, pr?: string | null, ownedHeadSha?: string, headRefOid?: string, status?: string, runtime?: string, reports?: Array<Record<string, unknown>> }} AoSession */
/** @typedef {{ lastCiLevel?: CiLevel, greenEpoch?: number }} HeadCiRecord */
/** @typedef {{ heads?: Record<string, HeadCiRecord>, nudged?: Record<string, { sessionId?: string, sentAtMs?: number }>, lastTickMs?: number }} CiGreenWakeState */
/** @typedef {{ type: 'nudge', prNumber: number, headSha: string, sessionId: string, transitionId: string, message: string } | { type: 'skip', prNumber: number, headSha: string, reason: string, transitionId?: string }} CiGreenWakeAction */

/**
 * @param {CiCheck[]} checks
 */
export function classifyRequiredCiLevel(checks) {
  const list = toArray(checks);
  if (list.length === 0) {
    return /** @type {CiLevel} */ ('pending');
  }
  if (isMergeContractCiGreen(list)) {
    return 'green';
  }
  for (const check of list) {
    if (isCiCheckPending(check)) {
      return 'pending';
    }
  }
  for (const check of list) {
    if (isCiCheckFailure(check)) {
      return 'red';
    }
  }
  return 'red';
}

/**
 * @param {number} prNumber
 * @param {string} headSha
 */
export function headTrackingKey(prNumber, headSha) {
  return `${prNumber}:${normalizeSha(headSha)}`;
}

/**
 * @param {number} prNumber
 * @param {string} headSha
 * @param {number} greenEpoch
 */
export function buildTransitionId(prNumber, headSha, greenEpoch) {
  return `${headTrackingKey(prNumber, headSha)}:${greenEpoch}`;
}

/**
 * @param {HeadCiRecord | undefined} record
 * @param {CiLevel} currentLevel
 */
export function deriveGreenEpoch(record, currentLevel) {
  const priorLevel = record?.lastCiLevel;
  const priorEpoch = Number(record?.greenEpoch ?? 0);

  if (currentLevel !== 'green') {
    return { greenEpoch: priorEpoch, lastCiLevel: currentLevel };
  }

  if (priorLevel !== 'green') {
    return { greenEpoch: Math.max(1, priorEpoch + 1), lastCiLevel: 'green' };
  }

  return {
    greenEpoch: priorEpoch > 0 ? priorEpoch : 1,
    lastCiLevel: 'green',
  };
}

/**
 * @param {AoSession} session
 * @param {string} headSha
 */
/**
 * @param {AoSession} session
 * @param {string} headSha
 */
export function isPreHandOffWorkerForHead(session, headSha) {
  const postHandOff = findLatestReportForHead(session, headSha, {
    matchStates: POST_HANDOFF_REPORT_STATES,
  });
  if (postHandOff) {
    return false;
  }

  const last = findLatestReportForHead(session, headSha);
  if (!last) {
    return true;
  }

  return PRE_HANDOFF_REPORT_STATES.has(getReportState(last));
}

/**
 * @param {object} input
 * @param {AoSession} input.session
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {OpenPr[]} [input.openPrs]
 * @param {CiCheck[]} [input.ciChecks]
 */
export function evaluateCiGreenWakeCandidate({
  session,
  prNumber,
  headSha,
  openPrs = [],
  ciChecks = [],
}) {
  const sessionId = getSessionIdentifier(session);
  const reasons = [];

  if (!sessionId) {
    reasons.push('no_session_id');
  }
  if (!isLiveWorkerSession(session)) {
    reasons.push('session_not_live');
  }
  if (!isRuntimeAlive(session)) {
    reasons.push('runtime_not_alive');
  }
  if (!sessionOwnsRunHead(session, prNumber, headSha, openPrs)) {
    reasons.push('session_does_not_own_head');
  }
  if (!isPreHandOffWorkerForHead(session, headSha)) {
    reasons.push('post_handoff_or_ineligible_report');
  }

  const ciLevel = classifyRequiredCiLevel(ciChecks);
  if (ciLevel !== 'green') {
    reasons.push(`ci_${ciLevel}`);
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    sessionId: sessionId ?? '',
    ciLevel,
  };
}

/**
 * @param {object} input
 * @param {OpenPr[]} input.openPrs
 * @param {AoSession[]} input.sessions
 * @param {Record<string, CiCheck[]> | Array<{ prNumber: number, checks: CiCheck[] }>} input.ciChecksByPr
 * @param {CiGreenWakeState} [input.tracking]
 */
export function planCiGreenWakeActions({ openPrs, sessions, ciChecksByPr, tracking = {} }) {
  /** @type {CiGreenWakeAction[]} */
  const actions = [];
  const sessionList = toArray(sessions);
  const headRecords = { ...(tracking.heads ?? {}) };
  const nudged = tracking.nudged ?? {};

  const checksMap = normalizeCiChecksByPr(ciChecksByPr);

  for (const pr of toArray(openPrs)) {
    const prNumber = Number(pr?.number);
    const headSha = normalizeSha(pr?.headRefOid);
    if (!prNumber || !headSha) {
      continue;
    }

    const checks = checksMap.get(prNumber) ?? [];
    const ciLevel = classifyRequiredCiLevel(checks);
    const trackKey = headTrackingKey(prNumber, headSha);
    const derived = deriveGreenEpoch(headRecords[trackKey], ciLevel);
    headRecords[trackKey] = derived;

    if (ciLevel !== 'green') {
      continue;
    }

    const sessionId = resolveWorkerSessionId(sessionList, prNumber);
    if (!sessionId) {
      actions.push({ type: 'skip', prNumber, headSha, reason: 'no_worker_session' });
      continue;
    }

    const session = findSessionById(sessionList, sessionId);
    if (!session) {
      actions.push({ type: 'skip', prNumber, headSha, reason: 'session_not_found' });
      continue;
    }

    const candidate = evaluateCiGreenWakeCandidate({
      session,
      prNumber,
      headSha,
      openPrs: toArray(openPrs),
      ciChecks: checks,
    });

    if (!candidate.eligible) {
      actions.push({
        type: 'skip',
        prNumber,
        headSha,
        reason: candidate.reasons.join(','),
      });
      continue;
    }

    const transitionId = buildTransitionId(prNumber, headSha, derived.greenEpoch);
    if (nudged[transitionId]) {
      actions.push({
        type: 'skip',
        prNumber,
        headSha,
        reason: 'already_nudged',
        transitionId,
      });
      continue;
    }

    actions.push({
      type: 'nudge',
      prNumber,
      headSha,
      sessionId,
      transitionId,
      message: CI_GREEN_WAKE_MESSAGE,
    });
  }

  return { actions, headRecords };
}

/**
 * @param {Record<string, CiCheck[]> | Array<{ prNumber: number, checks: CiCheck[] }>} ciChecksByPr
 * @returns {Map<number, CiCheck[]>}
 */
export function normalizeCiChecksByPr(ciChecksByPr) {
  /** @type {Map<number, CiCheck[]>} */
  const map = new Map();
  if (ciChecksByPr == null) {
    return map;
  }
  if (Array.isArray(ciChecksByPr)) {
    for (const row of ciChecksByPr) {
      const prNumber = Number(row?.prNumber);
      if (prNumber) {
        map.set(prNumber, toArray(row?.checks));
      }
    }
    return map;
  }
  for (const [key, checks] of Object.entries(ciChecksByPr)) {
    const prNumber = Number(key);
    if (prNumber) {
      map.set(prNumber, toArray(checks));
    }
  }
  return map;
}

/**
 * Pre-send snapshot recheck (fail-closed; criterion 3).
 *
 * @param {object} planned
 * @param {object} fresh
 * @param {string} planned.sessionId
 * @param {number} planned.prNumber
 * @param {string} planned.headSha
 * @param {OpenPr[]} fresh.openPrs
 * @param {AoSession[]} fresh.sessions
 * @param {Record<string, CiCheck[]> | Array<{ prNumber: number, checks: CiCheck[] }>} fresh.ciChecksByPr
 */
export function preSendRecheck(planned, fresh) {
  const { sessionId, prNumber, headSha } = planned;
  const session = findSessionById(toArray(fresh.sessions), sessionId);
  if (!session) {
    return { ok: false, reason: 'session_missing_at_send' };
  }
  if (getSessionIdentifier(session) !== sessionId) {
    return { ok: false, reason: 'session_id_changed' };
  }

  const checksMap = normalizeCiChecksByPr(fresh.ciChecksByPr);
  const checks = checksMap.get(prNumber) ?? [];
  const candidate = evaluateCiGreenWakeCandidate({
    session,
    prNumber,
    headSha,
    openPrs: toArray(fresh.openPrs),
    ciChecks: checks,
  });

  if (!candidate.eligible) {
    return { ok: false, reason: `recheck_failed:${candidate.reasons.join(',')}` };
  }

  return { ok: true, reason: 'ok' };
}

/**
 * @param {CiGreenWakeState} tracking
 * @param {string} transitionId
 * @param {string} sessionId
 * @param {number} sentAtMs
 */
export function recordSuccessfulNudge(tracking, transitionId, sessionId, sentAtMs) {
  const nudged = { ...(tracking.nudged ?? {}) };
  nudged[transitionId] = { sessionId, sentAtMs };
  return { ...tracking, nudged };
}

/**
 * @param {CiGreenWakeState} tracking
 * @param {Record<string, HeadCiRecord>} headRecords
 * @param {number} lastTickMs
 */
export function mergeTrackingAfterTick(tracking, headRecords, lastTickMs) {
  return {
    ...tracking,
    heads: headRecords,
    lastTickMs,
  };
}

/**
 * @param {object} input
 * @param {number} input.nowMs
 * @param {number | undefined} input.lastTickMs
 * @param {number} [input.intervalMs]
 */
export function evaluateCiGreenWakeInterval({ nowMs, lastTickMs, intervalMs }) {
  return evaluateMechanicalTickInterval({
    nowMs,
    lastTickMs,
    intervalMs: Number(intervalMs) || DEFAULT_CI_GREEN_WAKE_INTERVAL_MS,
    defaultIntervalMs: DEFAULT_CI_GREEN_WAKE_INTERVAL_MS,
  });
}

/**
 * @param {string[]} commandLines
 */
export function findForbiddenCiGreenWakeCommands(commandLines) {
  return findForbiddenCommandPatterns(commandLines, FORBIDDEN_LIFECYCLE_PATTERNS);
}

/**
 * @param {string} sessionId
 * @param {string} message
 */
export function buildCiGreenWakeSendArgv(sessionId, message) {
  return ['send', sessionId, message];
}

runStdinJsonCli('ci-green-wake-reconcile.mjs', {
  plan: () => {
    const payload = readStdinJson();
    return planCiGreenWakeActions(payload);
  },
  interval: () => {
    const payload = readStdinJson();
    return evaluateCiGreenWakeInterval({
      nowMs: Number(payload.nowMs) || Date.now(),
      lastTickMs: payload.lastTickMs,
      intervalMs: payload.intervalMs,
    });
  },
  recheck: () => {
    const payload = readStdinJson();
    return preSendRecheck(payload.planned, payload.fresh);
  },
});
