/**
 * Post-submit confirmed-delivery gate for the pack scripted PR-review flow (Issue #669).
 * Vitest: scripts/scripted-review-confirmed-delivery-gate.test.ts
 */
import { readStdinJson, resolveBoundedInt, runStdinJsonCli, toArray } from './review-mechanical-cli.mjs';
import { isLiveWorkerSession, normalizeSha } from './review-reconcile-primitives.mjs';
import { sessionOwnsRunHead } from './review-trigger-reconcile.mjs';

export const DEFAULT_POLL_WINDOW_MS = 45 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 2 * 1000;
export const MAX_POLL_WINDOW_MS = 120 * 1000;
export const ENV_POLL_WINDOW_SECONDS = 'AO_SCRIPTED_REVIEW_DELIVERY_POLL_WINDOW_SECONDS';
export const ENV_POLL_INTERVAL_SECONDS = 'AO_SCRIPTED_REVIEW_DELIVERY_POLL_INTERVAL_SECONDS';

export const GATE_ACTION_SEND = 'send';
export const GATE_ACTION_SUPPRESS = 'suppress';
export const GATE_ACTION_ESCALATE = 'escalate';

export const LIVENESS_LIVE_HEAD_OWNING = 'live_head_owning';
export const LIVENESS_DRIFTED_HEAD = 'drifted_head';
export const LIVENESS_DEAD_TERMINATED = 'dead_terminated';

export const POLL_DELIVERED = 'delivered';
export const POLL_NOT_DELIVERED = 'not_delivered';
export const POLL_AMBIGUOUS = 'ambiguous';

export const OPERATOR_REMEDY_TEXT =
  'Verify worker session liveness and PR head ownership; inspect GET /api/v1/sessions/{id}/reviews latestRun.status; if auto-delivery missed, relay findings once via journaled-worker-send or manual operator send; if ambiguous overlapping runs, reconcile review runs before re-triggering review.';

/**
 * @param {Record<string, unknown>} [config]
 */
export function resolveGateConfig(config = {}) {
  const windowSeconds = resolveBoundedInt(
    config.pollWindowSeconds,
    DEFAULT_POLL_WINDOW_MS / 1000,
    1,
  );
  const cappedWindowSeconds = Math.min(windowSeconds, MAX_POLL_WINDOW_MS / 1000);
  const intervalSeconds = Math.min(
    resolveBoundedInt(config.pollIntervalSeconds, DEFAULT_POLL_INTERVAL_MS / 1000, 1),
    cappedWindowSeconds,
  );
  return {
    pollWindowMs: cappedWindowSeconds * 1000,
    pollIntervalMs: intervalSeconds * 1000,
  };
}

/**
 * @param {unknown} status
 */
export function isDaemonDeliveryConfirmed(status) {
  return String(status ?? '').trim().toLowerCase() === 'delivered';
}

/**
 * @param {unknown} status
 */
export function isTerminalNotDelivered(status) {
  const normalized = String(status ?? '').trim().toLowerCase();
  return normalized === 'complete' || normalized === 'failed';
}

/**
 * @param {unknown} reviews
 * @param {{ runId?: string, batchId?: string, prNumber?: number, targetSha?: string }} submit
 */
