/**
 * Shared worker-iteration cycle state machine (Issue #332).
 * Vitest: scripts/worker-iteration-cycle.test.ts
 *
 * Both review-trigger-reconcile and ci-green-wake-reconcile consume this module
 * for per-cycle arming, review-revision lock, settle debounce, and nudge/fallback
 * precedence — never independent per-head idempotency for mid-cycle commits.
 */
import {
  findLatestReportForHead,
} from './review-ready-stuck-guard.mjs';
import {
  getReportState,
  getReportTimestampMs,
  getReviewRunId,
  isPendingSentDeliveryRun,
  parseIsoMs,
} from './review-finding-delivery-confirm.mjs';
import {
  buildReviewSendDeliveryId,
  isDeliveryConsumed,
  isSessionStreaming,
  selectSurvivingDelivery,
} from './worker-message-dispatch-observe.mjs';
import {
  collectSessionIdentifiers,
  getSessionIdentifier,
  isHeadCovered,
  isLiveWorkerSession,
  normalizeSha,
  toArray,
} from './review-reconcile-primitives.mjs';

/** Re-use #261 debounce duration without importing review-head-ready (breaks import cycle). */
export const QUIESCENCE_DEBOUNCE_MS = 15 * 60 * 1000;

export const CYCLE_SURFACE_QUIESCENT_FALLBACK = 'quiescent_fallback';
export const CYCLE_SURFACE_READY_FOR_REVIEW = 'ready_for_review';
export const CYCLE_SURFACE_CI_GREEN_NUDGE = 'ci_green_nudge';

/** Nudge bounded expiry — must be >= quiescence debounce so settle can complete first. */
export const NUDGE_EXPIRY_MS = 20 * 60 * 1000;

/** Open revision stuck past this bound escalates instead of silent defer. */
export const OPEN_REVISION_STUCK_BOUND_MS = 60 * 60 * 1000;

/** Stale unconsumed pending delivery re-derived past this bound. */
export const STALE_PENDING_DELIVERY_BOUND_MS = 30 * 60 * 1000;

export const IN_FLIGHT_REVISION_STATUSES = new Set([
  'queued',
  'preparing',
  'running',
  'reviewing',
]);

export const TERMINAL_REVISION_RELEASE_STATUSES = new Set([
  'clean',
  'failed',
  'cancelled',
  'outdated',
]);

/** Durable blockers sort before transient ones for audit primary reason. */
export const BLOCKER_PRECEDENCE = [
  'owner_resolution_fail_closed',
  'source_stale',
  'source_read_error',
  'prior_revision_open',
  'already_reviewed_this_cycle',
  'already_nudged_this_cycle',
  'nudge_outstanding',
  'fallback_planned',
  'nudge_expired_fallback_pending',
  'ci_red',
  'worker_actively_working',
  'pending_unconsumed_delivery',
  'quiescence_debounce_pending',
  'ready_for_review_debounce_pending',
  'handed_off',
  'intra_cycle_head_advance',
];

/**
 * @param {string | undefined | null} repoRoot
 */
export function normalizeCanonicalRepoIdentity(repoRoot) {
  let raw = String(repoRoot ?? 'orchestrator-pack').trim();
  if (!raw) {
    raw = 'orchestrator-pack';
  }
  raw = raw.replace(/\\/g, '/');
  const wslMatch = raw.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (wslMatch) {
    return `${wslMatch[1].toUpperCase()}:/${wslMatch[2]}`.toLowerCase();
  }
  return raw.replace(/\/+$/, '').toLowerCase();
}

/**
 * @param {string} repoId
 * @param {number} prNumber
 */
export function buildPrScopedKey(repoId, prNumber) {
  return `${repoId}:pr:${prNumber}`;
}

/**
 * @param {string} repoId
 * @param {number} prNumber
 * @param {string} ownerSessionId
 */
export function buildOwnerCycleKey(repoId, prNumber, ownerSessionId) {
  const owner = String(ownerSessionId ?? '').trim().toLowerCase();
  return `${repoId}:pr:${prNumber}:owner:${owner}`;
}

/**
 * @param {string} surface
 * @param {string} repoId
 * @param {number} prNumber
 * @param {string} [ownerSessionId]
 */
export function buildSurfaceStateKey(surface, repoId, prNumber, ownerSessionId = '') {
  const owner = String(ownerSessionId ?? '').trim().toLowerCase();
  return `${repoId}:pr:${prNumber}:surface:${surface}${owner ? `:owner:${owner}` : ''}`;
}

/**
 * @param {Record<string, unknown>} state
 * @param {string} repoId
 * @param {number} prNumber
 */
export function getPrRevisionLock(state, repoId, prNumber) {
  const key = buildPrScopedKey(repoId, prNumber);
  const locks = state?.revisionLocks ?? {};
  return locks[key] ?? null;
}

/**
 * @param {Record<string, unknown>} state
 * @param {string} repoId
 * @param {number} prNumber
 * @param {string} ownerSessionId
 */
export function getOwnerCycleRecord(state, repoId, prNumber, ownerSessionId) {
  const key = buildOwnerCycleKey(repoId, prNumber, ownerSessionId);
  const cycles = state?.ownerCycles ?? {};
  return cycles[key] ?? null;
}

/**
 * @param {Record<string, unknown>} record
 */
