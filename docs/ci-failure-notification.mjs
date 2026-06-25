#!/usr/bin/env node
/**
 * CI-failure notification predicate and episode lifecycle (Issues #283 / #342).
 *
 * Terminal predicate action: SEND | SUPPRESS. Episode lifecycle adds pending→terminal
 * outbox states; live worker fixing_ci suppressor binds to the PR-owner's latest
 * head-scoped worker report (not session.status).
 */
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, rmSync, readdirSync, renameSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readStdinJson, runStdinJsonCli, resolveBoundedInt, evaluateMechanicalTickInterval } from './review-mechanical-cli.mjs';
import { resolveHeadOwningWorkerSessionId, sessionOwnsRunHead, sessionMatchesPr, resolveHeadCommittedAtMs, getStoredReportHeadSha } from './review-trigger-reconcile.mjs';
import { normalizeSha, toArray, getSessionIdentifier } from './review-reconcile-primitives.mjs';
import { isSessionAlive } from './worker-message-dispatch-observe.mjs';
import {
  classifyRequiredCiLevel,
  normalizeCiChecksByPr,
  normalizeRequiredCheckLookupFailedByPr,
  normalizeRequiredCheckNamesByPr,
} from './ci-green-wake-reconcile.mjs';
import { findLatestReportForHead, isCiCheckFailure, normalizeCiState } from './review-ready-stuck-guard.mjs';
import { getReportState } from './review-finding-delivery-confirm.mjs';
import { getReportTimestampMs } from './review-trigger-reconcile.mjs';
import { withDedupStateFileLock } from './orchestrator-wake-filter.mjs';

export const TERMINAL_ACTIONS = Object.freeze(['SEND', 'SUPPRESS']);
export const DEFAULT_HELPER_ERROR_LIMIT = 3;
export const DEFAULT_MIN_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
export const DEFAULT_MAX_ELIGIBLE_EVALUATION_AGE_MS = 180_000;
export const DEFAULT_PENDING_EXPIRY_MS = 30 * 60 * 1000;
export const DEFAULT_CLAIM_STALE_MS = 60 * 1000;
export const REPORT_STALE_BACKSTOP_MS = 30 * 60 * 1000;
export const DEFAULT_PROGRESS_FRESHNESS_MS = 15 * 60 * 1000;
export const PROGRESS_FRESHNESS_ENV = 'AO_CI_FAILURE_PROGRESS_FRESHNESS_MS';

export const TERMINAL_REASONS = Object.freeze([
  'sent',
  'delivery-failed',
  'progress_stale',
  'suppressed-live-worker',
  'suppressed-dedup',
  'suppressed-intent-token',
  'abandoned-no-live-owner',
  'abandoned-expired',
  'abandoned-superseded',
  'reaction_ci_failed_sent_to_active_target',
  'worker_fixing_ci_for_episode',
  'orchestrator_intent_token_present',
  'intent_failed_owned_escalated',
  'helper_error_safe_suppress',
  'ci_source_disagreement_safe_suppress',
  'no_suppressor',
  'progress_freshness_evidence_unreadable',
]);

export const EPISODE_OUTBOX_STATES = Object.freeze([
  'pending',
  'claimed',
  'submit-intent-reserved',
  'submitted-unacked',
]);

export const WORKER_STATE_REQUIRED_TOP = Object.freeze(['sessions', 'openPrs']);

export function assertTerminalAction(action) {
  if (!TERMINAL_ACTIONS.includes(action)) {
    throw new Error(`invalid terminal_action: ${String(action)}`);
  }
  return action;
}

export function normalizeHeadSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`invalid headSha: ${String(value)}`);
  }
  return sha;
}

export function normalizeEpisodeKey(episode) {
  if (!episode || typeof episode !== 'object') {
    throw new Error('episode is required');
  }
  const repo = String(episode.repo ?? '').trim();
  const prNumber = Number(episode.prNumber);
  const headSha = normalizeHeadSha(episode.headSha);
  const redPeriod = String(episode.redPeriod ?? '').trim();
  const targetId = String(episode.targetId ?? '').trim();
  const targetGeneration = String(episode.targetGeneration ?? targetId).trim();
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0 || !redPeriod || !targetId || !targetGeneration) {
    throw new Error('episode key requires repo, positive prNumber, headSha, redPeriod, targetId, targetGeneration');
  }
  return { repo, prNumber, headSha, redPeriod, targetId, targetGeneration };
}

export function episodeKeyString(episode) {
  const e = normalizeEpisodeKey(episode);
  return `${e.repo}#${e.prNumber}#${e.headSha}#${e.redPeriod}#${e.targetGeneration}#${e.targetId}`;
}

export function episodeKeyDigest(episode) {
  return createHash('sha256').update(episodeKeyString(episode)).digest('hex');
}

export function safeTokenName(episode) {
  return `${episodeKeyDigest(episode)}.json`;
}

export function safeEpisodeRecordName(episode) {
  return `${episodeKeyDigest(episode)}.episode.json`;
}

function field(obj, names) {
  for (const name of names) {
    const parts = name.split('.');
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (cur && typeof cur === 'object' && part in cur) cur = cur[part];
      else { ok = false; break; }
    }
    if (ok && cur !== undefined && cur !== null && String(cur) !== '') return cur;
  }
  return undefined;
}

export function eventEpisode(event) {
  const episode = field(event, ['episode', 'metadata.episode', 'details.episode', 'payload.episode', 'data.episode']);
  if (episode && typeof episode === 'object') return episode;
  return {
    repo: field(event, ['repo', 'repository', 'metadata.repo', 'details.repo', 'payload.repo', 'data.repo', 'data.repository']),
    prNumber: field(event, ['prNumber', 'pr', 'pullRequest.number', 'metadata.prNumber', 'details.prNumber', 'payload.prNumber', 'data.prNumber', 'data.pr', 'data.pullRequest.number']),
    headSha: field(event, ['headSha', 'sha', 'metadata.headSha', 'details.headSha', 'payload.headSha', 'data.headSha', 'data.sha']),
    redPeriod: field(event, ['redPeriod', 'ciRunId', 'checkSuiteId', 'metadata.redPeriod', 'details.redPeriod', 'payload.redPeriod', 'data.redPeriod', 'data.ciRunId', 'data.checkSuiteId']),
    targetId: field(event, ['targetId', 'sessionId', 'workerSessionId', 'metadata.targetId', 'details.targetId', 'payload.targetId', 'data.targetId', 'data.sessionId', 'data.workerSessionId']),
    targetGeneration: field(event, ['targetGeneration', 'sessionGeneration', 'metadata.targetGeneration', 'details.targetGeneration', 'payload.targetGeneration', 'data.targetGeneration', 'data.sessionGeneration']),
  };
}

function sameEpisode(a, b) {
  try {
    return episodeKeyString(a) === episodeKeyString(b);
  } catch {
    return false;
  }
}

export function deriveTargetGeneration(session) {
  const gen = field(session, ['targetGeneration', 'sessionGeneration', 'generation']);
  if (gen) return String(gen).trim();
  return getSessionIdentifier(session) ?? '';
}

export function findSessionByIdentifier(sessions, identifier) {
  const needle = String(identifier ?? '').trim();
  if (!needle) return null;
  for (const session of toArray(sessions)) {
    for (const id of [session?.name, session?.sessionId, session?.id]) {
      if (String(id ?? '').trim() === needle) return session;
    }
  }
  return null;
}

export function validateWorkerStateInput(workerState) {
  if (workerState == null || typeof workerState !== 'object') {
    return { ok: false, error: 'missing_worker_state_input', code: 'missing_worker_state_input' };
  }
  for (const key of WORKER_STATE_REQUIRED_TOP) {
    if (!Object.prototype.hasOwnProperty.call(workerState, key)) {
      return { ok: false, error: 'incompatible_worker_state_shape', code: 'missing_field', field: key };
    }
    if (!Array.isArray(workerState[key])) {
      return { ok: false, error: 'incompatible_worker_state_shape', code: 'invalid_field_type', field: key };
    }
  }
  return { ok: true };
}

export function resolveProgressFreshnessMs(input = {}) {
  const fromInput = input.progressFreshnessMs ?? input.progress_freshness_ms;
  const fromEnv = typeof process !== 'undefined' ? process.env?.[PROGRESS_FRESHNESS_ENV] : undefined;
  const raw = fromInput ?? fromEnv;
  const parsed = Number(raw);
  const fallback = DEFAULT_PROGRESS_FRESHNESS_MS;
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  const capped = Math.min(resolved, REPORT_STALE_BACKSTOP_MS - 1);
  return Math.max(1, capped);
}

export function resolveConfig(input = {}) {
  const reconcileIntervalMs = resolveBoundedInt(input.reconcileIntervalMs, DEFAULT_RECONCILE_INTERVAL_MS, 1_000);
  const maxEligibleEvaluationAgeMs = resolveBoundedInt(
    input.maxEligibleEvaluationAgeMs,
    Math.min(DEFAULT_MAX_ELIGIBLE_EVALUATION_AGE_MS, 3 * reconcileIntervalMs),
    1_000,
  );
  const pendingExpiryMs = resolveBoundedInt(
    input.pendingExpiryMs ?? input.expiryMs,
    DEFAULT_PENDING_EXPIRY_MS,
    reconcileIntervalMs,
  );
  const claimStaleMs = resolveBoundedInt(
    input.claimStaleMs,
    Math.max(3 * reconcileIntervalMs, DEFAULT_CLAIM_STALE_MS),
    1000,
  );
  return {
    reconcileIntervalMs,
    maxEligibleEvaluationAgeMs: Math.min(maxEligibleEvaluationAgeMs, REPORT_STALE_BACKSTOP_MS - 1),
    pendingExpiryMs: Math.min(pendingExpiryMs, REPORT_STALE_BACKSTOP_MS),
    claimStaleMs,
    progressFreshnessMs: resolveProgressFreshnessMs(input),
  };
}

export function evaluateSnapshotCoherence({ openPrs, prNumber, headShaFirst, headShaSecond, versionMarkerFirst, versionMarkerSecond }) {
  if (versionMarkerFirst != null && versionMarkerSecond != null && String(versionMarkerFirst) !== String(versionMarkerSecond)) {
    return { skew: true, reason: 'version_marker_mismatch' };
  }
  const pr = toArray(openPrs).find((row) => Number(row?.number) === Number(prNumber));
  const currentHead = normalizeSha(pr?.headRefOid);
  const first = normalizeSha(headShaFirst);
  const second = normalizeSha(headShaSecond);
  if (first && second && first !== second) {
    return { skew: true, reason: 'head_sha_bracket_mismatch' };
  }
  if (currentHead && first && currentHead !== first) {
    return { skew: false, staleEpisode: true, currentHead };
  }
  return { skew: false, currentHead: currentHead || first || second };
}

