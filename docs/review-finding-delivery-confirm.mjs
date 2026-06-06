/**
 * Sender-side review-finding delivery confirmation (Issue #171).
 * Vitest: scripts/review-finding-delivery-confirm.test.ts
 */
import {
  evaluateMechanicalTickInterval,
  readStdinJson,
  resolveBoundedInt,
  runStdinJsonCli,
} from './review-mechanical-cli.mjs';
import {
  findForbiddenLifecycleCommands,
  findSessionById,
  isLiveWorkerSession,
  normalizeSha,
  sessionMatchesIdentifier,
  sessionMatchesPr,
  sessionOwnsRunHead,
  toArray,
} from './review-trigger-reconcile.mjs';

export { sessionOwnsRunHead };

export { findForbiddenLifecycleCommands as findForbiddenDeliveryLifecycleCommands };

/** Default: wait 5 minutes after send before re-delivery / escalation. */
export const DEFAULT_CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;

/** Default: at most two best-effort re-deliveries per run. */
export const DEFAULT_MAX_REDELIVERIES = 2;

/** Default mechanical tick cadence (low-frequency). */
export const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000;

/** Worker reports that prove the review round started (not generic activity). */
export const REVIEW_ROUND_REPORT_STATES = new Set([
  'addressing_reviews',
  'fixing_ci',
  'ready_for_review',
]);

export const DELIVERY_STATE_CONFIRMED = 'confirmed';
export const DELIVERY_STATE_ESCALATED = 'escalated';
export const DELIVERY_STATE_UNCONFIRMED = 'unconfirmed';

/** @typedef {{ id?: string, reviewerSessionId?: string, prNumber?: number, targetSha?: string, status?: string, sentFindingCount?: number, linkedSessionId?: string, sentAt?: string, updatedAt?: string }} ReviewRun */
/** @typedef {{ number?: number, headRefOid?: string }} OpenPr */
/** @typedef {{ name?: string, sessionId?: string, id?: string, role?: string, prNumber?: number | null, pr?: string | null, ownedHeadSha?: string, headRefOid?: string, status?: string, reports?: Array<{ reportState?: string, report_state?: string, reportedAt?: string, timestamp?: string, createdAt?: string }> }} AoSession */
/** @typedef {{ deliveryState?: string, sendObservedAtMs?: number, redeliveryCount?: number, lastRedeliveryAtMs?: number, escalatedAtMs?: number, submitCount?: number, lastSubmitAtMs?: number, submitDecisionKey?: string }} RunDeliveryRecord */
/** @typedef {{ runs?: Record<string, RunDeliveryRecord>, lastTickMs?: number }} DeliveryTrackingState */

/**
 * @param {ReviewRun} run
 */
export function getReviewRunId(run) {
  const id = String(run?.id ?? run?.reviewerSessionId ?? '').trim();
  return id || null;
}

/** Run statuses with findings sent but delivery not yet confirmed. */
export const PENDING_SENT_DELIVERY_STATUSES = new Set([
  'waiting_update',
  'sent_to_agent',
]);

/**
 * @param {ReviewRun} run
 */
export function isPendingSentDeliveryRun(run) {
  const status = String(run?.status ?? '').toLowerCase();
  const sent = Number(run?.sentFindingCount ?? 0);
  return PENDING_SENT_DELIVERY_STATUSES.has(status) && sent > 0;
}

/**
 * @param {string | undefined} iso
 */
