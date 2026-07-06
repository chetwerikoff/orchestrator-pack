/**
 * AO 0.10 stuck review-run liveness reaper (Issue #624).
 * Vitest: scripts/review-stuck-run-reaper.test.ts
 */

import { isRuntimeFieldLive } from './session-runtime-liveness.mjs';
import { normalizeSha } from './ao-0-10-review-api.mjs';
import { spawnSync } from 'node:child_process';
import { readStdinJson, runAsyncStdinJsonCliMain, runStdinJsonCli, toArray } from './review-mechanical-cli.mjs';

export const DEFAULT_STUCK_AGE_FLOOR_SECONDS = 600;
export const FAIL_STALE_UPSTREAM_ISSUE = 'AgentWrapper/agent-orchestrator#2070';
export const AO_REVIEW_FAIL_STALE_PATH =
  '/api/v1/sessions/{sessionId}/reviews/runs/{runId}/fail-stale';

export function buildFailStalePath(sessionId, runId) {
  const sid = String(sessionId ?? '').trim();
  const rid = String(runId ?? '').trim();
  if (!sid || !rid) throw new Error('sessionId and runId are required for fail-stale path');
  return `/api/v1/sessions/${encodeURIComponent(sid)}/reviews/runs/${encodeURIComponent(rid)}/fail-stale`;
}


export function buildSessionReviewsListPath(sessionId) {
  const id = String(sessionId ?? '').trim();
  if (!id) throw new Error('session id is required for review list');
  return `/api/v1/sessions/${encodeURIComponent(id)}/reviews`;
}

export async function fetchSessionReviewsList(baseUrl, sessionId) {
  const base = String(baseUrl ?? '').replace(/\/$/, '');
  if (!base) throw new Error('baseUrl is required to fetch session reviews');
  const response = await fetch(`${base}${buildSessionReviewsListPath(sessionId)}`);
  if (!response.ok) {
    throw new Error(`session reviews fetch failed (HTTP ${response.status})`);
  }
  return response.json();
}

export function defaultTmuxExists(handleId) {
  const handle = String(handleId ?? '').trim();
  if (!handle) return 'unavailable';
  try {
    const result = spawnSync('tmux', ['has-session', '-t', handle], { encoding: 'utf8' });
    if (result.error) return 'unavailable';
    return result.status === 0 ? 'exists' : 'missing';
  } catch {
    return 'unavailable';
  }
}

export function createJitPaneProbe({ sessions = [], tmuxExists = defaultTmuxExists, refreshSessions = null } = {}) {
  return async ({ reviewerHandleId }) => {
    const freshSessions =
      typeof refreshSessions === 'function' ? await refreshSessions() : sessions;
    return probeReviewerPaneLiveness({
      reviewerHandleId,
      sessions: toArray(freshSessions),
      tmuxExists,
    });
  };
}


