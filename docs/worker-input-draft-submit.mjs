/**
 * Pack bridge: submit AO-delivered multi-line paste drafts (Issue #216).
 * Vitest: scripts/review-finding-delivery-submit.test.ts, scripts/submit-worker-input-draft.test.ts
 */
import {
  readStdinJson,
  resolveBoundedInt,
  runStdinJsonCli,
} from './review-mechanical-cli.mjs';
import { normalizeSha, toArray } from './review-trigger-reconcile.mjs';
import {
  countAmbiguousUnconfirmedPeers,
  getConfirmationAnchorMs,
  getReviewRunId,
  isDeliveryConfirmed,
  isLinkedSessionLiveOwner,
  isPendingSentDeliveryRun,
  resolveSendObservedAtMs,
} from './review-finding-delivery-confirm.mjs';
import { resolveEventSessionId } from './terminal-flood-detect.mjs';

/** Default: at most one submit attempt per (runId, head SHA). */
export const DEFAULT_MAX_SUBMITS = 1;

/**
 * Event kinds that invalidate input freshness for a controlled delivery anchor.
 * State-derived only — no pane scraping.
 */
export const INPUT_AFFECTING_EVENT_KINDS = new Set([
  'activity.transition',
  'reaction.action_succeeded',
  'reaction.send_to_agent_failed',
  'session.send_failed',
]);

/**
 * @param {object} [config]
 */
export function resolveSubmitConfig(config = {}) {
  return {
    maxSubmits: resolveBoundedInt(config.maxSubmits, DEFAULT_MAX_SUBMITS, 0),
  };
}

/**
 * @param {string} runId
 * @param {string | undefined} headSha
 */
export function buildSubmitDecisionKey(runId, headSha) {
  const head = normalizeSha(headSha);
  const id = String(runId ?? '').trim();
  if (!id || !head) {
    return null;
  }
  return `${id}:${head}`;
}

/**
 * @param {{ sendObservedAtMs?: number, lastRedeliveryAtMs?: number }} record
 */
export function getControlledDeliveryAnchorMs(record) {
  const sendMs = Number(record?.sendObservedAtMs ?? 0);
  const redeliverMs = Number(record?.lastRedeliveryAtMs ?? 0);
  if (redeliverMs > 0 && redeliverMs >= sendMs) {
    return redeliverMs;
  }
  return sendMs;
}

/**
 * @param {Record<string, unknown>} event
 */
function getEventTimestampMs(event) {
  if (typeof event.tsEpoch === 'number' && Number.isFinite(event.tsEpoch)) {
    return event.tsEpoch;
  }
  const iso = typeof event.ts === 'string' ? event.ts : '';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * @param {Record<string, unknown>} event
 */
function isInputAffectingEvent(event) {
  const kind = String(event?.kind ?? '');
  if (!INPUT_AFFECTING_EVENT_KINDS.has(kind)) {
    return false;
  }
  if (kind === 'activity.transition') {
    const data = event.data;
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      return String(data.to ?? '').toLowerCase() === 'active';
    }
    return false;
  }
  if (kind === 'reaction.action_succeeded') {
    const data = event.data;
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      return String(data.action ?? '') === 'send-to-agent';
    }
    return false;
  }
  return true;
}

/**
 * @param {Array<Record<string, unknown>>} events
 * @param {string} sessionId
 * @param {number} anchorMs
 */
