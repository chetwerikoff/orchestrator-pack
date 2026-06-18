#!/usr/bin/env node
/**
 * CI-failure notification predicate and episode lifecycle (Issues #283 / #342).
 *
 * Terminal predicate action: SEND | SUPPRESS. Episode lifecycle adds pending→terminal
 * outbox states; live worker fixing_ci suppressor binds to PR-owner session state.
 */
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readStdinJson, runStdinJsonCli, resolveBoundedInt, evaluateMechanicalTickInterval } from './review-mechanical-cli.mjs';
import { resolveHeadOwningWorkerSessionId, sessionOwnsRunHead, sessionMatchesPr } from './review-trigger-reconcile.mjs';
import { normalizeSha, toArray, getSessionIdentifier } from './review-reconcile-primitives.mjs';
import { isSessionAlive } from './worker-message-dispatch-observe.mjs';
import { normalizeSessionReportState } from './ci-green-wake-reconcile.mjs';

export const TERMINAL_ACTIONS = Object.freeze(['SEND', 'SUPPRESS']);
export const DEFAULT_HELPER_ERROR_LIMIT = 3;
export const DEFAULT_MIN_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
export const DEFAULT_MAX_ELIGIBLE_EVALUATION_AGE_MS = 180_000;
export const DEFAULT_PENDING_EXPIRY_MS = 30 * 60 * 1000;
export const REPORT_STALE_BACKSTOP_MS = 30 * 60 * 1000;

