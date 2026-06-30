#!/usr/bin/env node
/**
 * GraphQL primary-quota exhaustion fail-fast at gh api graphql passthrough (Issue #540).
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const CACHE_VERSION = 1;
export const RATE_LIMIT_REFRESH_MS = 60_000;
export const RATE_LIMIT_REFRESH_LOCK_STALE_MS = 120_000;
export const AUDIT_LABEL = 'graphql_degraded_fail_fast';
export const CACHE_IO_AUDIT_LABEL = 'graphql_degraded_cache_io_failed';
export const SUPPRESSION_EXIT_CODE = 1;
export const PRIMARY_QUOTA_MARKER = 'GraphQL primary quota exhausted';

const DEFAULT_HOST = 'github.com';

function nowMs() {
  const override = process.env.GH_GRAPHQL_DEGRADED_NOW_MS;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

/**
 * @param {string[]} argv
 */
/**
 * @param {string[]} argv
 * @returns {{ host: string; explicit: boolean }}
 */
export function extractApiHostnameInfo(argv, env = process.env) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--hostname' && argv[i + 1]) {
      return { host: argv[i + 1], explicit: true };
    }
    if (token.startsWith('--hostname=')) {
      return { host: token.slice('--hostname='.length), explicit: true };
    }
  }
  const ghHost = typeof env.GH_HOST === 'string' ? env.GH_HOST.trim() : '';
  return { host: ghHost || DEFAULT_HOST, explicit: false };
}

export function extractApiHostname(argv, env = process.env) {
  return extractApiHostnameInfo(argv, env).host;
}

/**
 * @param {string} hostname
 * @param {boolean} explicitHostname
 * @returns {string[]}
 */
function hostnameFlagArgs(hostname, explicitHostname) {
  if (explicitHostname || hostname !== DEFAULT_HOST) {
    return ['--hostname', hostname];
  }
  return [];
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} hostname
 */
export function resolveEnvTokenForHost(env, hostname) {
  if (hostname !== DEFAULT_HOST) {
    const enterprise = env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN || env.GHE_TOKEN;
    if (enterprise) {
      return enterprise;
    }
  }
  return env.GH_TOKEN || env.GITHUB_TOKEN || null;
}

const GH_API_VALUE_FLAGS = new Set([
  '--hostname',
  '--method',
  '-X',
  '-H',
  '--header',
  '-f',
  '--field',
  '--raw-field',
  '-F',
  '--form',
  '--input',
  '--jq',
  '-q',
  '-t',
  '--template',
  '--cache',
  '-R',
  '--repo',
  '--preview',
  '-p',
]);

/**
 * @param {string[]} argv
 * @param {number} idx
 */
function advanceGhApiFlag(argv, idx) {
  const token = argv[idx];
  if (token.includes('=')) {
    return 1;
  }
  if (GH_API_VALUE_FLAGS.has(token)) {
    return idx + 1 < argv.length ? 2 : 1;
  }
  return 1;
}

/**
 * @param {string[]} argv
 */
export function isGraphqlPassthroughArgv(argv) {
  const apiIdx = argv.indexOf('api');
  if (apiIdx === -1) {
    return false;
  }
  let cursor = apiIdx + 1;
  while (cursor < argv.length) {
    const token = argv[cursor];
    if (!token.startsWith('-')) {
      return token === 'graphql';
    }
    cursor += advanceGhApiFlag(argv, cursor);
  }
  return false;
}

/**
 * @param {string} text
 */