function defaultOwnerCycleRecord(record = {}) {
  const row = record ?? {};
  return {
    cycleId: String(row.cycleId ?? ''),
    ownerSessionId: String(row.ownerSessionId ?? ''),
    prNumber: Number(row.prNumber ?? 0),
    openedAtMs: Number(row.openedAtMs ?? 0),
    currentHeadSha: normalizeSha(row.currentHeadSha),
    firstHeadSha: normalizeSha(row.firstHeadSha),
    lastHeadSha: normalizeSha(row.lastHeadSha),
    reviewArmed: Boolean(row.reviewArmed),
    nudgeArmed: Boolean(row.nudgeArmed),
    nudgeSentAtMs: Number(row.nudgeSentAtMs ?? 0) || null,
    nudgeExpiresAtMs: Number(row.nudgeExpiresAtMs ?? 0) || null,
    nudgeExpiredFallbackPending: Boolean(row.nudgeExpiredFallbackPending),
    fallbackArmed: Boolean(row.fallbackArmed),
    debounce: row.debounce ?? {},
    suppressAudit: row.suppressAudit ?? {},
    headAdvanceCount: Number(row.headAdvanceCount ?? 0),
  };
}

/**
 * @param {string[]} blockers
 */
export function choosePrimaryBlocker(blockers) {
  const set = new Set(toArray(blockers).map((b) => String(b)));
  for (const candidate of BLOCKER_PRECEDENCE) {
    if (set.has(candidate)) {
      return candidate;
    }
  }
  return blockers[0] ?? 'unknown';
}

/**
 * @param {Record<string, unknown>} cycle
 * @param {string} branch
 * @param {string} headSha
 * @param {string[]} blockers
 */
export function coalesceSuppressAudit(cycle, branch, headSha, blockers) {
  const audit = { ...(cycle.suppressAudit ?? {}) };
  const key = String(branch);
  const existing = audit[key];
  const head = normalizeSha(headSha);
  if (!existing) {
    audit[key] = {
      firstHead: head,
      lastHead: head,
      count: 1,
      primary: choosePrimaryBlocker(blockers),
      blockers: [...blockers],
    };
  } else {
    audit[key] = {
      firstHead: existing.firstHead || head,
      lastHead: head,
      count: Number(existing.count ?? 0) + 1,
      primary: choosePrimaryBlocker(blockers),
      blockers: [...new Set([...toArray(existing.blockers), ...blockers])],
    };
  }
  return audit;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} runs
 * @param {number} prNumber
 */
export function listPrReviewRuns(runs, prNumber) {
  return toArray(runs)
    .filter((run) => Number(run?.prNumber) === prNumber)
    .sort((a, b) => {
      const aMs = Date.parse(String(a?.createdAt ?? a?.startedAt ?? '')) || 0;
      const bMs = Date.parse(String(b?.createdAt ?? b?.startedAt ?? '')) || 0;
      if (bMs !== aMs) {
        return bMs - aMs;
      }
      return String(getReviewRunId(b) ?? '').localeCompare(String(getReviewRunId(a) ?? ''));
    });
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun} run
 */
export function isRevisionTerminalReleased(run) {
  const status = String(run?.status ?? '').toLowerCase();
  if (status === 'clean') {
    return true;
  }
  if (status === 'failed' || status === 'cancelled') {
    return true;
  }
  return false;
}

export const ACTIVELY_WORKING_REPORT_STATES = new Set([
  'working',
  'fixing_ci',
  'started',
  'pr_created',
  'addressing_reviews',
]);

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} headSha
 * @param {{ headCommittedAtMs?: number }} [options]
 */
function hasReadyForReviewForHeadLocal(session, headSha, options = {}) {
  return Boolean(
    findLatestReportForHead(session, headSha, {
      matchStates: new Set(['ready_for_review']),
      headCommittedAtMs: options.headCommittedAtMs,
    }),
  );
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} headSha
 * @param {number} nowMs
 * @param {{ headCommittedAtMs?: number, workerDeliveries?: Array<Record<string, unknown>>, pendingDeliveryFirstSeenAtMs?: number }} [options]
 */
function isWorkerActivelyWorkingLocal(session, headSha, nowMs, options = {}) {
  if (!session) {
    return false;
  }
  const activity = String(session?.activity ?? '').trim().toLowerCase();
  const status = String(session?.status ?? '').toLowerCase();
  if (isSessionStreaming(session) || activity === 'active') {
    return true;
  }
  if (['working', 'fixing_ci', 'started', 'pr_created', 'addressing_reviews'].includes(status) && activity !== 'idle') {
    return true;
  }
  const headCommittedAtMs = Number(options.headCommittedAtMs);
  if (Number.isFinite(headCommittedAtMs) && headCommittedAtMs > 0 && nowMs - headCommittedAtMs < QUIESCENCE_DEBOUNCE_MS) {
    return true;
  }
  const sessionId = getSessionIdentifier(session);
  if (sessionId) {
    const needles = collectSessionIdentifiers(session);
    if (!needles.includes(sessionId)) {
      needles.push(sessionId);
    }
    for (const needle of needles) {
      const surviving = selectSurvivingDelivery(toArray(options.workerDeliveries), needle);
      if (!surviving) {
        continue;
      }
      if (!isDeliveryConsumed(session, surviving, Number(surviving.deliveredAtMs ?? 0))) {
        const firstSeenAtMs = Number(options.pendingDeliveryFirstSeenAtMs ?? 0);
        if (
          firstSeenAtMs > 0 &&
          nowMs - firstSeenAtMs >= STALE_PENDING_DELIVERY_BOUND_MS
        ) {
          continue;
        }
        return true;
      }
    }
  }
  for (const report of toArray(session?.reports)) {
    const state = getReportState(report);
    if (!ACTIVELY_WORKING_REPORT_STATES.has(state)) {
      continue;
    }
    const ts = getReportTimestampMs(report);
    if (ts > 0 && nowMs - ts < QUIESCENCE_DEBOUNCE_MS) {
      return true;
    }
  }
  return false;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun} run
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} session
 * @param {Array<Record<string, unknown>>} workerDeliveries
 * @param {string} currentHeadSha
 * @param {{ headCommittedAtMs?: number, nowMs?: number }} [options]
 */
