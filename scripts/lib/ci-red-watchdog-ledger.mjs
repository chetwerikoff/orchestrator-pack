import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  CI_RED_WATCHDOG_SCHEMA_VERSION,
  boundedInt,
  ciRedEpisodeKey,
  evaluateCiRedWatchdogCandidate,
  finitePositive,
  normalizeCiRedEpisodeIdentity,
  resolveCiRedWatchdogConfig,
} from './ci-red-watchdog-core.mjs';

function freshLedger() {
  return { schemaVersion: CI_RED_WATCHDOG_SCHEMA_VERSION, nextSequence: 1, episodes: {}, lookupFailures: {}, history: [] };
}

export function resolveCiRedWatchdogStoreDir(input = '') {
  const explicit = String(input ?? '').trim();
  if (explicit) return explicit;
  if (process.env.AO_CI_RED_WATCHDOG_STATE_DIR) return process.env.AO_CI_RED_WATCHDOG_STATE_DIR.trim();
  if (process.env.AO_SIDE_PROCESS_STATE_DIR) return path.join(process.env.AO_SIDE_PROCESS_STATE_DIR.trim(), 'ci-red-watchdog');
  return path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'orchestrator-ci-red-watchdog');
}

function ledgerPaths(storeDir) {
  const root = resolveCiRedWatchdogStoreDir(storeDir);
  return {
    root,
    ledger: path.join(root, 'ledger.json'),
    lock: path.join(root, 'ledger.lock'),
  };
}

function quarantineCorruptLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return null;
  const quarantined = `${ledgerPath}.corrupt-${Date.now()}-${randomUUID()}`;
  renameSync(ledgerPath, quarantined);
  return quarantined;
}

export function readCiRedWatchdogLedger(storeDir = '') {
  const paths = ledgerPaths(storeDir);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.ledger)) return freshLedger();
  try {
    const parsed = JSON.parse(readFileSync(paths.ledger, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Number(parsed.schemaVersion) !== CI_RED_WATCHDOG_SCHEMA_VERSION) {
      throw new Error('unsupported_or_invalid_schema');
    }
    if (!parsed.episodes || typeof parsed.episodes !== 'object' || !Array.isArray(parsed.history)) {
      throw new Error('invalid_ledger_shape');
    }
    if (!parsed.lookupFailures || typeof parsed.lookupFailures !== 'object') parsed.lookupFailures = {};
    parsed.nextSequence = boundedInt(parsed.nextSequence, parsed.history.length + 1, 1);
    return parsed;
  } catch {
    const quarantinedPath = quarantineCorruptLedger(paths.ledger);
    const ledger = freshLedger();
    if (quarantinedPath) {
      ledger.quarantinedPaths = [quarantinedPath];
      ledger.history.push({
        sequence: ledger.nextSequence++,
        atMs: Date.now(),
        key: '',
        actor: 'ci-red-watchdog',
        attemptId: '',
        from: 'corrupt',
        to: 'quarantined',
        reason: 'ledger_corrupt_quarantined',
        metadata: { quarantinedPath },
      });
    }
    return ledger;
  }
}

