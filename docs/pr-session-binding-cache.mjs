/** Pack-side PR↔session binding cache and Issue #857 read contract. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { withJsonStateFileLock } from './json-state-file-lock.mjs';
import {
  DEFER_AMBIGUOUS_ISSUE_PR_BINDING,
  DEFER_AMBIGUOUS_PR_SESSION_BINDING,
  DEFER_AMBIGUOUS_SESSION_PRS,
  getSessionIssueNumber,
  resolvePrOwningWorkerSessionBinding,
  resolveSessionPrBinding,
} from './session-pr-binding-resolver.mjs';

export const PR_SESSION_BINDING_CACHE_SCHEMA_VERSION = 1;
export const PACK_PR_SESSION_BINDING_CACHE_SURFACE = 'pack-pr-session-binding-cache';
export const DEFAULT_BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_BINDING_MAX_RECORDS = 512;
export const BINDING_SOURCE_PUSH_REGISTER = 'push_register';
export const BINDING_SOURCE_CLAIM_PR = 'claim_pr';
export const BINDING_SOURCE_BACKFILL_RESOLVER = 'backfill_resolver';
export const PR_SESSION_BINDING_REASON_SET_VERSION = 1;
export const PR_SESSION_BINDING_FAIL_CLOSED_REASONS = Object.freeze([
  'no_source', 'live_ambiguous', 'stale_cache_no_live', 'stale_cache_live_ambiguous',
  'binding_cache_conflict', 'ambiguous_issue_pr_binding', 'ambiguous_pr_session_binding',
  'head_owner_mismatch', 'no_worker_session', 'binding_miss_after_backfill',
  'binding_cache_read_failed', 'binding_cache_lock_timeout', 'binding_cache_cas_exhausted',
  'missing_pr_number', 'missing_session_id', 'missing_repo_slug',
]);

const COLLISION = 'binding_collision';
const MAX_CAS_ATTEMPTS = 8;
const n = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const text = (v) => String(v ?? '').trim();
const repo = (v) => text(v).toLowerCase();
const sha = (v) => /^[0-9a-f]{7,64}$/i.test(text(v)) ? text(v).toLowerCase() : '';
const normalizeSha = sha;
const array = (v) => Array.isArray(v) ? v : v == null ? [] : [v];
const sessionIdOf = (s) => text(s?.sessionId ?? s?.id ?? s?.name) || null;
const findSession = (sessions, id) => array(sessions).find((s) => sessionIdOf(s) === text(id)) ?? null;
const terminal = (pr) => ['closed', 'merged'].includes(text(pr?.state).toLowerCase()) || pr?.merged === true || pr?.closed === true;
const tempPath = (p) => `${p}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;

function normalizeRepoFromCwd(env = process.env, cwd = process.cwd()) {
  const explicit = repo(env.AO_REPO_SLUG ?? env.GITHUB_REPOSITORY);
  if (explicit) return explicit;
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return repo(remote.match(/github\.com[:/]([^/]+\/[^/.]+)/i)?.[1]);
  } catch { return ''; }
}

function findOpenPr(openPrs, repoSlug, prNumber) {
  const scope = repo(repoSlug);
  return array(openPrs).find((pr) => {
    const rowRepo = repo(pr?.repoSlug ?? pr?.repository ?? scope);
    return n(pr?.number) === n(prNumber) && (!scope || !rowRepo || rowRepo === scope);
  }) ?? null;
}

export function bindingRecordIsLive(record, openPrs = [], authoritative = false, repoSlug = '', nowMs = Date.now(), ttlMs = DEFAULT_BINDING_TTL_MS) {
  if (!record || record.superseded || n(record.prNumber) <= 0) return false;
  if (n(record.lastUpdatedMs) > 0 && nowMs - n(record.lastUpdatedMs) > ttlMs) return false;
  const scope = repo(repoSlug);
  if (scope && repo(record.repoSlug) && repo(record.repoSlug) !== scope) return false;
  const pr = findOpenPr(openPrs, scope || record.repoSlug, record.prNumber);
  return pr ? !terminal(pr) : !authoritative;
}

export function resolvePrSessionBindingCachePath(env = process.env) {
  if (env.AO_PR_SESSION_BINDING_CACHE) return String(env.AO_PR_SESSION_BINDING_CACHE);
  if (env.AO_REPORT_STATE_SEED_STATE) return join(dirname(String(env.AO_REPORT_STATE_SEED_STATE)), 'pr-session-binding-cache.json');
  return join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor', 'pr-session-binding-cache.json');
}

export function createDefaultPrSessionBindingCache(raw = {}) {
  return {
    schemaVersion: PR_SESSION_BINDING_CACHE_SCHEMA_VERSION,
    lastUpdatedMs: n(raw.lastUpdatedMs) || null,
    generation: n(raw.generation),
    records: raw.records && typeof raw.records === 'object' ? { ...raw.records } : {},
  };
}

export function readPrSessionBindingCacheFile(path) {
  return existsSync(path) ? createDefaultPrSessionBindingCache(JSON.parse(readFileSync(path, 'utf8'))) : createDefaultPrSessionBindingCache();
}

export function writePrSessionBindingCacheFile(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  writeFileSync(tmp, `${JSON.stringify(store)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function writePrSessionBindingCacheFileWithCas(path, store, expectedGeneration) {
  const result = withJsonStateFileLock(path, () => {
    const liveGeneration = existsSync(path) ? n(JSON.parse(readFileSync(path, 'utf8'))?.generation) : 0;
    if (liveGeneration !== n(expectedGeneration)) return { ok: false, reason: 'generation_mismatch', generation: liveGeneration };
    writePrSessionBindingCacheFile(path, store);
    return { ok: true, generation: n(store.generation) };
  });
  return result?.reason === 'state_file_lock_timeout' ? { ok: false, reason: 'binding_cache_lock_timeout' } : result;
}

export function updatePrSessionBindingCacheWithCas(cachePath, mutator, nowMs = Date.now()) {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    let observed;
    try { observed = readPrSessionBindingCacheFile(cachePath); }
    catch { observed = createDefaultPrSessionBindingCache(); }
    const expected = n(observed.generation);
    const store = createDefaultPrSessionBindingCache(observed);
    const mutation = mutator(store, nowMs);
    if (!mutation?.ok) return mutation;
    const result = writePrSessionBindingCacheFileWithCas(cachePath, store, expected);
    if (result?.ok) return { ok: true, reason: mutation.reason, generation: result.generation };
    if (result?.reason === 'binding_cache_lock_timeout') return result;
  }
  return { ok: false, reason: 'binding_cache_cas_exhausted', diagnostic: 'generation_mismatch' };
}

export const buildSessionBindingKey = (repoSlug, sessionId) => `${repo(repoSlug)}|session:${text(sessionId)}`;
export const buildPrBindingKey = (repoSlug, prNumber) => `${repo(repoSlug)}|pr:${n(prNumber)}`;

function record(input, nowMs) {
  return {
    schemaVersion: 1,
    sessionId: text(input.sessionId), prNumber: n(input.prNumber),
    issueNumber: n(input.issueNumber) || null, headSha: sha(input.headSha) || null,
    repoSlug: repo(input.repoSlug), source: text(input.source), lastUpdatedMs: nowMs,
    superseded: Boolean(input.superseded), ...(input.conflict ? { conflict: input.conflict } : {}),
  };
}

function supersede(store, old, nowMs, conflict) {
  if (!old) return false;
  let changed = false;
  for (const key of [buildSessionBindingKey(old.repoSlug, old.sessionId), buildPrBindingKey(old.repoSlug, old.prNumber)]) {
    if (store.records[key]) {
      store.records[key] = { ...store.records[key], superseded: true, lastUpdatedMs: nowMs, ...(conflict ? { conflict } : {}) };
      changed = true;
    }
  }
  if (changed) { store.lastUpdatedMs = nowMs; store.generation = n(store.generation) + 1; }
  return changed;
}

function cap(store, max, nowMs) {
  const entries = Object.entries(store.records);
  if (entries.length <= max) return;
  for (const [key] of entries.sort((a, b) => n(a[1]?.lastUpdatedMs) - n(b[1]?.lastUpdatedMs)).slice(0, entries.length - max)) delete store.records[key];
  store.lastUpdatedMs = nowMs; store.generation = n(store.generation) + 1;
}

export function registerPrSessionBindingRecord(store, input, nowMs) {
  const id = text(input.sessionId), prNumber = n(input.prNumber), repoSlug = repo(input.repoSlug);
  if (!id || prNumber <= 0 || !repoSlug) return { ok: false, reason: 'invalid_binding_record' };
  const sessionKey = buildSessionBindingKey(repoSlug, id), prKey = buildPrBindingKey(repoSlug, prNumber);
  let bySession = store.records[sessionKey] ?? null;
  const byPr = store.records[prKey] ?? null;
  const openPrs = array(input.openPrs);
  if (input.source === BINDING_SOURCE_PUSH_REGISTER && bySession && !bySession.superseded && n(bySession.prNumber) !== prNumber) {
    if (!openPrs.length || bindingRecordIsLive(bySession, openPrs, true, repoSlug, nowMs)) return { ok: false, reason: COLLISION, diagnostic: 'ambiguous_binding' };
    supersede(store, bySession, nowMs, { reason: 'push_register_rebind' }); bySession = null;
  }
  const same = bySession && !bySession.superseded && bySession.sessionId === id && n(bySession.prNumber) === prNumber;
  if (same) {
    const next = record({ ...bySession, ...input, sessionId: id, prNumber, repoSlug }, nowMs);
    store.records[sessionKey] = next; store.records[prKey] = next;
    store.lastUpdatedMs = nowMs; store.generation = n(store.generation) + 1;
    return { ok: true, reason: 'converged' };
  }
  const sessionLive = bySession && bindingRecordIsLive(bySession, openPrs, false, repoSlug, nowMs);
  const prLive = byPr && bindingRecordIsLive(byPr, openPrs, false, repoSlug, nowMs);
  if ((sessionLive && n(bySession.prNumber) !== prNumber) || (prLive && byPr.sessionId !== id)) return { ok: false, reason: COLLISION, diagnostic: 'ambiguous_binding' };
  if (bySession && !sessionLive) supersede(store, bySession, nowMs, { reason: 'stale_replaced' });
  if (byPr && !prLive && byPr.sessionId !== id) supersede(store, byPr, nowMs, { reason: 'stale_replaced' });
  const next = record({ ...input, sessionId: id, prNumber, repoSlug }, nowMs);
  store.records[sessionKey] = next; store.records[prKey] = next;
  store.lastUpdatedMs = nowMs; store.generation = n(store.generation) + 1;
  cap(store, n(input.maxRecords) || DEFAULT_BINDING_MAX_RECORDS, nowMs);
  return { ok: true, reason: bySession || byPr ? 'binding_superseded' : 'registered' };
}

export function lookupBindingByPr(store, repoSlug, prNumber) {
  const value = store.records?.[buildPrBindingKey(repoSlug, prNumber)] ?? null;
  return !value || value.superseded ? null : value;
}
export function lookupBindingBySession(store, repoSlug, sessionId) {
  const value = store.records?.[buildSessionBindingKey(repoSlug, sessionId)] ?? null;
  return !value || value.superseded ? null : value;
}

export function evictPrSessionBindings({ store, openPrs = [], nowMs, ttlMs = DEFAULT_BINDING_TTL_MS, maxRecords = DEFAULT_BINDING_MAX_RECORDS, openListAuthoritative = false, repoSlug = '' }) {
  let removed = 0;
  for (const [key, value] of Object.entries(store.records ?? {})) {
    if (value.superseded || !bindingRecordIsLive(value, openPrs, openListAuthoritative, repoSlug, nowMs, ttlMs)) { delete store.records[key]; removed += 1; }
  }
  if (removed) { store.lastUpdatedMs = nowMs; store.generation = n(store.generation) + 1; }
  cap(store, maxRecords, nowMs);
  return { removed, recordCount: Object.keys(store.records).length };
}

const cacheRank = (source) => source === BINDING_SOURCE_PUSH_REGISTER ? 500 : source === BINDING_SOURCE_CLAIM_PR ? 300 : 100;
const liveRank = (binding) => binding?.bindingSource === 'live_prs' ? 400 : 200;
const ambiguous = (binding) => [DEFER_AMBIGUOUS_SESSION_PRS, DEFER_AMBIGUOUS_ISSUE_PR_BINDING, DEFER_AMBIGUOUS_PR_SESSION_BINDING].includes(binding?.deferReason);
const unbound = (reason, sessionId, extra = {}) => ({ bound: false, ok: false, failClosed: true, sessionId: sessionId || null, reason, ...extra });

function loadStore(input) {
  if (input.store) {
    if (!input.store.records || typeof input.store.records !== 'object') input.store.records = {};
    if (!Number.isFinite(Number(input.store.generation))) input.store.generation = 0;
    return { store: input.store, cachePath: input.cachePath, readFailed: false };
  }
  const cachePath = input.cachePath ?? resolvePrSessionBindingCachePath(input.env);
  try { return { store: readPrSessionBindingCacheFile(cachePath), cachePath, readFailed: false }; }
  catch (error) { return { store: createDefaultPrSessionBindingCache(), cachePath, readFailed: true, error }; }
}

function writePair({ store, cachePath, input, nowMs, writeBackfill, old }) {
  const mutate = (target, writeMs) => {
    if (old) supersede(target, old, writeMs, input.conflict);
    return registerPrSessionBindingRecord(target, input, writeMs);
  };
  if (!writeBackfill) return mutate(store, nowMs);
  if (!cachePath) return mutate(store, nowMs);
  return updatePrSessionBindingCacheWithCas(cachePath, mutate, nowMs);
}

export function resolveSessionPrBindingForConsumer(input) {
  const id = text(input.sessionId ?? sessionIdOf(input.session)), repoSlug = repo(input.repoSlug);
  if (!id) return unbound('missing_session_id', null);
  if (!repoSlug) return unbound('missing_repo_slug', id);
  const nowMs = n(input.nowMs) || Date.now(), openPrs = array(input.openPrs);
  const loaded = loadStore(input);
  if (loaded.readFailed) return unbound('binding_cache_read_failed', id, { diagnostic: text(loaded.error?.message) });
  const store = loaded.store;
  const raw = store.records?.[buildSessionBindingKey(repoSlug, id)] ?? null;
  const cacheLive = bindingRecordIsLive(raw, openPrs, Boolean(input.openListAuthoritative), repoSlug, nowMs, input.ttlMs ?? DEFAULT_BINDING_TTL_MS);
  const live = resolveSessionPrBinding(input.session ?? {}, openPrs, { repoSlug, headSha: input.headSha, openListAuthoritative: input.openListAuthoritative });
  const liveAmbiguous = ambiguous(live), liveBound = Boolean(live.bound && n(live.prNumber) > 0);
  if (!raw && !liveBound) return unbound(liveAmbiguous ? 'live_ambiguous' : 'no_source', id, { deferReason: live.deferReason });
  if (!raw && liveBound) {
    const result = writePair({ store, cachePath: loaded.cachePath, nowMs, writeBackfill: input.writeBackfill !== false, input: {
      sessionId: id, prNumber: live.prNumber, repoSlug, issueNumber: getSessionIssueNumber(input.session), headSha: input.headSha,
      source: BINDING_SOURCE_BACKFILL_RESOLVER, openPrs,
    } });
    return result.ok ? { bound: true, ok: true, failClosed: false, sessionId: id, prNumber: n(live.prNumber), source: 'live', bindingSource: live.bindingSource, reason: 'live_hit', bindingCacheGeneration: n(result.generation ?? store.generation) }
      : unbound(result.reason === COLLISION ? 'binding_cache_conflict' : result.reason, id, { diagnostic: result.diagnostic });
  }
  if (!cacheLive) {
    if (!liveBound) return unbound(liveAmbiguous ? 'stale_cache_live_ambiguous' : 'stale_cache_no_live', id, { deferReason: live.deferReason });
    const result = writePair({ store, cachePath: loaded.cachePath, nowMs, writeBackfill: input.writeBackfill !== false, old: raw, input: {
      sessionId: id, prNumber: live.prNumber, repoSlug, issueNumber: getSessionIssueNumber(input.session), headSha: input.headSha,
      source: BINDING_SOURCE_BACKFILL_RESOLVER, openPrs, conflict: { reason: 'stale_cache_replaced', winner: live.bindingSource },
    } });
    return result.ok ? { bound: true, ok: true, failClosed: false, sessionId: id, prNumber: n(live.prNumber), source: 'live', bindingSource: live.bindingSource, reason: 'live_replaced_stale_cache', bindingCacheGeneration: n(result.generation ?? store.generation) }
      : unbound(result.reason, id, { diagnostic: result.diagnostic });
  }
  if (!liveBound) return { bound: true, ok: true, failClosed: false, sessionId: id, prNumber: n(raw.prNumber), source: 'cache', bindingSource: raw.source, reason: 'cache_hit', ...(liveAmbiguous ? { diagnostic: { liveReason: live.deferReason } } : {}) };
  if (n(raw.prNumber) === n(live.prNumber)) return { bound: true, ok: true, failClosed: false, sessionId: id, prNumber: n(raw.prNumber), source: 'cache', bindingSource: raw.source, reason: 'cache_hit_live_corroborated' };
  if (cacheRank(raw.source) >= liveRank(live)) return { bound: true, ok: true, failClosed: false, sessionId: id, prNumber: n(raw.prNumber), source: 'cache', bindingSource: raw.source, reason: 'cache_conflict_won', diagnostic: { loser: { source: live.bindingSource, prNumber: n(live.prNumber) } } };
  const result = writePair({ store, cachePath: loaded.cachePath, nowMs, writeBackfill: input.writeBackfill !== false, old: raw, input: {
    sessionId: id, prNumber: live.prNumber, repoSlug, issueNumber: getSessionIssueNumber(input.session), headSha: input.headSha,
    source: BINDING_SOURCE_BACKFILL_RESOLVER, openPrs, conflict: { reason: 'read_time_conflict', winner: live.bindingSource },
  } });
  return result.ok ? { bound: true, ok: true, failClosed: false, sessionId: id, prNumber: n(live.prNumber), source: 'live', bindingSource: live.bindingSource, reason: 'live_conflict_won', bindingCacheGeneration: n(result.generation ?? store.generation) }
    : unbound(result.reason, id, { diagnostic: result.diagnostic });
}

export function resolvePrSessionBindingForConsumer(input) {
  const targetPr = n(input.prNumber), repoSlug = repo(input.repoSlug);
  if (targetPr <= 0) return { sessionId: null, reason: 'missing_pr_number', failClosed: true, diagnostic: 'missing_pr_number' };
  if (!repoSlug) return { sessionId: null, reason: 'missing_repo_slug', failClosed: true };
  const loaded = loadStore(input);
  if (loaded.readFailed) return { sessionId: null, reason: 'binding_cache_read_failed', failClosed: true, diagnostic: text(loaded.error?.message) };
  const store = loaded.store, nowMs = n(input.nowMs) || Date.now(), openPrs = array(input.openPrs);
  const raw = store.records?.[buildPrBindingKey(repoSlug, targetPr)] ?? null;
  const cached = bindingRecordIsLive(raw, openPrs, Boolean(input.openListAuthoritative), repoSlug, nowMs) ? raw : null;
  const live = resolvePrOwningWorkerSessionBinding(input.sessions, targetPr, openPrs, { headSha: input.headSha, repoSlug, requireLive: true, isLive: input.isLive });
  if (live.failClosed) return { ...live, source: cached ? 'cache' : 'miss' };
  if (cached && live.sessionId && live.sessionId !== cached.sessionId) return {
    sessionId: live.sessionId, conflictingSessionId: cached.sessionId, reason: 'binding_cache_conflict', failClosed: true,
    deferReason: DEFER_AMBIGUOUS_PR_SESSION_BINDING, source: 'cache', diagnostic: 'binding_cache_conflict',
  };
  if (cached) return { sessionId: cached.sessionId, reason: 'cache_hit', failClosed: false, source: 'cache' };
  if (!live.sessionId) return { sessionId: null, reason: live.reason ?? 'binding_miss_after_backfill', failClosed: true, source: 'miss', diagnostic: live.reason };
  const session = findSession(input.sessions, live.sessionId);
  const result = writePair({ store, cachePath: loaded.cachePath, nowMs, writeBackfill: input.writeBackfill !== false, old: raw, input: {
    sessionId: live.sessionId, prNumber: targetPr, repoSlug, issueNumber: getSessionIssueNumber(session), headSha: input.headSha,
    source: BINDING_SOURCE_BACKFILL_RESOLVER, openPrs,
  } });
  return result.ok ? { sessionId: live.sessionId, reason: 'backfill_hit', failClosed: false, source: 'backfill_resolver' }
    : { sessionId: live.sessionId, reason: result.reason === COLLISION ? 'binding_cache_conflict' : result.reason, failClosed: true, source: 'miss', diagnostic: result.diagnostic };
}

export function resolveBindingRepoSlug(options = {}, openPrs = [], env = process.env, cwd = process.cwd()) {
  const explicit = repo(options.repoSlug); if (explicit) return explicit;
  const repos = new Set(array(openPrs).map((pr) => repo(pr?.repoSlug ?? pr?.repository)).filter(Boolean));
  return repos.size === 1 ? [...repos][0] : repos.size > 1 ? '' : normalizeRepoFromCwd(env, cwd);
}

export function sessionRowFromAoSessionGetPayload(payload) {
  const s = payload && typeof payload === 'object' && payload.session ? payload.session : payload;
  const id = sessionIdOf(s); if (!id) return null;
  const kind = text(s.kind ?? s.role).toLowerCase();
  return { id, sessionId: id, role: ['worker', 'coding'].includes(kind) ? 'worker' : kind, projectId: text(s.projectId), issueNumber: n(s.issueId ?? s.issueNumber), issueId: s.issueId, status: text(s.status ?? s.activity?.state), branch: text(s.branch), prs: array(s.prs), isTerminated: Boolean(s.isTerminated) };
}

export function loadPushRegisterVerifiedSessions(options = {}) {
  const env = options.env ?? process.env, cwd = options.cwd ?? process.cwd(), provided = array(options.sessions);
  if (provided.length) return { ok: true, sessions: provided, source: 'provided' };
  const id = text(env.AO_WORKER_SESSION_ID ?? env.AO_SESSION_ID);
  if (!id) return { ok: false, reason: 'push_register_missing_session_identity', sessions: [] };
  const repoSlug = normalizeRepoFromCwd(env, cwd), project = text(env.AO_PROJECT_ID ?? env.AO_PROJECT) || repoSlug.split('/').pop();
  const args = ['session', 'get', id, '--json']; if (project) args.push('-p', project);
  const aoCommand = text(env.AO_COMMAND) || 'ao';
  const result = spawnSync(aoCommand, args, {
    cwd,
    env: { ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
  try {
    if (result.status !== 0) throw new Error('failed');
    const row = sessionRowFromAoSessionGetPayload(JSON.parse(result.stdout));
    if (!row || sessionIdOf(row) !== id) throw new Error('identity');
    return { ok: true, sessions: [row], source: 'ao_session_get' };
  } catch { return { ok: false, reason: 'push_register_session_verify_failed', sessions: [] }; }
}

export function provePushRegisterWorkerIdentity(env = process.env, options = {}) {
  const id = text(env.AO_WORKER_SESSION_ID ?? env.AO_SESSION_ID);
  if (!id) return { ok: false, reason: 'push_register_missing_session_identity' };
  if (text(options.claimedSessionId) && text(options.claimedSessionId) !== id) return { ok: false, reason: 'push_register_session_identity_mismatch' };
  const repoSlug = normalizeRepoFromCwd(env, options.cwd ?? process.cwd());
  if (!repoSlug) return { ok: false, reason: 'push_register_missing_repo_identity' };
  const sessions = array(options.sessions); if (!sessions.length) return { ok: false, reason: 'push_register_session_verification_required' };
  const s = findSession(sessions, id); if (!s) return { ok: false, reason: 'push_register_session_not_found' };
  const role = text(s.role ?? s.kind).toLowerCase();
  if (role && !['worker', 'coding'].includes(role)) return { ok: false, reason: 'push_register_non_worker_role' };
  if (s.isTerminated === true) return { ok: false, reason: 'push_register_session_terminated' };
  const issueNumber = n(env.AO_ISSUE_NUMBER ?? env.GITHUB_ISSUE_NUMBER ?? getSessionIssueNumber(s));
  return { ok: true, sessionId: id, repoSlug, issueNumber: issueNumber || undefined };
}

export function fetchPriorPrOpenRowForPushRegister(repoSlug, prNumber, cwd = process.cwd(), env = process.env) {
  const slug = repo(repoSlug), number = n(prNumber); if (!slug || number <= 0) return null;
  const ghCommand = text(env.GH_BIN ?? env.AO_GH_COMMAND) || 'gh';
  const args = ['pr', 'view', String(number), '--repo', slug, '--json', 'number,state,headRefOid'];
  const result = spawnSync(ghCommand, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try { const parsed = JSON.parse(result.stdout); return result.status === 0 && n(parsed.number) > 0 ? { number: n(parsed.number), state: text(parsed.state) || 'OPEN', headRefOid: sha(parsed.headRefOid), repoSlug: slug } : null; }
  catch { return null; }
}

export function parsePrNumberFromGhPrCreateOutput(stdout = '', stderr = '') {
  const value = `${stdout}\n${stderr}`;
  return n(value.match(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i)?.[1] ?? value.match(/pull request #(\d+)/i)?.[1]);
}

export function isGhPrCreateArgv(argv = []) {
  const args = [...argv];
  while (args[0]?.startsWith('-')) { const flag = args.shift(); if (['--repo', '-R', '--hostname', '--config', '--cwd'].includes(flag)) args.shift(); }
  return args[0] === 'pr' && args[1] === 'create';
}

export function tryPushRegisterFromPrCreate({ argv, status, stdout, stderr, env = process.env, cwd = process.cwd(), sessions, fetchPriorPrOpenRow }) {
  if (!isGhPrCreateArgv(argv) || status !== 0) return { registered: false, reason: 'not_applicable' };
  const prNumber = parsePrNumberFromGhPrCreateOutput(stdout, stderr); if (prNumber <= 0) return { registered: false, reason: 'push_register_pr_number_unparsed' };
  const verified = loadPushRegisterVerifiedSessions({ env, cwd, sessions }); if (!verified.ok) return { registered: false, reason: verified.reason, diagnostic: verified.reason };
  const identity = provePushRegisterWorkerIdentity(env, { cwd, sessions: verified.sessions }); if (!identity.ok) return { registered: false, reason: identity.reason, diagnostic: identity.reason };
  let headSha = normalizeSha(env.AO_HEAD_SHA ?? env.GITHUB_SHA);
  if (!headSha) {
    try {
      headSha = normalizeSha(
        execSync('git rev-parse HEAD', {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      );
    } catch {
      headSha = '';
    }
  }
  try {
    const cachePath = resolvePrSessionBindingCachePath(env), current = readPrSessionBindingCacheFile(cachePath), prior = lookupBindingBySession(current, identity.repoSlug, identity.sessionId);
    const openPrs = prior && n(prior.prNumber) !== prNumber ? [fetchPriorPrOpenRow?.(identity.repoSlug, prior.prNumber, cwd, env) ?? fetchPriorPrOpenRowForPushRegister(identity.repoSlug, prior.prNumber, cwd, env)].filter(Boolean) : [];
    const result = updatePrSessionBindingCacheWithCas(cachePath, (store, nowMs) => registerPrSessionBindingRecord(store, { sessionId: identity.sessionId, prNumber, repoSlug: identity.repoSlug, issueNumber: identity.issueNumber, headSha, source: BINDING_SOURCE_PUSH_REGISTER, openPrs }, nowMs));
    return result.ok ? { registered: true, reason: result.reason ?? 'registered' } : { registered: false, reason: result.reason, diagnostic: result.diagnostic };
  } catch (error) { return { registered: false, reason: 'push_register_cache_io_failed', diagnostic: text(error?.message) }; }
}