export function resolveHeadScopedLatestReport(session, headSha, openPrs, prNumber) {
  const headCommittedAtMs = resolveHeadCommittedAtMs(openPrs, prNumber);
  const latest = findLatestReportForHead(session, headSha, { headCommittedAtMs });
  if (!latest) {
    return { ok: true, report: null, reportState: null, reportedAtMs: null };
  }
  if (
    !Object.prototype.hasOwnProperty.call(latest, 'reportState')
    && !Object.prototype.hasOwnProperty.call(latest, 'report_state')
  ) {
    return {
      ok: false,
      error: 'incompatible_worker_state_shape',
      code: 'missing_report_state_field',
      field: 'reportState',
    };
  }
  const reportedAtMs = getReportTimestampMs(latest);
  return {
    ok: true,
    report: latest,
    reportState: getReportState(latest) || null,
    reportedAtMs: reportedAtMs > 0 ? reportedAtMs : null,
  };
}

export function resolveHeadScopedReportState(session, headSha, openPrs, prNumber) {
  const scoped = resolveHeadScopedLatestReport(session, headSha, openPrs, prNumber);
  if (!scoped.ok) {
    return scoped;
  }
  return { ok: true, reportState: scoped.reportState };
}

export function evaluateProgressFreshness({ reportedAtMs, nowMs, config = resolveConfig() }) {
  const evaluationMs = Number(nowMs);
  const timestampMs = Number(reportedAtMs);
  const progressFreshnessMs = resolveProgressFreshnessMs(config);
  if (!Number.isFinite(evaluationMs) || evaluationMs <= 0) {
    return { ok: false, error: 'invalid_evaluation_time' };
  }
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return { ok: false, error: 'progress_freshness_evidence_unreadable' };
  }
  const ageMs = Math.max(0, evaluationMs - timestampMs);
  return {
    ok: true,
    fresh: ageMs <= progressFreshnessMs,
    ageMs,
    progressFreshnessMs,
    reportedAtMs: timestampMs,
    evaluationMs,
  };
}

export function resolveLivePrOwner({ workerState, episode }) {
  const validation = validateWorkerStateInput(workerState);
  if (!validation.ok) return { ok: false, ...validation };
  const ep = normalizeEpisodeKey(episode);
  const ownerId = resolveHeadOwningWorkerSessionId(workerState.sessions, ep.prNumber, ep.headSha, workerState.openPrs);
  if (!ownerId) {
    return { ok: true, ownerId: null, owner: null, live: false, reportState: null, targetGeneration: null };
  }
  const owner = findSessionByIdentifier(workerState.sessions, ownerId);
  const live = Boolean(owner && isSessionAlive(owner));
  let reportState = null;
  if (owner) {
    const scoped = resolveHeadScopedReportState(owner, ep.headSha, workerState.openPrs, ep.prNumber);
    if (!scoped.ok) {
      return { ok: false, ...scoped };
    }
    reportState = scoped.reportState;
  }
  const targetGeneration = owner ? deriveTargetGeneration(owner) : null;
  return { ok: true, ownerId, owner, live, reportState, targetGeneration };
}


/**
 * Class B cross-head stint bridge: fresh fixing_ci on an earlier explicit head after
 * one or more head advances before the worker reports on the newest head.
 *
 * @param {object} input
 */
export function findCrossHeadFixingCiBridge({
  owner,
  episode,
  openPrs,
  nowMs,
  config: inputConfig,
}) {
  const ep = normalizeEpisodeKey(episode);
  const currentHead = ep.headSha;
  const currentHeadCommittedAtMs = resolveHeadCommittedAtMs(openPrs, ep.prNumber);
  const currentScoped = resolveHeadScopedLatestReport(owner, currentHead, openPrs, ep.prNumber);
  if (!currentScoped.ok) {
    return { bridged: false, error: currentScoped.error, code: currentScoped.code, field: currentScoped.field };
  }
  if (currentScoped.reportState === 'fixing_ci') {
    return { bridged: false, reason: 'current_head_has_fixing_ci' };
  }
  if (currentScoped.report && currentScoped.reportState) {
    return { bridged: false, reason: 'current_head_catch_up_reported' };
  }

  const config = resolveConfig(inputConfig ?? {});
  const evaluationMs = Number(nowMs) || Date.now();
  /** @type {{ report: Record<string, unknown>, headSha: string, reportedAtMs: number, ageMs: number, progressFreshnessMs: number } | null} */
  let best = null;
  let bestMs = -1;

  for (const report of toArray(owner?.reports)) {
    if (getReportState(report) !== 'fixing_ci') {
      continue;
    }
    const priorHead = getStoredReportHeadSha(report);
    if (!priorHead || priorHead === currentHead) {
      continue;
    }
    const reportedAtMs = getReportTimestampMs(report);
    if (reportedAtMs <= 0) {
      continue;
    }
    if (Number.isFinite(currentHeadCommittedAtMs) && currentHeadCommittedAtMs > 0 && reportedAtMs > currentHeadCommittedAtMs) {
      continue;
    }
    const freshness = evaluateProgressFreshness({
      reportedAtMs,
      nowMs: evaluationMs,
      config,
    });
    if (!freshness.ok || !freshness.fresh) {
      continue;
    }
    if (reportedAtMs >= bestMs) {
      bestMs = reportedAtMs;
      best = {
        report,
        headSha: priorHead,
        reportedAtMs,
        ageMs: freshness.ageMs,
        progressFreshnessMs: freshness.progressFreshnessMs,
      };
    }
  }

  if (!best) {
    return { bridged: false, reason: 'no_qualifying_bridge' };
  }
  return {
    bridged: true,
    stintClass: 'B',
    bridgeHeadSha: best.headSha,
    reportedAtMs: best.reportedAtMs,
    ageMs: best.ageMs,
    progressFreshnessMs: best.progressFreshnessMs,
  };
}

function isOrchestratorTurnSurface(surface) {
  const normalized = String(surface ?? '').trim().toLowerCase();
  return normalized === 'orchestrator-turn' || normalized.includes('orchestrator-turn');
}

/**
 * @param {string} storeDir
 * @param {{ prNumber: number, headSha: string, targetId: string, targetGeneration: string }} match
 */
export function readPostStaleEscalationLock(storeDir, match) {
  const dir = path.join(String(storeDir ?? ''), 'episodes');
  if (!storeDir || !existsSync(dir)) {
    return { open: false };
  }
  const prNumber = Number(match?.prNumber ?? 0);
  const headSha = normalizeSha(match?.headSha);
  const targetId = String(match?.targetId ?? '').trim();
  const targetGeneration = String(match?.targetGeneration ?? targetId).trim();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.episode.json')) {
      continue;
    }
    const record = tryReadEpisodeFile(path.join(dir, name));
    if (!record || record.sendEscalationReason !== 'progress_stale') {
      continue;
    }
    const episode = record.episode ?? {};
    if (Number(episode.prNumber) !== prNumber) {
      continue;
    }
    if (normalizeSha(episode.headSha) !== headSha) {
      continue;
    }
    if (String(episode.targetId ?? '') !== targetId) {
      continue;
    }
    if (String(episode.targetGeneration ?? episode.targetId ?? '') !== targetGeneration) {
      continue;
    }
    if (record.staleEscalationCleared) {
      continue;
    }
    return {
      open: true,
      owner: record.staleEscalationOwner ?? 'reconcile',
      record,
      digest: record.digest ?? episodeKeyDigest(episode),
    };
  }
  return { open: false };
}

/**
 * Shared ci-failure suppression / stale-escalation predicate for reconcile and orchestrator-turn.
 *
 * @param {object} input
 */
export function evaluateCiFailureSuppressorDecision(input) {
  const episode = normalizeEpisodeKey(input?.episode);
  const surface = String(input?.surface ?? input?.source ?? 'unknown');
  const storeDir = input?.storeDir ?? null;
  const nowMs = Number(input?.nowMs) || Date.now();
  const config = resolveConfig(input?.config);
  const orchestratorTurn = isOrchestratorTurnSurface(surface);

  const auditBase = {
    surface,
    prNumber: episode.prNumber,
    headSha: episode.headSha,
    targetId: episode.targetId,
    targetGeneration: episode.targetGeneration,
  };

  const live = evaluateLiveWorkerSuppressor({
    episode,
    workerState: input?.workerState,
    headShaFirst: input?.headShaFirst,
    headShaSecond: input?.headShaSecond,
    versionMarkerFirst: input?.versionMarkerFirst,
    versionMarkerSecond: input?.versionMarkerSecond,
    nowMs,
    config,
  });

  if (live.status === 'snapshot_skew' || live.status === 'input_error' || live.status === 'progress_freshness_unreadable') {
    return {
      decision: 'SUPPRESS',
      reason: live.reason ?? live.error_kind ?? 'degraded_fail_closed',
      failClosed: true,
      live,
      audit: {
        ...auditBase,
        suppressReason: live.reason ?? live.error_kind ?? 'degraded_fail_closed',
        stintClass: 'C',
        postStaleLock: false,
      },
    };
  }

  if (orchestratorTurn && storeDir) {
    const lock = readPostStaleEscalationLock(storeDir, episode);
    if (lock.open) {
      if (live.status === 'matched') {
        clearPostStaleEscalationLock(storeDir, lock);
      } else {
        return {
          decision: 'SUPPRESS',
          reason: 'post_stale_escalation_lock',
          stintClass: 'C',
          postStaleLock: true,
          live,
          audit: {
            ...auditBase,
            postStaleLock: true,
            staleEscalationOwner: lock.owner,
            suppressReason: 'post_stale_escalation_lock',
          },
        };
      }
    }
  }

  if (live.status === 'matched') {
    return {
      decision: 'SUPPRESS',
      reason: 'suppressed-live-worker',
      stintClass: live.stintClass ?? 'A',
      live,
      audit: {
        ...auditBase,
        suppressReason: 'suppressed-live-worker',
        stintClass: live.stintClass ?? 'A',
        bridgeHeadSha: live.bridgeHeadSha ?? null,
        postStaleLock: false,
        reportedAtMs: live.reportedAtMs ?? null,
        progressFreshnessMs: live.progressFreshnessMs ?? null,
        ageMs: live.ageMs ?? null,
      },
    };
  }

  if (live.status === 'progress_stale') {
    if (orchestratorTurn) {
      return {
        decision: 'SUPPRESS',
        reason: 'progress_stale_reconcile_owned',
        stintClass: 'A',
        live,
        audit: {
          ...auditBase,
          suppressReason: 'progress_stale_reconcile_owned',
          stintClass: 'A',
          postStaleLock: false,
        },
      };
    }
    armPostStaleEscalationLock(storeDir, episode, input?.staleEscalationOwner ?? 'reconcile');
    return {
      decision: 'SEND',
      reason: 'progress_stale',
      stintClass: 'A',
      live,
      audit: {
        ...auditBase,
        auditReason: 'progress_stale',
        stintClass: 'A',
        postStaleLock: true,
      },
    };
  }

  if (live.status === 'superseded' || live.status === 'no_live_owner') {
    const reason = live.reason ?? (live.status === 'no_live_owner' ? 'abandoned-no-live-owner' : 'abandoned-superseded');
    return {
      decision: 'SUPPRESS',
      reason,
      stintClass: 'C',
      live,
      audit: {
        ...auditBase,
        suppressReason: reason,
        stintClass: 'C',
        postStaleLock: false,
        currentHead: live.currentHead ?? null,
        currentTargetId: live.currentTargetId ?? null,
        currentTargetGeneration: live.currentTargetGeneration ?? null,
      },
    };
  }

  if (live.status === 'not_suppressing') {
    return {
      decision: 'SEND',
      reason: 'no_suppressor',
      stintClass: live.stintClass ?? 'C',
      live,
      audit: {
        ...auditBase,
        suppressReason: 'no_suppressor',
        stintClass: live.stintClass ?? 'C',
        postStaleLock: false,
      },
    };
  }

  return {
    decision: 'SUPPRESS',
    reason: live.reason ?? 'degraded_fail_closed',
    failClosed: true,
    live,
    audit: {
      ...auditBase,
      suppressReason: live.reason ?? 'degraded_fail_closed',
      stintClass: 'C',
      postStaleLock: false,
    },
  };
}