function hashFingerprint(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * @param {string} realGh
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveCredentialFingerprint(
  realGh,
  env = process.env,
  hostname = DEFAULT_HOST,
  explicitHostname = false,
) {
  const envToken = resolveEnvTokenForHost(env, hostname);
  if (envToken) {
    return hashFingerprint(`env-token:${envToken}`);
  }

  const hostArgs = hostnameFlagArgs(hostname, explicitHostname);

  const tokenResult = spawnSync(realGh, ['auth', 'token', ...hostArgs], {
    encoding: 'utf8',
    env: { ...env, GH_WRAPPER_ACTIVE: '1' },
  });
  if (tokenResult.status === 0) {
    const token = (tokenResult.stdout || '').trim();
    if (token) {
      return hashFingerprint(`gh-auth-token:${token}`);
    }
  }

  const loginResult = spawnSync(realGh, ['api', ...hostArgs, 'user', '-q', '.login'], {
    encoding: 'utf8',
    env: { ...env, GH_WRAPPER_ACTIVE: '1' },
  });
  if (loginResult.status === 0) {
    const login = (loginResult.stdout || '').trim();
    if (login) {
      return hashFingerprint(`gh-login:${login}`);
    }
  }

  return hashFingerprint('anonymous');
}

/**
 * @param {string} realGh
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePartitionKey(realGh, argv, env = process.env) {
  const { host, explicit } = extractApiHostnameInfo(argv, env);
  const credential = resolveCredentialFingerprint(realGh, env, host, explicit);
  return `${host}|${credential}`;
}

export function resolveCacheDir(env = process.env) {
  if (env.GH_GRAPHQL_DEGRADED_CACHE_DIR) {
    return env.GH_GRAPHQL_DEGRADED_CACHE_DIR;
  }
  const stateBase = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(stateBase, 'orchestrator-pack', 'gh-graphql-degraded');
}

/**
 * @param {string} partitionKey
 */
export function cacheFilePath(cacheDir, partitionKey) {
  return join(cacheDir, `${hashFingerprint(partitionKey)}.json`);
}

/**
 * @param {unknown} value
 * @returns {value is {
 *   v: number;
 *   partition: string;
 *   degraded: boolean;
 *   graphqlResetAt: number | null;
 *   graphqlRemaining: number | null;
 *   lastRateLimitFetchMs: number;
 * }}
 */
function isValidCacheRecord(value, partitionKey) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.v !== CACHE_VERSION) {
    return false;
  }
  if (record.partition !== partitionKey) {
    return false;
  }
  if (typeof record.degraded !== 'boolean') {
    return false;
  }
  if (record.graphqlResetAt !== null && typeof record.graphqlResetAt !== 'number') {
    return false;
  }
  if (record.graphqlRemaining !== null && typeof record.graphqlRemaining !== 'number') {
    return false;
  }
  if (typeof record.lastRateLimitFetchMs !== 'number') {
    return false;
  }
  return true;
}

/**
 * @param {string} cacheDir
 * @param {string} partitionKey
 */
export function readDegradedCache(cacheDir, partitionKey) {
  const filePath = cacheFilePath(cacheDir, partitionKey);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isValidCacheRecord(parsed, partitionKey)) {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // best-effort cache repair
      }
      return null;
    }
    return parsed;
  } catch {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // best-effort cache repair
    }
    return null;
  }
}

/**
 * @param {string} cacheDir
 * @param {string} partitionKey
 * @param {{
 *   degraded: boolean;
 *   graphqlResetAt: number | null;
 *   graphqlRemaining: number | null;
 *   lastRateLimitFetchMs: number;
 * }} state
 */
