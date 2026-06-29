/**
 * Cross-attempt review-start envelope ledger (Issue #516).
 * Vitest: scripts/review-start-envelope-ledger.test.ts
 */
import { findCoveringRunForKey } from './review-start-envelope-external-io.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const ENVELOPE_LEDGER_VERSION = 'review-start-envelope-ledger/v1';
export const DEFAULT_CONSECUTIVE_FAILURE_ESCALATE_THRESHOLD = 3;
export const INFRA_TRANSPORT_FAILURE_CLASS = 'infra_transport';

/** @type {readonly string[]} */
export const COUNTED_TERMINAL_OUTCOMES = Object.freeze([
  'hold_budget_exceeded',
  'readiness_envelope_exceeded',
  'readiness_attempt_ceiling_exceeded',
]);

/**
 * @param {string} headSha
 */
export function normalizeLedgerHeadSha(headSha) {
  return String(headSha ?? '').trim().toLowerCase();
}

/**
 * @param {number} prNumber
 * @param {string} headSha
 */
export function ledgerKeyForPrHead(prNumber, headSha) {
  const normalized = normalizeLedgerHeadSha(headSha);
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !normalized) {
    return '';
  }
  return `pr-${prNumber}-${normalized}`;
}

/**
 * @param {unknown} value
 */
function readFailureClass(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'object' && value && 'failureClass' in value) {
    return String(/** @type {Record<string, unknown>} */ (value).failureClass ?? '');
  }
  return String(value);
}

/**
 * @param {object} input
 */
function resolveCountedFailureClass(input = {}) {
  const outcome = String(input.outcome ?? '').trim();
  if (COUNTED_TERMINAL_OUTCOMES.includes(outcome)) {
    return outcome;
  }
  if (outcome === 'run_not_visible_fenced') {
    const extra = /** @type {Record<string, unknown>} */ (input.extra ?? {});
    const underlying = String(extra.decisionReason ?? extra.reason ?? '').trim();
    if (COUNTED_TERMINAL_OUTCOMES.includes(underlying)) {
      return underlying;
    }
  }
  return '';
}

/**
 * @param {object} input
 */
export function isCountedTerminal(input = {}) {
  const failureClass = resolveCountedFailureClass(input);
  if (failureClass) {
    return { counted: true, failureClass };
  }

  const outcome = String(input.outcome ?? '').trim();
  if (outcome !== 'released_for_retry') {
    return { counted: false, failureClass: '' };
  }

  const extra = /** @type {Record<string, unknown>} */ (input.extra ?? {});
  const direct =
    readFailureClass(extra.failureClass)
    || readFailureClass(extra.classification)
    || readFailureClass(extra.transportFailure);
  if (direct === INFRA_TRANSPORT_FAILURE_CLASS) {
    return { counted: true, failureClass: INFRA_TRANSPORT_FAILURE_CLASS };
  }

  const failureText = String(extra.failure ?? extra.reason ?? '').toLowerCase();
  if (failureText.includes('infra_transport') || failureText.includes('gh-wrapper')) {
    return { counted: true, failureClass: INFRA_TRANSPORT_FAILURE_CLASS };
  }

  return { counted: false, failureClass: '' };
}

/**
 * @param {object} input
 */
export function shouldResetLedger(input = {}) {
  const reason = String(input.reason ?? input.event ?? '').trim();
  if (reason === 'run_started' || reason === 'covered_head' || reason === 'preflight_success') {
    return true;
  }
  if (input.covered === true) {
    return true;
  }
  const reviewRuns = Array.isArray(input.reviewRuns) ? input.reviewRuns : [];
  const prNumber = Number(input.prNumber);
  const headSha = String(input.headSha ?? '');
  if (Number.isInteger(prNumber) && headSha && findCoveringRunForKey(reviewRuns, prNumber, headSha)) {
    return true;
  }
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} ledger
 */
export function emptyEnvelopeLedger(ledger = null) {
  const base = ledger && typeof ledger === 'object' ? { ...ledger } : {};
  return {
    schemaVersion: ENVELOPE_LEDGER_VERSION,
    entries: /** @type {Record<string, Record<string, unknown>>} */ (
      base.entries && typeof base.entries === 'object' ? { ...base.entries } : {}
    ),
  };
}

/**
 * @param {object} input
 */
