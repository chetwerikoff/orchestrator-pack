/**
 * Review-start readiness envelope external I/O accounting (Issue #515).
 * Infra transport pause, monotonic attempt ceiling, supervised gh classification.
 */
import { printJson, readStdinJson, runAsyncStdinJsonCliMain } from './review-mechanical-cli.mjs';
import { normalizeLegacyReviewRunStatus, isRunCoveringHead, resolveAuthoritativeReviewRunStatus } from './review-reconcile-primitives.mjs';

const COVERED_RUN_STATUSES = [
  'queued',
  'preparing',
  'running',
  'reviewing',
  'up_to_date',
  'commented',
  'changes_requested',
];

function normalizeHeadSha(headSha) {
  return String(headSha ?? '').trim().toLowerCase();
}

export function findCoveringRunForKey(reviewRuns, prNumber, headSha) {
  const normalized = normalizeHeadSha(headSha);
  if (!normalized) return null;
  for (const run of Array.isArray(reviewRuns) ? reviewRuns : []) {
    const runPr = Number(run?.prNumber);
    if (!Number.isInteger(runPr) || runPr !== prNumber) continue;
    if (normalizeHeadSha(run?.targetSha) !== normalized) continue;
    if (!isRunCoveringHead(run)) continue;
    const status = normalizeLegacyReviewRunStatus(resolveAuthoritativeReviewRunStatus(run));
    if (!COVERED_RUN_STATUSES.includes(status)) continue;
    return { run, status, runId: String(run?.id ?? run?.runId ?? '') };
  }
  return null;
}

export const ENVELOPE_EXTERNAL_IO_VERSION = 'review-start-envelope-external-io/v1';
export const DEFAULT_ATTEMPT_CEILING_MS = 5 * 60 * 1000;
export const INFRA_TRANSPORT_FAILURE_CLASS = 'infra_transport';

/** @type {readonly string[]} */
export const INFRA_TRANSPORT_POSITIVE_SHAPES = Object.freeze([
  'dns_timeout',
  'tls_reset',
  'connect_timeout',
  'process_hang',
  'gh_wrapper_transport',
]);

/**
 * Injectable monotonic clock for tests.
 * @param {number} [startMs]
 */