export function findReviewEntryForSubmit(reviews, submit) {
  const runId = String(submit.runId ?? '').trim();
  const batchId = String(submit.batchId ?? '').trim();
  const prNumber = Number(submit.prNumber);
  const targetSha = normalizeSha(submit.targetSha);
  const candidates = [];

  for (const entry of toArray(reviews)) {
    const latest = entry?.latestRun;
    if (!latest || typeof latest !== 'object') {
      continue;
    }
    const entryPr = Number(entry?.prNumber ?? latest?.prNumber);
    if (Number.isFinite(prNumber) && prNumber > 0 && entryPr !== prNumber) {
      continue;
    }
    const entryHead = normalizeSha(entry?.targetSha ?? entry?.headSha ?? latest?.targetSha);
    if (targetSha && entryHead && entryHead !== targetSha) {
      continue;
    }
    candidates.push(entry);
  }

  if (candidates.length > 1) {
    return { ok: false, reason: 'ambiguous_overlapping_runs', matchCount: candidates.length };
  }

  const matches = [];
  for (const entry of candidates) {
    const latest = entry?.latestRun;
    const latestRunId = String(latest.id ?? latest.runId ?? '').trim();
    const latestBatchId = String(latest.batchId ?? '').trim();
    const runMatch = runId && latestRunId === runId;
    const batchMatch = batchId && latestBatchId === batchId;
    if (runId && !runMatch) {
      continue;
    }
    if (batchId && !batchMatch && !runMatch) {
      continue;
    }
    matches.push(entry);
  }

  if (matches.length === 1) {
    return { ok: true, entry: matches[0] };
  }
  if (matches.length === 0) {
    return { ok: false, reason: 'unattributable_latest_run' };
  }
  return { ok: false, reason: 'ambiguous_matching_rows', matchCount: matches.length };
}

/**
 * @param {object} input
 * @param {unknown} [input.entry]
 * @param {string} [input.submittedRunId]
 * @param {string} [input.submittedBatchId]
 * @param {string} [input.initialObservedRunId]
 */
export function attributeSubmittedRun({
  entry,
  submittedRunId,
  submittedBatchId,
  initialObservedRunId,
}) {
  const latest = entry?.latestRun;
  if (!latest || typeof latest !== 'object') {
    return { ok: false, reason: 'missing_latest_run' };
  }
  const latestRunId = String(latest.id ?? latest.runId ?? '').trim();
  const latestBatchId = String(latest.batchId ?? '').trim();
  const expectedRunId = String(submittedRunId ?? '').trim();
  const expectedBatchId = String(submittedBatchId ?? '').trim();
  const initialRunId = String(initialObservedRunId ?? '').trim();

  if (expectedRunId && latestRunId && latestRunId !== expectedRunId) {
    if (initialRunId && latestRunId !== initialRunId) {
      return { ok: false, reason: 'overlapping_same_head_submit' };
    }
    return { ok: false, reason: 'latest_run_id_drift' };
  }
  if (expectedBatchId && latestBatchId && latestBatchId !== expectedBatchId) {
    return { ok: false, reason: 'batch_id_drift' };
  }
  return { ok: true, latestRun: latest };
}

/**
 * @param {object} input
 */
export function classifyPollDatum({ latestRun, attributionOk, attributionReason }) {
  if (!attributionOk) {
    return { outcome: POLL_AMBIGUOUS, reason: attributionReason ?? 'ambiguous_attribution' };
  }
  if (!latestRun || typeof latestRun !== 'object') {
    return { outcome: POLL_AMBIGUOUS, reason: 'missing_latest_run' };
  }
  const status = String(latestRun.status ?? '').trim().toLowerCase();
  if (!status) {
    return { outcome: POLL_AMBIGUOUS, reason: 'unreadable_status' };
  }
  if (isDaemonDeliveryConfirmed(status)) {
    return { outcome: POLL_DELIVERED, reason: 'daemon_confirmed' };
  }
  if (isTerminalNotDelivered(status)) {
    return { outcome: POLL_NOT_DELIVERED, reason: 'terminal_not_delivered', status };
  }
  return { outcome: POLL_NOT_DELIVERED, reason: 'pending_delivery', status };
}

/**
 * @param {object} input
 */
export function classifyWorkerLiveness({ session, openPrs, prNumber, targetSha }) {
  if (!session || typeof session !== 'object') {
    return { liveness: LIVENESS_DEAD_TERMINATED, reason: 'missing_session' };
  }
  if (!isLiveWorkerSession(session)) {
    return { liveness: LIVENESS_DEAD_TERMINATED, reason: 'session_not_live' };
  }
  if (!sessionOwnsRunHead(session, prNumber, targetSha, openPrs)) {
    return { liveness: LIVENESS_DRIFTED_HEAD, reason: 'head_not_owned' };
  }
  return { liveness: LIVENESS_LIVE_HEAD_OWNING, reason: 'live_head_owning' };
}