export function applyLedgerReset(input = {}) {
  const ledger = emptyEnvelopeLedger(input.ledger);
  const key = ledgerKeyForPrHead(Number(input.prNumber), String(input.headSha ?? ''));
  if (!key) {
    return { ledger, changed: false, reason: 'invalid_key' };
  }
  if (!ledger.entries[key]) {
    return { ledger, changed: false, reason: 'missing_entry' };
  }
  delete ledger.entries[key];
  return { ledger, changed: true, reason: String(input.reason ?? 'reset') };
}

/**
 * @param {object} input
 */
export function applyLedgerTerminal(input = {}) {
  const counted = isCountedTerminal(input);
  if (!counted.counted) {
    return {
      ledger: emptyEnvelopeLedger(input.ledger),
      changed: false,
      counted: false,
      consecutiveFailureCount: 0,
      shouldEscalate: false,
    };
  }

  const ledger = emptyEnvelopeLedger(input.ledger);
  const prNumber = Number(input.prNumber);
  const headSha = normalizeLedgerHeadSha(input.headSha);
  const key = ledgerKeyForPrHead(prNumber, headSha);
  if (!key) {
    return {
      ledger,
      changed: false,
      counted: true,
      consecutiveFailureCount: 0,
      shouldEscalate: false,
      reason: 'invalid_key',
    };
  }

  const threshold = Number(input.threshold) > 0
    ? Number(input.threshold)
    : DEFAULT_CONSECUTIVE_FAILURE_ESCALATE_THRESHOLD;
  const surface = String(input.surface ?? '').trim();
  const nowUtc = String(input.nowUtc ?? new Date().toISOString());
  const prior = /** @type {Record<string, unknown>} */ (ledger.entries[key] ?? {});
  const priorSurfaces = Array.isArray(prior.surfaces) ? [...prior.surfaces] : [];
  if (surface && !priorSurfaces.includes(surface)) {
    priorSurfaces.push(surface);
  }

  const consecutiveFailureCount = Number(prior.consecutiveFailureCount ?? 0) + 1;
  const entry = {
    prNumber,
    headSha,
    consecutiveFailureCount,
    lastFailureClass: counted.failureClass,
    lastOutcome: String(input.outcome ?? ''),
    surfaces: priorSurfaces,
    lastTerminalAtUtc: nowUtc,
    revision: Number(prior.revision ?? 0) + 1,
  };
  ledger.entries[key] = entry;

  const shouldEscalate = consecutiveFailureCount === threshold;

  return {
    ledger,
    changed: true,
    counted: true,
    entry,
    consecutiveFailureCount,
    shouldEscalate,
    threshold,
  };
}

/**
 * @param {object} input
 */
export function markLedgerEscalated(input = {}) {
  const ledger = emptyEnvelopeLedger(input.ledger);
  const key = ledgerKeyForPrHead(Number(input.prNumber), String(input.headSha ?? ''));
  if (!key || !ledger.entries[key]) {
    return { ledger, changed: false, reason: 'missing_entry' };
  }
  const nowUtc = String(input.nowUtc ?? new Date().toISOString());
  ledger.entries[key] = {
    ...ledger.entries[key],
    lastEscalatedAtUtc: nowUtc,
    revision: Number(ledger.entries[key].revision ?? 0) + 1,
  };
  return { ledger, changed: true, lastEscalatedAtUtc: nowUtc };
}

/**
 * @param {object} input
 */
export function evaluateLedgerEscalation(input = {}) {
  const ledger = emptyEnvelopeLedger(input.ledger);
  const key = ledgerKeyForPrHead(Number(input.prNumber), String(input.headSha ?? ''));
  const entry = key ? ledger.entries[key] : null;
  const threshold = Number(input.threshold) > 0
    ? Number(input.threshold)
    : DEFAULT_CONSECUTIVE_FAILURE_ESCALATE_THRESHOLD;
  const count = Number(entry?.consecutiveFailureCount ?? 0);
  return {
    key,
    consecutiveFailureCount: count,
    threshold,
    shouldNotify: count >= threshold,
    entry: entry ?? null,
  };
}

runStdinJsonCli('review-start-envelope-ledger.mjs', {
  'is-counted-terminal': () => isCountedTerminal(readStdinJson()),
  'should-reset': () => ({ reset: shouldResetLedger(readStdinJson()) }),
  'apply-terminal': () => applyLedgerTerminal(readStdinJson()),
  'apply-reset': () => applyLedgerReset(readStdinJson()),
  'mark-escalated': () => markLedgerEscalated(readStdinJson()),
  evaluate: () => evaluateLedgerEscalation(readStdinJson()),
});