export function armPostStaleEscalationLock(storeDir, episode, owner = 'reconcile') {
  if (!storeDir) {
    return { armed: false, reason: 'missing_store_dir' };
  }
  const ep = normalizeEpisodeKey(episode);
  const record = readEpisodeRecord(storeDir, ep);
  if (!record) {
    return { armed: false, reason: 'missing_record' };
  }
  const updated = {
    ...record,
    sendEscalationReason: 'progress_stale',
    staleEscalationOwner: owner,
    staleEscalationArmedAtMs: Number(record.staleEscalationArmedAtMs ?? Date.now()),
    staleEscalationCleared: false,
  };
  writeEpisodeRecord(storeDir, updated);
  return { armed: true, record: updated };
}

export function clearPostStaleEscalationLock(storeDir, lock) {
  if (!storeDir || !lock?.record) {
    return { cleared: false };
  }
  const record = lock.record;
  const updated = {
    ...record,
    staleEscalationCleared: true,
    staleEscalationClearedAtMs: Date.now(),
  };
  writeEpisodeRecord(storeDir, updated);
  return { cleared: true, record: updated };
}

export function evaluateLiveWorkerSuppressor({
  episode,
  workerState,
  headShaFirst,
  headShaSecond,
  versionMarkerFirst,
  versionMarkerSecond,
  nowMs,
  config: inputConfig,
}) {
  const validation = validateWorkerStateInput(workerState);
  if (!validation.ok) {
    return { status: 'input_error', error_kind: validation.error, code: validation.code, field: validation.field };
  }
  const ep = normalizeEpisodeKey(episode);
  const coherence = evaluateSnapshotCoherence({
    openPrs: workerState.openPrs,
    prNumber: ep.prNumber,
    headShaFirst: headShaFirst ?? ep.headSha,
    headShaSecond: headShaSecond ?? ep.headSha,
    versionMarkerFirst,
    versionMarkerSecond,
  });
  if (coherence.skew) {
    return { status: 'snapshot_skew', reason: coherence.reason };
  }
  if (coherence.staleEpisode) {
    return { status: 'superseded', reason: 'abandoned-superseded', currentHead: coherence.currentHead };
  }
  const ownerResolution = resolveLivePrOwner({ workerState, episode: ep });
  if (!ownerResolution.ok) {
    return {
      status: 'input_error',
      error_kind: ownerResolution.error,
      code: ownerResolution.code,
      field: ownerResolution.field,
    };
  }
  if (!ownerResolution.live || !ownerResolution.owner) {
    return { status: 'no_live_owner', reason: 'abandoned-no-live-owner' };
  }
  const currentGen = ownerResolution.targetGeneration ?? ownerResolution.ownerId;
  if (ownerResolution.ownerId !== ep.targetId || currentGen !== ep.targetGeneration) {
    return {
      status: 'superseded',
      reason: 'abandoned-superseded',
      currentTargetId: ownerResolution.ownerId,
      currentTargetGeneration: currentGen,
    };
  }
  if (ownerResolution.reportState === 'fixing_ci') {
    const config = resolveConfig(inputConfig ?? {});
    const scoped = resolveHeadScopedLatestReport(
      ownerResolution.owner,
      ep.headSha,
      workerState.openPrs,
      ep.prNumber,
    );
    if (!scoped.ok) {
      return {
        status: 'input_error',
        error_kind: scoped.error,
        code: scoped.code,
        field: scoped.field,
      };
    }
    const freshness = evaluateProgressFreshness({
      reportedAtMs: scoped.reportedAtMs,
      nowMs: Number(nowMs) || Date.now(),
      config,
    });
    if (!freshness.ok) {
      return {
        status: 'progress_freshness_unreadable',
        reason: freshness.error,
        ownerId: ownerResolution.ownerId,
        reportState: ownerResolution.reportState,
      };
    }
    if (freshness.fresh) {
      return {
        status: 'matched',
        reason: 'suppressed-live-worker',
        stintClass: 'A',
        ownerId: ownerResolution.ownerId,
        reportState: ownerResolution.reportState,
        reportedAtMs: freshness.reportedAtMs,
        progressFreshnessMs: freshness.progressFreshnessMs,
        ageMs: freshness.ageMs,
      };
    }
    return {
      status: 'progress_stale',
      reason: 'progress_stale',
      stintClass: 'A',
      ownerId: ownerResolution.ownerId,
      reportState: ownerResolution.reportState,
      reportedAtMs: freshness.reportedAtMs,
      progressFreshnessMs: freshness.progressFreshnessMs,
      ageMs: freshness.ageMs,
      targetId: ep.targetId,
      targetGeneration: ep.targetGeneration,
      headSha: ep.headSha,
      prNumber: ep.prNumber,
    };
  }

  const bridge = findCrossHeadFixingCiBridge({
    owner: ownerResolution.owner,
    episode: ep,
    openPrs: workerState.openPrs,
    nowMs,
    config: resolveConfig(inputConfig ?? {}),
  });
  if (bridge.error) {
    return {
      status: 'input_error',
      error_kind: bridge.error,
      code: bridge.code,
      field: bridge.field,
    };
  }
  if (bridge.bridged) {
    return {
      status: 'matched',
      reason: 'suppressed-live-worker',
      stintClass: 'B',
      bridgeHeadSha: bridge.bridgeHeadSha,
      ownerId: ownerResolution.ownerId,
      reportState: 'fixing_ci',
      reportedAtMs: bridge.reportedAtMs,
      progressFreshnessMs: bridge.progressFreshnessMs,
      ageMs: bridge.ageMs,
    };
  }

  return {
    status: 'not_suppressing',
    stintClass: 'C',
    ownerId: ownerResolution.ownerId,
    reportState: ownerResolution.reportState,
  };
}


function reactionEventAction(event) {
  return String(
    field(event, ['data.action', 'action', 'metadata.action', 'details.action', 'payload.action', 'data.reaction.action'])
    ?? '',
  ).trim();
}

function isCiFailedWorkerDeliveryEvent(event) {
  const type = String(field(event, ['type', 'kind', 'event', 'name']) ?? '');
  const reactionKey = String(field(event, ['reactionKey', 'reaction.key', 'metadata.reactionKey', 'details.reactionKey', 'payload.reactionKey', 'data.reactionKey', 'data.reaction.key']) ?? '');
  if (type !== 'reaction.action_succeeded' || reactionKey !== 'ci-failed') {
    return false;
  }
  return reactionEventAction(event) === 'send-to-agent';
}

export function bindReactionEvent(episode, events = [], { excludeDigest = null } = {}) {
  let sawCandidate = false;
  let sawUnbindable = false;
  for (const event of events ?? []) {
    if (!isCiFailedWorkerDeliveryEvent(event)) continue;
    sawCandidate = true;
    const ep = eventEpisode(event);
    try {
      normalizeEpisodeKey(ep);
    } catch {
      sawUnbindable = true;
      continue;
    }
    if (excludeDigest && episodeKeyDigest(ep) === excludeDigest) continue;
    if (sameEpisode(episode, ep)) {
      return { status: 'matched', eventId: String(field(event, ['id', 'eventId']) ?? ''), event };
    }
  }
  return { status: sawUnbindable ? 'unbindable' : (sawCandidate ? 'no-match' : 'absent'), eventId: null };
}

export function exactIntentTokenLookup(episode, tokens = [], { excludeDigest = null } = {}) {
  const key = episodeKeyString(episode);
  const digest = episodeKeyDigest(episode);
  for (const token of tokens ?? []) {
    const tokenEpisode = token.episode ?? token;
    const tokenDigest = token.digest ?? (tokenEpisode ? episodeKeyDigest(tokenEpisode) : null);
    if (excludeDigest && tokenDigest === excludeDigest) continue;
    if (sameEpisode(episode, tokenEpisode)) {
      return { status: token.status === 'failed-owned' ? 'failed-owned' : 'present', tokenId: token.id ?? token.tokenId ?? digest };
    }
    if (token.key && String(token.key) === key) {
      return { status: token.status === 'failed-owned' ? 'failed-owned' : 'present', tokenId: token.id ?? token.tokenId ?? digest };
    }
  }
  return { status: 'absent', tokenId: null };
}

export function deriveEpisodeFromCiSource({ repo, prNumber, headSha, activeTarget, ciSource }) {
  if (!ciSource || String(ciSource.aggregateStatus) !== 'red') return null;
  const redPeriod = String(ciSource.aggregateRunId ?? ciSource.checkSuiteId ?? ciSource.workflowRunId ?? '').trim();
  if (!redPeriod) throw new Error('canonical CI source missing aggregate red-period id');
  return normalizeEpisodeKey({
    repo,
    prNumber,
    headSha,
    redPeriod,
    targetId: activeTarget?.targetId,
    targetGeneration: activeTarget?.targetGeneration ?? activeTarget?.targetId,
  });
}

export function buildCiSourceFromRequiredChecks(checks = [], options = {}) {
  const level = classifyRequiredCiLevel(checks, options);
  if (level === 'green') {
    return { aggregateStatus: 'green', source: 'gh-required-checks' };
  }
  if (level === 'pending') {
    return { aggregateStatus: 'pending', source: 'gh-required-checks' };
  }
  const branchRequired = toArray(options.requiredCheckNames)
    .map((name) => String(name ?? '').trim().toLowerCase())
    .filter(Boolean);
  const scope = branchRequired.length > 0
    ? toArray(checks).filter((check) => branchRequired.includes(String(check?.name ?? '').trim().toLowerCase()))
    : toArray(checks);
  const failedCheckNames = scope
    .filter((check) => isTrackedRedFailingCheck(check))
    .map((check) => String(check?.name ?? 'check').trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return {
    aggregateStatus: 'red',
    failedCheckNames,
    source: 'gh-required-checks',
  };
}

function isTrackedRedFailingCheck(check) {
  const state = normalizeCiState(check?.state ?? check?.conclusion ?? check?.status);
  return isCiCheckFailure(check) || state === 'fail';
}

function buildRedCheckRunSignature(check) {
  return [
    String(check?.startedAt ?? check?.completedAt ?? '').trim(),
    String(check?.link ?? '').trim(),
    String(check?.workflow ?? '').trim(),
  ].join('|');
}

function redFailingCheckScope(checks = [], options = {}) {
  const branchRequired = toArray(options.requiredCheckNames)
    .map((name) => String(name ?? '').trim().toLowerCase())
    .filter(Boolean);
  return branchRequired.length > 0
    ? toArray(checks).filter((check) => branchRequired.includes(String(check?.name ?? '').trim().toLowerCase()))
    : toArray(checks);
}

export function buildRedFailureFingerprint(checks = [], options = {}) {
  const level = classifyRequiredCiLevel(checks, options);
  if (level !== 'red') return null;
  const parts = redFailingCheckScope(checks, options)
    .filter((check) => isTrackedRedFailingCheck(check))
    .map((check) => [
      String(check?.name ?? '').trim().toLowerCase(),
      buildRedCheckRunSignature(check),
    ].join('|'))
    .sort();
  if (parts.length === 0) return null;
  return createHash('sha256').update(parts.join(';')).digest('hex').slice(0, 16);
}

/** @returns {Record<string, string>} */
export function buildRedFailingRunMap(checks = [], options = {}) {
  const level = classifyRequiredCiLevel(checks, options);
  if (level !== 'red') return {};
  /** @type {Record<string, string>} */
  const runs = {};
  for (const check of redFailingCheckScope(checks, options)) {
    if (!isTrackedRedFailingCheck(check)) {
      continue;
    }
    const name = String(check?.name ?? '').trim().toLowerCase();
    if (!name) continue;
    runs[name] = buildRedCheckRunSignature(check);
  }
  return runs;
}

function hasTerminalEpisodeForRedStint(storeDir, repo, prNumber, headSha, stintId) {
  const redPeriod = `head-red:${headSha}:stint-${stintId}`;
  const dir = path.join(String(storeDir ?? ''), 'episodes');
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.episode.json')) continue;
    const record = tryReadEpisodeFile(path.join(dir, name));
    if (!record?.terminalReason) continue;
    const ep = record.episode;
    if (!ep) continue;
    if (String(ep.repo ?? '') !== String(repo ?? '')) continue;
    if (Number(ep.prNumber) !== Number(prNumber)) continue;
    if (normalizeSha(ep.headSha ?? '') !== normalizeSha(headSha ?? '')) continue;
    if (String(ep.redPeriod ?? '') !== redPeriod) continue;
    return true;
  }
  return false;
}