export function createMonotonicClock(startMs = 0) {
  let now = Number(startMs) || 0;
  return {
    now: () => now,
    advance: (ms) => {
      now += Number(ms) || 0;
      return now;
    },
    set: (ms) => {
      now = Number(ms) || 0;
      return now;
    },
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readInjectedMonotonicNowMs(env = process.env) {
  const raw = String(env.AO_REVIEW_START_MONOTONIC_NOW_MS ?? '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function getMonotonicNowMs(env = process.env) {
  const injected = readInjectedMonotonicNowMs(env);
  if (injected != null) return injected;
  return Math.round(Number(process.hrtime.bigint()) / 1_000_000);
}

/**
 * @param {object} input
 */
export function classifyInfraTransportFailure(input = {}) {
  const stderr = String(input.stderr ?? input.message ?? input.failure ?? '');
  const text = stderr.toLowerCase();
  const timedOut = Boolean(input.timedOut);

  if (timedOut) {
    return { failureClass: INFRA_TRANSPORT_FAILURE_CLASS, shape: 'process_hang' };
  }

  if (
    text.includes('enotfound')
    || text.includes('name or service not known')
    || (text.includes('lookup') && text.includes('api.github.com'))
  ) {
    return { failureClass: INFRA_TRANSPORT_FAILURE_CLASS, shape: 'dns_timeout' };
  }

  if (
    text.includes('econnreset')
    || text.includes('connection reset')
    || text.includes('tls: handshake failure')
    || text.includes('tls handshake')
  ) {
    return { failureClass: INFRA_TRANSPORT_FAILURE_CLASS, shape: 'tls_reset' };
  }

  if (
    (text.includes('api.github.com') || text.includes('gh-wrapper'))
    && (text.includes('etimedout') || text.includes('i/o timeout') || text.includes('connect: connection timed out'))
  ) {
    return {
      failureClass: INFRA_TRANSPORT_FAILURE_CLASS,
      shape: text.includes('gh-wrapper') ? 'gh_wrapper_transport' : 'connect_timeout',
    };
  }

  if (
    text.includes('401')
    || text.includes('403')
    || text.includes('bad credentials')
    || text.includes('authentication failed')
    || text.includes('gh auth login')
  ) {
    return { failureClass: null, shape: 'auth' };
  }

  if (text.includes('rate limit') || text.includes('api rate limit') || text.includes('secondary rate limit')) {
    return { failureClass: null, shape: 'rate_limit' };
  }

  if (text.includes('malformed') || text.includes('invalid json') || text.includes('config')) {
    return { failureClass: null, shape: 'config_or_semantic' };
  }

  return { failureClass: null, shape: 'unknown' };
}

/**
 * @param {Record<string, unknown> | null | undefined} claim
 */
export function resolveFirstAttemptMonotonicMs(claim) {
  const first = claim?.firstAttemptAtMonotonicMs ?? claim?.readinessStartMonotonicMs;
  if (first == null || first === '') return null;
  const parsed = Number(first);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveReadinessStartMonotonicMs(claim) {
  const readiness = claim?.readinessStartMonotonicMs;
  if (readiness != null && readiness !== '') {
    const parsed = Number(readiness);
    if (Number.isFinite(parsed)) return parsed;
  }
  return resolveFirstAttemptMonotonicMs(claim);
}

/**
 * @param {Record<string, unknown> | null | undefined} claim
 * @param {number} nowMonotonicMs
 */
export function sumInfraPauseMs(claim, nowMonotonicMs) {
  let total = 0;
  const segments = Array.isArray(claim?.infraPauseSegments) ? claim.infraPauseSegments : [];
  for (const segment of segments) {
    const record = /** @type {Record<string, unknown>} */ (segment ?? {});
    if (record.failureClass !== INFRA_TRANSPORT_FAILURE_CLASS) continue;
    const start = Number(record.startedMonotonicMs);
    const end = record.endedMonotonicMs == null ? nowMonotonicMs : Number(record.endedMonotonicMs);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      total += end - start;
    }
  }

  const active = claim?.activeInfraPause;
  if (active && typeof active === 'object') {
    const start = Number(/** @type {Record<string, unknown>} */ (active).startedMonotonicMs);
    if (Number.isFinite(start) && nowMonotonicMs > start) {
      total += nowMonotonicMs - start;
    }
  }

  return total;
}

/**
 * @param {object} args
 */
export function evaluateReadinessEnvelopeWithPause({
  claim,
  nowMs,
  nowMonotonicMs,
  config,
}) {
  const budgetMs = Number(config?.readinessEnvelopeMs) > 0
    ? Number(config.readinessEnvelopeMs)
    : 30_000;
  const readinessMono = resolveReadinessStartMonotonicMs(claim);

  if (readinessMono == null || !Number.isFinite(nowMonotonicMs)) {
    const startedMs = Date.parse(String(claim?.acquiredAtUtc ?? ''));
    if (!Number.isFinite(startedMs)) {
      return {
        exceeded: false,
        reason: 'no_readiness_start',
        ageMs: 0,
        budgetMs,
        remainingMs: budgetMs,
        pauseMs: 0,
        clock: 'wall',
      };
    }
    const ageMs = Math.max(0, Number(nowMs) - startedMs);
    return {
      exceeded: ageMs >= budgetMs,
      ageMs,
      budgetMs,
      remainingMs: Math.max(0, budgetMs - ageMs),
      pauseMs: 0,
      reason: ageMs >= budgetMs ? 'envelope_exceeded' : 'within_envelope',
      clock: 'wall',
    };
  }

  const rawAgeMs = Math.max(0, Number(nowMonotonicMs) - readinessMono);
  const pauseMs = sumInfraPauseMs(claim, Number(nowMonotonicMs));
  const ageMs = Math.max(0, rawAgeMs - pauseMs);
  return {
    exceeded: ageMs >= budgetMs,
    ageMs,
    rawAgeMs,
    pauseMs,
    budgetMs,
    remainingMs: Math.max(0, budgetMs - ageMs),
    reason: ageMs >= budgetMs ? 'envelope_exceeded' : 'within_envelope',
    clock: 'monotonic',
    activeInfraPause: Boolean(claim?.activeInfraPause),
  };
}

/**
 * @param {object} args
 */
export function evaluateAttemptCeiling({
  claim,
  nowMonotonicMs,
  reviewRuns = [],
  config = {},
}) {
  const prNumber = Number(claim?.prNumber);
  const headSha = String(claim?.headSha ?? '');
  const covered = findCoveringRunForKey(reviewRuns, prNumber, headSha);
  if (covered) {
    return { exceeded: false, reason: 'covered', coveredRunId: covered.runId };
  }

  const firstMono = resolveFirstAttemptMonotonicMs(claim);
  if (firstMono == null || !Number.isFinite(nowMonotonicMs)) {
    return { exceeded: false, reason: 'no_first_attempt' };
  }

  const ceilingMs = Number(config.attemptCeilingMs) > 0
    ? Number(config.attemptCeilingMs)
    : DEFAULT_ATTEMPT_CEILING_MS;
  const ageMs = Math.max(0, Number(nowMonotonicMs) - firstMono);
  return {
    exceeded: ageMs >= ceilingMs,
    ageMs,
    ceilingMs,
    remainingMs: Math.max(0, ceilingMs - ageMs),
    reason: ageMs >= ceilingMs ? 'attempt_ceiling_exceeded' : 'within_ceiling',
  };
}

/**
 * @param {object} input
 */
export function beginInfraPauseSegment(input = {}) {
  const startedMonotonicMs = Number(input.startedMonotonicMs ?? input.nowMonotonicMs);
  return {
    activeInfraPause: {
      startedMonotonicMs,
      supervisedGhPid: input.supervisedGhPid ?? null,
      shape: input.shape ?? 'pending',
    },
  };
}

/**
 * @param {object} input
 */
export function closeInfraPauseSegment(input = {}) {
  const claim = /** @type {Record<string, unknown>} */ (input.claim ?? {});
  const active = claim.activeInfraPause;
  if (!active || typeof active !== 'object') {
    return { closed: false, reason: 'no_active_pause' };
  }

  const classification = input.classification
    ?? classifyInfraTransportFailure({
      stderr: input.stderr,
      timedOut: input.timedOut,
    });

  const startedMonotonicMs = Number(/** @type {Record<string, unknown>} */ (active).startedMonotonicMs);
  const endedMonotonicMs = Number(input.endedMonotonicMs ?? input.nowMonotonicMs);
  const segments = Array.isArray(claim.infraPauseSegments) ? [...claim.infraPauseSegments] : [];

  if (classification.failureClass === INFRA_TRANSPORT_FAILURE_CLASS) {
    segments.push({
      startedMonotonicMs,
      endedMonotonicMs,
      failureClass: INFRA_TRANSPORT_FAILURE_CLASS,
      shape: classification.shape,
    });
  }

  return {
    closed: true,
    classification,
    infraPauseSegments: segments,
    activeInfraPause: null,
    clearActiveInfraPause: true,
  };
}

/**
 * @param {object} input
 */
export function clearFirstAttemptOnCoveredHead(input = {}) {
  const claim = /** @type {Record<string, unknown>} */ (input.claim ?? {});
  const reviewRuns = Array.isArray(input.reviewRuns) ? input.reviewRuns : [];
  const covered = findCoveringRunForKey(
    reviewRuns,
    Number(claim.prNumber),
    String(claim.headSha ?? ''),
  );
  if (!covered) {
    return { clear: false, reason: 'uncovered' };
  }
  return {
    clear: true,
    clearFields: ['firstAttemptAtMonotonicMs', 'readinessStartMonotonicMs', 'infraPauseSegments', 'activeInfraPause'],
  };
}

async function main() {
  const subcommand = process.argv[2] ?? 'classify';
  const payload = await readStdinJson();

  if (subcommand === 'monotonic-now') {
    return { nowMonotonicMs: getMonotonicNowMs() };
  }
  if (subcommand === 'classify') {
    return classifyInfraTransportFailure(payload ?? {});
  }
  if (subcommand === 'envelope') {
    return evaluateReadinessEnvelopeWithPause({
      claim: payload?.claim,
      nowMs: Number(payload?.nowMs) > 0 ? Number(payload.nowMs) : Date.now(),
      nowMonotonicMs: Number(payload?.nowMonotonicMs),
      config: payload?.config ?? {},
    });
  }
  if (subcommand === 'attempt-ceiling') {
    return evaluateAttemptCeiling({
      claim: payload?.claim,
      nowMonotonicMs: Number(payload?.nowMonotonicMs),
      reviewRuns: payload?.reviewRuns ?? [],
      config: payload?.config ?? {},
    });
  }
  if (subcommand === 'begin-pause') {
    return beginInfraPauseSegment(payload ?? {});
  }
  if (subcommand === 'close-pause') {
    return closeInfraPauseSegment(payload ?? {});
  }
  if (subcommand === 'sum-pause') {
    return {
      pauseMs: sumInfraPauseMs(payload?.claim, Number(payload?.nowMonotonicMs)),
    };
  }

  throw new Error(`Unknown review-start-envelope-external-io subcommand: ${subcommand}`);
}

runAsyncStdinJsonCliMain('review-start-envelope-external-io.mjs', main);
