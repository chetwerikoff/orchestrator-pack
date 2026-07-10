/**
 * Pack-side PR↔session binding cache with push-register (Issue #719).
 * Vitest: scripts/pr-session-binding-cache.test.ts
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { normalizeSha, toArray } from './review-reconcile-primitives.mjs';
import {
  DEFER_AMBIGUOUS_ISSUE_PR_BINDING,
  DEFER_AMBIGUOUS_PR_SESSION_BINDING,
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

const COLLISION_REASON = 'binding_collision';
const SUPERSEDED_REASON = 'binding_superseded';

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeString(value) {
  return String(value ?? '').trim();
}

function normalizeRepoSlug(value) {
  return normalizeString(value).toLowerCase();
}

function getSessionIdentifier(session) {
  return normalizeString(session?.sessionId ?? session?.id ?? session?.name) || null;
}

function findSessionById(sessions, sessionId) {
  const target = normalizeString(sessionId);
  if (!target) {
    return null;
  }
  return toArray(sessions).find((session) => getSessionIdentifier(session) === target) ?? null;
}

function parseIssueNumberFromEnv(env = process.env) {
  for (const key of ['AO_ISSUE_NUMBER', 'GITHUB_ISSUE_NUMBER']) {
    const parsed = numberOrZero(env[key]);
    if (parsed > 0) {
      return parsed;
    }
  }
  const issueRef = normalizeString(env.AO_ISSUE_ID ?? env.GITHUB_ISSUE);
  if (issueRef) {
    const bare = issueRef.replace(/^#/, '');
    const parsed = numberOrZero(bare);
    if (parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function resolveRepoSlugFromEnvOrCwd(env = process.env, cwd = process.cwd()) {
  const explicit = normalizeRepoSlug(env.AO_REPO_SLUG ?? env.GITHUB_REPOSITORY);
  if (explicit) {
    return explicit;
  }
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/i);
    if (match?.[1]) {
      return normalizeRepoSlug(match[1]);
    }
  } catch {
    // best effort
  }
  return '';
}

function isTerminalOpenPr(pr) {
  const state = normalizeString(pr?.state).toLowerCase();
  return state === 'closed' || state === 'merged' || pr?.merged === true || pr?.closed === true;
}

function bindingRecordIsLive(record, openPrs = [], openListAuthoritative = false, repoSlug = '') {
  if (!record || record.superseded) {
    return false;
  }
  const prNumber = numberOrZero(record.prNumber);
  if (prNumber <= 0) {
    return false;
  }
  const recordRepo = normalizeRepoSlug(record.repoSlug);
  const scopeRepo = normalizeRepoSlug(repoSlug);
  if (scopeRepo && recordRepo && recordRepo !== scopeRepo) {
    return false;
  }
  const prRow = toArray(openPrs).find((pr) => {
    const prRepo = normalizeRepoSlug(pr?.repoSlug ?? pr?.repository ?? recordRepo);
    return numberOrZero(pr?.number) === prNumber && (!scopeRepo || !prRepo || prRepo === scopeRepo);
  });
  if (!prRow) {
    return openListAuthoritative ? false : true;
  }
  return !isTerminalOpenPr(prRow);
}

/**
 * @param {Record<string, unknown>} [env]
 */
export function resolvePrSessionBindingCachePath(env = process.env) {
  if (env.AO_PR_SESSION_BINDING_CACHE) {
    return String(env.AO_PR_SESSION_BINDING_CACHE);
  }
  if (env.AO_REPORT_STATE_SEED_STATE) {
    const seedPath = String(env.AO_REPORT_STATE_SEED_STATE);
    return join(dirname(seedPath), 'pr-session-binding-cache.json');
  }
  return join(
    homedir(),
    '.local',
    'state',
    'orchestrator-pack-wake-supervisor',
    'pr-session-binding-cache.json',
  );
}

/**
 * @param {Record<string, unknown>} [raw]
 */
export function createDefaultPrSessionBindingCache(raw = {}) {
  return {
    schemaVersion: PR_SESSION_BINDING_CACHE_SCHEMA_VERSION,
    lastUpdatedMs: Number(raw.lastUpdatedMs ?? 0) || null,
    generation: Number(raw.generation ?? 0) || 0,
    records:
      raw.records && typeof raw.records === 'object'
        ? { ...raw.records }
        : {},
  };
}