export function hasInterveningInputActivity(events, sessionId, anchorMs) {
  const needle = String(sessionId ?? '').trim();
  if (!needle || !anchorMs) {
    return false;
  }

  for (const event of toArray(events)) {
    const eventSession = resolveEventSessionId(event);
    if (eventSession !== needle) {
      continue;
    }
    const ts = getEventTimestampMs(event);
    if (ts <= anchorMs) {
      continue;
    }
    if (isInputAffectingEvent(event)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Record<string, boolean | undefined>} floodActiveSessions
 * @param {string} sessionId
 */
export function isSessionFloodActive(floodActiveSessions, sessionId) {
  const needle = String(sessionId ?? '').trim();
  if (!needle) {
    return false;
  }
  return Boolean(floodActiveSessions?.[needle]);
}

/**
 * @param {object} input
 * @param {import('./review-finding-delivery-confirm.mjs').ReviewRun} input.run
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} input.sessions
 * @param {import('./review-finding-delivery-confirm.mjs').DeliveryTrackingState} input.tracking
 * @param {import('./review-finding-delivery-confirm.mjs').ReviewRun[]} input.allRuns
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} [input.openPrs]
 * @param {Array<Record<string, unknown>>} [input.aoEvents]
 * @param {Record<string, boolean>} [input.floodActiveSessions]
 * @param {number} input.nowMs
 * @param {object} [input.config]
 */
export function evaluateSubmitEligibility({
  run,
  sessions,
  tracking,
  allRuns,
  openPrs,
  aoEvents,
  floodActiveSessions,
  nowMs,
  config,
}) {
  const runId = getReviewRunId(run);
  const linkedSessionId = String(run?.linkedSessionId ?? '').trim();
  const headSha = normalizeSha(run?.targetSha);
  const prNumber = Number(run?.prNumber);
  const { maxSubmits } = resolveSubmitConfig(config);

  if (!runId || !linkedSessionId || !headSha || !prNumber) {
    return { ok: false, reason: 'missing_run_metadata' };
  }

  const record = tracking?.runs?.[runId] ?? {};
  const sendObservedAtMs = record.sendObservedAtMs ?? resolveSendObservedAtMs(run, nowMs);
  const confirmationAnchorMs = getConfirmationAnchorMs(
    { ...record, sendObservedAtMs },
    sendObservedAtMs,
  );

  if (
    isDeliveryConfirmed(
      run,
      sessions,
      confirmationAnchorMs,
      allRuns,
      tracking,
      openPrs,
    )
  ) {
    return { ok: false, reason: 'already_confirmed' };
  }

  if (countAmbiguousUnconfirmedPeers(allRuns, tracking, run, sessions) > 1) {
    return { ok: false, reason: 'ambiguous_overlap' };
  }

  if (!isLinkedSessionLiveOwner(run, sessions, openPrs)) {
    return { ok: false, reason: 'session_not_live_owner' };
  }

  if (isSessionFloodActive(floodActiveSessions ?? {}, linkedSessionId)) {
    return { ok: false, reason: 'flood_active', defer: true };
  }

  const decisionKey = buildSubmitDecisionKey(runId, headSha);
  const storedKey = String(record.submitDecisionKey ?? '').trim();
  const submitCount =
    storedKey && storedKey === decisionKey ? Number(record.submitCount ?? 0) : 0;
  if (submitCount >= maxSubmits) {
    return { ok: false, reason: 'submit_budget_exhausted' };
  }

  const controlledAnchorMs = getControlledDeliveryAnchorMs({
    sendObservedAtMs,
    lastRedeliveryAtMs: record.lastRedeliveryAtMs,
  });
  if (
    hasInterveningInputActivity(toArray(aoEvents), linkedSessionId, controlledAnchorMs)
  ) {
    return { ok: false, reason: 'stale_input' };
  }

  return {
    ok: true,
    reason: 'eligible',
    runId,
    sessionId: linkedSessionId,
    prNumber,
    headSha,
    decisionKey,
    attempt: submitCount + 1,
    maxSubmits,
  };
}

/**
 * @param {string} tmuxTarget
 */
export function buildSubmitEnterArgv(tmuxTarget) {
  const target = String(tmuxTarget ?? '').trim();
  if (!target) {
    throw new Error('tmux target required');
  }
  return ['send-keys', '-t', target, 'Enter'];
}

/**
 * @param {object} input
 * @param {string} input.sessionId
 * @param {string} input.expectedSessionId
 * @param {boolean} input.tmuxAvailable
 * @param {boolean} input.tmuxSessionExists
 * @param {string} [input.tmuxTarget]
 */
export function evaluateSubmitAdapterGate({
  sessionId,
  expectedSessionId,
  tmuxAvailable,
  tmuxSessionExists,
  tmuxTarget,
}) {
  const session = String(sessionId ?? '').trim();
  const expected = String(expectedSessionId ?? '').trim();
  if (!session || !expected || session !== expected) {
    return { ok: false, reason: 'wrong_session', enter: false };
  }
  if (!tmuxAvailable) {
    return { ok: false, reason: 'tmux_unavailable', enter: false };
  }
  const target = String(tmuxTarget ?? session).trim();
  if (!tmuxSessionExists) {
    return { ok: false, reason: 'tmux_session_missing', enter: false };
  }
  return { ok: true, reason: 'ready', enter: true, tmuxTarget: target };
}

/**
 * Adapter must never compose finding text — only Enter to submit existing draft.
 * @param {string[]} argv
 */
export function assertSubmitArgvIsEnterOnly(argv) {
  const args = toArray(argv);
  if (args.length !== 4) {
    throw new Error('submit argv must be exactly send-keys -t <target> Enter');
  }
  if (args[0] !== 'send-keys' || args[1] !== '-t' || args[3] !== 'Enter') {
    throw new Error('submit argv must only send Enter');
  }
  const target = String(args[2] ?? '').trim();
  if (!target) {
    throw new Error('submit argv missing tmux target');
  }
}

runStdinJsonCli('worker-input-draft-submit.mjs', {
  gate() {
    const payload = readStdinJson();
    return evaluateSubmitAdapterGate({
      sessionId: payload.sessionId,
      expectedSessionId: payload.expectedSessionId,
      tmuxAvailable: Boolean(payload.tmuxAvailable),
      tmuxSessionExists: Boolean(payload.tmuxSessionExists),
      tmuxTarget: payload.tmuxTarget,
    });
  },
});