export function writeDegradedCache(cacheDir, partitionKey, state) {
  mkdirSync(cacheDir, { recursive: true });
  const filePath = cacheFilePath(cacheDir, partitionKey);
  const payload = {
    v: CACHE_VERSION,
    partition: partitionKey,
    degraded: state.degraded,
    graphqlResetAt: state.graphqlResetAt,
    graphqlRemaining: state.graphqlRemaining,
    lastRateLimitFetchMs: state.lastRateLimitFetchMs,
  };
  const tempPath = `${filePath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, 'utf8');
  renameSync(tempPath, filePath);
  return payload;
}

/**
 * @param {unknown} body
 */
export function parseRateLimitGraphql(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const resources = /** @type {Record<string, unknown>} */ (body).resources;
  if (!resources || typeof resources !== 'object') {
    return null;
  }
  const graphql = /** @type {Record<string, unknown>} */ (resources).graphql;
  if (!graphql || typeof graphql !== 'object') {
    return null;
  }
  const remaining = /** @type {Record<string, unknown>} */ (graphql).remaining;
  const reset = /** @type {Record<string, unknown>} */ (graphql).reset;
  if (typeof remaining !== 'number' || typeof reset !== 'number') {
    return null;
  }
  return { remaining, reset };
}

/**
 * @param {{ stderr?: string; stdout?: string; exitCode?: number | null }} result
 */
export function isPrimaryGraphqlQuotaExhaustion(result) {
  const combined = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  if (!combined.trim()) {
    return false;
  }
  if (/secondary_rate_limit/i.test(combined)) {
    return false;
  }
  if (/abuse rate limit/i.test(combined)) {
    return false;
  }
  if (/HTTP 401/i.test(combined) || /Bad credentials/i.test(combined)) {
    return false;
  }
  if (/ENOTFOUND|ETIMEDOUT|context deadline exceeded|network/i.test(combined)
    && !/graphql_rate_limit/i.test(combined)) {
    return false;
  }
  if (/Field '.+' doesn't exist on type/i.test(combined)) {
    return false;
  }
  if (/graphql_rate_limit/i.test(combined)) {
    return true;
  }
  if (/rate limit exceeded/i.test(combined) && /graphql/i.test(combined)) {
    return true;
  }
  if (/HTTP 403/i.test(combined) && /graphql/i.test(combined) && /rate limit/i.test(combined)) {
    return true;
  }
  if (/GraphQL quota exhausted/i.test(combined)) {
    return true;
  }
  return false;
}

function emitAudit(partitionKey, details = {}) {
  const shortPartition = hashFingerprint(partitionKey);
  const detailPairs = Object.entries(details)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const suffix = detailPairs ? ` ${detailPairs}` : '';
  process.stderr.write(`gh-wrapper-audit: ${AUDIT_LABEL} partition=${shortPartition}${suffix}\n`);
}

function formatSuppressionMessage(resetAt) {
  if (resetAt) {
    return `${PRIMARY_QUOTA_MARKER} (suppressed; resets at ${new Date(resetAt * 1000).toISOString()})`;
  }
  return `${PRIMARY_QUOTA_MARKER} (suppressed)`;
}

function exitSuppressed(partitionKey, resetAt) {
  emitAudit(partitionKey, { suppressed: 1 });
  process.stderr.write(`${formatSuppressionMessage(resetAt)}\n`);
  process.exit(SUPPRESSION_EXIT_CODE);
}

/**
 * @param {string} realGh
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
export function fetchRateLimitGraphql(realGh, argv, env) {
  const { host, explicit } = extractApiHostnameInfo(argv, env);
  const args = ['api', 'rate_limit'];
  if (explicit) {
    args.splice(1, 0, '--hostname', host);
  }
  const result = spawnSync(realGh, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...env, GH_WRAPPER_ACTIVE: '1' },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || '').trim() };
  }
  try {
    const body = JSON.parse(result.stdout);
    const graphql = parseRateLimitGraphql(body);
    if (!graphql) {
      return { ok: false, error: 'rate_limit response missing resources.graphql' };
    }
    return { ok: true, ...graphql };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}


export function rateLimitRefreshLockPath(cacheDir, partitionKey) {
  return `${cacheFilePath(cacheDir, partitionKey)}.refresh-lock`;
}

/**
 * @param {string} lockPath
 */
function readRefreshLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} cacheDir
 * @param {string} partitionKey
 * @param {number} currentMs
 */
export function tryAcquireRateLimitRefreshLease(cacheDir, partitionKey, currentMs) {
  const lockPath = rateLimitRefreshLockPath(cacheDir, partitionKey);
  mkdirSync(cacheDir, { recursive: true });

  const attempt = () => {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredMs: currentMs })}\n`, 'utf8');
      closeSync(fd);
      return true;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') {
        throw err;
      }
      return false;
    }
  };

  if (attempt()) {
    return { acquired: true, lockPath };
  }

  const existing = readRefreshLock(lockPath);
  if (
    existing
    && typeof existing.acquiredMs === 'number'
    && currentMs - existing.acquiredMs > RATE_LIMIT_REFRESH_LOCK_STALE_MS
  ) {
    rmSync(lockPath, { force: true });
    if (attempt()) {
      return { acquired: true, lockPath };
    }
  }

  return { acquired: false, lockPath };
}

/**
 * @param {string} lockPath
 */
export function releaseRateLimitRefreshLease(lockPath) {
  rmSync(lockPath, { force: true });
}

const PEER_REFRESH_WAIT_MS = 250;

/**
 * @param {string} cacheDir
 * @param {string} partitionKey
 * @param {string} lockPath
 */
function waitForPeerCacheRefresh(cacheDir, partitionKey, lockPath) {
  const deadline = Date.now() + PEER_REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    const cache = readDegradedCache(cacheDir, partitionKey);
    if (cache) {
      return cache;
    }
    if (!existsSync(lockPath)) {
      return readDegradedCache(cacheDir, partitionKey);
    }
  }
  return readDegradedCache(cacheDir, partitionKey);
}

/**
 * @param {string} cacheDir
 * @param {string} partitionKey
 * @param {string} realGh
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {number} currentMs
 * @param {{ ignoreCadence?: boolean }} [options]
 */