/**
 * @param {string} path
 */
export function readPrSessionBindingCacheFile(path) {
  if (!existsSync(path)) {
    return createDefaultPrSessionBindingCache();
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const schemaVersion = Number(parsed?.schemaVersion ?? 0);
  if (schemaVersion > PR_SESSION_BINDING_CACHE_SCHEMA_VERSION) {
    return createDefaultPrSessionBindingCache(parsed);
  }
  return createDefaultPrSessionBindingCache(parsed);
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} store
 */
export function writePrSessionBindingCacheFile(path, store) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(store)}\n`, 'utf8');
  renameSync(tempPath, path);
}

export function buildSessionBindingKey(repoSlug, sessionId) {
  return `${normalizeRepoSlug(repoSlug)}|session:${normalizeString(sessionId)}`;
}

export function buildPrBindingKey(repoSlug, prNumber) {
  return `${normalizeRepoSlug(repoSlug)}|pr:${numberOrZero(prNumber)}`;
}

function buildBindingRecord({
  sessionId,
  prNumber,
  repoSlug,
  issueNumber = 0,
  headSha = '',
  source,
  nowMs,
  superseded = false,
}) {
  return {
    schemaVersion: PR_SESSION_BINDING_CACHE_SCHEMA_VERSION,
    sessionId: normalizeString(sessionId),
    prNumber: numberOrZero(prNumber),
    issueNumber: numberOrZero(issueNumber) > 0 ? numberOrZero(issueNumber) : null,
    headSha: normalizeSha(headSha) || null,
    repoSlug: normalizeRepoSlug(repoSlug),
    source,
    lastUpdatedMs: nowMs,
    superseded: Boolean(superseded),
  };
}

function markRecordSuperseded(store, key, nowMs) {
  const existing = store.records[key];
  if (!existing) {
    return;
  }
  store.records[key] = {
    ...existing,
    superseded: true,
    lastUpdatedMs: nowMs,
  };
}

function enforceRecordCap(store, maxRecords, nowMs) {
  const entries = Object.entries(store.records ?? {});
  if (entries.length <= maxRecords) {
    return;
  }
  entries
    .sort((a, b) => numberOrZero(a[1]?.lastUpdatedMs) - numberOrZero(b[1]?.lastUpdatedMs))
    .slice(0, entries.length - maxRecords)
    .forEach(([key]) => {
      delete store.records[key];
    });
  store.lastUpdatedMs = nowMs;
  store.generation = numberOrZero(store.generation) + 1;
}

/**
 * @param {Record<string, unknown>} [env]
 * @param {{ claimedSessionId?: string, cwd?: string, sessions?: Array<Record<string, unknown>> }} [options]
 */
export function provePushRegisterWorkerIdentity(env = process.env, options = {}) {
  const sessionId = normalizeString(env.AO_WORKER_SESSION_ID ?? env.AO_SESSION_ID);
  if (!sessionId) {
    return { ok: false, reason: 'push_register_missing_session_identity' };
  }
  const claimed = normalizeString(options.claimedSessionId);
  if (claimed && claimed !== sessionId) {
    return { ok: false, reason: 'push_register_session_identity_mismatch' };
  }
  const child = normalizeString(env.AO_SIDE_PROCESS_CHILD_ID);
  const consumer = normalizeString(env.GH_GOVERNOR_CONSUMER);
  if (child && !/worker|interactive|orchestrator/i.test(consumer) && env.GH_GOVERNOR_LANE !== 'interactive') {
    return { ok: false, reason: 'push_register_non_worker_context' };
  }
  const repoSlug = resolveRepoSlugFromEnvOrCwd(env, options.cwd ?? process.cwd());
  if (!repoSlug) {
    return { ok: false, reason: 'push_register_missing_repo_identity' };
  }
  if (options.sessions) {
    const session = findSessionById(options.sessions, sessionId);
    if (!session) {
      return { ok: false, reason: 'push_register_session_not_found' };
    }
    const role = normalizeString(session.role).toLowerCase();
    if (role && role !== 'worker' && role !== 'coding') {
      return { ok: false, reason: 'push_register_non_worker_role' };
    }
  }
  const issueNumber = parseIssueNumberFromEnv(env) || getSessionIssueNumber(findSessionById(options.sessions ?? [], sessionId));
  return { ok: true, sessionId, repoSlug, issueNumber: issueNumber > 0 ? issueNumber : undefined };
}

/**
 * @param {Record<string, unknown>} store
 */
export function registerPrSessionBindingRecord(store, record, nowMs) {
  const sessionId = normalizeString(record.sessionId);
  const prNumber = numberOrZero(record.prNumber);
  const repoSlug = normalizeRepoSlug(record.repoSlug);
  if (!sessionId || prNumber <= 0 || !repoSlug) {
    return { ok: false, reason: 'invalid_binding_record' };
  }

  const sessionKey = buildSessionBindingKey(repoSlug, sessionId);
  const prKey = buildPrBindingKey(repoSlug, prNumber);
  const existingSession = store.records[sessionKey] ?? null;
  const existingPr = store.records[prKey] ?? null;
  const openPrs = toArray(record.openPrs);

  const samePair =
    existingSession
    && numberOrZero(existingSession.prNumber) === prNumber
    && normalizeString(existingSession.sessionId) === sessionId
    && !existingSession.superseded;

  if (samePair) {
    const merged = buildBindingRecord({
      sessionId,
      prNumber,
      repoSlug,
      issueNumber: numberOrZero(record.issueNumber ?? existingSession.issueNumber),
      headSha: normalizeSha(record.headSha ?? existingSession.headSha),
      source: record.source,
      nowMs,
    });
    store.records[sessionKey] = merged;
    store.records[prKey] = merged;
    store.lastUpdatedMs = nowMs;
    store.generation = numberOrZero(store.generation) + 1;
    return { ok: true, reason: 'converged' };
  }

  const sessionLive = existingSession && bindingRecordIsLive(existingSession, openPrs, false, repoSlug);
  const prLive = existingPr && bindingRecordIsLive(existingPr, openPrs, false, repoSlug);

  const sessionCollision =
    sessionLive
    && (normalizeString(existingSession.sessionId) !== sessionId
      || numberOrZero(existingSession.prNumber) !== prNumber);
  const prCollision =
    prLive
    && (normalizeString(existingPr.sessionId) !== sessionId
      || numberOrZero(existingPr.prNumber) !== prNumber);

  if (sessionCollision || prCollision) {
    return {
      ok: false,
      reason: COLLISION_REASON,
      diagnostic: 'ambiguous_binding',
    };
  }

  if (existingSession && !sessionLive) {
    markRecordSuperseded(store, sessionKey, nowMs);
    const oldPrKey = buildPrBindingKey(repoSlug, existingSession.prNumber);
    markRecordSuperseded(store, oldPrKey, nowMs);
  }
  if (existingPr && !prLive && normalizeString(existingPr.sessionId) !== sessionId) {
    markRecordSuperseded(store, prKey, nowMs);
    const oldSessionKey = buildSessionBindingKey(repoSlug, existingPr.sessionId);
    markRecordSuperseded(store, oldSessionKey, nowMs);
  }

  const next = buildBindingRecord({
    sessionId,
    prNumber,
    repoSlug,
    issueNumber: record.issueNumber,
    headSha: record.headSha,
    source: record.source,
    nowMs,
  });
  store.records[sessionKey] = next;
  store.records[prKey] = next;
  store.lastUpdatedMs = nowMs;
  store.generation = numberOrZero(store.generation) + 1;
  enforceRecordCap(store, numberOrZero(record.maxRecords) || DEFAULT_BINDING_MAX_RECORDS, nowMs);
  return { ok: true, reason: existingSession || existingPr ? SUPERSEDED_REASON : 'registered' };
}

export function lookupBindingByPr(store, repoSlug, prNumber) {
  const key = buildPrBindingKey(repoSlug, prNumber);
  const record = store.records?.[key] ?? null;
  if (!record || record.superseded) {
    return null;
  }
  return record;
}

export function lookupBindingBySession(store, repoSlug, sessionId) {
  const key = buildSessionBindingKey(repoSlug, sessionId);
  const record = store.records?.[key] ?? null;
  if (!record || record.superseded) {
    return null;
  }
  return record;
}

export function evictPrSessionBindings({
  store,
  openPrs = [],
  nowMs,
  ttlMs = DEFAULT_BINDING_TTL_MS,
  maxRecords = DEFAULT_BINDING_MAX_RECORDS,
  openListAuthoritative = false,
  repoSlug = '',
}) {
  let removed = 0;
  for (const [key, record] of Object.entries(store.records ?? {})) {
    const stale = numberOrZero(record?.lastUpdatedMs) > 0 && nowMs - numberOrZero(record.lastUpdatedMs) > ttlMs;
    const live = bindingRecordIsLive(record, openPrs, openListAuthoritative, repoSlug);
    if (record.superseded || stale || (openListAuthoritative && !live)) {
      delete store.records[key];
      removed += 1;
    }
  }
  if (removed > 0) {
    store.lastUpdatedMs = nowMs;
    store.generation = numberOrZero(store.generation) + 1;
  }
  enforceRecordCap(store, maxRecords, nowMs);
  return { removed, recordCount: Object.keys(store.records ?? {}).length };
}

function backfillAndMaybeWrite({
  store,
  cachePath,
  repoSlug,
  prNumber,
  headSha,
  sessions,
  openPrs,
  sessionDetailsById,
  nowMs,
  writeBackfill,
  isLive,
}) {
  const resolution = resolvePrOwningWorkerSessionBinding(sessions, prNumber, openPrs, {
    headSha,
    sessionDetailsById,
    requireLive: true,
    isLive,
  });

  if (resolution.deferReason === DEFER_AMBIGUOUS_ISSUE_PR_BINDING) {
    return {
      sessionId: null,
      reason: 'ambiguous_issue_pr_binding',
      failClosed: true,
      deferReason: DEFER_AMBIGUOUS_ISSUE_PR_BINDING,
      source: 'miss',
      diagnostic: 'ambiguous_binding',
    };
  }
  if (resolution.failClosed || resolution.deferReason === DEFER_AMBIGUOUS_PR_SESSION_BINDING) {
    return {
      sessionId: null,
      reason: resolution.reason ?? 'ambiguous_pr_session_binding',
      failClosed: true,
      deferReason: resolution.deferReason ?? DEFER_AMBIGUOUS_PR_SESSION_BINDING,
      source: 'miss',
      diagnostic: 'ambiguous_binding',
    };
  }
  if (!resolution.sessionId) {
    return {
      sessionId: null,
      reason: resolution.reason ?? 'binding_miss_after_backfill',
      failClosed: true,
      source: 'miss',
      diagnostic: resolution.reason ?? 'binding_miss_after_backfill',
    };
  }

  const session = findSessionById(sessions, resolution.sessionId);
  const issueNumber = getSessionIssueNumber(session);
  if (writeBackfill) {
    const register = registerPrSessionBindingRecord(
      store,
      {
        sessionId: resolution.sessionId,
        prNumber,
        repoSlug,
        issueNumber,
        headSha,
        source: BINDING_SOURCE_BACKFILL_RESOLVER,
        openPrs,
      },
      nowMs,
    );
    if (!register.ok && register.reason === COLLISION_REASON) {
      return {
        sessionId: null,
        reason: COLLISION_REASON,
        failClosed: true,
        deferReason: DEFER_AMBIGUOUS_PR_SESSION_BINDING,
        source: 'miss',
        diagnostic: register.diagnostic ?? 'ambiguous_binding',
      };
    }
    if (cachePath) {
      writePrSessionBindingCacheFile(cachePath, store);
    }
  }

  return {
    sessionId: resolution.sessionId,
    reason: 'backfill_hit',
    failClosed: false,
    source: 'backfill_resolver',
  };
}

export function resolvePrSessionBindingForConsumer({
  cachePath,
  store: inputStore,
  repoSlug,
  prNumber,
  headSha = '',
  sessions,
  openPrs = [],
  sessionDetailsById = {},
  nowMs = Date.now(),
  writeBackfill = true,
  isLive,
}) {
  const targetPr = numberOrZero(prNumber);
  if (targetPr <= 0) {
    return {
      sessionId: null,
      reason: 'missing_pr_number',
      failClosed: true,
      diagnostic: 'missing_pr_number',
    };
  }

  const cacheFile = cachePath ?? resolvePrSessionBindingCachePath();
  const store = inputStore ?? readPrSessionBindingCacheFile(cacheFile);
  evictPrSessionBindings({
    store,
    openPrs,
    nowMs,
    repoSlug,
  });

  const cached = lookupBindingByPr(store, repoSlug, targetPr);
  if (cached) {
    const session = findSessionById(sessions, cached.sessionId);
    if (session) {
      const binding = resolveSessionPrBinding(session, openPrs, {
        headSha,
        sessionDetail: sessionDetailsById[cached.sessionId] ?? null,
      });
      if (binding.deferReason === DEFER_AMBIGUOUS_ISSUE_PR_BINDING) {
        return {
          sessionId: null,
          reason: 'ambiguous_issue_pr_binding',
          failClosed: true,
          deferReason: DEFER_AMBIGUOUS_ISSUE_PR_BINDING,
          source: 'cache',
          diagnostic: 'ambiguous_binding',
        };
      }
    }
    return {
      sessionId: cached.sessionId,
      reason: 'cache_hit',
      failClosed: false,
      source: 'cache',
    };
  }

  return backfillAndMaybeWrite({
    store,
    cachePath: writeBackfill ? cacheFile : undefined,
    repoSlug,
    prNumber: targetPr,
    headSha,
    sessions,
    openPrs,
    sessionDetailsById,
    nowMs,
    writeBackfill,
    isLive,
  });
}

export function resolveBindingRepoSlug(options = {}, openPrs = [], env = process.env, cwd = process.cwd()) {
  const explicit = normalizeRepoSlug(options.repoSlug);
  if (explicit) {
    return explicit;
  }
  for (const pr of toArray(openPrs)) {
    const slug = normalizeRepoSlug(pr?.repoSlug ?? pr?.repository);
    if (slug) {
      return slug;
    }
  }
  return resolveRepoSlugFromEnvOrCwd(env, cwd);
}

export function parsePrNumberFromGhPrCreateOutput(stdout = '', stderr = '') {
  const combined = `${stdout}\n${stderr}`;
  const urlMatch = combined.match(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i);
  if (urlMatch?.[1]) {
    return numberOrZero(urlMatch[1]);
  }
  const bareMatch = combined.match(/pull request #(\d+)/i);
  if (bareMatch?.[1]) {
    return numberOrZero(bareMatch[1]);
  }
  return 0;
}

export function isGhPrCreateArgv(argv = []) {
  return argv[0] === 'pr' && argv[1] === 'create';
}

/**
 * @param {{ argv: string[], status: number, stdout: string, stderr: string, env?: NodeJS.ProcessEnv, cwd?: string }} input
 */
export function tryPushRegisterFromPrCreate({
  argv,
  status,
  stdout,
  stderr,
  env = process.env,
  cwd = process.cwd(),
}) {
  if (!isGhPrCreateArgv(argv) || status !== 0) {
    return { registered: false, reason: 'not_applicable' };
  }

  const prNumber = parsePrNumberFromGhPrCreateOutput(stdout, stderr);
  if (prNumber <= 0) {
    return { registered: false, reason: 'push_register_pr_number_unparsed' };
  }

  const identity = provePushRegisterWorkerIdentity(env, { cwd });
  if (!identity.ok) {
    return {
      registered: false,
      reason: identity.reason ?? 'push_register_identity_failed',
      diagnostic: identity.reason,
    };
  }

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

  const cachePath = resolvePrSessionBindingCachePath(env);
  const store = readPrSessionBindingCacheFile(cachePath);
  const register = registerPrSessionBindingRecord(
    store,
    {
      sessionId: identity.sessionId,
      prNumber,
      repoSlug: identity.repoSlug,
      issueNumber: identity.issueNumber,
      headSha,
      source: BINDING_SOURCE_PUSH_REGISTER,
    },
    Date.now(),
  );
  if (!register.ok) {
    return {
      registered: false,
      reason: register.reason ?? 'push_register_write_failed',
      diagnostic: register.diagnostic ?? register.reason,
    };
  }
  writePrSessionBindingCacheFile(cachePath, store);
  return { registered: true, reason: register.reason };
}