export function parseIsoMs(iso) {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {ReviewRun} run
 * @param {number} fallbackMs
 */
export function resolveSendObservedAtMs(run, fallbackMs) {
  return (
    parseIsoMs(run?.sentAt) ??
    parseIsoMs(run?.updatedAt) ??
    fallbackMs
  );
}

/**
 * @param {{ reportState?: string, report_state?: string }} report
 */
export function getReportState(report) {
  return String(report?.reportState ?? report?.report_state ?? '').toLowerCase();
}

/**
 * @param {{ reportState?: string, report_state?: string, reportedAt?: string, timestamp?: string, createdAt?: string }} report
 */
export function getReportTimestampMs(report) {
  return (
    parseIsoMs(report?.reportedAt) ??
    parseIsoMs(report?.timestamp) ??
    parseIsoMs(report?.createdAt) ??
    0
  );
}

/**
 * @param {AoSession} session
 * @param {number} sendObservedAtMs
 */
export function findReviewRoundReportAfterSend(session, sendObservedAtMs) {
  const reports = toArray(session?.reports);
  for (const report of reports) {
    const state = getReportState(report);
    if (!REVIEW_ROUND_REPORT_STATES.has(state)) {
      continue;
    }
    if (getReportTimestampMs(report) > sendObservedAtMs) {
      return report;
    }
  }
  return null;
}

/**
 * @param {ReviewRun} run
 * @param {AoSession[]} sessions
 * @param {OpenPr[]} [openPrs]
 */
export function isLinkedSessionLiveOwner(run, sessions, openPrs) {
  const linkedId = String(run?.linkedSessionId ?? '').trim();
  if (!linkedId) {
    return false;
  }

  const session = findSessionById(sessions, linkedId);
  if (!session) {
    return false;
  }
  if (!isLiveWorkerSession(session)) {
    return false;
  }

  const prNumber = Number(run?.prNumber);
  if (!prNumber) {
    return false;
  }

  return sessionOwnsRunHead(session, prNumber, String(run?.targetSha ?? ''), openPrs);
}

/**
 * @param {AoSession[]} sessions
 * @param {string} linkedA
 * @param {string} linkedB
 */
export function linkedRunSessionsMatch(sessions, linkedA, linkedB) {
  const a = String(linkedA ?? '').trim();
  const b = String(linkedB ?? '').trim();
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const session = findSessionById(sessions, a) ?? findSessionById(sessions, b);
  if (!session) {
    return false;
  }
  return sessionMatchesIdentifier(session, a) && sessionMatchesIdentifier(session, b);
}

/**
 * @param {ReviewRun[]} runs
 * @param {DeliveryTrackingState} tracking
 * @param {ReviewRun} target
 * @param {AoSession[]} sessions
 */
export function countAmbiguousUnconfirmedPeers(runs, tracking, target, sessions) {
  const prNumber = Number(target?.prNumber);
  const head = normalizeSha(target?.targetSha);
  const sessionId = String(target?.linkedSessionId ?? '').trim();
  const sessionList = toArray(sessions);
  if (!prNumber || !head || !sessionId) {
    return 0;
  }

  let count = 0;
  for (const run of toArray(runs)) {
    if (!isPendingSentDeliveryRun(run)) {
      continue;
    }
    if (Number(run?.prNumber) !== prNumber) {
      continue;
    }
    if (normalizeSha(run?.targetSha) !== head) {
      continue;
    }
    const peerLinked = String(run?.linkedSessionId ?? '').trim();
    if (!linkedRunSessionsMatch(sessionList, sessionId, peerLinked)) {
      continue;
    }
    const runId = getReviewRunId(run);
    if (!runId) {
      continue;
    }
    const record = tracking?.runs?.[runId];
    const state = record?.deliveryState ?? DELIVERY_STATE_UNCONFIRMED;
    if (state === DELIVERY_STATE_CONFIRMED || state === DELIVERY_STATE_ESCALATED) {
      continue;
    }
    count += 1;
  }
  return count;
}

/**
 * @param {ReviewRun} run
 * @param {AoSession[]} sessions
 * @param {number} sendObservedAtMs
 * @param {ReviewRun[]} allRuns
 * @param {DeliveryTrackingState} tracking
 * @param {OpenPr[]} [openPrs]
 */
export function isDeliveryConfirmed(
  run,
  sessions,
  sendObservedAtMs,
  allRuns,
  tracking,
  openPrs,
) {
  const linkedId = String(run?.linkedSessionId ?? '').trim();
  if (!linkedId) {
    return false;
  }

  if (countAmbiguousUnconfirmedPeers(allRuns, tracking, run, sessions) > 1) {
    return false;
  }

  if (!isLinkedSessionLiveOwner(run, sessions, openPrs)) {
    return false;
  }

  const session = findSessionById(sessions, linkedId);
  if (!session) {
    return false;
  }

  return Boolean(findReviewRoundReportAfterSend(session, sendObservedAtMs));
}

/**
 * @param {object} input
 * @param {number} input.nowMs
 * @param {number | undefined} input.lastTickMs
 * @param {number} [input.intervalMs]
 */
export function evaluateDeliveryTickInterval({ nowMs, lastTickMs, intervalMs }) {
  return evaluateMechanicalTickInterval({
    nowMs,
    lastTickMs,
    intervalMs,
    defaultIntervalMs: DEFAULT_TICK_INTERVAL_MS,
  });
}

/**
 * @param {RunDeliveryRecord} record
 * @param {number} sendObservedAtMs
 */
export function getConfirmationAnchorMs(record, sendObservedAtMs) {
  const lastRedelivery = record?.lastRedeliveryAtMs;
  if (lastRedelivery && lastRedelivery > 0) {
    return lastRedelivery;
  }
  return sendObservedAtMs;
}

/**
 * @param {object} config
 * @param {number} [config.confirmationWindowMs]
 * @param {number} [config.maxRedeliveries]
 * @param {number} [config.maxSubmits]
 */
export function resolveDeliveryConfig(config = {}) {
  return {
    confirmationWindowMs: resolveBoundedInt(
      config.confirmationWindowMs,
      DEFAULT_CONFIRMATION_WINDOW_MS,
      1,
    ),
    maxRedeliveries: resolveBoundedInt(
      config.maxRedeliveries,
      DEFAULT_MAX_REDELIVERIES,
      0,
    ),
  };
}

export const OPERATOR_REMEDY_TEXT =
  'Inspect the worker session terminal (flooded input channel is a known failure mode). ' +
  'Do not ao review send into a dead linked session — use ao session claim-pr with a live worker, ' +
  'reviewer-workspace-preflight if needed, then ao review run on the live session. ' +
  'See docs/orchestrator-recovery-runbook.md (Review finding delivery unconfirmed).';

/**
 * @param {object} input
 * @param {ReviewRun[]} input.reviewRuns
 * @param {AoSession[]} input.sessions
 * @param {DeliveryTrackingState} input.tracking
 * @param {number} input.nowMs
 * @param {object} [input.config]
 * @param {OpenPr[]} [input.openPrs]
 * @param {Array<Record<string, unknown>>} [input.aoEvents]
 * @param {Record<string, boolean>} [input.floodActiveSessions]
 */
export function planDeliveryConfirmActions({
  reviewRuns,
  sessions,
  tracking,
  nowMs,
  config,
  openPrs,
  aoEvents,
  floodActiveSessions,
}) {
  const { confirmationWindowMs, maxRedeliveries } = resolveDeliveryConfig(config);
  const runList = toArray(reviewRuns);
  const sessionList = toArray(sessions);
  const openPrList = toArray(openPrs);
  /** @type {Array<Record<string, unknown>>} */
  const actions = [];
  /** @type {Record<string, RunDeliveryRecord>} */
  const nextRuns = { ...(tracking?.runs ?? {}) };

  for (const run of runList) {
    if (!isPendingSentDeliveryRun(run)) {
      continue;
    }

    const runId = getReviewRunId(run);
    if (!runId) {
      continue;
    }

    const existing = nextRuns[runId] ?? {};
    const deliveryState = existing.deliveryState ?? DELIVERY_STATE_UNCONFIRMED;
    if (deliveryState === DELIVERY_STATE_CONFIRMED) {
      continue;
    }
    if (deliveryState === DELIVERY_STATE_ESCALATED) {
      continue;
    }

    const sendObservedAtMs =
      existing.sendObservedAtMs ?? resolveSendObservedAtMs(run, nowMs);
    const recordForAnchor = {
      ...existing,
      ...(nextRuns[runId] ?? {}),
      sendObservedAtMs,
    };
    const confirmationAnchorMs = getConfirmationAnchorMs(
      recordForAnchor,
      sendObservedAtMs,
    );

    if (!existing.sendObservedAtMs) {
      nextRuns[runId] = {
        ...existing,
        deliveryState: DELIVERY_STATE_UNCONFIRMED,
        sendObservedAtMs,
        redeliveryCount: existing.redeliveryCount ?? 0,
      };
    }

    // Use pre-tick tracking for overlap checks so same-tick escalations still count.
    if (
      isDeliveryConfirmed(
        run,
        sessionList,
        confirmationAnchorMs,
        runList,
        tracking,
        openPrList,
      )
    ) {
      nextRuns[runId] = {
        ...nextRuns[runId],
        deliveryState: DELIVERY_STATE_CONFIRMED,
        sendObservedAtMs,
      };
      actions.push({ type: 'mark_confirmed', runId, prNumber: run.prNumber });
      continue;
    }

    const redeliveryCount = nextRuns[runId]?.redeliveryCount ?? 0;
    const linkedSessionId = String(run?.linkedSessionId ?? '').trim();
    const prNumber = Number(run?.prNumber);

    if (!isLinkedSessionLiveOwner(run, sessionList, openPrList)) {
      const headMismatch =
        Boolean(normalizeSha(run?.targetSha)) &&
        Boolean(
          openPrList.find(
            (pr) =>
              Number(pr?.number) === prNumber &&
              normalizeSha(pr?.headRefOid) &&
              normalizeSha(pr?.headRefOid) !== normalizeSha(run?.targetSha),
          ),
        );
      nextRuns[runId] = {
        ...nextRuns[runId],
        deliveryState: DELIVERY_STATE_ESCALATED,
        sendObservedAtMs,
        redeliveryCount,
        escalatedAtMs: nowMs,
      };
      actions.push({
        type: 'escalate',
        runId,
        sessionId: linkedSessionId,
        prNumber,
        reason: headMismatch
          ? 'stale_run_head_not_owned'
          : 'orphan_or_dead_linked_session',
        message: buildEscalationMessage({
          runId,
          sessionId: linkedSessionId,
          prNumber,
        }),
      });
      continue;
    }

    const elapsed = nowMs - confirmationAnchorMs;
    if (elapsed < confirmationWindowMs) {
      actions.push({
        type: 'wait',
        runId,
        prNumber: run.prNumber,
        reason: 'confirmation_window_open',
        remainingMs: confirmationWindowMs - elapsed,
      });
      continue;
    }

    if (redeliveryCount < maxRedeliveries) {
      nextRuns[runId] = {
        ...nextRuns[runId],
        deliveryState: DELIVERY_STATE_UNCONFIRMED,
        sendObservedAtMs,
        redeliveryCount: redeliveryCount + 1,
        lastRedeliveryAtMs: nowMs,
      };
      actions.push({
        type: 'redeliver',
        runId,
        sessionId: linkedSessionId,
        prNumber,
        attempt: redeliveryCount + 1,
        maxRedeliveries,
      });
      continue;
    }

    // Submit is owned by worker-message-submit-reconcile.ps1 (Issue #232).
    nextRuns[runId] = {
      ...nextRuns[runId],
      deliveryState: DELIVERY_STATE_ESCALATED,
      sendObservedAtMs,
      redeliveryCount,
      escalatedAtMs: nowMs,
    };
    actions.push({
      type: 'escalate',
      runId,
      sessionId: linkedSessionId,
      prNumber,
      reason: 'max_redeliveries_exhausted',
      message: buildEscalationMessage({
        runId,
        sessionId: linkedSessionId,
        prNumber,
      }),
    });
  }

  return {
    actions,
    tracking: {
      runs: nextRuns,
      lastTickMs: tracking?.lastTickMs,
    },
  };
}

/**
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.sessionId
 * @param {number} input.prNumber
 */
export function buildEscalationMessage({ runId, sessionId, prNumber }) {
  return (
    `[review-finding-delivery-confirm] ESCALATION: unconfirmed delivery for review run ${runId} ` +
    `(PR #${prNumber}, session ${sessionId}). Operator remedy: ${OPERATOR_REMEDY_TEXT}`
  );
}

/**
 * @param {string} runId
 */
export function buildReviewSendArgv(runId) {
  return ['review', 'send', runId];
}

runStdinJsonCli('review-finding-delivery-confirm.mjs', {
  plan: () => {
    const payload = readStdinJson();
    return planDeliveryConfirmActions({
      reviewRuns: payload.reviewRuns,
      sessions: payload.sessions,
      openPrs: payload.openPrs,
      tracking: payload.tracking ?? { runs: {} },
      nowMs: Number(payload.nowMs) || Date.now(),
      config: payload.config ?? {},
      aoEvents: payload.aoEvents ?? [],
      floodActiveSessions: payload.floodActiveSessions ?? {},
    });
  },
  interval: () => {
    const payload = readStdinJson();
    return evaluateDeliveryTickInterval({
      nowMs: Number(payload.nowMs) || Date.now(),
      lastTickMs: payload.lastTickMs,
      intervalMs: Number(payload.intervalMs) || DEFAULT_TICK_INTERVAL_MS,
    });
  },
});
