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
import {
  commitOwnerCyclePatch,
  evaluateWorkerIterationCycleForPr,
  NUDGE_EXPIRY_MS,
} from './worker-iteration-cycle.mjs';
import {
  getReportState,
} from './review-finding-delivery-confirm.mjs';
import {
  isWorkerActivelyWorking,
} from './review-head-ready.mjs';
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
  resolveHeadCommittedAtMs,
  resolveHeadOwningWorkerSessionId,
  sessionOwnsRunHead,
  toArray,
} from './review-trigger-reconcile.mjs';

export { resolveHeadOwningWorkerSessionId } from './review-trigger-reconcile.mjs';
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
/** @typedef {{ heads?: Record<string, HeadCiRecord>, nudged?: Record<string, { sessionId?: string, sentAtMs?: number }>, lastTickMs?: number, cycleState?: Record<string, unknown> }} CiGreenWakeState */
/** @typedef {{ type: 'nudge', prNumber: number, headSha: string, sessionId: string, transitionId: string, message: string, ownerCycle?: { repoId: string, cycle: Record<string, unknown> } } | { type: 'skip', prNumber: number, headSha: string, reason: string, transitionId?: string }} CiGreenWakeAction */

/**
 * Required CI per prompts/agent_rules.md: branch-protection contexts when configured,
 * else pack merge-contract fallback via isMergeContractCiGreen default names.
 *
 * @param {CiCheck[]} checks
 * @param {{ requiredCheckNames?: string[] }} [options]
 */
