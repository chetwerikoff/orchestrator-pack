import { normalizeSha, toArray } from './review-trigger-reconcile.mjs';
import {
  DELIVERY_STATE_CONFIRMED,
  DELIVERY_STATE_ESCALATED,
  DELIVERY_STATE_UNCONFIRMED,
  OPERATOR_REMEDY_TEXT,
  getConfirmationAnchorMs,
  getReviewRunId,
  isDeliveryConfirmed,
  isLinkedSessionLiveOwner,
  isPendingSentDeliveryRun,
  resolveDeliveryConfig,
  resolveSendObservedAtMs,
} from './review-delivery-confirmation-core.mjs';

export function planDeliveryConfirmActions({
  reviewRuns,
  sessions,
  tracking,
  nowMs,
  config,
  openPrs,
}) {
  const { confirmationWindowMs } = resolveDeliveryConfig(config);
  const runList = toArray(reviewRuns);
  const sessionList = toArray(sessions);
  const openPrList = toArray(openPrs);
  const actions = [];
  const nextRuns = { ...(tracking?.runs ?? {}) };

  for (const run of runList) {
    if (!isPendingSentDeliveryRun(run)) continue;
    const runId = getReviewRunId(run);
    if (!runId) continue;

    const existing = nextRuns[runId] ?? {};
    const deliveryState = existing.deliveryState ?? DELIVERY_STATE_UNCONFIRMED;
    if (deliveryState === DELIVERY_STATE_CONFIRMED || deliveryState === DELIVERY_STATE_ESCALATED) {
      continue;
    }

    const sendObservedAtMs = existing.sendObservedAtMs ?? resolveSendObservedAtMs(run, nowMs);
    const confirmationAnchorMs = getConfirmationAnchorMs(
      { ...existing, ...(nextRuns[runId] ?? {}), sendObservedAtMs },
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

    if (isDeliveryConfirmed(run, sessionList, confirmationAnchorMs, runList, tracking, openPrList)) {
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
      const headMismatch = Boolean(normalizeSha(run?.targetSha)) && Boolean(
        openPrList.find((pr) =>
          Number(pr?.number) === prNumber &&
          normalizeSha(pr?.headRefOid) &&
          normalizeSha(pr?.headRefOid) !== normalizeSha(run?.targetSha)),
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
        reason: headMismatch ? 'stale_run_head_not_owned' : 'orphan_or_dead_linked_session',
        message: buildEscalationMessage({ runId, sessionId: linkedSessionId, prNumber }),
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

    // AO 0.10 auto-delivery is observe-only. Worker input submission remains owned
    // by worker-message-submit-reconcile.ps1; this shared planner only escalates.
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
      message: buildEscalationMessage({ runId, sessionId: linkedSessionId, prNumber }),
    });
  }

  return { actions, tracking: { runs: nextRuns, lastTickMs: tracking?.lastTickMs } };
}

export function buildEscalationMessage({ runId, sessionId, prNumber }) {
  return (
    `[review-delivery-confirmation] ESCALATION: unconfirmed delivery for review run ${runId} ` +
    `(PR #${prNumber}, session ${sessionId}). Operator remedy: ${OPERATOR_REMEDY_TEXT}`
  );
}