/**
 * @param {object} input
 */
export function evaluateGateTerminalAction({
  verdict,
  pollOutcome,
  liveness,
  windowExpired = false,
}) {
  const normalizedVerdict = String(verdict ?? '').trim().toLowerCase();
  const live = liveness?.liveness === LIVENESS_LIVE_HEAD_OWNING;

  if (liveness?.liveness === LIVENESS_DRIFTED_HEAD || liveness?.liveness === LIVENESS_DEAD_TERMINATED) {
    return {
      action: GATE_ACTION_ESCALATE,
      reason: liveness.reason ?? liveness.liveness,
    };
  }

  if (normalizedVerdict === 'approved') {
    return live
      ? { action: GATE_ACTION_SEND, reason: 'approved_sole_channel' }
      : { action: GATE_ACTION_ESCALATE, reason: 'approved_no_live_target' };
  }

  if (normalizedVerdict !== 'changes_requested') {
    return { action: GATE_ACTION_ESCALATE, reason: 'unsupported_verdict' };
  }

  if (pollOutcome?.outcome === POLL_AMBIGUOUS) {
    return { action: GATE_ACTION_ESCALATE, reason: pollOutcome.reason ?? 'ambiguous_poll' };
  }

  if (pollOutcome?.outcome === POLL_DELIVERED && live) {
    return { action: GATE_ACTION_SUPPRESS, reason: 'daemon_delivery_confirmed' };
  }

  if (windowExpired && pollOutcome?.outcome === POLL_NOT_DELIVERED && live) {
    return { action: GATE_ACTION_SEND, reason: 'poll_window_expired_not_delivered' };
  }

  return { action: null, reason: 'continue_polling' };
}

/**
 * @param {object} input
 */
export function evaluateGatePollStep(input) {
  const config = resolveGateConfig(input.config ?? {});
  const startedAtMs = Number(input.startedAtMs ?? input.nowMs ?? Date.now());
  const nowMs = Number(input.nowMs ?? Date.now());
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  const windowExpired = elapsedMs >= config.pollWindowMs;
  const normalizedVerdict = String(input.verdict ?? '').trim().toLowerCase();

  if (normalizedVerdict === 'approved') {
    const liveness = classifyWorkerLiveness({
      session: input.session,
      openPrs: input.openPrs,
      prNumber: input.prNumber,
      targetSha: input.targetSha,
    });
    const terminal = evaluateGateTerminalAction({
      verdict: 'approved',
      pollOutcome: { outcome: POLL_NOT_DELIVERED, reason: 'approved_skip_poll' },
      liveness,
      windowExpired: false,
    });
    return {
      config,
      elapsedMs,
      windowExpired: false,
      pollOutcome: { outcome: POLL_NOT_DELIVERED, reason: 'approved_skip_poll' },
      liveness,
      terminal,
      shouldContinuePolling: false,
    };
  }

  const findResult = findReviewEntryForSubmit(input.reviews, {
    runId: input.runId,
    batchId: input.batchId,
    prNumber: input.prNumber,
    targetSha: input.targetSha,
  });
  if (!findResult.ok) {
    const liveness = classifyWorkerLiveness({
      session: input.session,
      openPrs: input.openPrs,
      prNumber: input.prNumber,
      targetSha: input.targetSha,
    });
    const terminal = evaluateGateTerminalAction({
      verdict: input.verdict,
      pollOutcome: { outcome: POLL_AMBIGUOUS, reason: findResult.reason },
      liveness,
      windowExpired: true,
    });
    return {
      config,
      elapsedMs,
      windowExpired: true,
      pollOutcome: { outcome: POLL_AMBIGUOUS, reason: findResult.reason },
      liveness,
      terminal,
      shouldContinuePolling: false,
    };
  }

  const attribution = attributeSubmittedRun({
    entry: findResult.entry,
    submittedRunId: input.runId,
    submittedBatchId: input.batchId,
    initialObservedRunId: input.initialObservedRunId,
  });
  const pollOutcome = classifyPollDatum({
    latestRun: attribution.latestRun,
    attributionOk: attribution.ok,
    attributionReason: attribution.reason,
  });
  const liveness = classifyWorkerLiveness({
    session: input.session,
    openPrs: input.openPrs,
    prNumber: input.prNumber,
    targetSha: input.targetSha,
  });
  const terminal = evaluateGateTerminalAction({
    verdict: input.verdict,
    pollOutcome,
    liveness,
    windowExpired,
  });
  const shouldContinuePolling =
    terminal.action === null && !windowExpired && input.verdict === 'changes_requested';

  return {
    config,
    elapsedMs,
    windowExpired,
    pollOutcome,
    liveness,
    terminal,
    shouldContinuePolling,
    latestRunStatus: String(attribution.latestRun?.status ?? ''),
  };
}