function readRedStintTracker(trackerPath) {
  /** @type {{ lastLevel?: string | null, stintId?: number, lastRedRuns?: Record<string, string> }} */
  let tracker = { lastLevel: null, stintId: 0, lastRedRuns: {} };
  if (!existsSync(trackerPath)) return tracker;
  try {
    const parsed = JSON.parse(readFileSync(trackerPath, 'utf8'));
    tracker = {
      lastLevel: parsed?.lastLevel ?? null,
      stintId: Number(parsed?.stintId ?? 0),
      lastRedRuns: parsed?.lastRedRuns && typeof parsed.lastRedRuns === 'object' ? parsed.lastRedRuns : {},
    };
  } catch {
    tracker = { lastLevel: null, stintId: 0, lastRedRuns: {} };
  }
  return tracker;
}

function updateRedStintTracker(trackerPath, updater) {
  const result = withDedupStateFileLock(trackerPath, () => {
    const current = readRedStintTracker(trackerPath);
    const next = updater(current);
    writeJsonAtomic(trackerPath, next);
    return next;
  }, { maxWaitMs: 1_000 });
  if (
    result
    && typeof result === 'object'
    && 'ok' in result
    && /** @type {{ ok?: boolean, reason?: string }} */ (result).ok === false
    && /** @type {{ ok?: boolean, reason?: string }} */ (result).reason === 'dedup_lock_timeout'
  ) {
    throw new Error(`failed to acquire red-stint tracker lock for ${trackerPath}`);
  }
  return result;
}

export function resolveRedPeriodAggregateId(input) {
  const storeDir = String(input?.storeDir ?? '').trim();
  const repo = String(input?.repo ?? '').trim();
  const prNumber = Number(input?.prNumber);
  const headSha = normalizeSha(input?.headSha ?? '');
  const aggregateStatus = String(input?.aggregateStatus ?? 'red').trim();
  if (!headSha) {
    throw new Error('resolveRedPeriodAggregateId requires headSha');
  }
  if (!storeDir) {
    return `head-red:${headSha}:stint-1`;
  }
  ensureStore(storeDir);
  const trackerKey = createHash('sha256').update(`${repo}#${prNumber}#${headSha}`).digest('hex');
  const trackerPath = path.join(storeDir, 'red-stints', `${trackerKey}.json`);
  const tracker = updateRedStintTracker(trackerPath, (current) => {
  /** @type {{ lastLevel?: string | null, stintId?: number, lastRedRuns?: Record<string, string> }} */
    const next = {
      lastLevel: current.lastLevel ?? null,
      stintId: Number(current.stintId ?? 0),
      lastRedRuns: current.lastRedRuns && typeof current.lastRedRuns === 'object' ? { ...current.lastRedRuns } : {},
    };
    if (aggregateStatus === 'red') {
      const currentRuns = input?.redFailingRuns && typeof input.redFailingRuns === 'object'
        ? input.redFailingRuns
        : {};
      const priorRuns = next.lastRedRuns ?? {};
      let stintAdvanced = next.lastLevel !== 'red';
      if (!stintAdvanced) {
        const activeStintId = Number(next.stintId ?? 0);
        if (activeStintId > 0 && hasTerminalEpisodeForRedStint(storeDir, repo, prNumber, headSha, activeStintId)) {
          for (const [name, signature] of Object.entries(priorRuns)) {
            if (Object.prototype.hasOwnProperty.call(currentRuns, name) && currentRuns[name] !== signature) {
              stintAdvanced = true;
              break;
            }
          }
        }
      }
      if (stintAdvanced) {
        next.stintId = Number(next.stintId ?? 0) + 1;
      }
      next.lastLevel = 'red';
      next.lastRedRuns = { ...priorRuns, ...currentRuns };
      return next;
    }
    next.lastLevel = aggregateStatus;
    if (aggregateStatus !== 'red') {
      next.lastRedRuns = {};
    }
    return next;
  });
  if (aggregateStatus !== 'red') {
    return null;
  }
  return `head-red:${headSha}:stint-${tracker.stintId}`;
}

export function listIntentTokensFromStore(storeDir) {
  const dir = path.join(String(storeDir ?? ''), 'tokens');
  if (!existsSync(dir)) return [];
  const tokens = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const token = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      tokens.push(token);
    } catch {
      // ignore corrupt token files
    }
  }
  return tokens;
}

export function syncRedPeriodTrackersForOpenPrs(input) {
  const repo = String(input?.repo ?? '').trim();
  const openPrs = toArray(input?.openPrs);
  const checksMap = normalizeCiChecksByPr(input?.ciChecksByPr);
  const requiredNamesMap = normalizeRequiredCheckNamesByPr(input?.requiredCheckNamesByPr);
  const lookupFailedMap = normalizeRequiredCheckLookupFailedByPr(input?.requiredCheckLookupFailedByPr);
  /** @type {Array<{ prNumber: number, headSha: string, aggregateStatus: string, aggregateRunId: string | null }>} */
  const snapshots = [];
  for (const pr of openPrs) {
    const prNumber = Number(pr?.number);
    const headSha = normalizeSha(pr?.headRefOid);
    if (!repo || !prNumber || !headSha) continue;
    const checks = checksMap.get(prNumber) ?? [];
    const requiredCheckNames = requiredNamesMap.get(prNumber) ?? [];
    const requiredCheckLookupFailed = lookupFailedMap.get(prNumber) ?? false;
    const ciSource = buildCiSourceFromRequiredChecks(checks, { requiredCheckNames, requiredCheckLookupFailed, headSha });
    const aggregateStatus = String(ciSource.aggregateStatus ?? 'green');
    let aggregateRunId = null;
    if (aggregateStatus === 'red') {
      const redFailingRuns = buildRedFailingRunMap(checks, {
        requiredCheckNames,
        requiredCheckLookupFailed,
        headSha,
      });
      aggregateRunId = resolveRedPeriodAggregateId({
        storeDir: input?.storeDir,
        repo,
        prNumber,
        headSha,
        aggregateStatus: 'red',
        redFailingRuns,
      });
    } else {
      resolveRedPeriodAggregateId({
        storeDir: input?.storeDir,
        repo,
        prNumber,
        headSha,
        aggregateStatus,
      });
    }
    snapshots.push({ prNumber, headSha, aggregateStatus, aggregateRunId });
  }
  return { snapshots };
}

export function planCiFailureReactionRecords(input) {
  const repo = String(input?.repo ?? '').trim();
  const openPrs = toArray(input?.openPrs);
  const sessions = toArray(input?.sessions);
  const checksMap = normalizeCiChecksByPr(input?.ciChecksByPr);
  const requiredNamesMap = normalizeRequiredCheckNamesByPr(input?.requiredCheckNamesByPr);
  const lookupFailedMap = normalizeRequiredCheckLookupFailedByPr(input?.requiredCheckLookupFailedByPr);
  syncRedPeriodTrackersForOpenPrs(input);
  /** @type {Array<{ episode: ReturnType<typeof normalizeEpisodeKey>, ciSource: Record<string, unknown> }>} */
  const records = [];
  for (const pr of openPrs) {
    const prNumber = Number(pr?.number);
    const headSha = normalizeSha(pr?.headRefOid);
    if (!repo || !prNumber || !headSha) continue;
    const checks = checksMap.get(prNumber) ?? [];
    const requiredCheckNames = requiredNamesMap.get(prNumber) ?? [];
    const requiredCheckLookupFailed = lookupFailedMap.get(prNumber) ?? false;
    const ciSource = buildCiSourceFromRequiredChecks(checks, { requiredCheckNames, requiredCheckLookupFailed, headSha });
    if (String(ciSource.aggregateStatus) !== 'red') {
      continue;
    }
    const redFailingRuns = buildRedFailingRunMap(checks, {
      requiredCheckNames,
      requiredCheckLookupFailed,
      headSha,
    });
    const aggregateRunId = resolveRedPeriodAggregateId({
      storeDir: input?.storeDir,
      repo,
      prNumber,
      headSha,
      aggregateStatus: 'red',
      redFailingRuns,
    });
    const enrichedCiSource = { ...ciSource, aggregateRunId };
    const targetId = resolveHeadOwningWorkerSessionId(sessions, prNumber, headSha, openPrs);
    if (!targetId) continue;
    const owner = findSessionByIdentifier(sessions, targetId);
    const activeTarget = {
      targetId,
      targetGeneration: owner ? deriveTargetGeneration(owner) : targetId,
    };
    const episode = deriveEpisodeFromCiSource({ repo, prNumber, headSha, activeTarget, ciSource: enrichedCiSource });
    if (!episode) continue;
    records.push({ episode, ciSource });
  }
  return { records };
}