export function isRevisionDrained(run, session, workerDeliveries, currentHeadSha, options = {}) {
  const status = String(run?.status ?? '').toLowerCase();
  const findingCount = Number(run?.findingCount ?? 0);
  const sentFindingCount = Number(run?.sentFindingCount ?? 0);
  const openFindingCount = Number(run?.openFindingCount ?? 0);

  if (status === 'clean' && findingCount === 0 && sentFindingCount === 0 && openFindingCount === 0) {
    return true;
  }

  if (status === 'failed' || status === 'cancelled') {
    return true;
  }

  if (!session) {
    return false;
  }

  const runId = getReviewRunId(run);
  const sessionId = getSessionIdentifier(session);
  if (!runId || !sessionId) {
    return false;
  }

  const sendObservedAtMs =
    parseIsoMs(run?.sentAt) ?? parseIsoMs(run?.updatedAt) ?? Number(options.nowMs ?? 0);
  const deliveryId = buildReviewSendDeliveryId(sessionId, runId, sendObservedAtMs);
  const delivery =
    toArray(workerDeliveries).find((row) => String(row?.deliveryId ?? '') === deliveryId) ??
    selectSurvivingDelivery(toArray(workerDeliveries), sessionId);
  const revisionDelivery =
    delivery && String(delivery?.sourceKey ?? '').includes(runId) ? delivery : null;

  const consumed = revisionDelivery
    ? isDeliveryConsumed(session, revisionDelivery, Number(revisionDelivery.deliveredAtMs ?? sendObservedAtMs))
    : isPendingSentDeliveryRun(run)
      ? false
      : sentFindingCount > 0 &&
        toArray(session?.reports).some((report) => {
          const ts = getReportTimestampMs(report);
          return ts > sendObservedAtMs && getReportState(report) === 'addressing_reviews';
        });

  if (!consumed) {
    return false;
  }

  return hasReadyForReviewForHeadLocal(session, currentHeadSha, {
    headCommittedAtMs: options.headCommittedAtMs,
  });
}

/**
 * @param {object} input
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} input.reviewRuns
 * @param {number} input.prNumber
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} [input.session]
 * @param {Array<Record<string, unknown>>} [input.workerDeliveries]
 * @param {string} [input.currentHeadSha]
 * @param {number} [input.nowMs]
 * @param {number} [input.headCommittedAtMs]
 */
export function evaluateOpenReviewRevision({
  reviewRuns,
  prNumber,
  session = null,
  workerDeliveries = [],
  currentHeadSha = '',
  nowMs = Date.now(),
  headCommittedAtMs,
}) {
  const runs = listPrReviewRuns(reviewRuns, prNumber);
  for (const run of runs) {
    const status = String(run?.status ?? '').toLowerCase();
    const runId = getReviewRunId(run);
    if (!runId) {
      continue;
    }
    if (TERMINAL_REVISION_RELEASE_STATUSES.has(status) && status !== 'failed' && status !== 'cancelled') {
      if (status === 'clean') {
        continue;
      }
      continue;
    }
    if (IN_FLIGHT_REVISION_STATUSES.has(status)) {
      return {
        open: true,
        runId,
        headSha: normalizeSha(run?.targetSha),
        reason: 'revision_in_flight',
        openedAtMs: parseIsoMs(run?.startedAt) ?? parseIsoMs(run?.createdAt) ?? nowMs,
      };
    }
    if (status === 'needs_triage' || status === 'waiting_update' || isPendingSentDeliveryRun(run)) {
      if (isRevisionDrained(run, session, workerDeliveries, currentHeadSha, {
        headCommittedAtMs,
        nowMs,
      })) {
        continue;
      }
      return {
        open: true,
        runId,
        headSha: normalizeSha(run?.targetSha),
        reason:
          Number(run?.sentFindingCount ?? 0) > 0 ? 'revision_findings_open' : 'revision_open',
        openedAtMs: parseIsoMs(run?.sentAt) ?? parseIsoMs(run?.updatedAt) ?? nowMs,
      };
    }
    if ((status === 'failed' || status === 'cancelled') && !isRevisionDrained(run, session, workerDeliveries, currentHeadSha, {
      headCommittedAtMs,
      nowMs,
    })) {
      const openedAtMs = parseIsoMs(run?.updatedAt) ?? parseIsoMs(run?.createdAt) ?? nowMs;
      if (nowMs - openedAtMs < OPEN_REVISION_STUCK_BOUND_MS) {
        return {
          open: true,
          runId,
          headSha: normalizeSha(run?.targetSha),
          reason: 'revision_terminal_pending_retry',
          openedAtMs,
        };
      }
    }
  }
  return { open: false, runId: null, headSha: '', reason: 'none', openedAtMs: 0 };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} session
 * @param {string} sessionId
 * @param {Array<Record<string, unknown>>} workerDeliveries
 * @param {number} nowMs
 * @param {number} firstSeenAtMs
 */
