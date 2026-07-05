/**
 * Review-start fresh-head preflight transient rate-limit shield (Issue #584).
 * Classifies gh pr view outcomes, computes bounded backoff, and evaluates retry budget.
 */
import { printJson, readStdinJson, runAsyncStdinJsonCliMain } from './review-mechanical-cli.mjs';
import { INFRA_TRANSPORT_FAILURE_CLASS } from './review-start-envelope-external-io.mjs';

export const PREFLIGHT_SHIELD_VERSION = 'review-start-preflight-shield/v1';
export const DEFAULT_MAX_ATTEMPTS = 4;
export const DEFAULT_WALL_CLOCK_BUDGET_MS = 60_000;
export const DEFAULT_BASE_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

const RATE_LIMIT_HEADER_NAMES = new Set([
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-ratelimit-used',
]);

/**
 * @param {string} stderr
 */
export function parseRateLimitHeadersFromStderr(stderr) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of String(stderr ?? '').split(/\r?\n/)) {
    const match = line.match(/^([\w-]+):\s*(.+)$/i);
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (RATE_LIMIT_HEADER_NAMES.has(name)) {
      headers[name] = match[2].trim();
    }
  }
  return headers;
}

/**
 * @param {Record<string, string>} headers
 */
export function hasRateLimitHeaders(headers) {
  return Object.keys(headers ?? {}).length > 0;
}

/**
 * @param {object} input
 */
export function classifyPreflightGhOutcome(input = {}) {
  const exitCode = Number(input.exitCode ?? 0);
  const stderr = String(input.stderr ?? '');
  const stdout = String(input.stdout ?? '');
  const timedOut = Boolean(input.timedOut);
  const parseOk = input.parseOk;
  const parseReason = String(input.parseReason ?? '');

  if (exitCode === 0 && parseOk === true) {
    return { disposition: 'success', reason: 'ok' };
  }

  if (exitCode === 0 && parseOk === false) {
    const reason = parseReason || 'structured_output_polluted';
    return { disposition: 'terminal', reason, terminalClass: 'parse_pollution' };
  }

  if (timedOut) {
    return { disposition: 'transient', reason: 'preflight_timeout', transientClass: 'timeout' };
  }

  const text = stderr.toLowerCase();

  if (
    text.includes('401')
    || text.includes('bad credentials')
    || text.includes('authentication failed')
    || text.includes('gh auth login')
  ) {
    return { disposition: 'terminal', reason: 'gh_auth_failed', terminalClass: 'auth' };
  }

  if (
    text.includes('429')
    || text.includes('secondary rate limit')
    || text.includes('abuse rate limit')
    || text.includes('abuse detection')
    || text.includes('api rate limit exceeded')
    || (text.includes('rate limit') && !text.includes('graphql_rate_limit'))
  ) {
    return { disposition: 'transient', reason: 'rate_limit', transientClass: 'rate_limit' };
  }

  if (text.includes('403') && text.includes('rate limit')) {
    return { disposition: 'transient', reason: 'rate_limit', transientClass: 'rate_limit' };
  }

  if (
    /\bhttp\s+5\d{2}\b/.test(text)
    || text.includes('bad gateway')
    || text.includes('service unavailable')
    || text.includes('gateway timeout')
  ) {
    return { disposition: 'transient', reason: 'upstream_5xx', transientClass: 'server_error' };
  }

  if (
    text.includes('enotfound')
    || text.includes('econnreset')
    || text.includes('connection reset')
    || text.includes('i/o timeout')
    || text.includes('etimedout')
    || text.includes('connect: connection timed out')
  ) {
    return { disposition: 'transient', reason: 'network_transport', transientClass: 'network' };
  }

  if (
    (text.includes('not found') || text.includes('no such file'))
    && (text.includes('gh') || text.includes('command') || text.includes('.ps1'))
  ) {
    return { disposition: 'terminal', reason: 'gh_binary_missing', terminalClass: 'config' };
  }

  if (text.includes('policy') || text.includes('boundary deny') || text.includes('forbidden by policy')) {
    return { disposition: 'terminal', reason: 'policy_denied', terminalClass: 'policy' };
  }

  if (text.includes('unknown flag') || text.includes('invalid argument') || text.includes('malformed')) {
    return { disposition: 'terminal', reason: 'malformed_argv', terminalClass: 'malformed' };
  }

  if (exitCode !== 0) {
    return { disposition: 'terminal', reason: 'gh_command_failed', terminalClass: 'unknown' };
  }

  if (stdout.trim() && !parseOk) {
    return { disposition: 'terminal', reason: parseReason || 'structured_output_polluted', terminalClass: 'parse_pollution' };
  }

  return { disposition: 'terminal', reason: 'gh_command_failed', terminalClass: 'unknown' };
}

/**
 * @param {object} input
 */