export function preSendCiRedRecheck(episode, fresh) {
  const ep = normalizeEpisodeKey(episode);
  const pr = toArray(fresh?.openPrs).find((row) => Number(row?.number) === ep.prNumber);
  const currentHead = normalizeSha(pr?.headRefOid);
  if (!currentHead || currentHead !== ep.headSha) {
    return { ok: false, reason: 'head_rotated_or_pr_closed' };
  }
  const checksMap = normalizeCiChecksByPr(fresh?.ciChecksByPr);
  const requiredNamesMap = normalizeRequiredCheckNamesByPr(fresh?.requiredCheckNamesByPr);
  const lookupFailedMap = normalizeRequiredCheckLookupFailedByPr(fresh?.requiredCheckLookupFailedByPr);
  const checks = checksMap.get(ep.prNumber) ?? [];
  const requiredCheckNames = requiredNamesMap.get(ep.prNumber) ?? [];
  const requiredCheckLookupFailed = lookupFailedMap.get(ep.prNumber) ?? false;
  const ciLevel = classifyRequiredCiLevel(checks, { requiredCheckNames, requiredCheckLookupFailed });
  if (ciLevel !== 'red') {
    return { ok: false, reason: `ci_not_red:${ciLevel}` };
  }
  const workerState = {
    sessions: toArray(fresh?.sessions),
    openPrs: toArray(fresh?.openPrs),
  };
  const ownerResolution = resolveLivePrOwner({ workerState, episode: ep });
  if (!ownerResolution.ok) {
    return { ok: false, reason: ownerResolution.error ?? 'incompatible_worker_state_shape' };
  }
  if (!ownerResolution.live || !ownerResolution.owner) {
    return { ok: false, reason: 'abandoned-no-live-owner' };
  }
  const currentGen = ownerResolution.targetGeneration ?? ownerResolution.ownerId;
  if (ownerResolution.ownerId !== ep.targetId || currentGen !== ep.targetGeneration) {
    return { ok: false, reason: 'abandoned-superseded' };
  }
  return { ok: true, reason: 'ci_still_red' };
}

export function buildDiagnosticAudit({ episode, errorKind, detail = null, nowUtc = new Date().toISOString() }) {
  const normalized = normalizeEpisodeKey(episode);
  return {
    schema: 'ci-failure-notification.audit.v1',
    phase: 'diagnostic',
    episode_key: normalized,
    episode_key_digest: episodeKeyDigest(normalized),
    diagnostic: { error_kind: errorKind, detail },
    emitted_at_utc: nowUtc,
  };
}

export function mapReasonToTerminalAction(reason) {
  if (reason === 'sent' || reason === 'delivery-failed' || reason === 'no_suppressor' || reason === 'progress_stale') {
    return 'SEND';
  }
  return 'SUPPRESS';
}

export function mapTerminalReasonToAuditReason(reason) {
  if (reason === 'reaction_ci_failed_sent_to_active_target') return 'suppressed-dedup';
  if (reason === 'orchestrator_intent_token_present' || reason === 'intent_failed_owned_escalated') return 'suppressed-intent-token';
  if (reason === 'worker_fixing_ci_for_episode') return 'suppressed-live-worker';
  return reason;
}

export function evaluateEpisodeTerminal(input) {
  const episode = normalizeEpisodeKey(input?.episode);
  const digest = episodeKeyDigest(episode);
  const excludeDigest = input?.excludeOwnDigest ?? null;
  const readSource = input?.readSource ?? 'initial_eligible_snapshot';
  const config = resolveConfig(input?.config);

  if (input?.existingTerminal?.terminalReason) {
    return {
      terminal: true,
      immutable: true,
      terminal_action: input.existingTerminal.terminalAction ?? mapReasonToTerminalAction(input.existingTerminal.terminalReason),
      reason: input.existingTerminal.terminalReason,
      episode_key: episode,
      episode_key_digest: digest,
      read_source: 'existing_terminal',
      audit: buildTerminalAudit({
        episode,
        terminal_action: input.existingTerminal.terminalAction ?? mapReasonToTerminalAction(input.existingTerminal.terminalReason),
        reason: mapTerminalReasonToAuditReason(input.existingTerminal.terminalReason),
        diagnostics: input.existingTerminal.diagnostics ?? {},
        readSource: 'existing_terminal',
      }),
    };
  }

  const workerValidation = validateWorkerStateInput(input?.workerState);
  if (!workerValidation.ok) {
    return {
      hard_failure: true,
      reevaluable: true,
      episode_key: episode,
      episode_key_digest: digest,
      diagnostic: { error_kind: workerValidation.error, code: workerValidation.code, field: workerValidation.field },
      audit: buildDiagnosticAudit({ episode, errorKind: workerValidation.error }),
    };
  }

  const live = evaluateLiveWorkerSuppressor({
    episode,
    workerState: input.workerState,
    headShaFirst: input?.headShaFirst,
    headShaSecond: input?.headShaSecond,
    versionMarkerFirst: input?.versionMarkerFirst,
    versionMarkerSecond: input?.versionMarkerSecond,
    nowMs: input?.nowMs,
    config,
  });

  if (live.status === 'snapshot_skew') {
    return {
      hard_failure: true,
      reevaluable: true,
      episode_key: episode,
      episode_key_digest: digest,
      diagnostic: { error_kind: 'snapshot_skew', reason: live.reason },
      audit: buildDiagnosticAudit({ episode, errorKind: 'snapshot_skew', detail: live.reason }),
    };
  }

  if (live.status === 'input_error') {
    return {
      hard_failure: true,
      reevaluable: true,
      episode_key: episode,
      episode_key_digest: digest,
      diagnostic: {
        error_kind: live.error_kind,
        code: live.code,
        field: live.field,
      },
      audit: buildDiagnosticAudit({
        episode,
        errorKind: live.error_kind,
        detail: live.field ?? live.code ?? null,
      }),
    };
  }

  if (live.status === 'progress_freshness_unreadable') {
    return {
      hard_failure: true,
      reevaluable: true,
      episode_key: episode,
      episode_key_digest: digest,
      diagnostic: {
        error_kind: 'progress_freshness_evidence_unreadable',
        reason: live.reason,
        owner_id: live.ownerId ?? null,
        report_state: live.reportState ?? null,
      },
      audit: buildDiagnosticAudit({
        episode,
        errorKind: 'progress_freshness_evidence_unreadable',
        detail: live.reason ?? null,
      }),
    };
  }

  const diagnostics = {
    reaction_bind_status: 'absent',
    live_worker_bind_status: live.status,
    self_fix_bind_status: 'absent',
    error_kind: null,
    ci_source_status: input?.ciSourceEquivalence?.disagreement ? 'disagreement' : 'ok',
    read_source: readSource,
  };

  if (input?.helperError) {
    return finalizeTerminal({
      episode,
      terminal_action: 'SUPPRESS',
      reason: 'helper_error_safe_suppress',
      diagnostics: { ...diagnostics, error_kind: 'helper_error' },
      readSource,
    });
  }

  if (input?.ciSourceEquivalence?.disagreement) {
    return finalizeTerminal({
      episode,
      terminal_action: 'SUPPRESS',
      reason: 'ci_source_disagreement_safe_suppress',
      diagnostics: { ...diagnostics, error_kind: 'ci_source_disagreement' },
      readSource,
    });
  }

  if (live.status === 'superseded') {
    return finalizeTerminal({
      episode,
      terminal_action: 'SUPPRESS',
      reason: live.reason,
      diagnostics,
      readSource,
    });
  }

  const reaction = bindReactionEvent(episode, input?.reactionEvents ?? []);
  diagnostics.reaction_bind_status = reaction.status;
  const token = exactIntentTokenLookup(episode, input?.intentTokens ?? [], { excludeDigest: excludeDigest });

  if (reaction.status === 'matched') {
    return finalizeTerminal({
      episode,
      terminal_action: 'SUPPRESS',
      reason: 'reaction_ci_failed_sent_to_active_target',
      diagnostics,
      boundReactionEventId: reaction.eventId,
      intentTokenState: token.status,
      intentTokenId: token.tokenId,
      readSource,
    });
  }

  if (token.status === 'present' || token.status === 'failed-owned') {
    return finalizeTerminal({
      episode,
      terminal_action: 'SUPPRESS',
      reason: token.status === 'failed-owned' ? 'intent_failed_owned_escalated' : 'orchestrator_intent_token_present',
      diagnostics,
      intentTokenState: token.status,
      intentTokenId: token.tokenId,
      readSource,
    });
  }

  if (live.status === 'matched') {
    return finalizeTerminal({
      episode,
      terminal_action: 'SUPPRESS',
      reason: 'suppressed-live-worker',
      diagnostics: {
        ...diagnostics,
        progress_freshness: {
          reportedAtMs: live.reportedAtMs,
          progressFreshnessMs: live.progressFreshnessMs,
          ageMs: live.ageMs,
        },
      },
      readSource,
    });
  }

  if (live.status === 'progress_stale') {
    return finalizeTerminal({
      episode,
      terminal_action: 'SEND',
      reason: 'progress_stale',
      diagnostics: {
        ...diagnostics,
        progress_stale: {
          prNumber: live.prNumber ?? episode.prNumber,
          headSha: live.headSha ?? episode.headSha,
          targetId: live.targetId ?? episode.targetId,
          targetGeneration: live.targetGeneration ?? episode.targetGeneration,
          latestReportTimestampMs: live.reportedAtMs,
          latestReportTimestampUtc: live.reportedAtMs ? new Date(live.reportedAtMs).toISOString() : null,
          progressFreshnessMs: live.progressFreshnessMs,
          ageMs: live.ageMs,
        },
      },
      readSource,
    });
  }

  if (live.status === 'no_live_owner') {
    return finalizeTerminal({
      episode,
      terminal_action: 'SUPPRESS',
      reason: 'abandoned-no-live-owner',
      diagnostics,
      readSource,
    });
  }

  return finalizeTerminal({
    episode,
    terminal_action: 'SEND',
    reason: 'no_suppressor',
    diagnostics,
    readSource,
  });
}

function finalizeTerminal({ episode, terminal_action, reason, diagnostics, boundReactionEventId = null, intentTokenState = 'absent', intentTokenId = null, readSource = 'initial_eligible_snapshot' }) {
  assertTerminalAction(terminal_action);
  const auditReason = mapTerminalReasonToAuditReason(reason);
  return {
    terminal: true,
    terminal_action,
    reason: auditReason,
    legacy_reason: reason,
    episode_key: normalizeEpisodeKey(episode),
    episode_key_digest: episodeKeyDigest(episode),
    diagnostics,
    bound_reaction_event_id: boundReactionEventId,
    intent_token_state: intentTokenState,
    intent_token_id: intentTokenId,
    read_source: readSource,
    audit: buildTerminalAudit({
      episode,
      terminal_action,
      reason: auditReason,
      diagnostics,
      boundReactionEventId,
      intentTokenState,
      intentTokenId,
      readSource,
    }),
  };
}

export function decideCiFailureNotification(input) {
  const result = evaluateEpisodeTerminal({ ...input, readSource: input?.readSource ?? 'initial_eligible_snapshot' });
  if (result.hard_failure) {
    return {
      hard_failure: true,
      reevaluable: true,
      diagnostic: result.diagnostic,
      audit: result.audit,
    };
  }
  return {
    terminal_action: result.terminal_action,
    reason: result.legacy_reason ?? result.reason,
    episode_key: result.episode_key,
    episode_key_digest: result.episode_key_digest,
    diagnostics: result.diagnostics,
    bound_reaction_event_id: result.bound_reaction_event_id,
    intent_token_state: result.intent_token_state,
    intent_token_id: result.intent_token_id,
    read_source: result.read_source,
    audit: result.audit,
  };
}

export function buildTerminalAudit({ episode, terminal_action, reason, diagnostics, boundReactionEventId = null, intentTokenState = 'absent', intentTokenId = null, readSource = 'initial_eligible_snapshot', nowUtc = new Date().toISOString() }) {
  return buildAuditLine({
    episode,
    terminal_action,
    reason,
    diagnostics,
    boundReactionEventId,
    intentTokenState,
    intentTokenId,
    phase: 'terminal',
    readSource,
    nowUtc,
  });
}