export function evaluateStalePendingDelivery(session, sessionId, workerDeliveries, nowMs, firstSeenAtMs) {
  if (!session || !sessionId) {
    return { stale: false, pending: false };
  }
  const needles = collectSessionIdentifiers(session);
  if (!needles.includes(sessionId)) {
    needles.push(sessionId);
  }
  let pending = false;
  for (const needle of needles) {
    const surviving = selectSurvivingDelivery(toArray(workerDeliveries), needle);
    if (!surviving) {
      continue;
    }
    const deliveredAtMs = Number(surviving.deliveredAtMs ?? 0);
    if (!isDeliveryConsumed(session, surviving, deliveredAtMs)) {
      pending = true;
      break;
    }
  }
  if (!pending) {
    return { stale: false, pending: false };
  }
  if (firstSeenAtMs > 0 && nowMs - firstSeenAtMs >= STALE_PENDING_DELIVERY_BOUND_MS) {
    return { stale: true, pending: true };
  }
  return { stale: false, pending: true };
}

/**
 * Whether an armed owner cycle reached a terminal close event (#332) so the next
 * worker iteration can arm review/nudge again. Closes after a terminal-and-drained
 * review/fallback (no open revision) or when the worker hands off on a new uncovered
 * head after the prior reviewed head was covered.
 *
 * @param {object} input
 */
export function shouldTerminalCloseOwnerCycle(input) {
  const {
    cycle,
    openRevision,
    reviewRuns,
    prNumber,
    headSha,
    handoffAccepted = false,
  } = input;

  if (!cycle?.cycleId) {
    return false;
  }
  if (openRevision?.open) {
    return false;
  }
  if (!cycle.reviewArmed && !cycle.fallbackArmed) {
    return false;
  }

  const head = normalizeSha(headSha);
  if (head && isHeadCovered(reviewRuns, prNumber, head)) {
    return true;
  }

  const firstHead = normalizeSha(cycle.firstHeadSha);
  const headAdvancedPastFirst =
    Boolean(head && firstHead && head !== firstHead) || Number(cycle.headAdvanceCount ?? 0) > 0;

  if (
    handoffAccepted &&
    head &&
    !isHeadCovered(reviewRuns, prNumber, head) &&
    firstHead &&
    isHeadCovered(reviewRuns, prNumber, firstHead)
  ) {
    return true;
  }

  if (headAdvancedPastFirst && firstHead && isHeadCovered(reviewRuns, prNumber, firstHead)) {
    return true;
  }

  return false;
}

/**
 * Remove owner-cycle rows for other owners on the same PR so stale transfer rows
 * do not force the current owner's cycle to close/reopen every tick.
 *
 * @param {Record<string, unknown>} state
 * @param {string} repoId
 * @param {number} prNumber
 * @param {string} ownerSessionId
 */
export function pruneStaleOwnerCyclesForPr(state, repoId, prNumber, ownerSessionId) {
  const owner = String(ownerSessionId ?? '').trim();
  if (!owner) {
    return state;
  }
  const ownerCycles = { ...(state.ownerCycles ?? {}) };
  let pruned = false;
  for (const [key, record] of Object.entries(ownerCycles)) {
    const row = /** @type {Record<string, unknown>} */ (record);
    if (Number(row.prNumber) !== prNumber) {
      continue;
    }
    const rowOwner = String(row.ownerSessionId ?? '');
    if (rowOwner && rowOwner !== owner) {
      delete ownerCycles[key];
      pruned = true;
    }
  }
  if (!pruned) {
    return state;
  }
  return { ...state, repoId, ownerCycles };
}

/**
 * @param {object} input
 */
export function resolveOrAdvanceOwnerCycle(input) {
  const {
    state = {},
    repoId,
    prNumber,
    ownerSessionId,
    headSha,
    nowMs = Date.now(),
    terminalClose = false,
    handoffAccepted = false,
  } = input;
  const head = normalizeSha(headSha);
  const owner = String(ownerSessionId ?? '').trim();
  const ownerCycles = { ...(state.ownerCycles ?? {}) };
  const key = owner ? buildOwnerCycleKey(repoId, prNumber, owner) : '';
  let cycle = key ? defaultOwnerCycleRecord(getOwnerCycleRecord(state, repoId, prNumber, owner)) : null;

  const shouldClose =
    terminalClose ||
    (cycle && cycle.ownerSessionId && owner && cycle.ownerSessionId !== owner);

  if (shouldClose && cycle?.cycleId) {
    if (key) {
      delete ownerCycles[key];
    }
    cycle = null;
  }

  if (!owner) {
    return { state: { ...state, ownerCycles }, cycle: null, opened: false, advanced: false };
  }

  if (!cycle || !cycle.cycleId) {
    const cycleId = `${repoId}:${prNumber}:${owner}:${nowMs}`;
    cycle = defaultOwnerCycleRecord({
      cycleId,
      ownerSessionId: owner,
      prNumber,
      openedAtMs: nowMs,
      currentHeadSha: head,
      firstHeadSha: head,
      lastHeadSha: head,
    });
    ownerCycles[key] = cycle;
    return { state: { ...state, ownerCycles }, cycle, opened: true, advanced: false };
  }

  let advanced = false;
  if (head && cycle.currentHeadSha && head !== cycle.currentHeadSha) {
    cycle = {
      ...cycle,
      currentHeadSha: head,
      lastHeadSha: head,
      headAdvanceCount: Number(cycle.headAdvanceCount ?? 0) + 1,
    };
    ownerCycles[key] = cycle;
    advanced = true;
  } else if (head && !cycle.currentHeadSha) {
    cycle = { ...cycle, currentHeadSha: head, firstHeadSha: head, lastHeadSha: head };
    ownerCycles[key] = cycle;
  }

  return { state: { ...state, ownerCycles }, cycle, opened: false, advanced };
}