function writeCiRedWatchdogLedger(storeDir, ledger) {
  const paths = ledgerPaths(storeDir);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const copy = {
    schemaVersion: CI_RED_WATCHDOG_SCHEMA_VERSION,
    nextSequence: boundedInt(ledger.nextSequence, 1, 1),
    episodes: ledger.episodes ?? {},
    lookupFailures: ledger.lookupFailures ?? {},
    history: Array.isArray(ledger.history) ? ledger.history : [],
    ...(Array.isArray(ledger.quarantinedPaths) ? { quarantinedPaths: ledger.quarantinedPaths } : {}),
  };
  const temp = `${paths.ledger}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(copy, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, paths.ledger);
}

function lockIsStale(lockPath, staleMs) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

export function withCiRedWatchdogLedgerLock(storeDir, callback, options = {}) {
  const paths = ledgerPaths(storeDir);
  const config = resolveCiRedWatchdogConfig(options.config);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + boundedInt(options.waitMs, 5_000, 100, 30_000);
  let fd = null;
  while (Date.now() <= deadline) {
    try {
      fd = openSync(paths.lock, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now() }));
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (lockIsStale(paths.lock, Math.max(config.leaseMs * 2, 60_000))) {
        rmSync(paths.lock, { force: true });
        continue;
      }
      const until = Date.now() + 25;
      while (Date.now() < until) { /* bounded synchronous contention wait */ }
    }
  }
  if (fd === null) return { ok: false, reason: 'ledger_lock_busy' };
  try {
    return callback();
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    rmSync(paths.lock, { force: true });
  }
}

function appendTransition(ledger, { key, atMs, actor, attemptId = '', from = '', to, reason, metadata = {} }) {
  const safeMetadata = {};
  for (const [name, value] of Object.entries(metadata ?? {})) {
    if (/diagnostic|log|message|payload|secret/i.test(name)) continue;
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) safeMetadata[name] = value;
  }
  ledger.history.push({
    sequence: ledger.nextSequence++,
    atMs,
    key,
    actor: String(actor || 'ci-red-watchdog'),
    attemptId: String(attemptId || ''),
    from: String(from || ''),
    to: String(to || ''),
    reason: String(reason || ''),
    metadata: safeMetadata,
  });
}

function baseEpisodeRecord(identity, nowMs) {
  return {
    identity: normalizeCiRedEpisodeIdentity(identity),
    state: 'armed',
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    attempts: 0,
    totalAttempts: 0,
    nextEligibleAtMs: nowMs,
    lastDeferReason: '',
    diagnosticFingerprint: '',
    currentAttempt: null,
    verifiedDeliveries: {},
  };
}

function normalizeLookupFailureIdentity(input) {
  if (!input || typeof input !== 'object') throw new Error('ci-red watchdog lookup identity is required');
  const repo = String(input.repo ?? '').trim().toLowerCase();
  const prNumber = Number(input.prNumber);
  const requiredCheckContext = String(input.requiredCheckContext ?? '').trim();
  const headSha = String(input.headSha ?? '').trim().toLowerCase();
  if (!repo) throw new Error('ci-red watchdog lookup identity requires repo');
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error('ci-red watchdog lookup identity requires positive prNumber');
  if (!requiredCheckContext) throw new Error('ci-red watchdog lookup identity requires requiredCheckContext');
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error('ci-red watchdog lookup identity requires valid headSha');
  return { repo, prNumber, requiredCheckContext, headSha };
}

export function ciRedLookupFailureKey(input) {
  const identity = normalizeLookupFailureIdentity(input);
  const serialized = [
    'lookup',
    identity.repo,
    identity.prNumber,
    identity.requiredCheckContext,
    identity.headSha,
  ].map((value) => encodeURIComponent(String(value))).join('|');
  return `lookup:${createHash('sha256').update(serialized).digest('hex')}`;
}

function baseLookupFailureRecord(identity, nowMs) {
  return {
    kind: 'authoritative-check-lookup',
    identity: normalizeLookupFailureIdentity(identity),
    state: 'deferred',
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    attempts: 0,
    totalAttempts: 0,
    nextEligibleAtMs: nowMs,
    lastDeferReason: '',
  };
}

export function recordCiRedWatchdogLookupFailure({
  storeDir = '',
  lookup,
  reason = 'authoritative_lookup_failed',
  nowMs = Date.now(),
  actor = 'ci-failure-notification-reconcile',
  config: rawConfig = {},
} = {}) {
  const config = resolveCiRedWatchdogConfig(rawConfig);
  const identity = normalizeLookupFailureIdentity(lookup);
  const key = ciRedLookupFailureKey(identity);
  return withCiRedWatchdogLedgerLock(storeDir, () => {
    const ledger = readCiRedWatchdogLedger(storeDir);
    ledger.lookupFailures ??= {};
    let record = ledger.lookupFailures[key];
    if (!record || record.state === 'resolved') {
      const priorTotal = Number(record?.totalAttempts ?? 0);
      record = baseLookupFailureRecord(identity, nowMs);
      record.totalAttempts = priorTotal;
      ledger.lookupFailures[key] = record;
    }
    if (record.state === 'parked') {
      return { ok: true, action: 'park', reason: record.parkedReason, key, record };
    }
    if (record.attempts > 0 && Number(record.nextEligibleAtMs ?? 0) > nowMs) {
      return { ok: true, action: 'defer', reason: 'authoritative_lookup_backoff_active', key, record };
    }

    const from = String(record.state || 'deferred');
    record.attempts = Number(record.attempts ?? 0) + 1;
    record.totalAttempts = Number(record.totalAttempts ?? 0) + 1;
    record.updatedAtMs = nowMs;
    record.lastDeferReason = String(reason || 'authoritative_lookup_failed');
    const shouldPark = record.attempts >= config.maxAttempts;
    record.state = shouldPark ? 'parked' : 'deferred';
    record.nextEligibleAtMs = shouldPark ? 0 : nowMs + backoffForAttempt(config, record.attempts);
    if (shouldPark) record.parkedReason = 'authoritative_lookup_failure_ceiling';
    appendTransition(ledger, {
      key,
      atMs: nowMs,
      actor,
      from,
      to: record.state,
      reason: shouldPark ? record.parkedReason : record.lastDeferReason,
      metadata: {
        attempts: record.attempts,
        failureReason: record.lastDeferReason,
        nextEligibleAtMs: record.nextEligibleAtMs,
      },
    });
    writeCiRedWatchdogLedger(storeDir, ledger);
    return {
      ok: true,
      action: shouldPark ? 'park' : 'defer',
      reason: shouldPark ? record.parkedReason : record.lastDeferReason,
      key,
      record,
    };
  }, { config });
}

export function resolveCiRedWatchdogLookupFailure({
  storeDir = '',
  lookup,
  nowMs = Date.now(),
  actor = 'ci-failure-notification-reconcile',
  config: rawConfig = {},
} = {}) {
  const config = resolveCiRedWatchdogConfig(rawConfig);
  const identity = normalizeLookupFailureIdentity(lookup);
  const key = ciRedLookupFailureKey(identity);
  return withCiRedWatchdogLedgerLock(storeDir, () => {
    const ledger = readCiRedWatchdogLedger(storeDir);
    const record = ledger.lookupFailures?.[key];
    if (!record || record.state === 'resolved') return { ok: true, resolved: false, key };
    const from = String(record.state || 'deferred');
    record.state = 'resolved';
    record.updatedAtMs = nowMs;
    record.resolvedAtMs = nowMs;
    record.nextEligibleAtMs = 0;
    appendTransition(ledger, {
      key,
      atMs: nowMs,
      actor,
      from,
      to: 'resolved',
      reason: 'authoritative_lookup_recovered',
      metadata: { attempts: Number(record.attempts ?? 0) },
    });
    writeCiRedWatchdogLedger(storeDir, ledger);
    return { ok: true, resolved: true, key, record };
  }, { config });
}

function backoffForAttempt(config, attempts) {
  const index = Math.max(0, Math.min(config.backoffMs.length - 1, Math.max(1, attempts) - 1));
  return config.backoffMs[index];
}

function recoverExpiredAttempt(ledger, key, record, nowMs, config, actor) {
  if (!record?.currentAttempt || !['leased', 'awaiting-submit'].includes(record.state)) return false;
  const deadline = record.state === 'leased'
    ? Number(record.currentAttempt.leaseExpiresAtMs ?? 0)
    : Number(record.currentAttempt.submitProofDeadlineMs ?? 0);
  if (!deadline || deadline > nowMs) return false;
  const from = record.state;
  record.state = 'deferred';
  record.updatedAtMs = nowMs;
  record.lastDeferReason = from === 'leased' ? 'claim_lease_expired' : 'submit_proof_timeout';
  record.nextEligibleAtMs = nowMs + backoffForAttempt(config, record.attempts);
  appendTransition(ledger, {
    key,
    atMs: nowMs,
    actor,
    attemptId: record.currentAttempt.attemptId,
    from,
    to: record.state,
    reason: record.lastDeferReason,
  });
  record.currentAttempt = null;
  return true;
}

export function claimCiRedWatchdogEpisode({ storeDir = '', candidate, nowMs = Date.now(), owner = 'ci-failure-notification-reconcile', config: rawConfig = {} } = {}) {
  const config = resolveCiRedWatchdogConfig(rawConfig);
  return withCiRedWatchdogLedgerLock(storeDir, () => {
    const ledger = readCiRedWatchdogLedger(storeDir);
    const key = ciRedEpisodeKey(candidate?.episode);
    let record = ledger.episodes[key] ?? baseEpisodeRecord(candidate.episode, nowMs);
    ledger.episodes[key] = record;
    recoverExpiredAttempt(ledger, key, record, nowMs, config, owner);
    const decision = evaluateCiRedWatchdogCandidate({ candidate, record, nowMs, config });
    if (decision.action === 'park') {
      const from = record.state;
      record.state = 'parked';
      record.updatedAtMs = nowMs;
      record.parkedReason = decision.reason;
      record.currentAttempt = null;
      appendTransition(ledger, { key, atMs: nowMs, actor: owner, from, to: 'parked', reason: decision.reason, metadata: { attempts: record.attempts } });
      writeCiRedWatchdogLedger(storeDir, ledger, config);
      return { ok: true, action: 'park', reason: decision.reason, key, record };
    }
    if (decision.action !== 'send') {
      const from = record.state;
      if (!['verified-delivered', 'parked', 'leased', 'awaiting-submit'].includes(record.state)) record.state = 'deferred';
      record.updatedAtMs = nowMs;
      record.lastDeferReason = decision.reason;
      if (candidate?.diagnostic?.fingerprint) record.diagnosticFingerprint = String(candidate.diagnostic.fingerprint);
      appendTransition(ledger, { key, atMs: nowMs, actor: owner, from, to: record.state, reason: decision.reason });
      writeCiRedWatchdogLedger(storeDir, ledger, config);
      return { ok: true, ...decision, key, record };
    }

    const candidateGeneration = String(candidate.worker.sessionGeneration);
    const priorGeneration = String(record.recipientSessionGeneration ?? '');
    if (priorGeneration && priorGeneration !== candidateGeneration && !record.currentAttempt) {
      const priorState = record.state;
      record.state = 'armed';
      record.attempts = 0;
      record.nextEligibleAtMs = nowMs;
      record.lastDeferReason = '';
      delete record.parkedReason;
      appendTransition(ledger, {
        key,
        atMs: nowMs,
        actor: owner,
        from: priorState,
        to: 'armed',
        reason: 'session_generation_changed_rearm',
        metadata: { priorGeneration, nextGeneration: candidateGeneration },
      });
    }
    const attemptId = `ci-red-watchdog:${key}:${record.attempts + 1}:${randomUUID()}`;
    const from = record.state;
    record.state = 'leased';
    record.updatedAtMs = nowMs;
    record.attempts = Number(record.attempts ?? 0) + 1;
    record.totalAttempts = Number(record.totalAttempts ?? 0) + 1;
    record.lastDeferReason = '';
    record.diagnosticFingerprint = String(candidate.diagnostic.fingerprint);
    record.recipientSessionId = String(candidate.worker.sessionId);
    record.recipientSessionGeneration = String(candidate.worker.sessionGeneration);
    record.currentAttempt = {
      attemptId,
      leaseOwner: String(owner),
      claimedAtMs: nowMs,
      leaseExpiresAtMs: nowMs + config.leaseMs,
      sessionId: record.recipientSessionId,
      sessionGeneration: candidateGeneration,
      diagnosticFingerprint: record.diagnosticFingerprint,
    };
    appendTransition(ledger, { key, atMs: nowMs, actor: owner, attemptId, from, to: 'leased', reason: 'atomic_send_claim', metadata: { attempt: record.attempts, totalAttempts: record.totalAttempts } });
    writeCiRedWatchdogLedger(storeDir, ledger, config);
    return { ok: true, action: 'send', reason: decision.reason, key, attemptId, record };
  }, { config });
}

function mutateMatchingAttempt({ storeDir, episode, attemptId, nowMs, actor, config: rawConfig, mutation }) {
  const config = resolveCiRedWatchdogConfig(rawConfig);
  return withCiRedWatchdogLedgerLock(storeDir, () => {
    const ledger = readCiRedWatchdogLedger(storeDir);
    const key = ciRedEpisodeKey(episode);
    const record = ledger.episodes[key];
    if (!record) return { ok: false, reason: 'episode_not_found', key };
    if (String(record.currentAttempt?.attemptId ?? '') !== String(attemptId ?? '')) {
      return { ok: false, reason: 'attempt_mismatch', key };
    }
    const result = mutation({ ledger, key, record, config });
    writeCiRedWatchdogLedger(storeDir, ledger, config);
    return { ok: true, key, record, ...result };
  }, { config });
}

export function markCiRedWatchdogTransportIssued({ storeDir = '', episode, attemptId, nowMs = Date.now(), actor = 'ci-failure-notification-reconcile', config = {} } = {}) {
  return mutateMatchingAttempt({ storeDir, episode, attemptId, nowMs, actor, config, mutation: ({ ledger, key, record, config: resolved }) => {
    if (record.state !== 'leased') return { accepted: false, reason: 'invalid_state_for_transport' };
    const from = record.state;
    record.state = 'awaiting-submit';
    record.updatedAtMs = nowMs;
    record.currentAttempt.transportIssuedAtMs = nowMs;
    record.currentAttempt.submitProofDeadlineMs = nowMs + resolved.submitProofTimeoutMs;
    appendTransition(ledger, { key, atMs: nowMs, actor, attemptId, from, to: record.state, reason: 'transport_issued' });
    return { accepted: true, reason: 'awaiting_submit' };
  } });
}

export function releaseCiRedWatchdogAttempt({ storeDir = '', episode, attemptId, reason = 'attempt_released', nowMs = Date.now(), actor = 'ci-failure-notification-reconcile', config = {} } = {}) {
  return mutateMatchingAttempt({ storeDir, episode, attemptId, nowMs, actor, config, mutation: ({ ledger, key, record, config: resolved }) => {
    const from = record.state;
    const shouldPark = record.attempts >= resolved.maxAttempts || nowMs - record.createdAtMs >= resolved.episodeLifetimeMs;
    record.state = shouldPark ? 'parked' : 'deferred';
    record.updatedAtMs = nowMs;
    record.lastDeferReason = String(reason);
    record.nextEligibleAtMs = shouldPark ? 0 : nowMs + backoffForAttempt(resolved, record.attempts);
    if (shouldPark) record.parkedReason = record.attempts >= resolved.maxAttempts ? 'attempt_ceiling' : 'episode_lifetime';
    appendTransition(ledger, {
      key,
      atMs: nowMs,
      actor,
      attemptId,
      from,
      to: record.state,
      reason: shouldPark ? record.parkedReason : reason,
      metadata: { attempts: record.attempts, nextEligibleAtMs: record.nextEligibleAtMs },
    });
    record.currentAttempt = null;
    return { accepted: true, parked: shouldPark, reason: shouldPark ? record.parkedReason : reason };
  } });
}

function submittedEvidenceForAttempt(submitState, attemptId) {
  const deliveries = submitState?.deliveries;
  if (!deliveries || typeof deliveries !== 'object') return null;
  const record = deliveries[attemptId];
  if (!record || typeof record !== 'object') return null;
  return {
    terminalState: String(record.terminalState ?? ''),
    submittedAtMs: finitePositive(record.submittedAtMs ?? record.terminalAtMs ?? record.updatedAtMs),
    sessionId: String(record.sessionId ?? ''),
  };
}

export function reconcileCiRedWatchdogSubmitted({ storeDir = '', submitState = {}, currentCandidates = [], nowMs = Date.now(), actor = 'ci-failure-notification-reconcile', config: rawConfig = {} } = {}) {
  const config = resolveCiRedWatchdogConfig(rawConfig);
  const candidateByKey = new Map();
  for (const candidate of Array.isArray(currentCandidates) ? currentCandidates : []) {
    try { candidateByKey.set(ciRedEpisodeKey(candidate.episode), candidate); } catch { /* invalid candidates are ignored fail-closed */ }
  }
  return withCiRedWatchdogLedgerLock(storeDir, () => {
    const ledger = readCiRedWatchdogLedger(storeDir);
    const results = [];
    for (const [key, record] of Object.entries(ledger.episodes)) {
      if (!record?.currentAttempt || record.state !== 'awaiting-submit') continue;
      const attemptId = String(record.currentAttempt.attemptId ?? '');
      const evidence = submittedEvidenceForAttempt(submitState, attemptId);
      if (!evidence || evidence.terminalState !== 'submitted') {
        recoverExpiredAttempt(ledger, key, record, nowMs, config, actor);
        continue;
      }
      const candidate = candidateByKey.get(key);
      if (!candidate) {
        const from = record.state;
        record.state = 'deferred';
        record.updatedAtMs = nowMs;
        record.lastDeferReason = 'verified_commit_eligibility_missing';
        record.nextEligibleAtMs = nowMs + backoffForAttempt(config, record.attempts);
        appendTransition(ledger, { key, atMs: nowMs, actor, attemptId, from, to: record.state, reason: record.lastDeferReason });
        record.currentAttempt = null;
        results.push({ key, attemptId, verified: false, reason: 'verified_commit_eligibility_missing' });
        continue;
      }
      // A verified submit is correlated to the diagnostic fingerprint reserved on the
      // durable attempt. Do not require GitHub log retention to remain available after
      // Enter: eligibility, head/run identity, worker liveness and generation are still
      // revalidated, while the already-sanitized diagnostic provenance is recovered from
      // the durable claim rather than fetched again.
      const verificationCandidate = {
        ...candidate,
        diagnostic: {
          available: true,
          fingerprint: String(record.currentAttempt.diagnosticFingerprint ?? record.diagnosticFingerprint ?? ''),
          headSha: record.identity.headSha,
          checkRunId: record.identity.checkRunId,
          attempt: record.identity.attempt,
        },
      };
      const decision = evaluateCiRedWatchdogCandidate({
        candidate: verificationCandidate,
        record: { ...record, currentAttempt: null, state: 'deferred' },
        nowMs,
        config,
        verificationMode: true,
      });
      if (!['send', 'suppress'].includes(decision.action) || (decision.action === 'suppress' && decision.reason !== 'verified_delivered_current_generation')) {
        const from = record.state;
        record.state = 'deferred';
        record.updatedAtMs = nowMs;
        record.lastDeferReason = `verified_commit_${decision.reason}`;
        record.nextEligibleAtMs = nowMs + backoffForAttempt(config, record.attempts);
        appendTransition(ledger, { key, atMs: nowMs, actor, attemptId, from, to: record.state, reason: record.lastDeferReason });
        record.currentAttempt = null;
        results.push({ key, attemptId, verified: false, reason: record.lastDeferReason });
        continue;
      }
      const generation = String(record.currentAttempt.sessionGeneration ?? '');
      if (!generation || generation !== String(candidate.worker?.sessionGeneration ?? '')) {
        const from = record.state;
        record.state = 'deferred';
        record.updatedAtMs = nowMs;
        record.lastDeferReason = 'verified_commit_session_generation_changed';
        record.nextEligibleAtMs = nowMs + backoffForAttempt(config, record.attempts);
        appendTransition(ledger, { key, atMs: nowMs, actor, attemptId, from, to: record.state, reason: record.lastDeferReason });
        record.currentAttempt = null;
        results.push({ key, attemptId, verified: false, reason: record.lastDeferReason });
        continue;
      }
      const from = record.state;
      record.state = 'verified-delivered';
      record.updatedAtMs = nowMs;
      record.verifiedDeliveries[generation] = {
        terminalState: 'submitted',
        attemptId,
        submittedAtMs: evidence.submittedAtMs ?? nowMs,
        sessionId: String(record.currentAttempt.sessionId ?? ''),
      };
      record.currentAttempt = null;
      record.nextEligibleAtMs = 0;
      appendTransition(ledger, { key, atMs: nowMs, actor, attemptId, from, to: record.state, reason: 'terminal_submitted_verified' });
      results.push({ key, attemptId, verified: true, reason: 'terminal_submitted_verified' });
    }
    writeCiRedWatchdogLedger(storeDir, ledger, config);
    return { ok: true, results, ledger };
  }, { config });
}

export function inspectCiRedWatchdogAttempt({ storeDir = '', attemptId = '' } = {}) {
  const ledger = readCiRedWatchdogLedger(storeDir);
  for (const [key, record] of Object.entries(ledger.episodes)) {
    if (String(record?.currentAttempt?.attemptId ?? '') === String(attemptId)) {
      return { found: true, key, record };
    }
    for (const [generation, evidence] of Object.entries(record?.verifiedDeliveries ?? {})) {
      if (String(evidence?.attemptId ?? '') === String(attemptId)) return { found: true, key, generation, record };
    }
  }
  return { found: false };
}

export function ledgerContainsRawDiagnostic(ledger, diagnosticText) {
  const needle = String(diagnosticText ?? '');
  if (!needle) return false;
  return JSON.stringify(ledger).includes(needle);
}
