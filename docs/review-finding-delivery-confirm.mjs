/**
 * Sender-side review-finding delivery confirmation (Issue #171).
 * Vitest: scripts/review-finding-delivery-confirm.test.ts
 */
import {
  evaluateMechanicalTickInterval,
  readStdinJson,
  runStdinJsonCli,
} from './review-mechanical-cli.mjs';
import {
  findForbiddenLifecycleCommands,
  findSessionById,
  isLiveWorkerSession,
  normalizeSha,
  sessionMatchesPr,
  toArray,
} from './review-trigger-reconcile.mjs';

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
/** @typedef {{ name?: string, sessionId?: string, id?: string, role?: string, prNumber?: number | null, pr?: string | null, status?: string, reports?: Array<{ reportState?: string, report_state?: string, reportedAt?: string, timestamp?: string, createdAt?: string }> }} AoSession */
/** @typedef {{ deliveryState?: string, sendObservedAtMs?: number, redeliveryCount?: number, lastRedeliveryAtMs?: number, escalatedAtMs?: number }} RunDeliveryRecord */
/** @typedef {{ runs?: Record<string, RunDeliveryRecord>, lastTickMs?: number }} DeliveryTrackingState */

/**
 * @param {ReviewRun} run
 */
export function getReviewRunId(run) {
  const id = String(run?.id ?? run?.reviewerSessionId ?? '').trim();
  return id || null;
}

/**
 * @param {ReviewRun} run
 */
export function isPendingSentDeliveryRun(run) {
  const status = String(run?.status ?? '').toLowerCase();
  const sent = Number(run?.sentFindingCount ?? 0);
  return status === 'waiting_update' && sent > 0;
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
 */
export function isLinkedSessionLiveOwner(run, sessions) {
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

  return sessionMatchesPr(session, prNumber);
}

/**
 * @param {ReviewRun[]} runs
 * @param {DeliveryTrackingState} tracking
 * @param {ReviewRun} target
 */
export function countAmbiguousUnconfirmedPeers(runs, tracking, target) {
  const prNumber = Number(target?.prNumber);
  const head = normalizeSha(target?.targetSha);
  const sessionId = String(target?.linkedSessionId ?? '').trim();
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
    if (String(run?.linkedSessionId ?? '').trim() !== sessionId) {
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
 */
export function isDeliveryConfirmed(run, sessions, sendObservedAtMs, allRuns, tracking) {
  const linkedId = String(run?.linkedSessionId ?? '').trim();
  if (!linkedId) {
    return false;
  }

  if (countAmbiguousUnconfirmedPeers(allRuns, tracking, run) > 1) {
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
 * @param {unknown} value
 * @param {number} defaultValue
 * @param {number} [min]
 */
function resolveBoundedInt(value, defaultValue, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(min, parsed);
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
 */
export function planDeliveryConfirmActions({
  reviewRuns,
  sessions,
  tracking,
  nowMs,
  config,
}) {
  const { confirmationWindowMs, maxRedeliveries } = resolveDeliveryConfig(config);
  const runList = toArray(reviewRuns);
  const sessionList = toArray(sessions);
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
      isDeliveryConfirmed(run, sessionList, confirmationAnchorMs, runList, tracking)
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

    if (!isLinkedSessionLiveOwner(run, sessionList)) {
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
        reason: 'orphan_or_dead_linked_session',
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
      tracking: payload.tracking ?? { runs: {} },
      nowMs: Number(payload.nowMs) || Date.now(),
      config: payload.config ?? {},
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