/**
 * @param {object} input
 */
export function evaluateReadyForReviewSettleDebounce(input) {
  const {
    cycle,
    headSha,
    nowMs = Date.now(),
    handoffAccepted = false,
    handoffHeadSha = '',
    headCommittedAtMs,
  } = input;
  if (!handoffAccepted) {
    return { settled: true, waiting: false, reason: 'no_handoff' };
  }
  const handoffHead = normalizeSha(handoffHeadSha || headSha);
  const headStableMs =
    Number.isFinite(Number(headCommittedAtMs)) && Number(headCommittedAtMs) > 0
      ? nowMs - Number(headCommittedAtMs)
      : null;

  if (headStableMs == null) {
    const currentHead = normalizeSha(headSha);
    if (handoffHead && currentHead && handoffHead !== currentHead) {
      return {
        settled: false,
        waiting: false,
        reason: 'stale_handoff_head',
        handoffHeadSha: handoffHead,
        currentHeadSha: currentHead,
      };
    }
    return { settled: true, waiting: false, reason: 'settled', handoffHeadSha: handoffHead };
  }

  if (headStableMs >= QUIESCENCE_DEBOUNCE_MS) {
    const currentHead = normalizeSha(headSha);
    if (handoffHead && currentHead && handoffHead !== currentHead) {
      return {
        settled: false,
        waiting: false,
        reason: 'stale_handoff_head',
        handoffHeadSha: handoffHead,
        currentHeadSha: currentHead,
      };
    }
    return { settled: true, waiting: false, reason: 'settled', handoffHeadSha: handoffHead };
  }

  const debounce = cycle?.debounce?.[CYCLE_SURFACE_READY_FOR_REVIEW];
  if (!debounce) {
    return {
      settled: false,
      waiting: true,
      reason: 'ready_for_review_debounce_pending',
      startedAtMs: nowMs,
      handoffHeadSha: handoffHead,
    };
  }
  const startedAtMs = Number(debounce.startedAtMs ?? 0);
  const boundHead = normalizeSha(debounce.handoffHeadSha);
  if (boundHead && handoffHead && boundHead !== handoffHead) {
    return {
      settled: false,
      waiting: true,
      reason: 'ready_for_review_debounce_pending',
      startedAtMs: nowMs,
      handoffHeadSha: handoffHead,
      staleHandoff: true,
    };
  }
  if (nowMs - startedAtMs < QUIESCENCE_DEBOUNCE_MS) {
    return {
      settled: false,
      waiting: true,
      reason: 'ready_for_review_debounce_pending',
      startedAtMs,
      handoffHeadSha: boundHead || handoffHead,
    };
  }
  const currentHead = normalizeSha(headSha);
  if (boundHead && currentHead && boundHead !== currentHead) {
    return {
      settled: false,
      waiting: false,
      reason: 'stale_handoff_head',
      handoffHeadSha: boundHead,
      currentHeadSha: currentHead,
    };
  }
  return { settled: true, waiting: false, reason: 'settled', handoffHeadSha: boundHead || handoffHead };
}

/**
 * @param {object} input
 */
export function evaluateReviewCycleGate(input) {
  const blockers = [];
  const {
    cycle,
    openRevision,
    reviewRuns,
    prNumber,
    headSha,
    handoffAccepted = false,
    readyDebounce,
    ownerResolutionFailClosed = false,
    sourceStale = false,
  } = input;

  if (ownerResolutionFailClosed) {
    blockers.push('owner_resolution_fail_closed');
  }
  if (sourceStale) {
    blockers.push('source_stale');
  }
  if (openRevision?.open) {
    blockers.push('prior_revision_open');
  }
  if (cycle?.reviewArmed) {
    blockers.push('already_reviewed_this_cycle');
  }
  if (readyDebounce?.waiting) {
    blockers.push('ready_for_review_debounce_pending');
  }
  if (readyDebounce?.reason === 'stale_handoff_head') {
    blockers.push('ready_for_review_debounce_pending');
  }
  if (handoffAccepted && isHeadCovered(reviewRuns, prNumber, headSha) && !openRevision?.open) {
    // covered head within same cycle is not a new arming opportunity
  }

  const allow = blockers.length === 0;

  return {
    allow,
    blockers,
    primary: choosePrimaryBlocker(blockers),
    deferReason: openRevision?.open
      ? `prior_revision_open:${openRevision.runId}`
      : choosePrimaryBlocker(blockers),
  };
}

/**
 * @param {object} input
 */