function maybeRefreshDegradedCache(cacheDir, partitionKey, realGh, argv, env, currentMs, options = {}) {
  let cache = readDegradedCache(cacheDir, partitionKey);
  const ignoreCadence = options.ignoreCadence === true;
  if (!ignoreCadence && !shouldRefreshRateLimit(cache, currentMs)) {
    return { cache, refreshed: false };
  }

  const lease = tryAcquireRateLimitRefreshLease(cacheDir, partitionKey, currentMs);
  if (!lease.acquired) {
    const reread = waitForPeerCacheRefresh(cacheDir, partitionKey, lease.lockPath);
    return { cache: reread ?? cache, refreshed: false };
  }

  try {
    cache = readDegradedCache(cacheDir, partitionKey);
    if (!ignoreCadence && !shouldRefreshRateLimit(cache, currentMs)) {
      return { cache, refreshed: false };
    }

    const rateLimit = fetchRateLimitGraphql(realGh, argv, env);
    if (!rateLimit.ok) {
      return { cache, refreshed: true };
    }

    const nextState = {
      degraded: rateLimit.remaining === 0,
      graphqlResetAt: rateLimit.reset,
      graphqlRemaining: rateLimit.remaining,
      lastRateLimitFetchMs: currentMs,
    };
    cache = writeDegradedCache(cacheDir, partitionKey, nextState);
    return { cache, refreshed: true };
  } finally {
    releaseRateLimitRefreshLease(lease.lockPath);
  }
}


function isGraphqlResetStale(cache, currentMs) {
  return cache?.graphqlResetAt != null && currentMs >= cache.graphqlResetAt * 1000;
}

function boundedResetEpochSec(currentMs) {
  return Math.ceil((currentMs + RATE_LIMIT_REFRESH_MS) / 1000);
}

/**
 * @param {{ degraded?: boolean, graphqlResetAt?: number | null, graphqlRemaining?: number, lastRateLimitFetchMs?: number } | null} cache
 * @param {number} currentMs
 * @returns {number | null}
 */
function effectiveResetEpochSec(cache, currentMs) {
  if (!cache) {
    return null;
  }
  if (cache.graphqlResetAt != null) {
    return cache.graphqlResetAt;
  }
  if (cache.degraded && cache.graphqlRemaining === 0 && cache.lastRateLimitFetchMs != null) {
    return boundedResetEpochSec(cache.lastRateLimitFetchMs);
  }
  return null;
}

/**
 * @param {{ degraded?: boolean, graphqlResetAt?: number | null, graphqlRemaining?: number, lastRateLimitFetchMs?: number } | null} cache
 * @param {number} currentMs
 */
function isActivelyDegraded(cache, currentMs) {
  if (!cache?.degraded) {
    return false;
  }
  const resetSec = effectiveResetEpochSec(cache, currentMs);
  if (resetSec === null) {
    return false;
  }
  return currentMs < resetSec * 1000;
}

function shouldRefreshRateLimit(cache, currentMs) {
  if (!cache) {
    return true;
  }
  if (isGraphqlResetStale(cache, currentMs)) {
    return true;
  }
  return currentMs - cache.lastRateLimitFetchMs >= RATE_LIMIT_REFRESH_MS;
}

function emitPassthroughResult(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.status ?? 1);
}

/**
 * @param {string} partitionKey
 * @param {unknown} err
 */
function emitCacheIoFailureDiagnostic(partitionKey, err) {
  const message = err instanceof Error ? err.message : String(err);
  const shortPartition = partitionKey ? hashFingerprint(partitionKey) : 'unknown';
  process.stderr.write(
    `gh-wrapper-audit: ${CACHE_IO_AUDIT_LABEL} partition=${shortPartition} error=${JSON.stringify(message)}\n`,
  );
}

/**
 * @param {string[]} argv
 * @param {string} realGh
 * @param {NodeJS.ProcessEnv} env
 */