export function classifyRequiredCiLevel(checks, options = {}) {
  if (options.requiredCheckLookupFailed) {
    return /** @type {CiLevel} */ ('pending');
  }

  const list = toArray(checks);
  if (list.length === 0) {
    return /** @type {CiLevel} */ ('pending');
  }

  const branchRequired = toArray(options.requiredCheckNames)
    .map((name) => String(name ?? '').trim())
    .filter(Boolean);
  const greenOpts =
    branchRequired.length > 0 ? { requiredCheckNames: branchRequired } : {};

  if (isMergeContractCiGreen(list, greenOpts)) {
    return 'green';
  }

  const normalizedRequired = branchRequired.map((name) => name.toLowerCase());
  const scope =
    normalizedRequired.length > 0
      ? list.filter((check) =>
          normalizedRequired.includes(String(check?.name ?? '').toLowerCase()),
        )
      : list;

  if (scope.length === 0 && normalizedRequired.length > 0) {
    return 'pending';
  }

  for (const check of scope) {
    if (isCiCheckPending(check)) {
      return 'pending';
    }
  }
  for (const check of scope) {
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
 */
export function normalizeSessionReportState(session) {
  return String(session?.status ?? session?.reportState ?? '').toLowerCase();
}

/**
 * @param {AoSession} session
 * @param {string} headSha
 */
export function isPreHandOffWorkerForHead(session, headSha, openPrs = [], prNumber = 0) {
  const headCommittedAtMs = prNumber ? resolveHeadCommittedAtMs(openPrs, prNumber) : undefined;
  const bindingOptions = { headCommittedAtMs };
  const postHandOff = findLatestReportForHead(session, headSha, {
    matchStates: POST_HANDOFF_REPORT_STATES,
    ...bindingOptions,
  });
  if (postHandOff) {
    return false;
  }

  const last = findLatestReportForHead(session, headSha, bindingOptions);
  if (!last) {
    const sessionState = normalizeSessionReportState(session);
    if (POST_HANDOFF_REPORT_STATES.has(sessionState)) {
      return false;
    }
    if (PRE_HANDOFF_REPORT_STATES.has(sessionState)) {
      return true;
    }
    return false;
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
 * @param {string[]} [input.requiredCheckNames]
 * @param {boolean} [input.requiredCheckLookupFailed]
 */
export function evaluateCiGreenWakeCandidate({
  session,
  prNumber,
  headSha,
  openPrs = [],
  ciChecks = [],
  requiredCheckNames = [],
  requiredCheckLookupFailed = false,
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
  if (!isPreHandOffWorkerForHead(session, headSha, openPrs, prNumber)) {
    reasons.push('post_handoff_or_ineligible_report');
  }

  const ciLevel = classifyRequiredCiLevel(ciChecks, {
    requiredCheckNames,
    requiredCheckLookupFailed,
  });
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
 * @param {Record<string, boolean> | Array<{ prNumber: number, failed: boolean }> | undefined} lookupFailedByPr
 * @returns {Map<number, boolean>}
 */
export function normalizeRequiredCheckLookupFailedByPr(lookupFailedByPr) {
  /** @type {Map<number, boolean>} */
  const map = new Map();
  if (lookupFailedByPr == null) {
    return map;
  }
  if (Array.isArray(lookupFailedByPr)) {
    for (const row of lookupFailedByPr) {
      const prNumber = Number(row?.prNumber);
      if (prNumber && row?.failed) {
        map.set(prNumber, true);
      }
    }
    return map;
  }
  for (const [key, failed] of Object.entries(lookupFailedByPr)) {
    const prNumber = Number(key);
    if (prNumber && failed) {
      map.set(prNumber, true);
    }
  }
  return map;
}

/**
 * @param {object} input
 * @param {OpenPr[]} input.openPrs
 * @param {AoSession[]} input.sessions
 * @param {Record<string, CiCheck[]> | Array<{ prNumber: number, checks: CiCheck[] }>} input.ciChecksByPr
 * @param {Record<string, string[]> | Array<{ prNumber: number, requiredCheckNames: string[] }>} [input.requiredCheckNamesByPr]
 * @param {Record<string, boolean> | Array<{ prNumber: number, failed: boolean }>} [input.requiredCheckLookupFailedByPr]
 * @param {CiGreenWakeState} [input.tracking]
 * @param {Array<Record<string, unknown>>} [input.workerDeliveries]
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} [input.reviewRuns]
 * @param {number} [input.nowMs]
 * @param {string} [input.repoRoot]
 */
export function planCiGreenWakeActions({
  openPrs,
  sessions,
  ciChecksByPr,
  requiredCheckNamesByPr,
  requiredCheckLookupFailedByPr,
  tracking = {},
  workerDeliveries = [],
  reviewRuns = [],
  nowMs = Date.now(),
  repoRoot = '',
}) {
  /** @type {CiGreenWakeAction[]} */
  const actions = [];
  const sessionList = toArray(sessions);
  const headRecords = { ...(tracking.heads ?? {}) };
  const nudged = tracking.nudged ?? {};
  let cycleState = { ...(tracking.cycleState ?? {}) };

  const checksMap = normalizeCiChecksByPr(ciChecksByPr);
  const requiredNamesMap = normalizeRequiredCheckNamesByPr(requiredCheckNamesByPr);
  const lookupFailedMap = normalizeRequiredCheckLookupFailedByPr(
    requiredCheckLookupFailedByPr,
  );

  for (const pr of toArray(openPrs)) {
    const prNumber = Number(pr?.number);
    const headSha = normalizeSha(pr?.headRefOid);
    if (!prNumber || !headSha) {
      continue;
    }

    const checks = checksMap.get(prNumber) ?? [];
    const requiredCheckNames = requiredNamesMap.get(prNumber) ?? [];
    const requiredCheckLookupFailed = lookupFailedMap.get(prNumber) ?? false;
    const ciLevel = classifyRequiredCiLevel(checks, {
      requiredCheckNames,
      requiredCheckLookupFailed,
    });
    const trackKey = headTrackingKey(prNumber, headSha);
    const derived = deriveGreenEpoch(headRecords[trackKey], ciLevel);
    headRecords[trackKey] = derived;

    if (ciLevel !== 'green') {
      continue;
    }

    const sessionId = resolveHeadOwningWorkerSessionId(
      sessionList,
      prNumber,
      headSha,
      toArray(openPrs),
    );
    if (!sessionId) {
      actions.push({ type: 'skip', prNumber, headSha, reason: 'no_head_owning_worker_session' });
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
      requiredCheckNames,
      requiredCheckLookupFailed,
    });

    const headCommittedAtMs = resolveHeadCommittedAtMs(toArray(openPrs), prNumber);
    const activelyWorking = isWorkerActivelyWorking(session, headSha, nowMs, {
      headCommittedAtMs,
      workerDeliveries,
    });

    const cycleEval = evaluateWorkerIterationCycleForPr({
      cycleState,
      repoRoot,
      prNumber,
      headSha,
      ownerSessionId: sessionId,
      reviewRuns,
      session,
      workerDeliveries,
      nowMs,
      headCommittedAtMs,
      handoffAccepted: !candidate.eligible && candidate.reasons.includes('post_handoff_or_ineligible_report'),
      legacyNudged: nudged,
    });
    cycleState = cycleEval.state;

    if (!candidate.eligible) {
      actions.push({
        type: 'skip',
        prNumber,
        headSha,
        reason: candidate.reasons.join(','),
      });
      continue;
    }

    if (activelyWorking || cycleEval.nudgeGate.blockers.includes('worker_actively_working')) {
      actions.push({
        type: 'skip',
        prNumber,
        headSha,
        reason: 'worker_actively_working',
      });
      continue;
    }

    if (!cycleEval.nudgeGate.allow) {
      actions.push({
        type: 'skip',
        prNumber,
        headSha,
        reason: cycleEval.nudgeGate.deferReason,
      });
      continue;
    }

    if (cycleEval.settleAction.action !== 'nudge') {
      actions.push({
        type: 'skip',
        prNumber,
        headSha,
        reason: cycleEval.settleAction.reason,
      });
      continue;
    }

    const transitionId = `${cycleEval.cycle?.cycleId ?? buildTransitionId(prNumber, headSha, derived.greenEpoch)}:nudge`;
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
      ownerCycle: {
        repoId: cycleEval.repoId,
        cycle: cycleEval.cycle ?? {},
      },
    });
  }

  return { actions, headRecords, cycleState };
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
 * @param {Record<string, string[]> | Array<{ prNumber: number, requiredCheckNames: string[] }> | undefined} requiredByPr
 * @returns {Map<number, string[]>}
 */
export function normalizeRequiredCheckNamesByPr(requiredByPr) {
  /** @type {Map<number, string[]>} */
  const map = new Map();
  if (requiredByPr == null) {
    return map;
  }
  if (Array.isArray(requiredByPr)) {
    for (const row of requiredByPr) {
      const prNumber = Number(row?.prNumber);
      const names = toArray(row?.requiredCheckNames)
        .map((name) => String(name ?? '').trim())
        .filter(Boolean);
      if (prNumber && names.length > 0) {
        map.set(prNumber, names);
      }
    }
    return map;
  }
  for (const [key, names] of Object.entries(requiredByPr)) {
    const prNumber = Number(key);
    const list = toArray(names)
      .map((name) => String(name ?? '').trim())
      .filter(Boolean);
    if (prNumber && list.length > 0) {
      map.set(prNumber, list);
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
 * @param {Record<string, string[]> | Array<{ prNumber: number, requiredCheckNames: string[] }>} [fresh.requiredCheckNamesByPr]
 * @param {Record<string, boolean> | Array<{ prNumber: number, failed: boolean }>} [fresh.requiredCheckLookupFailedByPr]
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
  const requiredNamesMap = normalizeRequiredCheckNamesByPr(fresh.requiredCheckNamesByPr);
  const lookupFailedMap = normalizeRequiredCheckLookupFailedByPr(
    fresh.requiredCheckLookupFailedByPr,
  );
  const checks = checksMap.get(prNumber) ?? [];
  const requiredCheckNames = requiredNamesMap.get(prNumber) ?? [];
  const requiredCheckLookupFailed = lookupFailedMap.get(prNumber) ?? false;
  const candidate = evaluateCiGreenWakeCandidate({
    session,
    prNumber,
    headSha,
    openPrs: toArray(fresh.openPrs),
    ciChecks: checks,
    requiredCheckNames,
    requiredCheckLookupFailed,
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
 * Persist per-cycle nudge arming only after a successful send — not during planning.
 *
 * @param {Record<string, unknown>} cycleState
 * @param {object} input
 * @param {string} input.repoId
 * @param {number} input.prNumber
 * @param {string} input.ownerSessionId
 * @param {Record<string, unknown>} [input.cycle]
 * @param {number} input.sentAtMs
 */
export function commitNudgeSentCycleState(cycleState, input) {
  const sentAtMs = Number(input.sentAtMs ?? Date.now());
  return commitOwnerCyclePatch(cycleState, input.repoId, input.prNumber, input.ownerSessionId, {
    ...(input.cycle ?? {}),
    nudgeArmed: true,
    nudgeSentAtMs: sentAtMs,
    nudgeExpiresAtMs: sentAtMs + NUDGE_EXPIRY_MS,
  });
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

/**
 * Merge legacy `contexts[]` and app-style `checks[].context` from branch protection.
 *
 * @param {string[] | undefined} contexts
 * @param {Array<string | { context?: string }> | undefined} checks
 * @returns {string[]}
 */
export function mergeBranchRequiredCheckNames(contexts, checks) {
  const seen = new Set();
  /** @type {string[]} */
  const names = [];

  const add = (raw) => {
    const name = String(raw ?? '').trim();
    if (!name) {
      return;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    names.push(name);
  };

  for (const context of toArray(contexts)) {
    add(context);
  }
  for (const row of toArray(checks)) {
    if (row && typeof row === 'object') {
      add(row.context);
    } else {
      add(row);
    }
  }

  return names;
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
  'merge-required-names': () => {
    const payload = readStdinJson();
    return mergeBranchRequiredCheckNames(payload.contexts, payload.checks);
  },
  'commit-nudge-sent': () => {
    const payload = readStdinJson();
    return {
      cycleState: commitNudgeSentCycleState(payload.cycleState ?? {}, {
        repoId: payload.repoId,
        prNumber: Number(payload.prNumber),
        ownerSessionId: String(payload.ownerSessionId ?? ''),
        cycle: payload.cycle,
        sentAtMs: Number(payload.sentAtMs) || Date.now(),
      }),
    };
  },
});