export function evaluateNudgeCycleGate(input) {
  const blockers = [];
  const {
    cycle,
    openRevision,
    activelyWorking = false,
    debouncePending = false,
    handedOff = false,
    ownerResolutionFailClosed = false,
    pendingDelivery = false,
    stalePendingDelivery = false,
    sourceStale = false,
    nowMs = Date.now(),
  } = input;

  if (ownerResolutionFailClosed) {
    blockers.push('owner_resolution_fail_closed');
  }
  if (sourceStale) {
    blockers.push('source_stale');
  }
  if (handedOff) {
    blockers.push('handed_off');
  }
  if (openRevision?.open) {
    blockers.push('prior_revision_open');
  }
  if (activelyWorking) {
    blockers.push('worker_actively_working');
  }
  if (debouncePending) {
    blockers.push('quiescence_debounce_pending');
  }
  if (pendingDelivery && !stalePendingDelivery) {
    blockers.push('pending_unconsumed_delivery');
  }
  if (cycle?.nudgeArmed) {
    blockers.push('already_nudged_this_cycle');
  }
  if (cycle?.fallbackArmed) {
    blockers.push('fallback_planned');
  }
  if (cycle?.nudgeExpiresAtMs && nowMs < cycle.nudgeExpiresAtMs && cycle.nudgeArmed) {
    blockers.push('nudge_outstanding');
  }
  if (cycle?.nudgeExpiredFallbackPending) {
    blockers.push('nudge_expired_fallback_pending');
  }

  const allow = blockers.length === 0;
  return {
    allow,
    blockers,
    primary: choosePrimaryBlocker(blockers),
    deferReason: choosePrimaryBlocker(blockers),
  };
}

/**
 * @param {object} input
 */
export function evaluateSettleActionPrecedence(input) {
  const {
    cycle,
    quiescentFallbackEligible = false,
    nudgeEligible = false,
    nowMs = Date.now(),
  } = input;

  if (nudgeEligible && !cycle?.nudgeArmed && !cycle?.fallbackArmed) {
    return { action: 'nudge', reason: 'primary_nudge' };
  }

  if (cycle?.nudgeArmed && cycle?.nudgeExpiresAtMs && nowMs >= cycle.nudgeExpiresAtMs) {
    if (quiescentFallbackEligible && !cycle?.fallbackArmed) {
      return { action: 'fallback', reason: 'nudge_expired_fallback' };
    }
    return { action: 'defer', reason: 'nudge_expired_fallback_pending' };
  }

  if (cycle?.nudgeExpiredFallbackPending && quiescentFallbackEligible) {
    return { action: 'fallback', reason: 'nudge_expired_fallback_pending' };
  }

  if (quiescentFallbackEligible && cycle?.nudgeArmed && cycle?.fallbackArmed) {
    return { action: 'fallback', reason: 'fallback_after_nudge' };
  }

  return { action: 'none', reason: 'no_settle_action' };
}

/**
 * @param {Record<string, unknown>} cycle
 * @param {string} branch
 * @param {Record<string, unknown>} patch
 */
export function patchOwnerCycle(cycle, patch) {
  return { ...defaultOwnerCycleRecord(cycle), ...patch };
}

/**
 * Merge owner-cycle rows from ci-green-wake into review-trigger local state.
 * Ci-green is authoritative for nudge arms; review-trigger keeps review arms.
 *
 * @param {Record<string, unknown>} localRecord
 * @param {Record<string, unknown>} sharedRecord
 */
function mergeOwnerCycleRecords(localRecord, sharedRecord) {
  const local = defaultOwnerCycleRecord(localRecord);
  const shared = defaultOwnerCycleRecord(sharedRecord);
  const merged = { ...local, ...shared };
  const localNudgeAt = Number(local.nudgeSentAtMs ?? 0);
  const sharedNudgeAt = Number(shared.nudgeSentAtMs ?? 0);
  if (shared.nudgeArmed && sharedNudgeAt >= localNudgeAt) {
    merged.nudgeArmed = shared.nudgeArmed;
    merged.nudgeSentAtMs = shared.nudgeSentAtMs;
    merged.nudgeExpiresAtMs = shared.nudgeExpiresAtMs;
    merged.nudgeExpiredFallbackPending = shared.nudgeExpiredFallbackPending;
  } else if (local.nudgeArmed) {
    merged.nudgeArmed = local.nudgeArmed;
    merged.nudgeSentAtMs = local.nudgeSentAtMs;
    merged.nudgeExpiresAtMs = local.nudgeExpiresAtMs;
    merged.nudgeExpiredFallbackPending = local.nudgeExpiredFallbackPending;
  }
  if (local.reviewArmed || local.fallbackArmed) {
    merged.reviewArmed = local.reviewArmed;
    merged.fallbackArmed = local.fallbackArmed;
  }
  merged.debounce = { ...(shared.debounce ?? {}), ...(local.debounce ?? {}) };
  merged.suppressAudit = { ...(local.suppressAudit ?? {}) };
  merged.cycleId = local.cycleId || shared.cycleId;
  merged.openedAtMs = local.openedAtMs || shared.openedAtMs;
  merged.ownerSessionId = local.ownerSessionId || shared.ownerSessionId;
  merged.prNumber = local.prNumber || shared.prNumber;
  return merged;
}

/**
 * @param {Record<string, unknown>} [localState]
 * @param {Record<string, unknown>} [sharedState]
 */
export function mergeSharedWorkerIterationCycleState(localState = {}, sharedState = {}) {
  const local = localState ?? {};
  const shared = sharedState ?? {};
  const ownerCycles = { ...(local.ownerCycles ?? {}) };
  for (const [key, sharedRecord] of Object.entries(shared.ownerCycles ?? {})) {
    const row = /** @type {Record<string, unknown>} */ (sharedRecord);
    ownerCycles[key] = ownerCycles[key]
      ? mergeOwnerCycleRecords(ownerCycles[key], row)
      : defaultOwnerCycleRecord(row);
  }
  return {
    ...local,
    repoId: local.repoId ?? shared.repoId,
    ownerCycles,
    revisionLocks: { ...(shared.revisionLocks ?? {}), ...(local.revisionLocks ?? {}) },
  };
}

