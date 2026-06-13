#!/usr/bin/env node
/**
 * Deterministic CI-failure notification decision predicate (Issue #283).
 *
 * The terminal predicate action is deliberately a closed binary enum:
 * SEND | SUPPRESS. Bindability/no-match/error details are diagnostics only.
 */
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const TERMINAL_ACTIONS = Object.freeze(['SEND', 'SUPPRESS']);
export const DEFAULT_HELPER_ERROR_LIMIT = 3;
export const DEFAULT_MIN_RETENTION_MS = 24 * 60 * 60 * 1000;

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

export function bindReactionEvent(episode, events = []) {
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
    if (sameEpisode(episode, ep)) {
      return { status: 'matched', eventId: String(field(event, ['id', 'eventId']) ?? ''), event };
    }
  }
  return { status: sawUnbindable ? 'unbindable' : (sawCandidate ? 'no-match' : 'absent'), eventId: null };
}

export function bindSelfFixReport(episode, reports = []) {
  let sawCandidate = false;
  for (const report of reports ?? []) {
    const state = String(field(report, ['state', 'status', 'report']) ?? '');
    if (state !== 'fixing_ci') continue;
    sawCandidate = true;
    const ep = field(report, ['episode', 'metadata.episode', 'details.episode']) ?? eventEpisode(report);
    if (sameEpisode(episode, ep)) {
      return { status: 'matched', reportId: String(field(report, ['id', 'reportId']) ?? '') };
    }
  }
  return { status: sawCandidate ? 'no-match' : 'absent', reportId: null };
}

export function exactIntentTokenLookup(episode, tokens = []) {
  const key = episodeKeyString(episode);
  for (const token of tokens ?? []) {
    const tokenEpisode = token.episode ?? token;
    if (sameEpisode(episode, tokenEpisode)) {
      return { status: token.status === 'failed-owned' ? 'failed-owned' : 'present', tokenId: token.id ?? token.tokenId ?? episodeKeyDigest(episode) };
    }
    if (token.key && String(token.key) === key) {
      return { status: token.status === 'failed-owned' ? 'failed-owned' : 'present', tokenId: token.id ?? token.tokenId ?? episodeKeyDigest(episode) };
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

export function decideCiFailureNotification(input) {
  const episode = normalizeEpisodeKey(input?.episode);
  const diagnostics = {
    reaction_bind_status: 'absent',
    self_fix_bind_status: 'absent',
    error_kind: null,
    ci_source_status: input?.ciSourceEquivalence?.disagreement ? 'disagreement' : 'ok',
  };
  let terminal_action = 'SEND';
  let reason = 'no_suppressor';
  let boundReactionEventId = null;
  let intentTokenState = 'absent';
  let intentTokenId = null;

  if (input?.helperError) {
    terminal_action = 'SUPPRESS';
    reason = 'helper_error_safe_suppress';
    diagnostics.error_kind = 'helper_error';
  } else if (input?.ciSourceEquivalence?.disagreement) {
    terminal_action = 'SUPPRESS';
    reason = 'ci_source_disagreement_safe_suppress';
    diagnostics.error_kind = 'ci_source_disagreement';
  } else {
    const reaction = bindReactionEvent(episode, input?.reactionEvents ?? []);
    diagnostics.reaction_bind_status = reaction.status;
    boundReactionEventId = reaction.eventId;
    const selfFix = bindSelfFixReport(episode, input?.workerReports ?? []);
    diagnostics.self_fix_bind_status = selfFix.status;
    const token = exactIntentTokenLookup(episode, input?.intentTokens ?? []);
    intentTokenState = token.status;
    intentTokenId = token.tokenId;

    if (reaction.status === 'matched') {
      terminal_action = 'SUPPRESS';
      reason = 'reaction_ci_failed_sent_to_active_target';
    } else if (selfFix.status === 'matched') {
      terminal_action = 'SUPPRESS';
      reason = 'worker_fixing_ci_for_episode';
    } else if (token.status === 'present' || token.status === 'failed-owned') {
      terminal_action = 'SUPPRESS';
      reason = token.status === 'failed-owned' ? 'intent_failed_owned_escalated' : 'orchestrator_intent_token_present';
    }
  }

  assertTerminalAction(terminal_action);
  return {
    terminal_action,
    reason,
    episode_key: episode,
    episode_key_digest: episodeKeyDigest(episode),
    diagnostics,
    bound_reaction_event_id: boundReactionEventId,
    intent_token_state: intentTokenState,
    intent_token_id: intentTokenId,
    audit: buildAuditLine({ episode, terminal_action, reason, diagnostics, boundReactionEventId, intentTokenState, intentTokenId }),
  };
}

export function buildAuditLine({ episode, terminal_action, reason, diagnostics, boundReactionEventId = null, intentTokenState = 'absent', intentTokenId = null, nowUtc = new Date().toISOString() }) {
  assertTerminalAction(terminal_action);
  const normalized = normalizeEpisodeKey(episode);
  return {
    schema: 'ci-failure-notification.audit.v1',
    episode_key: normalized,
    episode_key_digest: episodeKeyDigest(normalized),
    terminal_action,
    reason,
    diagnostic: diagnostics,
    bound_reaction_event_id: boundReactionEventId,
    intent_token_state: intentTokenState,
    intent_token_id: intentTokenId,
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
  const action = assertTerminalAction(audit.terminal_action);
  const base = path.join(storeDir, 'audit', `${audit.episode_key_digest}-${Date.now()}-${action}`);
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
    { kind: 'auth_material', re: /(authorization|cookie)\s*[:=]/i },
    { kind: 'absolute_operator_path', re: /([A-Za-z]:\\Users\\[^\s"']+|\/home\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/)/ },
  ];
  for (const p of patterns) if (p.re.test(text)) findings.push(p.kind);
  return { ok: findings.length === 0, findings };
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
  if (sub === 'claim') return claimIntentToken(input);
  if (sub === 'mark-send-failure') return markObservableSendFailure(input);
  if (sub === 'append-audit') return appendAudit(input);
  if (sub === 'helper-error') return evaluateHelperErrorEscalation(input);
  if (sub === 'adoption-artifact') return buildAdoptionArtifact(input);
  throw new Error(`unsupported subcommand: ${sub}`);
}

runStdinJsonCli('ci-failure-notification.mjs', { decide: cli, claim: cli, 'mark-send-failure': cli, 'append-audit': cli, 'helper-error': cli, 'adoption-artifact': cli });