export function buildAuditLine({ episode, terminal_action, reason, diagnostics, boundReactionEventId = null, intentTokenState = 'absent', intentTokenId = null, phase = 'terminal', readSource = null, nowUtc = new Date().toISOString() }) {
  if (terminal_action) assertTerminalAction(terminal_action);
  const normalized = normalizeEpisodeKey(episode);
  return {
    schema: 'ci-failure-notification.audit.v1',
    phase,
    episode_key: normalized,
    episode_key_digest: episodeKeyDigest(normalized),
    terminal_action: terminal_action ?? undefined,
    reason,
    diagnostic: diagnostics,
    bound_reaction_event_id: boundReactionEventId,
    intent_token_state: intentTokenState,
    intent_token_id: intentTokenId,
    read_source: readSource ?? diagnostics?.read_source ?? null,
    emitted_at_utc: nowUtc,
  };
}

export function buildRecordAudit({ episode, nowUtc = new Date().toISOString() }) {
  const normalized = normalizeEpisodeKey(episode);
  return {
    schema: 'ci-failure-notification.audit.v1',
    phase: 'record',
    episode_key: normalized,
    episode_key_digest: episodeKeyDigest(normalized),
    emitted_at_utc: nowUtc,
  };
}

export function evaluateTargetApplySnapshot({ decision, snapshotTargetGeneration, currentTargetGeneration }) {
  if (String(snapshotTargetGeneration) !== String(currentTargetGeneration)) {
    return { apply: false, reason: 'target_rotated_redecide_required', terminal_action: 'SUPPRESS' };
  }
  assertTerminalAction(decision?.terminal_action);
  return { apply: true, reason: 'target_generation_current', terminal_action: decision.terminal_action };
}

export function evaluateHelperErrorEscalation({ consecutiveErrors = 0, limit = DEFAULT_HELPER_ERROR_LIMIT }) {
  const n = Number(consecutiveErrors) || 0;
  const l = Math.max(1, Number(limit) || DEFAULT_HELPER_ERROR_LIMIT);
  return { terminal_action: 'SUPPRESS', diagnostic: { error_kind: 'helper_error' }, operator_visible: n >= l, consecutiveErrors: n, limit: l };
}

export function ensureStore(root) {
  mkdirSync(path.join(root, 'tokens'), { recursive: true });
  mkdirSync(path.join(root, 'audit'), { recursive: true });
  mkdirSync(path.join(root, 'episodes'), { recursive: true });
  mkdirSync(path.join(root, 'claims'), { recursive: true });
}

function isPreflightClaimStale(existingClaim, nowMs, config = resolveConfig()) {
  const claimSinceMs = Number(existingClaim?.claimedAtMs ?? 0);
  if (claimSinceMs <= 0) {
    return true;
  }
  const claimStaleMs = resolveBoundedInt(
    config.claimStaleMs,
    Math.max(3 * Number(config.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS), DEFAULT_CLAIM_STALE_MS),
    1000,
  );
  return nowMs - claimSinceMs >= claimStaleMs;
}

function safeEpisodeClaimName(digest) {
  return `${String(digest ?? '').trim()}.json`;
}

function removeEpisodeClaim(storeDir, digest) {
  try {
    rmSync(path.join(String(storeDir ?? ''), 'claims', safeEpisodeClaimName(digest)), { force: true });
  } catch {
    // best-effort claim cleanup
  }
}

function tryReadEpisodeFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}
`, 'utf8');
  renameSync(tmp, filePath);
}

export function readEpisodeRecord(storeDir, episode) {
  const file = path.join(storeDir, 'episodes', safeEpisodeRecordName(episode));
  if (!existsSync(file)) return null;
  return tryReadEpisodeFile(file);
}

export function writeEpisodeRecord(storeDir, record) {
  ensureStore(storeDir);
  const file = path.join(storeDir, 'episodes', safeEpisodeRecordName(record.episode));
  writeFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return { ok: true, path: file };
}

export function recordPendingEpisode(input) {
  const episode = normalizeEpisodeKey(input?.episode);
  const nowMs = Number(input?.nowMs) || Date.now();
  const config = resolveConfig(input?.config);
  const enqueueTickId = String(input?.enqueueTickId ?? '');
  const storeDir = input?.storeDir;
  if (!storeDir) throw new Error('storeDir is required');
  ensureStore(storeDir);
  const file = path.join(storeDir, 'episodes', safeEpisodeRecordName(episode));
  const digest = episodeKeyDigest(episode);
  const eligibleAfterMs = nowMs + config.reconcileIntervalMs;
  const record = {
    schema: 'ci-failure-notification.episode.v2',
    episode,
    digest,
    state: 'pending',
    recordedAtMs: nowMs,
    recordedAtUtc: new Date(nowMs).toISOString(),
    eligibleAfterMs,
    enqueueTickId,
    expiresAtMs: nowMs + config.pendingExpiryMs,
    terminalReason: null,
    terminalAction: null,
    submitIntentId: null,
    claimOwner: null,
  };
  let fd;
  try {
    fd = openSync(file, 'wx');
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    const audit = buildRecordAudit({ episode, nowUtc: record.recordedAtUtc });
    const auditWritten = appendAudit({ storeDir, audit });
    return { recorded: true, record, audit, auditWritten };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const existing = JSON.parse(readFileSync(file, 'utf8'));
      return { recorded: false, record: existing, audit: buildRecordAudit({ episode }) };
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function isEvaluationEligible(record, nowMs = Date.now(), { enqueueTickId = null, config = resolveConfig() } = {}) {
  if (!record || record.terminalReason) return { eligible: false, reason: 'already_terminal' };
  if (record.state !== 'pending') return { eligible: false, reason: 'not_pending' };
  if (enqueueTickId && record.enqueueTickId === enqueueTickId) {
    return { eligible: false, reason: 'enqueue_tick_boundary' };
  }
  if (nowMs >= Number(record.expiresAtMs ?? 0)) {
    return { eligible: false, reason: 'expired_pending' };
  }
  const ageMs = nowMs - Number(record.recordedAtMs ?? nowMs);
  if (ageMs > config.maxEligibleEvaluationAgeMs) {
    return { eligible: false, reason: 'freshness_sla_exceeded' };
  }
  if (nowMs < Number(record.eligibleAfterMs ?? 0)) {
    return { eligible: false, reason: 'eligibility_boundary' };
  }
  return { eligible: true };
}

export function claimEpisodePreflight(input) {
  const storeDir = input?.storeDir;
  const episode = normalizeEpisodeKey(input?.episode);
  const digest = episodeKeyDigest(episode);
  const claimOwner = String(input?.claimOwner ?? 'reconcile');
  const nowMs = Number(input?.nowMs) || Date.now();
  const config = resolveConfig(input?.config);
  ensureStore(storeDir);
  const record = readEpisodeRecord(storeDir, episode);
  if (!record) return { claimed: false, reason: 'missing_record' };
  if (record.terminalReason) return { claimed: false, reason: 'already_terminal', record };
  if (record.state === 'claimed') {
    if (record.claimOwner === claimOwner) return { claimed: true, record, reentry: true };
    return { claimed: false, reason: 'claim_held_by_other', record };
  }
  if (record.state !== 'pending') return { claimed: false, reason: 'invalid_prior_state', record };

  const claimPath = path.join(storeDir, 'claims', safeEpisodeClaimName(digest));
  let fd;
  try {
    fd = openSync(claimPath, 'wx');
    writeFileSync(fd, `${JSON.stringify({
      schema: 'ci-failure-notification.claim.v1',
      digest,
      claimOwner,
      claimedAtMs: nowMs,
      claimedAtUtc: new Date(nowMs).toISOString(),
    })}
`, 'utf8');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      let existingClaim = null;
      try {
        existingClaim = JSON.parse(readFileSync(claimPath, 'utf8'));
      } catch {
        return { claimed: false, reason: 'claim_held_by_other', record };
      }
      if (record.state === 'pending') {
        if (!isPreflightClaimStale(existingClaim, nowMs, config)) {
          return { claimed: false, reason: 'claim_held_by_other', record };
        }
        const recovered = {
          ...record,
          state: 'claimed',
          claimOwner,
          claimedAtMs: nowMs,
          claimedAtUtc: new Date(nowMs).toISOString(),
        };
        writeEpisodeRecord(storeDir, recovered);
        writeFileSync(claimPath, `${JSON.stringify({
          schema: 'ci-failure-notification.claim.v1',
          digest,
          claimOwner,
          claimedAtMs: nowMs,
          claimedAtUtc: new Date(nowMs).toISOString(),
          orphanReclaimed: true,
        })}