/**
 * Bootstrap per-cycle nudge state from legacy per-head transition keys.
 *
 * @param {Record<string, unknown>} cycleState
 * @param {Record<string, { sessionId?: string, sentAtMs?: number }>} legacyNudged
 * @param {number} prNumber
 * @param {string} ownerSessionId
 */
export function bootstrapLegacyNudgedCycle(cycleState, legacyNudged, prNumber, ownerSessionId) {
  if (!legacyNudged || !ownerSessionId) {
    return cycleState;
  }
  const prefix = `${prNumber}:`;
  let latestSentAt = 0;
  for (const [key, record] of Object.entries(legacyNudged)) {
    if (!String(key).startsWith(prefix)) {
      continue;
    }
    if (String(record?.sessionId ?? '') !== ownerSessionId) {
      continue;
    }
    latestSentAt = Math.max(latestSentAt, Number(record?.sentAtMs ?? 0));
  }
  if (!latestSentAt) {
    return cycleState;
  }
  const repoId = normalizeCanonicalRepoIdentity(cycleState?.repoId);
  const { state, cycle } = resolveOrAdvanceOwnerCycle({
    state: cycleState,
    repoId,
    prNumber,
    ownerSessionId,
    headSha: '',
    nowMs: latestSentAt,
  });
  if (!cycle) {
    return state;
  }
  const key = buildOwnerCycleKey(repoId, prNumber, ownerSessionId);
  const ownerCycles = { ...(state.ownerCycles ?? {}) };
  ownerCycles[key] = patchOwnerCycle(cycle, {
    nudgeArmed: true,
    nudgeSentAtMs: latestSentAt,
    nudgeExpiresAtMs: latestSentAt + NUDGE_EXPIRY_MS,
  });
  return { ...state, ownerCycles, migratedLegacyNudge: true };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} session
 * @param {string} headSha
 * @param {number} nowMs
 * @param {object} [options]
 */
export function isWorkerSettledIdle(session, headSha, nowMs, options = {}) {
  if (!session || !isLiveWorkerSession(session)) {
    return { settled: false, activelyWorking: true, debouncePending: true };
  }
  const activelyWorking = isWorkerActivelyWorkingLocal(session, headSha, nowMs, options);
  const lastActivityAgeMs = Number(session?.lastActivityAgeMs ?? NaN);
  const headCommittedAtMs = Number(options.headCommittedAtMs ?? NaN);
  const headStableMs =
    Number.isFinite(headCommittedAtMs) && headCommittedAtMs > 0
      ? nowMs - headCommittedAtMs
      : null;
  const debouncePending =
    activelyWorking ||
    (headStableMs != null && headStableMs < QUIESCENCE_DEBOUNCE_MS) ||
    (Number.isFinite(lastActivityAgeMs) && lastActivityAgeMs < QUIESCENCE_DEBOUNCE_MS);
  return {
    settled: !activelyWorking && !debouncePending,
    activelyWorking,
    debouncePending,
    headStableMs,
  };
}

/**
 * @param {Record<string, unknown>} state
 * @param {string} repoId
 * @param {number} prNumber
 * @param {string} ownerSessionId
 * @param {Record<string, unknown>} patch
 */
export function commitOwnerCyclePatch(state, repoId, prNumber, ownerSessionId, patch) {
  const key = buildOwnerCycleKey(repoId, prNumber, ownerSessionId);
  const ownerCycles = { ...(state.ownerCycles ?? {}) };
  const current = defaultOwnerCycleRecord(getOwnerCycleRecord(state, repoId, prNumber, ownerSessionId));
  ownerCycles[key] = patchOwnerCycle(current, patch);
  return { ...state, repoId, ownerCycles };
}

/**
 * Persist review arming only after a review run actually starts — not during planning.
 *
 * @param {Record<string, unknown>} cycleState
 * @param {object} input
 * @param {string} input.repoId
 * @param {number} input.prNumber
 * @param {string} input.ownerSessionId
 * @param {Record<string, unknown>} [input.cycle]
 * @param {boolean} [input.isQuiescentFallback]
 */
export function commitReviewStartedCycleState(cycleState, input) {
  const patch = {
    ...(input.cycle ?? {}),
    reviewArmed: true,
    debounce: {
      ...(input.cycle?.debounce ?? {}),
      [CYCLE_SURFACE_READY_FOR_REVIEW]: undefined,
    },
  };
  if (input.isQuiescentFallback) {
    patch.fallbackArmed = true;
  }
  return commitOwnerCyclePatch(
    cycleState,
    input.repoId,
    input.prNumber,
    input.ownerSessionId,
    patch,
  );
}

/**
 * @param {Record<string, unknown>} state
 * @param {string} repoId
 * @param {number} prNumber
 * @param {{ runId?: string, headSha?: string, openedAtMs?: number }} lock
 */
export function commitRevisionLock(state, repoId, prNumber, lock) {
  const key = buildPrScopedKey(repoId, prNumber);
  const revisionLocks = { ...(state.revisionLocks ?? {}) };
  if (!lock?.runId) {
    delete revisionLocks[key];
  } else {
    revisionLocks[key] = {
      runId: String(lock.runId),
      headSha: normalizeSha(lock.headSha),
      openedAtMs: Number(lock.openedAtMs ?? Date.now()),
    };
  }
  return { ...state, repoId, revisionLocks };
}

/**
 * Full per-PR cycle evaluation for reconcile plan steps.
 *
 * @param {object} input
 */
