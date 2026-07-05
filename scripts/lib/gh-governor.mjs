#!/usr/bin/env node
/**
 * Shared identity-keyed GitHub API admission governor (Issue #585).
 * File-backed token bucket + in-flight cap + observed-limit cooldown.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePartitionKey } from './gh-graphql-degraded.mjs';

export const GOVERNOR_VERSION = 'github-fleet-governor/v1';
export const GOVERNOR_DENIAL_EXIT_CODE = 75;
export const GOVERNOR_AUDIT_LABEL = 'github_governor';

export const LANES = /** @type {const} */ ([
  'background',
  'retry',
  'interactive-preflight',
  'interactive',
]);

/** @typedef {'background'|'retry'|'interactive-preflight'|'interactive'} GovernorLane */

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 5;

const DEFAULT_BUDGET = {
  maxTokens: 10,
  refillPerMs: 10 / 60_000,
  maxInFlight: 3,
  reservedTokens: 2,
  retryTokenCost: 2,
  coldStartFraction: 0.3,
  coldStartRampMs: 60_000,
  emergencyBudgetMax: 1,
  emergencyPaceMs: 250,
  fixedCooldownMs: 5_000,
  maxFixedCooldownMs: 120_000,
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isGovernorEnabled(env = process.env) {
  if (env.GH_GOVERNOR_DISABLED === '1') {
    return false;
  }
  return env.GH_GOVERNOR_ENABLED === '1';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveGovernorStateDir(env = process.env) {
  if (env.GH_GOVERNOR_STATE_DIR) {
    return env.GH_GOVERNOR_STATE_DIR;
  }
  if (env.AO_SIDE_PROCESS_STATE_DIR) {
    return join(env.AO_SIDE_PROCESS_STATE_DIR.trim(), 'github-governor');
  }
  const stateBase = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(stateBase, 'orchestrator-pack', 'github-governor');
}

/**
 * @param {string} partitionKey
 */
export function governorStatePath(stateDir, partitionKey) {
  const safe = createHash('sha256').update(partitionKey).digest('hex').slice(0, 32);
  return join(stateDir, `${safe}.json`);
}

/**
 * @param {string} partitionKey
 */
export function governorLockPath(stateDir, partitionKey) {
  const safe = createHash('sha256').update(partitionKey).digest('hex').slice(0, 32);
  return join(stateDir, `${safe}.lock`);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveGovernorBudget(env = process.env) {
  const readNum = (key, fallback) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    maxTokens: readNum('GH_GOVERNOR_MAX_TOKENS', DEFAULT_BUDGET.maxTokens),
    refillPerMs: readNum('GH_GOVERNOR_REFILL_PER_MS', DEFAULT_BUDGET.refillPerMs),
    maxInFlight: readNum('GH_GOVERNOR_MAX_IN_FLIGHT', DEFAULT_BUDGET.maxInFlight),
    reservedTokens: readNum('GH_GOVERNOR_RESERVED_TOKENS', DEFAULT_BUDGET.reservedTokens),
    retryTokenCost: readNum('GH_GOVERNOR_RETRY_TOKEN_COST', DEFAULT_BUDGET.retryTokenCost),
    coldStartFraction: readNum('GH_GOVERNOR_COLD_START_FRACTION', DEFAULT_BUDGET.coldStartFraction),
    coldStartRampMs: readNum('GH_GOVERNOR_COLD_START_RAMP_MS', DEFAULT_BUDGET.coldStartRampMs),
    emergencyBudgetMax: readNum('GH_GOVERNOR_EMERGENCY_BUDGET_MAX', DEFAULT_BUDGET.emergencyBudgetMax),
    emergencyPaceMs: readNum('GH_GOVERNOR_EMERGENCY_PACE_MS', DEFAULT_BUDGET.emergencyPaceMs),
    fixedCooldownMs: readNum('GH_GOVERNOR_FIXED_COOLDOWN_MS', DEFAULT_BUDGET.fixedCooldownMs),
    maxFixedCooldownMs: readNum('GH_GOVERNOR_MAX_FIXED_COOLDOWN_MS', DEFAULT_BUDGET.maxFixedCooldownMs),
  };
}

function nowMs(env = process.env) {
  const override = env.GH_GOVERNOR_NOW_MS;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/**
 * @param {string} lane
 * @returns {GovernorLane}
 */
export function normalizeLane(lane) {
  const value = String(lane ?? '').trim().toLowerCase();
  if (LANES.includes(/** @type {GovernorLane} */ (value))) {
    return /** @type {GovernorLane} */ (value);
  }
  return 'background';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} [argv]
 * @returns {GovernorLane}
 */
export function resolveCallerLane(env = process.env, argv = []) {
  if (env.GH_GOVERNOR_LANE) {
    return normalizeLane(env.GH_GOVERNOR_LANE);
  }
  const consumer = String(env.GH_GOVERNOR_CONSUMER ?? '');
  if (/preflight|review-start-scoped/i.test(consumer)) {
    return 'interactive-preflight';
  }
  if (/retry/i.test(consumer)) {
    return 'retry';
  }
  if (/interactive|orchestrator-turn|worker/i.test(consumer)) {
    return 'interactive';
  }
  const child = String(env.AO_SIDE_PROCESS_CHILD_ID ?? '');
  if (/preflight/i.test(child)) {
    return 'interactive-preflight';
  }
  if (env.AO_SESSION_ID && !child) {
    return 'interactive';
  }
  const joined = argv.join(' ');
  if (/pr view/.test(joined) && /headRefOid|headRefName/.test(joined)) {
    return 'interactive-preflight';
  }
  return 'background';
}

function isReservedLane(lane) {
  return lane === 'interactive' || lane === 'interactive-preflight';
}

function isSheddableLane(lane) {
  return lane === 'background' || lane === 'retry';
}

function sleepMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @returns {object}
 */
function defaultState(now, budget) {
  return {
    schemaVersion: 1,
    governorVersion: GOVERNOR_VERSION,
    tokens: budget.maxTokens * budget.coldStartFraction,
    lastRefillMs: now,
    inFlight: 0,
    cooldownUntilMs: 0,
    cooldownKind: null,
    cooldownSource: null,
    cooldownStrike: 0,
    rampStartedMs: now,
    emergencyBudgetUsed: 0,
    placeholderBudget: true,
    telemetryNote: 'conservative-placeholder-until-phase0-telemetry',
  };
}

function readStateFile(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeStateAtomic(path, state) {
  const dir = join(path, '..');
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, 'utf8');
  fs.renameSync(temp, path);
}

function acquireLock(lockPath, now) {
  fs.mkdirSync(join(lockPath, '..'), { recursive: true });
  const deadline = now + LOCK_WAIT_MS;
  while (now <= deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredMs: now })}\n`, 'utf8');
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') {
        throw err;
      }
      try {
        const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (
          typeof existing.acquiredMs === 'number'
          && now - existing.acquiredMs > LOCK_STALE_MS
        ) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      sleepMs(LOCK_POLL_MS);
      now = nowMs();
    }
  }
  return false;
}

function releaseLock(lockPath) {
  fs.rmSync(lockPath, { force: true });
}

function effectiveMaxTokens(state, budget, now) {
  const rampAge = now - (state.rampStartedMs ?? now);
  if (rampAge >= budget.coldStartRampMs) {
    return budget.maxTokens;
  }
  const fraction = budget.coldStartFraction
    + (1 - budget.coldStartFraction) * (rampAge / budget.coldStartRampMs);
  return budget.maxTokens * fraction;
}

function refillTokens(state, budget, now) {
  const elapsed = Math.max(0, now - (state.lastRefillMs ?? now));
  const max = effectiveMaxTokens(state, budget, now);
  const refilled = Math.min(max, (state.tokens ?? 0) + elapsed * budget.refillPerMs);
  return { ...state, tokens: refilled, lastRefillMs: now };
}

function tokenCost(lane, budget) {
  return lane === 'retry' ? budget.retryTokenCost : 1;
}

function availableGeneralTokens(state, budget) {
  const reserved = Math.min(budget.reservedTokens, state.tokens ?? 0);
  return Math.max(0, (state.tokens ?? 0) - reserved);
}

function canAffordAdmission(state, budget, lane) {
  const cost = tokenCost(lane, budget);
  const tokens = state.tokens ?? 0;
  if (isReservedLane(lane)) {
    return tokens >= cost;
  }
  return availableGeneralTokens(state, budget) >= cost;
}

function applyAdmissionCost(state, budget, lane) {
  const cost = tokenCost(lane, budget);
  return {
    ...state,
    tokens: Math.max(0, (state.tokens ?? 0) - cost),
    inFlight: (state.inFlight ?? 0) + 1,
  };
}

/**
 * @param {object} input
 */
export function classifyGovernorTransportOutcome(input = {}) {
  const exitCode = Number(input.exitCode ?? 0);
  const stderr = String(input.stderr ?? '').toLowerCase();
  const stdout = String(input.stdout ?? '').toLowerCase();
  const text = `${stderr}\n${stdout}`;
  const headers = input.headers && typeof input.headers === 'object' ? input.headers : {};

  if (
    exitCode === 401
    || text.includes('bad credentials')
    || text.includes('authentication failed')
    || text.includes('gh auth login')
  ) {
    return { disposition: 'terminal', reason: 'auth', terminalClass: '401' };
  }

  if (
    text.includes('gh command not found')
    || text.includes('native gh')
    || text.includes('gh_binary_missing')
    || text.includes('adoption')
  ) {
    return { disposition: 'terminal', reason: 'config', terminalClass: 'missing-gh' };
  }

  if (
    text.includes('policy')
    || text.includes('boundary deny')
    || text.includes('forbidden transport')
  ) {
    return { disposition: 'terminal', reason: 'policy', terminalClass: 'policy' };
  }

  if (text.includes('malformed') || text.includes('invalid argv')) {
    return { disposition: 'terminal', reason: 'malformed', terminalClass: 'malformed' };
  }

  if (
    text.includes('no checks reported')
    || (text.includes('not open') && text.includes('pull request'))
    || text.includes('pr-not-open')
  ) {
    return { disposition: 'terminal', reason: 'pr-not-open', terminalClass: 'pr-not-open' };
  }

  if (headers['retry-after']) {
    return {
      disposition: 'observed-limit',
      reason: 'secondary-or-429',
      limitKind: 'secondary',
      retryAfterSec: Number(headers['retry-after']),
      source: 'retry-after',
    };
  }

  if (headers['x-ratelimit-remaining'] === '0') {
    const reset = Number(headers['x-ratelimit-reset'] ?? 0);
    return {
      disposition: 'observed-limit',
      reason: 'primary-limit',
      limitKind: 'primary',
      resetAtSec: reset,
      source: 'x-ratelimit-reset',
    };
  }

  if (
    exitCode === 429
    || text.includes('secondary rate limit')
    || text.includes('abuse rate limit')
    || text.includes('api rate limit exceeded')
  ) {
    return {
      disposition: 'observed-limit',
      reason: 'secondary-or-429',
      limitKind: 'secondary',
      source: 'body-heuristic',
    };
  }

  if (/\b5\d{2}\b/.test(text) || text.includes('bad gateway') || text.includes('service unavailable')) {
    return {
      disposition: 'transient-transport',
      reason: 'upstream-5xx',
      transientClass: 'server_error',
    };
  }

  if (exitCode === 0 || exitCode === 304) {
    return { disposition: 'success', reason: 'ok' };
  }

  return { disposition: 'unknown', reason: 'unclassified' };
}

/**
 * @param {object} state
 * @param {object} outcome
 * @param {number} now
 * @param {ReturnType<typeof resolveGovernorBudget>} budget
 */
export function applyObservedLimitToState(state, outcome, now, budget) {
  if (outcome.disposition !== 'observed-limit' && outcome.disposition !== 'transient-transport') {
    return state;
  }
  const strike = (state.cooldownStrike ?? 0) + 1;
  let cooldownUntilMs = now;
  let cooldownSource = 'fixed-backoff';
  let cooldownKind = outcome.limitKind ?? 'transient';

  if (outcome.source === 'retry-after' && Number.isFinite(outcome.retryAfterSec)) {
    const jitter = Math.floor(Math.random() * 250);
    cooldownUntilMs = now + outcome.retryAfterSec * 1000 + jitter;
    cooldownSource = 'retry-after';
    cooldownKind = outcome.limitKind ?? 'secondary';
  } else if (outcome.source === 'x-ratelimit-reset' && Number.isFinite(outcome.resetAtSec) && outcome.resetAtSec > 0) {
    cooldownUntilMs = outcome.resetAtSec * 1000;
    cooldownSource = 'x-ratelimit-reset';
    cooldownKind = 'primary';
  } else {
    const backoff = Math.min(
      budget.maxFixedCooldownMs,
      budget.fixedCooldownMs * (2 ** Math.min(strike, 5)),
    );
    cooldownUntilMs = now + backoff;
  }

  return {
    ...state,
    cooldownUntilMs: Math.max(state.cooldownUntilMs ?? 0, cooldownUntilMs),
    cooldownKind,
    cooldownSource,
    cooldownStrike: strike,
  };
}

/**
 * @param {object} options
 */
export function acquireGithubGovernorAdmission(options = {}) {
  const env = options.env ?? process.env;
  if (!isGovernorEnabled(env)) {
    return {
      admitted: true,
      skipped: true,
      lane: resolveCallerLane(env, options.argv ?? []),
      release: () => {},
    };
  }

  const lane = resolveCallerLane(env, options.argv ?? []);
  const budget = resolveGovernorBudget(env);
  const now = nowMs(env);
  const stateDir = resolveGovernorStateDir(env);
  const partitionKey = options.partitionKey
    ?? resolvePartitionKey(options.realGh ?? 'gh', options.argv ?? [], env);
  const statePath = governorStatePath(stateDir, partitionKey);
  const lockPath = governorLockPath(stateDir, partitionKey);

  if (!acquireLock(lockPath, now)) {
    if (isReservedLane(lane)) {
      return admitEmergency(lane, budget, env, partitionKey, 'lock-timeout', { stateDir, statePath });
    }
    return denyAdmission(lane, 'governor-lock-timeout', partitionKey);
  }

  try {
    const stateExists = fs.existsSync(statePath);
    let state = stateExists ? readStateFile(statePath) : null;
    if (stateExists && !state) {
      releaseLock(lockPath);
      if (isReservedLane(lane)) {
        return admitEmergency(lane, budget, env, partitionKey, 'state-corrupt', { stateDir, statePath });
      }
      return denyAdmission(lane, 'governor-state-unavailable', partitionKey);
    }
    if (!state || state.schemaVersion !== 1) {
      state = defaultState(now, budget);
    }
    state = refillTokens(state, budget, now);

    if ((state.cooldownUntilMs ?? 0) > now) {
      if (isReservedLane(lane)) {
        releaseLock(lockPath);
        return admitEmergency(lane, budget, env, partitionKey, 'cooldown-reserved', { stateDir, statePath });
      }
      releaseLock(lockPath);
      return denyAdmission(lane, 'governor-cooldown', partitionKey, {
        cooldownUntilMs: state.cooldownUntilMs,
        cooldownKind: state.cooldownKind,
      });
    }

    if ((state.inFlight ?? 0) >= budget.maxInFlight) {
      if (isReservedLane(lane)) {
        releaseLock(lockPath);
        return admitEmergency(lane, budget, env, partitionKey, 'inflight-reserved', { stateDir, statePath });
      }
      releaseLock(lockPath);
      return denyAdmission(lane, 'governor-inflight-cap', partitionKey);
    }

    if (!canAffordAdmission(state, budget, lane)) {
      if (isReservedLane(lane)) {
        releaseLock(lockPath);
        return admitEmergency(lane, budget, env, partitionKey, 'token-reserved', { stateDir, statePath });
      }
      releaseLock(lockPath);
      return denyAdmission(lane, 'governor-token-budget', partitionKey);
    }

    const updated = applyAdmissionCost(state, budget, lane);
    writeStateAtomic(statePath, updated);
    releaseLock(lockPath);

    return {
      admitted: true,
      lane,
      partitionKey,
      statePath,
      emergency: false,
      audit: {
        event: 'admit',
        lane,
        partitionKey,
        inFlight: updated.inFlight,
        tokens: updated.tokens,
        placeholderBudget: true,
      },
      release: (releaseOptions = {}) => {
        releaseGithubGovernorAdmission({
          env,
          partitionKey,
          statePath,
          outcome: releaseOptions.outcome,
          headers: releaseOptions.headers,
          exitCode: releaseOptions.exitCode,
          stderr: releaseOptions.stderr,
          stdout: releaseOptions.stdout,
        });
      },
    };
  } catch (err) {
    releaseLock(lockPath);
    if (isReservedLane(lane)) {
      return admitEmergency(lane, budget, env, partitionKey, 'state-error', { stateDir, statePath });
    }
    if (isSheddableLane(lane)) {
      return denyAdmission(lane, 'governor-state-unavailable', partitionKey);
    }
    throw err;
  }
}

function admitEmergency(lane, budget, env, partitionKey, reason, paths = {}) {
  const { stateDir, statePath } = paths;
  const now = nowMs(env);
  const lockPath = governorLockPath(stateDir, partitionKey);
  const envUsed = Number(env.GH_GOVERNOR_EMERGENCY_USED ?? 0);
  if (!acquireLock(lockPath, now)) {
    return denyAdmission(lane, 'governor-lock-timeout', partitionKey);
  }
  let persistedUsed = 0;
  try {
    let state = readStateFile(statePath) ?? defaultState(now, budget);
    persistedUsed = state.emergencyBudgetUsed ?? 0;
    if (persistedUsed + envUsed >= budget.emergencyBudgetMax) {
      return denyAdmission(lane, 'governor-emergency-exhausted', partitionKey);
    }
    state = {
      ...state,
      emergencyBudgetUsed: persistedUsed + 1,
    };
    writeStateAtomic(statePath, state);
    persistedUsed = state.emergencyBudgetUsed;
  } finally {
    releaseLock(lockPath);
  }
  sleepMs(budget.emergencyPaceMs);
  return {
    admitted: true,
    lane,
    partitionKey,
    statePath,
    emergency: true,
    audit: {
      event: 'admit-emergency',
      lane,
      partitionKey,
      reason,
      emergencyBudgetUsed: persistedUsed,
      placeholderBudget: true,
    },
    release: (releaseOptions = {}) => {
      releaseGithubGovernorAdmission({
        env,
        partitionKey,
        statePath,
        outcome: releaseOptions.outcome,
        headers: releaseOptions.headers,
        exitCode: releaseOptions.exitCode,
        stderr: releaseOptions.stderr,
        stdout: releaseOptions.stdout,
      });
    },
  };
}

function denyAdmission(lane, reason, partitionKey, extra = {}) {
  return {
    admitted: false,
    lane,
    reason,
    partitionKey,
    ...extra,
    audit: {
      event: 'deny',
      lane,
      partitionKey,
      reason,
      ...extra,
    },
  };
}

/**
 * @param {object} options
 */
export function releaseGithubGovernorAdmission(options = {}) {
  const env = options.env ?? process.env;
  if (!isGovernorEnabled(env)) {
    return;
  }
  const partitionKey = options.partitionKey;
  if (!partitionKey) return;

  const budget = resolveGovernorBudget(env);
  const now = nowMs(env);
  const stateDir = resolveGovernorStateDir(env);
  const statePath = options.statePath ?? governorStatePath(stateDir, partitionKey);
  const lockPath = governorLockPath(stateDir, partitionKey);
  if (!acquireLock(lockPath, now)) {
    return;
  }
  try {
    let state = readStateFile(statePath);
    if (!state) return;
    state = {
      ...state,
      inFlight: Math.max(0, (state.inFlight ?? 1) - 1),
    };
    const outcome = classifyGovernorTransportOutcome({
      exitCode: options.exitCode,
      stderr: options.stderr,
      stdout: options.stdout,
      headers: options.headers ?? options.outcome?.headers,
    });
    if (outcome.disposition === 'observed-limit' || outcome.disposition === 'transient-transport') {
      state = applyObservedLimitToState(state, outcome, now, budget);
    }
    writeStateAtomic(statePath, state);
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * @param {object} options
 */
export function recordGithubGovernorObservedLimit(options = {}) {
  const env = options.env ?? process.env;
  if (!isGovernorEnabled(env)) return null;

  const partitionKey = options.partitionKey
    ?? resolvePartitionKey(options.realGh ?? 'gh', options.argv ?? [], env);
  const budget = resolveGovernorBudget(env);
  const now = nowMs(env);
  const stateDir = resolveGovernorStateDir(env);
  const statePath = governorStatePath(stateDir, partitionKey);
  const lockPath = governorLockPath(stateDir, partitionKey);
  const outcome = options.outcome ?? classifyGovernorTransportOutcome(options);
  if (outcome.disposition !== 'observed-limit' && outcome.disposition !== 'transient-transport') {
    return outcome;
  }
  if (!acquireLock(lockPath, now)) return outcome;
  try {
    let state = readStateFile(statePath) ?? defaultState(now, budget);
    state = applyObservedLimitToState(state, outcome, now, budget);
    writeStateAtomic(statePath, state);
    return outcome;
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * @param {object} denial
 */
export function formatGovernorDenialMessage(denial) {
  const parts = [
    `${GOVERNOR_AUDIT_LABEL}: deny`,
    `lane=${denial.lane ?? 'background'}`,
    `reason=${denial.reason ?? 'unknown'}`,
  ];
  if (denial.cooldownUntilMs) {
    parts.push(`cooldownUntilMs=${denial.cooldownUntilMs}`);
  }
  return parts.join(' ');
}

/**
 * Fixture helper: read governor state for tests.
 * @param {string} stateDir
 * @param {string} partitionKey
 */
export function readGovernorStateForFixture(stateDir, partitionKey) {
  return readStateFile(governorStatePath(stateDir, partitionKey));
}