function passthroughGraphqlDirect(argv, realGh, env) {
  const graphqlResult = spawnSync(realGh, argv, {
    cwd: process.cwd(),
    env: { ...env, GH_WRAPPER_ACTIVE: '1' },
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  emitPassthroughResult(graphqlResult);
}

/**
 * @param {string} cacheDir
 * @param {string} partitionKey
 * @param {{
 *   degraded: boolean;
 *   graphqlResetAt: number | null;
 *   graphqlRemaining: number | null;
 *   lastRateLimitFetchMs: number;
 * }} state
 */
function tryWriteDegradedCache(cacheDir, partitionKey, state) {
  try {
    return writeDegradedCache(cacheDir, partitionKey, state);
  } catch {
    return null;
  }
}

/**
 * @param {string} cacheDir
 * @param {string} partitionKey
 * @param {string} realGh
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {number} currentMs
 */
function applyDegradedGate(cacheDir, partitionKey, realGh, argv, env, currentMs) {
  let cache = readDegradedCache(cacheDir, partitionKey);

  const refreshResult = maybeRefreshDegradedCache(
    cacheDir,
    partitionKey,
    realGh,
    argv,
    env,
    currentMs,
  );
  cache = refreshResult.cache;
  if (isActivelyDegraded(cache, currentMs)) {
    exitSuppressed(partitionKey, effectiveResetEpochSec(cache, currentMs));
  }

  return { cache, refreshed: refreshResult.refreshed };
}

/**
 * Handle gh api graphql passthrough with degraded-mode gate. Exits on graphql argv.
 * @param {string[]} argv
 * @param {string} realGh
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {boolean} false when argv is not graphql passthrough
 */
export function tryGraphqlDegradedPassthrough(argv, realGh, options = {}) {
  if (!isGraphqlPassthroughArgv(argv)) {
    return false;
  }

  const env = options.env ?? process.env;
  const currentMs = nowMs();
  let cacheDir = '';
  let partitionKey = '';
  let cache = null;
  let refreshed = false;

  try {
    cacheDir = resolveCacheDir(env);
    partitionKey = resolvePartitionKey(realGh, argv, env);
    ({ cache, refreshed } = applyDegradedGate(cacheDir, partitionKey, realGh, argv, env, currentMs));
  } catch (err) {
    emitCacheIoFailureDiagnostic(partitionKey, err);
    passthroughGraphqlDirect(argv, realGh, env);
    return true;
  }

  const graphqlResult = spawnSync(realGh, argv, {
    cwd: process.cwd(),
    env: { ...env, GH_WRAPPER_ACTIVE: '1' },
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });

  if (graphqlResult.status === 0) {
    if (cache?.degraded) {
      tryWriteDegradedCache(cacheDir, partitionKey, {
        degraded: false,
        graphqlResetAt: null,
        graphqlRemaining: cache.graphqlRemaining,
        lastRateLimitFetchMs: cache.lastRateLimitFetchMs,
      });
    }
    if (graphqlResult.stdout) {
      process.stdout.write(graphqlResult.stdout);
    }
    if (graphqlResult.stderr) {
      process.stderr.write(graphqlResult.stderr);
    }
    process.exit(0);
  }

  if (isPrimaryGraphqlQuotaExhaustion({
    stderr: graphqlResult.stderr,
    stdout: graphqlResult.stdout,
    exitCode: graphqlResult.status,
  })) {
    let resetAt = cache?.graphqlResetAt ?? null;
    const resetStale = resetAt !== null && currentMs >= resetAt * 1000;
    if (refreshed && cache?.graphqlResetAt && !resetStale) {
      resetAt = cache.graphqlResetAt;
    } else if (!resetAt || resetStale) {
      try {
        cache = readDegradedCache(cacheDir, partitionKey) ?? cache;
        resetAt = cache?.graphqlResetAt ?? null;
        const rereadStale = resetAt !== null && currentMs >= resetAt * 1000;
        if (!resetAt || rereadStale) {
          const armRefresh = maybeRefreshDegradedCache(
            cacheDir,
            partitionKey,
            realGh,
            argv,
            env,
            currentMs,
            { ignoreCadence: true },
          );
          cache = armRefresh.cache ?? cache;
          resetAt = cache?.graphqlResetAt ?? null;
        }
      } catch (err) {
        emitCacheIoFailureDiagnostic(partitionKey, err);
      }
    }
    if (!cache || !cache.degraded) {
      cache = tryWriteDegradedCache(cacheDir, partitionKey, {
        degraded: true,
        graphqlResetAt: resetAt ?? boundedResetEpochSec(currentMs),
        graphqlRemaining: 0,
        lastRateLimitFetchMs: currentMs,
      }) ?? cache;
    }
    if (graphqlResult.stderr) {
      process.stderr.write(graphqlResult.stderr);
    } else {
      process.stderr.write(`${PRIMARY_QUOTA_MARKER}\n`);
    }
    process.exit(graphqlResult.status ?? SUPPRESSION_EXIT_CODE);
  }

  emitPassthroughResult(graphqlResult);
  return true;
}