export function evaluateWorkerIterationCycleForPr(input) {
  const {
    cycleState = {},
    repoRoot = '',
    prNumber,
    headSha,
    ownerSessionId = '',
    ownerResolutionFailClosed = false,
    reviewRuns = [],
    session = null,
    workerDeliveries = [],
    nowMs = Date.now(),
    headCommittedAtMs,
    handoffAccepted = false,
    legacyNudged = null,
  } = input;

  const repoId = normalizeCanonicalRepoIdentity(repoRoot || cycleState?.repoId);
  let state = { ...cycleState, repoId };
  if (legacyNudged && Object.keys(legacyNudged).length > 0) {
    state = bootstrapLegacyNudgedCycle(state, legacyNudged, prNumber, ownerSessionId);
  }

  const openRevision = evaluateOpenReviewRevision({
    reviewRuns,
    prNumber,
    session,
    workerDeliveries,
    currentHeadSha: headSha,
    nowMs,
    headCommittedAtMs,
  });

  state = commitRevisionLock(
    state,
    repoId,
    prNumber,
    openRevision.open
      ? {
          runId: openRevision.runId,
          headSha: openRevision.headSha,
          openedAtMs: openRevision.openedAtMs,
        }
      : null,
  );

  const ownershipChanged = Boolean(
    ownerSessionId &&
      Object.values(state.ownerCycles ?? {}).some((record) => {
        const row = /** @type {Record<string, unknown>} */ (record);
        return (
          Number(row.prNumber) === prNumber &&
          String(row.ownerSessionId ?? '') &&
          String(row.ownerSessionId) !== ownerSessionId
        );
      }),
  );
  if (ownershipChanged && ownerSessionId) {
    state = pruneStaleOwnerCyclesForPr(state, repoId, prNumber, ownerSessionId);
  }

  const priorCycle = ownerSessionId
    ? defaultOwnerCycleRecord(getOwnerCycleRecord(state, repoId, prNumber, ownerSessionId))
    : null;
  const terminalClose = shouldTerminalCloseOwnerCycle({
    cycle: priorCycle?.cycleId ? priorCycle : null,
    openRevision,
    reviewRuns,
    prNumber,
    headSha,
    handoffAccepted,
  });

  const { state: advancedState, cycle: resolvedCycle, opened, advanced } = resolveOrAdvanceOwnerCycle({
    state,
    repoId,
    prNumber,
    ownerSessionId,
    headSha,
    nowMs,
    terminalClose,
    handoffAccepted,
  });
  state = advancedState;
  let cycle = resolvedCycle;

  const readyDebounce = evaluateReadyForReviewSettleDebounce({
    cycle,
    headSha,
    nowMs,
    handoffAccepted,
    handoffHeadSha: handoffAccepted ? headSha : '',
    headCommittedAtMs,
  });

  const settle = isWorkerSettledIdle(session, headSha, nowMs, {
    headCommittedAtMs,
    workerDeliveries,
    pendingDeliveryFirstSeenAtMs: Number(cycle?.debounce?.pendingDeliveryFirstSeenAtMs ?? 0),
  });

  const pendingDelivery = evaluateStalePendingDelivery(
    session,
    ownerSessionId,
    workerDeliveries,
    nowMs,
    Number(cycle?.debounce?.pendingDeliveryFirstSeenAtMs ?? 0),
  );

  if (cycle && ownerSessionId) {
    const priorFirstSeen = Number(cycle.debounce?.pendingDeliveryFirstSeenAtMs ?? 0);
    if (pendingDelivery.pending && !(priorFirstSeen > 0)) {
      const nextDebounce = {
        ...(cycle.debounce ?? {}),
        pendingDeliveryFirstSeenAtMs: nowMs,
      };
      cycle = patchOwnerCycle(cycle, { debounce: nextDebounce });
      state = commitOwnerCyclePatch(state, repoId, prNumber, ownerSessionId, cycle);
    } else if (!pendingDelivery.pending && priorFirstSeen > 0) {
      const nextDebounce = { ...(cycle.debounce ?? {}) };
      delete nextDebounce.pendingDeliveryFirstSeenAtMs;
      cycle = patchOwnerCycle(cycle, { debounce: nextDebounce });
      state = commitOwnerCyclePatch(state, repoId, prNumber, ownerSessionId, cycle);
    }
  }

  const pendingDeliveryForGate = evaluateStalePendingDelivery(
    session,
    ownerSessionId,
    workerDeliveries,
    nowMs,
    Number(cycle?.debounce?.pendingDeliveryFirstSeenAtMs ?? 0),
  );

  const reviewGate = evaluateReviewCycleGate({
    cycle,
    openRevision,
    reviewRuns,
    prNumber,
    headSha,
    handoffAccepted,
    readyDebounce,
    ownerResolutionFailClosed,
  });

  const nudgeGate = evaluateNudgeCycleGate({
    cycle,
    openRevision,
    activelyWorking: settle.activelyWorking,
    debouncePending: settle.debouncePending,
    handedOff: handoffAccepted,
    ownerResolutionFailClosed,
    pendingDelivery: pendingDeliveryForGate.pending,
    stalePendingDelivery: pendingDeliveryForGate.stale,
    nowMs,
  });

  const settleAction = evaluateSettleActionPrecedence({
    cycle,
    quiescentFallbackEligible: settle.settled && !handoffAccepted && !openRevision.open,
    nudgeEligible: nudgeGate.allow,
    nowMs,
  });

  return {
    state,
    cycle,
    opened,
    advanced,
    openRevision,
    readyDebounce,
    settle,
    pendingDelivery: pendingDeliveryForGate,
    reviewGate,
    nudgeGate,
    settleAction,
    repoId,
  };
}