`, 'utf8');
        return { claimed: true, record: recovered, orphanReclaimed: true };
      }
      if (String(existingClaim?.claimOwner ?? '') !== claimOwner) {
        return { claimed: false, reason: 'claim_held_by_other', record };
      }
      const recovered = {
        ...record,
        state: 'claimed',
        claimOwner,
        claimedAtMs: nowMs,
        claimedAtUtc: new Date(nowMs).toISOString(),
      };
      writeEpisodeRecord(storeDir, recovered);
      return { claimed: true, record: recovered, reentry: true };
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const latest = readEpisodeRecord(storeDir, episode);
  if (!latest) return { claimed: false, reason: 'missing_record' };
  if (latest.terminalReason) return { claimed: false, reason: 'already_terminal', record: latest };
  if (latest.state === 'claimed') {
    if (latest.claimOwner === claimOwner) {
      return { claimed: true, record: latest, reentry: true };
    }
    return { claimed: false, reason: 'claim_held_by_other', record: latest };
  }
  if (latest.state !== 'pending') {
    return { claimed: false, reason: 'invalid_prior_state', record: latest };
  }

  const updated = {
    ...latest,
    state: 'claimed',
    claimOwner,
    claimedAtMs: nowMs,
    claimedAtUtc: new Date(nowMs).toISOString(),
  };
  writeEpisodeRecord(storeDir, updated);
  return { claimed: true, record: updated };
}

export function reserveSubmitIntent(input) {
  const storeDir = input?.storeDir;
  const episode = normalizeEpisodeKey(input?.episode);
  const record = readEpisodeRecord(storeDir, episode);
  if (!record) return { reserved: false, reason: 'missing_record' };
  if (record.terminalReason) return { reserved: false, reason: 'already_terminal', record };
  if (record.state === 'submit-intent-reserved' || record.state === 'submitted-unacked') {
    return { reserved: true, record, idempotencyKey: record.submitIntentId, reentry: true };
  }
  if (record.state !== 'claimed') return { reserved: false, reason: 'not_claimed', record };
  const submitIntentId = String(input?.submitIntentId ?? `ci-failed:${episodeKeyDigest(episode)}`);
  const updated = {
    ...record,
    state: 'submit-intent-reserved',
    submitIntentId,
    submitIntentReservedAtMs: Number(input?.nowMs) || Date.now(),
  };
  writeEpisodeRecord(storeDir, updated);
  return { reserved: true, record: updated, idempotencyKey: submitIntentId };
}

export function markSubmittedUnacked(input) {
  const storeDir = input?.storeDir;
  const episode = normalizeEpisodeKey(input?.episode);
  const record = readEpisodeRecord(storeDir, episode);
  if (!record) return { ok: false, reason: 'missing_record' };
  if (record.state !== 'submit-intent-reserved' && record.state !== 'submitted-unacked') {
    return { ok: false, reason: 'invalid_prior_state', record };
  }
  const updated = {
    ...record,
    state: 'submitted-unacked',
    submittedAtMs: Number(input?.nowMs) || Date.now(),
  };
  writeEpisodeRecord(storeDir, updated);
  return { ok: true, record: updated };
}

export function markSendIssued(input) {
  const storeDir = input?.storeDir;
  const episode = normalizeEpisodeKey(input?.episode);
  const record = readEpisodeRecord(storeDir, episode);
  if (!record) return { ok: false, reason: 'missing_record' };
  if (record.state !== 'submit-intent-reserved' && record.state !== 'submitted-unacked') {
    return { ok: false, reason: 'invalid_prior_state', record };
  }
  if (record.sendIssuedAtMs) {
    return { ok: true, idempotent: true, record };
  }
  const updated = {
    ...record,
    sendIssuedAtMs: Number(input?.nowMs) || Date.now(),
  };
  writeEpisodeRecord(storeDir, updated);
  return { ok: true, record: updated };
}

export function markSendDelivered(input) {
  const storeDir = input?.storeDir;
  const episode = normalizeEpisodeKey(input?.episode);
  const record = readEpisodeRecord(storeDir, episode);
  if (!record) return { ok: false, reason: 'missing_record' };
  if (record.state !== 'submit-intent-reserved' && record.state !== 'submitted-unacked') {
    return { ok: false, reason: 'invalid_prior_state', record };
  }
  if (record.sendDeliveredAtMs) {
    return { ok: true, idempotent: true, record };
  }
  const updated = {
    ...record,
    sendDeliveredAtMs: Number(input?.nowMs) || Date.now(),
  };
  writeEpisodeRecord(storeDir, updated);
  return { ok: true, record: updated };
}


export function releaseSubmitIntent(input) {
  const storeDir = input?.storeDir;
  const episode = normalizeEpisodeKey(input?.episode);
  const record = readEpisodeRecord(storeDir, episode);
  if (!record) return { ok: false, reason: 'missing_record' };
  if (record.state !== 'submit-intent-reserved') {
    return { ok: false, reason: 'invalid_prior_state', record };
  }
  if (record.sendDeliveredAtMs) {
    return { ok: false, reason: 'already_delivered', record };
  }
  const updated = {
    ...record,
    state: 'claimed',
    submitIntentId: null,
    submitIntentReservedAtMs: null,
    sendIssuedAtMs: null,
  };
  writeEpisodeRecord(storeDir, updated);
  return { ok: true, record: updated };
}

export function terminalizeEpisode(input) {
  const storeDir = input?.storeDir;
  const episode = normalizeEpisodeKey(input?.episode);
  const terminalReason = String(input?.terminalReason ?? input?.reason ?? '');
  const terminalAction = assertTerminalAction(input?.terminalAction ?? mapReasonToTerminalAction(terminalReason));
  const record = readEpisodeRecord(storeDir, episode);
  if (!record) return { ok: false, reason: 'missing_record' };
  if (record.terminalReason) {
    return { ok: true, idempotent: true, record };
  }
  const updated = {
    ...record,
    state: 'terminal',
    terminalReason,
    terminalAction,
    terminalizedAtMs: Number(input?.nowMs) || Date.now(),
    readSource: input?.readSource ?? null,
  };
  writeEpisodeRecord(storeDir, updated);
  removeEpisodeClaim(storeDir, episodeKeyDigest(episode));
  const audit = buildTerminalAudit({
    episode,
    terminal_action: terminalAction,
    reason: mapTerminalReasonToAuditReason(terminalReason),
    diagnostics: input?.diagnostics ?? {},
    readSource: input?.readSource,
  });
  const auditWritten = appendAudit({ storeDir, audit });
  return { ok: true, record: updated, audit, auditWritten };
}

export function resolveSubmittedDelivery(input) {
  const storeDir = input?.storeDir;
  const episode = normalizeEpisodeKey(input?.episode);
  const record = readEpisodeRecord(storeDir, episode);
  if (!record) return { resolved: false, reason: 'missing_record' };
  if (record.terminalReason) return { resolved: true, idempotent: true, record, terminalReason: record.terminalReason };
  if (record.state !== 'submitted-unacked' && record.state !== 'submit-intent-reserved') {
    return { resolved: false, reason: 'not_in_flight', record };
  }
  if (input?.acknowledged) {
    const isProgressStale = record.sendEscalationReason === 'progress_stale';
    const sent = terminalizeEpisode({
      storeDir,
      episode,
      terminalReason: isProgressStale ? 'progress_stale' : 'sent',
      terminalAction: 'SEND',
      readSource: isProgressStale ? 'delivery_resolution_ack_progress_stale' : 'delivery_resolution_ack',
      diagnostics: isProgressStale ? (record.sendEscalationDiagnostics ?? {}) : undefined,
      nowMs: input?.nowMs,
    });
    return { ...sent, terminalReason: isProgressStale ? 'progress_stale' : 'sent', resolved: true };
  }
  if (input?.retryExhausted) {
    const failed = terminalizeEpisode({
      storeDir,
      episode,
      terminalReason: 'delivery-failed',
      terminalAction: 'SEND',
      readSource: 'delivery_resolution_retry_exhausted',
      nowMs: input?.nowMs,
      diagnostics: { error_kind: 'delivery_failed_escalated' },
    });
    return { ...failed, terminalReason: 'delivery-failed', resolved: true };
  }
  return { resolved: false, reason: 'pending_ack', record };
}

export function evaluatePreflightRevalidation(input) {
  const storeDir = input?.storeDir;
  const episode = normalizeEpisodeKey(input?.episode);
  const record = readEpisodeRecord(storeDir, episode);
  if (!record) return { action: 'missing_record' };
  if (record.state !== 'claimed') return { action: 'not_claimed', record };
  const decision = evaluateEpisodeTerminal({
    ...input,
    episode,
    readSource: 'pre_submit_revalidation',
  });
  if (decision.hard_failure) {
    return { action: 'hard_failure', decision, record };
  }
  if (decision.terminal_action === 'SUPPRESS') {
    const terminal = terminalizeEpisode({
      storeDir,
      episode,
      terminalReason: decision.reason,
      terminalAction: 'SUPPRESS',
      readSource: 'pre_submit_revalidation',
      diagnostics: decision.diagnostics,
      nowMs: input?.nowMs,
    });
    return { action: 'suppressed', terminal, decision };
  }
  let workingRecord = record;
  if (decision.reason === 'progress_stale') {
    workingRecord = {
      ...record,
      sendEscalationReason: 'progress_stale',
      sendEscalationDiagnostics: decision.diagnostics ?? {},
      staleEscalationOwner: 'reconcile',
      staleEscalationArmedAtMs: Number(record.staleEscalationArmedAtMs ?? input?.nowMs ?? Date.now()),
      staleEscalationCleared: false,
    };
    writeEpisodeRecord(storeDir, workingRecord);
  }
  return { action: 'send_allowed', decision, record: workingRecord };
}

export function scanExpiredPendingRecords(storeDir, nowMs = Date.now()) {
  const dir = path.join(storeDir, 'episodes');
  if (!existsSync(dir)) return { expired: [] };
  const expired = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.episode.json')) continue;
    const record = tryReadEpisodeFile(path.join(dir, name));
    if (!record) continue;
    if (record.terminalReason) continue;
    if (record.state !== 'pending') continue;
    if (nowMs >= Number(record.expiresAtMs ?? 0)) {
      expired.push(record);
    }
  }
  return { expired };
}

export function scanFreshnessSlaExceededPendingRecords(storeDir, nowMs = Date.now(), config = resolveConfig()) {
  const dir = path.join(storeDir, 'episodes');
  if (!existsSync(dir)) return { exceeded: [] };
  const exceeded = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.episode.json')) continue;
    const record = tryReadEpisodeFile(path.join(dir, name));
    if (!record) continue;
    if (record.terminalReason) continue;
    if (record.state !== 'pending') continue;
    if (nowMs >= Number(record.expiresAtMs ?? 0)) continue;
    const ageMs = nowMs - Number(record.recordedAtMs ?? nowMs);
    if (ageMs > config.maxEligibleEvaluationAgeMs) {
      exceeded.push(record);
    }
  }
  return { exceeded };
}

export function expirePendingEpisode(input) {
  const storeDir = input?.storeDir;
  const episode = normalizeEpisodeKey(input?.episode);
  const record = readEpisodeRecord(storeDir, episode);
  if (!record) return { ok: false, reason: 'missing_record' };
  if (record.terminalReason) return { ok: true, idempotent: true, record };
  if (record.state !== 'pending') return { ok: false, reason: 'not_expirable_pending', record };
  const terminal = terminalizeEpisode({
    storeDir,
    episode,
    terminalReason: 'abandoned-expired',
    terminalAction: 'SUPPRESS',
    readSource: input?.freshnessSla ? 'freshness_sla_scanner' : 'expiry_scanner',
    diagnostics: {
      backstop_handoff: 'report-stale',
      reconcile_health: 'degraded',
      ...(input?.freshnessSla ? { freshness_sla_exceeded: true } : {}),
    },
    nowMs: input?.nowMs,
  });
  return { ok: true, ...terminal };
}

export function migrateLegacyEpisodeRecord(record) {
  if (!record || record.schema === 'ci-failure-notification.episode.v2') return record;
  if (record.status === 'claimed' || record.state === 'claimed') {
    return {
      schema: 'ci-failure-notification.episode.v2',
      episode: record.episode,
      digest: record.digest
        ? episodeKeyDigest(record.episode)
        : episodeKeyDigest(record.episode ?? record),
      state: 'claimed',
      recordedAtMs: Date.parse(record.claimedAtUtc ?? record.recordedAtUtc ?? 0) || Date.now(),
      terminalReason: record.terminalReason ?? null,
      terminalAction: record.terminalAction ?? null,
      legacy: true,
    };
  }
  if (record.terminalReason || record.terminalAction) {
    return {
      schema: 'ci-failure-notification.episode.v2',
      episode: record.episode,
      digest: episodeKeyDigest(record.episode),
      state: 'terminal',
      terminalReason: record.terminalReason ?? record.reason,
      terminalAction: record.terminalAction,
      legacy: true,
    };
  }
  return record;
}

export function interpretLegacyAuditLine(audit) {
  if (!audit || typeof audit !== 'object') return { authoritative: false };
  if (audit.phase === 'terminal' || audit.terminal_action) {
    return { authoritative: true, terminal_action: audit.terminal_action, reason: audit.reason, legacy: !audit.phase };
  }
  if (audit.phase === 'record') return { authoritative: false, phase: 'record' };
  return { authoritative: Boolean(audit.terminal_action), legacy: true, ...audit };
}

export function computeReconcileHealth({ pendingRecords = [], nowMs = Date.now(), config = resolveConfig() }) {
  const pending = toArray(pendingRecords).filter((r) => !r.terminalReason && r.state === 'pending');
  let oldestAgeMs = 0;
  for (const record of pending) {
    oldestAgeMs = Math.max(oldestAgeMs, nowMs - Number(record.recordedAtMs ?? nowMs));
  }
  const degraded = oldestAgeMs > config.maxEligibleEvaluationAgeMs;
  return {
    pendingCount: pending.length,
    oldestPendingAgeMs: oldestAgeMs,
    maxEligibleEvaluationAgeMs: config.maxEligibleEvaluationAgeMs,
    degraded,
    status: degraded ? 'degraded' : 'healthy',
  };
}

export function planReconcileTick(input) {
  const storeDir = input?.storeDir;
  const nowMs = Number(input?.nowMs) || Date.now();
  const config = resolveConfig(input?.config);
  const enqueueTickId = String(input?.enqueueTickId ?? `tick-${nowMs}`);
  const dir = path.join(storeDir, 'episodes');
  /** @type {Array<Record<string, unknown>>} */
  const actions = [];
  /** @type {Array<Record<string, unknown>>} */
  const pendingRecords = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.episode.json')) continue;
      const record = tryReadEpisodeFile(path.join(dir, name));
      if (!record) continue;
      pendingRecords.push(record);
    }
  }
  const expired = scanExpiredPendingRecords(storeDir, nowMs);
  const expiredDigests = new Set(expired.expired.map((record) => record.digest));
  for (const record of expired.expired) {
    actions.push({ type: 'expire', digest: record.digest, episode: record.episode });
  }
  const freshnessExceeded = scanFreshnessSlaExceededPendingRecords(storeDir, nowMs, config);
  for (const record of freshnessExceeded.exceeded) {
    if (expiredDigests.has(record.digest)) continue;
    expiredDigests.add(record.digest);
    actions.push({ type: 'expire', digest: record.digest, episode: record.episode, freshnessSla: true });
  }
  for (const record of pendingRecords) {
    if (record.terminalReason) continue;
    if (expiredDigests.has(record.digest)) continue;
    if (record.state === 'claimed' || record.state === 'submit-intent-reserved' || record.state === 'submitted-unacked') {
      actions.push({
        type: 'recover_in_flight',
        digest: record.digest,
        state: record.state,
        episode: record.episode,
      });
      continue;
    }
    const eligibility = isEvaluationEligible(record, nowMs, {
      enqueueTickId: input?.sameEnqueueTickId ? enqueueTickId : null,
      config,
    });
    if (!eligibility.eligible) continue;
    actions.push({ type: 'evaluate', digest: record.digest, episode: record.episode });
  }
  const health = computeReconcileHealth({ pendingRecords, nowMs, config });
  return { actions, health, config, enqueueTickId };
}

export function claimIntentToken({ storeDir, episode, owner = 'orchestrator', nowUtc = new Date().toISOString() }) {
  const ep = normalizeEpisodeKey(episode);
  ensureStore(storeDir);
  const file = path.join(storeDir, 'tokens', safeTokenName(ep));
  const record = { schema: 'ci-failure-notification.intent.v1', episode: ep, key: episodeKeyString(ep), digest: episodeKeyDigest(ep), owner, status: 'claimed', claimedAtUtc: nowUtc };
  let fd;
  try {
    fd = openSync(file, 'wx');
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    return { claimed: true, terminal_action: 'SEND', reason: 'intent_claimed', tokenPath: file, token: record };
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const existing = JSON.parse(readFileSync(file, 'utf8'));
      return { claimed: false, terminal_action: 'SUPPRESS', reason: 'intent_token_present', tokenPath: file, token: existing };
    }
    return { claimed: false, terminal_action: 'SUPPRESS', reason: 'intent_token_store_error', error: String(error?.message ?? error) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function markObservableSendFailure({ storeDir, episode, mode = 'release' }) {
  const ep = normalizeEpisodeKey(episode);
  const file = path.join(storeDir, 'tokens', safeTokenName(ep));
  if (mode === 'release') {
    rmSync(file, { force: true });
    return { terminal_action: 'SEND', reason: 'released_for_bounded_retry', released: true };
  }
  const record = { schema: 'ci-failure-notification.intent.v1', episode: ep, key: episodeKeyString(ep), digest: episodeKeyDigest(ep), status: 'failed-owned', failedAtUtc: new Date().toISOString(), operatorVisible: true };
  ensureStore(storeDir);
  writeFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return { terminal_action: 'SUPPRESS', reason: 'failed_owned_operator_visible', released: false, token: record };
}

export function appendAudit({ storeDir, audit }) {
  ensureStore(storeDir);
  const action = audit.terminal_action ? assertTerminalAction(audit.terminal_action) : null;
  const base = path.join(storeDir, 'audit', `${audit.episode_key_digest}-${Date.now()}-${action ?? audit.phase ?? 'diag'}`);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const file = `${base}${attempt === 0 ? '' : `-${attempt}`}.json`;
    let fd;
    try {
      fd = openSync(file, 'wx');
      writeFileSync(fd, `${JSON.stringify(audit)}\n`, 'utf8');
      return { ok: true, path: file };
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw new Error('unable to allocate unique audit record path');
}

export function compactRecords({ records = [], closures = [], nowMs = Date.now(), minRetentionMs = DEFAULT_MIN_RETENTION_MS }) {
  const closureByDigest = new Map((closures ?? []).map((c) => [String(c.episodeDigest ?? c.digest), c]));
  const retained = [];
  const removed = [];
  for (const record of records ?? []) {
    const digest = String(record.episodeDigest ?? record.digest ?? record.episode_key_digest ?? episodeKeyDigest(record.episode));
    const closure = closureByDigest.get(digest);
    const ts = Date.parse(record.createdAtUtc ?? record.claimedAtUtc ?? record.emittedAtUtc ?? record.emitted_at_utc ?? 0);
    const oldEnough = Number.isFinite(ts) && nowMs - ts >= minRetentionMs;
    if (closure && oldEnough && !record.activeTargetInFlight) removed.push({ digest, trigger: closure.trigger });
    else retained.push(record);
  }
  return { retained, removed };
}

export function scanFixtureSafety(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const findings = [];
  const patterns = [
    { kind: 'secret', re: /(ghp_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY)/ },
    { kind: 'auth_material', re: /(?:^|[\s{,])[\"']?(authorization|cookie)[\"']?\s*[:=]/i },
    { kind: 'absolute_operator_path', re: /([A-Za-z]:\\Users\\[^\s"']+|\/home\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/)/ },
    { kind: 'session_token', re: /session[_-]?id[\"']?\s*[:=]\s*[\"'][a-f0-9-]{20,}/i },
    { kind: 'env_value', re: /\/\.env\b|AO_[A-Z0-9_]+=|process\.env/i },
    { kind: 'ao_payload', re: /\"\.ao\/|\/\.ao\// },
  ];
  for (const p of patterns) if (p.re.test(text)) findings.push(p.kind);
  return { ok: findings.length === 0, findings };
}

export function validateInitGate(input) {
  const errors = [];
  if (!input?.workerStateInputConfigured) errors.push('missing_worker_state_input_wiring');
  if (!input?.durableSubmitAckConfigured) errors.push('missing_durable_submit_ack');
  if (!input?.reactionRecordConfigured) errors.push('missing_reaction_record_wiring');
  return {
    ok: errors.length === 0,
    errors,
    reactionEnabled: errors.length === 0,
    degradedHealth: errors.length > 0,
  };
}

export function buildAdoptionArtifact({ ruleText, repoIdentity, gitSha, wrapperPath, helperContent, dryRunVerdict }) {
  const verdict = assertTerminalAction(dryRunVerdict?.terminal_action ?? dryRunVerdict);
  return {
    schema: 'ci-failure-notification.adoption-artifact.v1',
    ruleFingerprint: createHash('sha256').update(String(ruleText ?? '')).digest('hex'),
    repoRootFingerprint: createHash('sha256').update(String(repoIdentity ?? '')).digest('hex'),
    gitSha: String(gitSha ?? ''),
    wrapperIdentity: path.basename(String(wrapperPath ?? 'ci-failure-notification.ps1')),
    helperContentHash: createHash('sha256').update(String(helperContent ?? '')).digest('hex'),
    dryRunVerdict: verdict,
  };
}

function cli() {
  const input = readStdinJson();
  const sub = process.argv[2];
  if (sub === 'decide') return decideCiFailureNotification(input);
  if (sub === 'evaluate') return evaluateEpisodeTerminal(input);
  if (sub === 'record') return recordPendingEpisode(input);
  if (sub === 'claim-preflight') return claimEpisodePreflight(input);
  if (sub === 'preflight-revalidate') return evaluatePreflightRevalidation(input);
  if (sub === 'reserve-intent') return reserveSubmitIntent(input);
  if (sub === 'mark-submitted') return markSubmittedUnacked(input);
  if (sub === 'mark-send-issued') return markSendIssued(input);
  if (sub === 'mark-send-delivered') return markSendDelivered(input);
  if (sub === 'release-submit-intent') return releaseSubmitIntent(input);
  if (sub === 'resolve-delivery') return resolveSubmittedDelivery(input);
  if (sub === 'terminalize') return terminalizeEpisode(input);
  if (sub === 'expire-scan') return scanExpiredPendingRecords(input?.storeDir, input?.nowMs);
  if (sub === 'expire') return expirePendingEpisode(input);
  if (sub === 'reconcile-plan') return planReconcileTick(input);
  if (sub === 'health') return computeReconcileHealth(input);
  if (sub === 'init-gate') return validateInitGate(input);
  if (sub === 'claim') return claimIntentToken(input);
  if (sub === 'mark-send-failure') return markObservableSendFailure(input);
  if (sub === 'append-audit') return appendAudit(input);
  if (sub === 'helper-error') return evaluateHelperErrorEscalation(input);
  if (sub === 'adoption-artifact') return buildAdoptionArtifact(input);
  if (sub === 'sync-red-period-trackers') return syncRedPeriodTrackersForOpenPrs(input);
  if (sub === 'reaction-record-plan') return planCiFailureReactionRecords(input);
  if (sub === 'list-intent-tokens') return { tokens: listIntentTokensFromStore(input?.storeDir) };
  if (sub === 'pre-send-recheck') return preSendCiRedRecheck(input?.episode, input?.fresh);
  if (sub === 'evaluate-suppressor') return evaluateCiFailureSuppressorDecision(input);
  throw new Error(`unsupported subcommand: ${sub}`);
}

runStdinJsonCli('ci-failure-notification.mjs', {
  decide: cli,
  evaluate: cli,
  record: cli,
  'claim-preflight': cli,
  'preflight-revalidate': cli,
  'reserve-intent': cli,
  'mark-submitted': cli,
  'mark-send-issued': cli,
  'mark-send-delivered': cli,
  'release-submit-intent': cli,
  'resolve-delivery': cli,
  terminalize: cli,
  'expire-scan': cli,
  expire: cli,
  'reconcile-plan': cli,
  health: cli,
  'init-gate': cli,
  'sync-red-period-trackers': cli,
  'reaction-record-plan': cli,
  'list-intent-tokens': cli,
  'pre-send-recheck': cli,
  claim: cli,
  'mark-send-failure': cli,
  'append-audit': cli,
  'helper-error': cli,
  'adoption-artifact': cli,
  'evaluate-suppressor': cli,
});