export function computePreflightBackoffMs(input = {}) {
  const attempt = Math.max(1, Number(input.attempt) || 1);
  const headers = /** @type {Record<string, string>} */ (input.headers ?? {});
  const config = input.config ?? {};
  const baseBackoffMs = Number(config.baseBackoffMs) > 0 ? Number(config.baseBackoffMs) : DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = Number(config.maxBackoffMs) > 0 ? Number(config.maxBackoffMs) : DEFAULT_MAX_BACKOFF_MS;
  const rawInjectedJitterMs = input.injectedJitterMs;

  const retryAfterRaw = headers['retry-after'];
  if (retryAfterRaw) {
    const retryAfterSec = Number(retryAfterRaw);
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      return {
        backoffMs: Math.min(maxBackoffMs, Math.ceil(retryAfterSec * 1000)),
        headerDegraded: false,
        source: 'retry-after',
      };
    }
  }

  const resetRaw = headers['x-ratelimit-reset'];
  if (resetRaw) {
    const resetEpochSec = Number(resetRaw);
    if (Number.isFinite(resetEpochSec) && resetEpochSec > 0) {
      const nowMs = Number(input.nowMs) > 0 ? Number(input.nowMs) : Date.now();
      const waitMs = Math.ceil(resetEpochSec * 1000 - nowMs);
      if (waitMs > 0) {
        return {
          backoffMs: Math.min(maxBackoffMs, waitMs),
          headerDegraded: false,
          source: 'x-ratelimit-reset',
        };
      }
    }
  }

  const exponent = Math.min(10, attempt - 1);
  const scaled = Math.min(maxBackoffMs, baseBackoffMs * (2 ** exponent));
  const jitter = rawInjectedJitterMs === null || rawInjectedJitterMs === undefined
    ? Math.floor(scaled * 0.2 * Math.random())
    : Math.max(0, Number(rawInjectedJitterMs));
  return {
    backoffMs: Math.min(maxBackoffMs, scaled + jitter),
    headerDegraded: !hasRateLimitHeaders(headers),
    source: 'fixed_degraded',
  };
}

/**
 * @param {object} input
 */
export function evaluatePreflightRetryBudget(input = {}) {
  const attempt = Math.max(1, Number(input.attempt) || 1);
  const maxAttempts = Number(input.maxAttempts) > 0 ? Number(input.maxAttempts) : DEFAULT_MAX_ATTEMPTS;
  const startedMonotonicMs = Number(input.startedMonotonicMs);
  const nowMonotonicMs = Number(input.nowMonotonicMs);
  const wallClockBudgetMs = Number(input.wallClockBudgetMs) > 0
    ? Number(input.wallClockBudgetMs)
    : DEFAULT_WALL_CLOCK_BUDGET_MS;
  const remainingClaimMs = Number(input.remainingClaimMs);

  let budgetMs = wallClockBudgetMs;
  if (Number.isFinite(remainingClaimMs) && remainingClaimMs > 0) {
    budgetMs = Math.min(budgetMs, remainingClaimMs);
  }

  const elapsedMs = Number.isFinite(startedMonotonicMs) && Number.isFinite(nowMonotonicMs)
    ? Math.max(0, nowMonotonicMs - startedMonotonicMs)
    : 0;
  const remainingMs = Math.max(0, budgetMs - elapsedMs);
  const capturesRemaining = Math.max(0, maxAttempts - attempt + 1);
  const canCapture = capturesRemaining > 0 && remainingMs > 0;
  const canRetry = attempt < maxAttempts && remainingMs > 0;

  return {
    canRetry,
    canCapture,
    attemptsRemaining: capturesRemaining,
    elapsedMs,
    remainingMs,
    budgetMs,
    exhaustedReason: remainingMs <= 0 ? 'wall_clock_budget_exhausted' : 'attempt_budget_exhausted',
  };
}

/**
 * @param {object} input
 */
export function shieldBackoffInfraClassification(input = {}) {
  return {
    failureClass: INFRA_TRANSPORT_FAILURE_CLASS,
    shape: String(input.transientClass ?? 'rate_limit_backoff'),
  };
}

async function main() {
  const subcommand = process.argv[2] ?? 'classify';
  const payload = await readStdinJson();

  if (subcommand === 'classify') {
    return classifyPreflightGhOutcome(payload ?? {});
  }
  if (subcommand === 'backoff') {
    return computePreflightBackoffMs(payload ?? {});
  }
  if (subcommand === 'budget') {
    return evaluatePreflightRetryBudget(payload ?? {});
  }
  if (subcommand === 'backoff-classification') {
    return shieldBackoffInfraClassification(payload ?? {});
  }

  throw new Error(`Unknown review-start-preflight-shield subcommand: ${subcommand}`);
}

runAsyncStdinJsonCliMain('review-start-preflight-shield.mjs', main);