export function parseTimestampMs(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function computeRunAgeSeconds(run, nowMs = Date.now()) {
  const started =
    parseTimestampMs(run.updatedAt) ??
    parseTimestampMs(run.startedAt) ??
    parseTimestampMs(run.createdAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((nowMs - started) / 1000));
}

export function isSameHeadRunning(run, headSha) {
  const status = String(run?.status ?? '').toLowerCase();
  if (status !== 'running') return false;
  const head = normalizeSha(headSha);
  const target = normalizeSha(run?.targetSha);
  return Boolean(head && target && head === target);
}

export function probeReviewerPaneLiveness({ reviewerHandleId, sessions = [], tmuxExists = null }) {
  const handle = String(reviewerHandleId ?? '').trim();
  if (!handle) return { paneLiveness: 'unknown', reason: 'missing_reviewer_handle' };

  const session = sessions.find((row) => String(row?.id ?? row?.name ?? '').trim() === handle);
  if (session) {
    if (isRuntimeFieldLive(session)) {
      const status = String(session.status ?? '').toLowerCase();
      if (status && !['killed', 'terminated', 'exited'].includes(status)) {
        return { paneLiveness: 'healthy', reason: 'session_runtime_alive' };
      }
    }
    if (String(session.runtime ?? '').trim() && !isRuntimeFieldLive(session)) {
      return { paneLiveness: 'absent', reason: 'session_runtime_dead' };
    }
  }

  if (typeof tmuxExists === 'function') {
    const tmux = tmuxExists(handle);
    if (tmux === 'exists') return { paneLiveness: 'healthy', reason: 'tmux_session_present' };
    if (tmux === 'missing') return { paneLiveness: 'absent', reason: 'tmux_session_missing' };
    if (tmux === 'unavailable') return { paneLiveness: 'unknown', reason: 'tmux_unavailable' };
  }

  return { paneLiveness: 'unknown', reason: 'probe_inconclusive' };
}

function resolvePaneLiveness(ctx, reviewerHandleId) {
  const handle = String(reviewerHandleId ?? '').trim();
  const mapped = ctx.paneByHandle?.[handle];
  if (mapped === 'healthy' || mapped === 'absent' || mapped === 'unknown') {
    return { paneLiveness: mapped, reason: 'precomputed' };
  }
  if (typeof ctx.paneProbe === 'function') return ctx.paneProbe({ reviewerHandleId: handle });
  return { paneLiveness: 'unknown', reason: 'no_probe' };
}

export function classifyStuckSameHeadCandidate({
  run,
  headSha,
  prUrl = '',
  ageFloorSeconds = DEFAULT_STUCK_AGE_FLOOR_SECONDS,
  paneLiveness,
  nowMs = Date.now(),
}) {
  const sessionId = String(run?.linkedSessionId ?? run?.sessionId ?? '');
  const runId = String(run?.id ?? run?.runId ?? '');
  const targetSha = String(run?.targetSha ?? headSha ?? '');
  const ageSeconds = computeRunAgeSeconds(run, nowMs);
  const floor = Math.max(0, Number(ageFloorSeconds) || DEFAULT_STUCK_AGE_FLOOR_SECONDS);
  const base = {
    sessionId,
    prUrl: String(prUrl ?? ''),
    runId,
    targetSha,
    ageSeconds,
    paneLiveness,
    prNumber: Number(run?.prNumber ?? 0) || undefined,
  };

  if (!isSameHeadRunning(run, headSha)) return { ...base, classification: 'no_op', reason: 'not_same_head_running' };
  if (paneLiveness === 'healthy') return { ...base, classification: 'no_op', reason: 'healthy_pane' };
  if (ageSeconds < floor) return { ...base, classification: 'no_op', reason: 'below_age_floor' };
  if (paneLiveness === 'unknown') {
    return { ...base, classification: 'stuck_same_head_alert_only', reason: 'unknown_pane_liveness' };
  }
  if (paneLiveness === 'absent') {
    return { ...base, classification: 'stuck_same_head', reason: 'absent_pane_above_age_floor' };
  }
  return { ...base, classification: 'no_op', reason: 'unclassified_pane' };
}

export function formatClassifiedAlertLine(action) {
  return [
    'review-stuck-run-reaper',
    `classification=${action.classification ?? 'unknown'}`,
    `sessionId=${action.sessionId ?? ''}`,
    `prUrl=${action.prUrl ?? ''}`,
    `runId=${action.runId ?? ''}`,
    `targetSha=${action.targetSha ?? ''}`,
    `ageSeconds=${action.ageSeconds ?? 0}`,
    `paneLiveness=${action.paneLiveness ?? 'unknown'}`,
  ].join(' ');
}

export async function justInTimeRevalidate({
  prior,
  headSha,
  listPayload = null,
  refreshListPayload = null,
  paneProbe,
}) {
  const payload =
    typeof refreshListPayload === 'function' ? await refreshListPayload() : listPayload;
  if (!payload) return { ok: false, reason: 'list_payload_unavailable' };

  const reviews = toArray(payload?.reviews);
  const prNumber = Number(prior.prNumber ?? 0);
  const head = normalizeSha(headSha);
  let entry = null;
  for (const row of reviews) {
    if (Number.isFinite(prNumber) && Number(row?.prNumber) !== prNumber) continue;
    const rowHead = normalizeSha(row?.headSha ?? row?.latestRun?.targetSha);
    if (head && rowHead && rowHead !== head) continue;
    entry = row;
    break;
  }
  if (!entry?.latestRun) return { ok: false, reason: 'run_no_longer_present' };
  const latest = entry.latestRun;
  const status = String(latest.status ?? '').toLowerCase();
  if (status !== 'running') return { ok: false, reason: 'run_no_longer_running', status };
  const targetSha = String(latest.targetSha ?? entry.headSha ?? '');
  if (normalizeSha(targetSha) !== head) return { ok: false, reason: 'head_changed' };
  const pane = await Promise.resolve(
    paneProbe({ reviewerHandleId: String(payload?.reviewerHandleId ?? '') }),
  );
  if (pane.paneLiveness === 'healthy') return { ok: false, reason: 'pane_became_healthy' };
  if (pane.paneLiveness === 'unknown') return { ok: false, reason: 'pane_liveness_unknown' };
  return {
    ok: true,
    runId: String(latest.id ?? latest.runId ?? prior.runId ?? ''),
    targetSha,
  };
}

export function detectFailStaleSurfaceFromProbe(probeResult) {
  return Boolean(probeResult && typeof probeResult === 'object' && probeResult.available === true);
}

export function evaluateFailStaleInvocation({
  classification,
  paneLiveness,
  failStaleSurfaceAvailable = false,
  dryRun = false,
}) {
  if (classification !== 'stuck_same_head') return { invoke: false, reason: 'not_recoverable_classification' };
  if (paneLiveness !== 'absent') return { invoke: false, reason: 'pane_not_absent' };
  if (!failStaleSurfaceAvailable) {
    return { invoke: false, reason: 'fail_stale_surface_absent', upstream: FAIL_STALE_UPSTREAM_ISSUE };
  }
  if (dryRun) return { invoke: false, reason: 'dry_run', wouldInvoke: true };
  return { invoke: true, reason: 'eligible' };
}

export async function invokeFailStaleRunHttp({ sessionId, runId, targetSha = '', prUrl = '', baseUrl = '' }) {
  const base = String(baseUrl ?? '').replace(/\/$/, '');
  if (!base) return { ok: false, reason: 'missing_base_url' };
  const response = await fetch(`${base}${buildFailStalePath(sessionId, runId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetSha, prUrl, reason: 'pack_stuck_run_reaper' }),
  });
  return { ok: response.ok, reason: String(response.status) };
}

export async function runStuckRunReaperTick({
  workerSessions = [],
  listPayloads = {},
  paneByHandle = {},
  config = {},
  nowMs = Date.now(),
  paneProbe = null,
  refreshListPayload = null,
  refreshSessionsList = null,
  refreshPaneProbe = null,
  failStaleInvoker = null,
  baseUrl = '',
  failStaleSurfaceAvailable = false,
  dryRun = false,
  inFlightRecoveries = new Set(),
  sessions = [],
}) {
  const probeCtx = { paneByHandle, paneProbe, sessions };
  const ageFloorSeconds = Number(config.ageFloorSeconds ?? DEFAULT_STUCK_AGE_FLOOR_SECONDS);
  const actions = [];

  for (const worker of workerSessions) {
    const sessionId = String(worker?.id ?? worker?.name ?? '').trim();
    if (!sessionId) continue;
    const listPayload = listPayloads[sessionId];
    if (!listPayload) continue;
    const reviewerHandleId = String(listPayload.reviewerHandleId ?? '');

    for (const entry of toArray(listPayload.reviews)) {
      const latestRun = entry?.latestRun;
      if (!latestRun || typeof latestRun !== 'object') continue;
      const headSha = String(entry?.headSha ?? latestRun.targetSha ?? '');
      const run = { ...latestRun, linkedSessionId: sessionId, prNumber: entry?.prNumber ?? latestRun.prNumber };
      const pane = resolvePaneLiveness(probeCtx, reviewerHandleId);
      const classified = classifyStuckSameHeadCandidate({
        run,
        headSha,
        prUrl: String(entry?.prUrl ?? ''),
        ageFloorSeconds,
        paneLiveness: pane.paneLiveness,
        nowMs,
      });
      if (classified.classification === 'no_op') continue;

      const recoveryKey = `${sessionId}:${classified.runId}`;
      const failPlan = evaluateFailStaleInvocation({
        classification: classified.classification,
        paneLiveness: classified.paneLiveness,
        failStaleSurfaceAvailable,
        dryRun,
      });
      const action = { ...classified, alertLine: formatClassifiedAlertLine(classified), recovery: failPlan };

      if (classified.classification === 'stuck_same_head' && failPlan.invoke) {
        if (inFlightRecoveries.has(recoveryKey)) {
          action.recovery = { invoke: false, reason: 'single_flight_busy' };
          actions.push(action);
          continue;
        }
        inFlightRecoveries.add(recoveryKey);
        try {
          const refreshReviews =
            typeof refreshListPayload === 'function'
              ? () => refreshListPayload(sessionId)
              : baseUrl
                ? () => fetchSessionReviewsList(baseUrl, sessionId)
                : async () => listPayload;
          const jitPaneProbe = createJitPaneProbe({
            sessions,
            refreshSessions: refreshSessionsList,
            tmuxExists: defaultTmuxExists,
          });
          const jit = await justInTimeRevalidate({
            prior: classified,
            headSha,
            refreshListPayload: refreshReviews,
            paneProbe:
              typeof refreshPaneProbe === 'function'
                ? (ctx) => refreshPaneProbe({ ...ctx, sessionId })
                : jitPaneProbe,
          });
          if (!jit.ok) {
            action.recovery = { invoke: false, reason: 'jit_abort', detail: jit.reason };
            actions.push(action);
            continue;
          }
          const invoker =
            typeof failStaleInvoker === 'function'
              ? failStaleInvoker
              : baseUrl
                ? (ctx) => invokeFailStaleRunHttp({ ...ctx, baseUrl })
                : null;
          if (invoker) {
            const result = await invoker({
              sessionId,
              runId: jit.runId,
              targetSha: jit.targetSha,
              prUrl: classified.prUrl,
            });
            action.recovery = { ...failPlan, invoked: true, ok: result?.ok === true, detail: result?.reason ?? '' };
          }
        } finally {
          inFlightRecoveries.delete(recoveryKey);
        }
      }
      actions.push(action);
    }
  }

  return {
    ok: true,
    scanned: workerSessions.length,
    actions,
    failStaleSurfaceAvailable,
    upstream: failStaleSurfaceAvailable ? null : FAIL_STALE_UPSTREAM_ISSUE,
  };
}

const cliEntry = process.argv[1] ?? '';
const isReaperCli =
  cliEntry.endsWith('review-stuck-run-reaper.mjs') || cliEntry.endsWith('review-stuck-run-reaper.js');
if (isReaperCli && process.argv[2] === 'tick') {
  runAsyncStdinJsonCliMain('review-stuck-run-reaper.mjs', async () => runStuckRunReaperTick(readStdinJson()));
} else {
  runStdinJsonCli('review-stuck-run-reaper.mjs', {
    probe: () => {
      const payload = readStdinJson();
      const tmux = payload.tmuxExists ?? null;
      return probeReviewerPaneLiveness({
        reviewerHandleId: payload.reviewerHandleId,
        sessions: toArray(payload.sessions),
        tmuxExists: tmux ? () => tmux : null,
      });
    },
    classify: () => classifyStuckSameHeadCandidate(readStdinJson()),
    'format-alert': () => ({ line: formatClassifiedAlertLine(readStdinJson()) }),
    'jit-revalidate': async () => justInTimeRevalidate(readStdinJson()),
  });
}