/**
 * @param {object} input
 */
export function evaluatePostSendComposition({
  explicitSendOutcome,
  lateAutoDeliveryConfirmed = false,
  dedupApplied = false,
  dedupFailed = false,
}) {
  const outcome = String(explicitSendOutcome ?? '').trim().toLowerCase();
  if (outcome === 'failed') {
    return { terminal: 'escalate', reason: 'explicit_send_failed' };
  }
  if (outcome === 'confirmed') {
    return { terminal: 'delivered_once', reason: 'explicit_send_confirmed' };
  }
  if (outcome === 'race_late_auto_delivery') {
    if (lateAutoDeliveryConfirmed && dedupApplied) {
      return { terminal: 'dedup_or_escalate', reason: 'late_auto_delivery_dedup_applied' };
    }
    if (lateAutoDeliveryConfirmed && dedupFailed) {
      return { terminal: 'escalate', reason: 'irreconcilable_double_delivery' };
    }
    return { terminal: 'delivered_once', reason: 'explicit_send_only' };
  }
  return { terminal: 'escalate', reason: 'unknown_explicit_send_outcome' };
}

/**
 * @param {{ runId?: string, sessionId?: string, prNumber?: number, reason?: string }} input
 */
export function buildGateEscalationMessage({ runId, sessionId, prNumber, reason }) {
  return (
    `[scripted-review-confirmed-delivery-gate] ESCALATION: ${reason ?? 'confirmed-delivery gate blocked'} ` +
    `for review run ${runId ?? '<run-id>'} (PR #${prNumber ?? '?'}, session ${sessionId ?? '<session-id>'}). ` +
    `Operator remedy: ${OPERATOR_REMEDY_TEXT}`
  );
}

/**
 * @param {Record<string, unknown>} env
 */
export function resolveGateConfigFromEnv(env = process.env) {
  const pollWindowSeconds = env[ENV_POLL_WINDOW_SECONDS];
  const pollIntervalSeconds = env[ENV_POLL_INTERVAL_SECONDS];
  return resolveGateConfig({
    pollWindowSeconds: pollWindowSeconds ? Number(pollWindowSeconds) : undefined,
    pollIntervalSeconds: pollIntervalSeconds ? Number(pollIntervalSeconds) : undefined,
  });
}

runStdinJsonCli('scripted-review-confirmed-delivery-gate.mjs', {
  'resolve-config': () => {
    const payload = readStdinJson();
    return resolveGateConfig(payload.config ?? {});
  },
  'poll-step': () => evaluateGatePollStep(readStdinJson()),
  'terminal-action': () => {
    const payload = readStdinJson();
    return evaluateGateTerminalAction({
      verdict: payload.verdict,
      pollOutcome: payload.pollOutcome,
      liveness: payload.liveness,
      windowExpired: Boolean(payload.windowExpired),
    });
  },
  'post-send': () => evaluatePostSendComposition(readStdinJson()),
  'build-escalation': () => {
    const payload = readStdinJson();
    return { message: buildGateEscalationMessage(payload) };
  },
});