export const TERMINAL_REASONS = Object.freeze([
  'sent',
  'delivery-failed',
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
  return {
    reconcileIntervalMs,
    maxEligibleEvaluationAgeMs: Math.min(maxEligibleEvaluationAgeMs, REPORT_STALE_BACKSTOP_MS - 1),
    pendingExpiryMs: Math.min(pendingExpiryMs, REPORT_STALE_BACKSTOP_MS),
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
  const reportState = owner ? normalizeSessionReportState(owner) : null;
  const targetGeneration = owner ? deriveTargetGeneration(owner) : null;
  return { ok: true, ownerId, owner, live, reportState, targetGeneration };
}

export function evaluateLiveWorkerSuppressor({ episode, workerState, headShaFirst, headShaSecond, versionMarkerFirst, versionMarkerSecond }) {
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
    return { status: 'matched', reason: 'suppressed-live-worker', ownerId: ownerResolution.ownerId, reportState: ownerResolution.reportState };
  }
  return {
    status: 'not_suppressing',
    ownerId: ownerResolution.ownerId,
    reportState: ownerResolution.reportState,
  };
}

export function bindReactionEvent(episode, events = [], { excludeDigest = null } = {}) {
  let sawCandidate = false;
  let sawUnbindable = false;
  for (const event of events ?? []) {
    const type = String(field(event, ['type', 'kind', 'event', 'name']) ?? '');
    const reactionKey = String(field(event, ['reactionKey', 'reaction.key', 'metadata.reactionKey', 'details.reactionKey', 'payload.reactionKey', 'data.reactionKey', 'data.reaction.key']) ?? '');
    if (type !== 'reaction.action_succeeded' || reactionKey !== 'ci-failed') continue;
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

/** @deprecated Episode-key binding retained for legacy audit only; #342 uses live worker state. */
export function bindSelfFixReport(episode, reports = []) {
  let sawCandidate = false;
  for (const report of reports ?? []) {
    const state = String(field(report, ['state', 'status', 'report', 'reportState', 'report_state']) ?? '').toLowerCase();
    if (state !== 'fixing_ci') continue;
    sawCandidate = true;
    const ep = field(report, ['episode', 'metadata.episode', 'details.episode']) ?? eventEpisode(report);
    if (sameEpisode(episode, ep)) {
      return { status: 'matched', reportId: String(field(report, ['id', 'reportId']) ?? '') };
    }
  }
  return { status: sawCandidate ? 'no-match' : 'absent', reportId: null };
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
  if (reason === 'sent' || reason === 'delivery-failed' || reason === 'no_suppressor') return 'SEND';
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
  const excludeDigest = input?.excludeOwnDigest ?? digest;
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
      diagnostics,
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
}

export function readEpisodeRecord(storeDir, episode) {
  const file = path.join(storeDir, 'episodes', safeEpisodeRecordName(episode));
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
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
    return { recorded: true, record, audit: buildRecordAudit({ episode, nowUtc: record.recordedAtUtc }) };
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

export function isEvaluationEligible(record, nowMs = Date.now(), { enqueueTickId = null } = {}) {
  if (!record || record.terminalReason) return { eligible: false, reason: 'already_terminal' };
  if (record.state !== 'pending') return { eligible: false, reason: 'not_pending' };
  if (enqueueTickId && record.enqueueTickId === enqueueTickId) {
    return { eligible: false, reason: 'enqueue_tick_boundary' };
  }
  if (nowMs >= Number(record.expiresAtMs ?? 0)) {
    return { eligible: false, reason: 'expired_pending' };
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
  const record = readEpisodeRecord(storeDir, episode);
  if (!record) return { claimed: false, reason: 'missing_record' };
  if (record.terminalReason) return { claimed: false, reason: 'already_terminal', record };
  if (record.state === 'claimed') {
    if (record.claimOwner === claimOwner) return { claimed: true, record, reentry: true };
    return { claimed: false, reason: 'claim_held_by_other', record };
  }
  if (record.state !== 'pending') return { claimed: false, reason: 'invalid_prior_state', record };
  const updated = {
    ...record,
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
  const audit = buildTerminalAudit({
    episode,
    terminal_action: terminalAction,
    reason: mapTerminalReasonToAuditReason(terminalReason),
    diagnostics: input?.diagnostics ?? {},
    readSource: input?.readSource,
  });
  return { ok: true, record: updated, audit };
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
    const sent = terminalizeEpisode({
      storeDir,
      episode,
      terminalReason: 'sent',
      terminalAction: 'SEND',
      readSource: 'delivery_resolution_ack',
      nowMs: input?.nowMs,
    });
    return { ...sent, terminalReason: 'sent', resolved: true };
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
    excludeOwnDigest: episodeKeyDigest(episode),
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
  return { action: 'send_allowed', decision, record };
}

export function scanExpiredPendingRecords(storeDir, nowMs = Date.now()) {
  const dir = path.join(storeDir, 'episodes');
  if (!existsSync(dir)) return { expired: [] };
  const expired = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.episode.json')) continue;
    const record = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    if (record.terminalReason) continue;
    if (record.state !== 'pending') continue;
    if (nowMs >= Number(record.expiresAtMs ?? 0)) {
      expired.push(record);
    }
  }
  return { expired };
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
    readSource: 'expiry_scanner',
    diagnostics: {
      backstop_handoff: 'report-stale',
      reconcile_health: 'degraded',
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
      pendingRecords.push(JSON.parse(readFileSync(path.join(dir, name), 'utf8')));
    }
  }
  const expired = scanExpiredPendingRecords(storeDir, nowMs);
  const expiredDigests = new Set(expired.expired.map((record) => record.digest));
  for (const record of expired.expired) {
    actions.push({ type: 'expire', digest: record.digest, episode: record.episode });
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
    const eligibility = isEvaluationEligible(record, nowMs, { enqueueTickId: input?.sameEnqueueTickId ? enqueueTickId : null });
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
  'resolve-delivery': cli,
  terminalize: cli,
  'expire-scan': cli,
  expire: cli,
  'reconcile-plan': cli,
  health: cli,
  'init-gate': cli,
  claim: cli,
  'mark-send-failure': cli,
  'append-audit': cli,
  'helper-error': cli,
  'adoption-artifact': cli,
});
