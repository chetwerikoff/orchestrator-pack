/**
 * Post-run autonomous review retry ledger (Issue #539).
 * Distinct from pre-launch envelope ledger (#516).
 */
import { normalizeSha } from './review-reconcile-primitives.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const POST_RUN_RETRY_LEDGER_VERSION = 'post-run-retry-ledger/v1';
export const DEFAULT_POST_RUN_RETRY_MAX = 1;
export const INFRA_NO_TRUSTWORTHY_VERDICT_ESCALATION = 'infra_no_trustworthy_verdict';
export const RETRY_BOUND_EXHAUSTED_REASON = 'retry_bound_exhausted';

/** Pre-launch classes owned by #516 — post-run ledger must not count these. */
export const PRE_LAUNCH_FAILURE_CLASSES = new Set(['infra_transport', 'readiness_envelope_exceeded']);

/**
 * @param {string} headSha
 */
export function normalizePostRunLedgerHeadSha(headSha) {
  return normalizeSha(headSha);
}

/**
 * @param {number} prNumber
 * @param {string} headSha
 * @param {string} failureClass
 */
export function postRunLedgerKey(prNumber, headSha, failureClass) {
  const normalized = normalizePostRunLedgerHeadSha(headSha);
  const klass = String(failureClass ?? '').trim();
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !normalized || !klass) {
    return '';
  }
  return `pr-${prNumber}-${normalized}-${klass}`;
}

/**
 * @param {string} failureClass
 */
export function isPreLaunchFailureClass(failureClass) {
  return PRE_LAUNCH_FAILURE_CLASSES.has(String(failureClass ?? '').trim());
}

/**
 * @param {Record<string, unknown> | null | undefined} ledger
 */
export function emptyPostRunRetryLedger(ledger = null) {
  const base = ledger && typeof ledger === 'object' ? { ...ledger } : {};
  return {
    schemaVersion: POST_RUN_RETRY_LEDGER_VERSION,
    entries: { ...(/** @type {Record<string, unknown>} */ (base.entries) ?? {}) },
    manualAudit: Array.isArray(base.manualAudit) ? [...base.manualAudit] : [],
  };
}

/**
 * @param {object} input
 */
export function recordManualOperatorRetryAudit(input = {}) {
  const ledger = emptyPostRunRetryLedger(input.ledger);
  const entry = {
    prNumber: Number(input.prNumber),
    headSha: normalizePostRunLedgerHeadSha(String(input.headSha ?? '')),
    failureClass: String(input.failureClass ?? ''),
    runId: String(input.runId ?? ''),
    atUtc: String(input.atUtc ?? new Date().toISOString()),
    provenance: 'manual-operator',
  };
  ledger.manualAudit = [...ledger.manualAudit, entry].slice(-50);
  return { ledger, changed: true, entry };
}

/**
 * @param {object} input
 */
export function applyPostRunRetryAttempt(input = {}) {
  const failureClass = String(input.failureClass ?? '').trim();
  if (!failureClass || isPreLaunchFailureClass(failureClass)) {
    return {
      ledger: emptyPostRunRetryLedger(input.ledger),
      changed: false,
      reason: 'pre_launch_or_missing_class',
      autonomousAttemptCount: 0,
    };
  }

  const ledger = emptyPostRunRetryLedger(input.ledger);
  const key = postRunLedgerKey(Number(input.prNumber), String(input.headSha ?? ''), failureClass);
  if (!key) {
    return { ledger, changed: false, reason: 'invalid_key', autonomousAttemptCount: 0 };
  }

  const prior = /** @type {Record<string, unknown>} */ (ledger.entries[key] ?? {});
  const autonomousAttemptCount = Number(prior.autonomousAttemptCount ?? 0) + 1;
  ledger.entries[key] = {
    ...prior,
    prNumber: Number(input.prNumber),
    headSha: normalizePostRunLedgerHeadSha(String(input.headSha ?? '')),
    failureClass,
    autonomousAttemptCount,
    lastAttemptAtUtc: String(input.atUtc ?? new Date().toISOString()),
    lastRunId: String(input.runId ?? prior.lastRunId ?? ''),
    revision: Number(prior.revision ?? 0) + 1,
  };

  return { ledger, changed: true, autonomousAttemptCount, key };
}

/**
 * @param {object} input
 */
export function readPostRunLedgerEntry(input = {}) {
  const ledger = emptyPostRunRetryLedger(input.ledger);
  const key = postRunLedgerKey(
    Number(input.prNumber),
    String(input.headSha ?? ''),
    String(input.failureClass ?? ''),
  );
  if (!key) {
    return { entry: null, autonomousAttemptCount: 0 };
  }
  const entry = ledger.entries[key] ?? null;
  return {
    entry,
    autonomousAttemptCount: Number(entry?.autonomousAttemptCount ?? 0),
  };
}

runStdinJsonCli('post-run-retry-ledger.mjs', {
  recordManualOperatorRetryAudit: () => {
    const payload = readStdinJson();
    return recordManualOperatorRetryAudit(payload ?? {});
  },
  applyPostRunRetryAttempt: () => {
    const payload = readStdinJson();
    return applyPostRunRetryAttempt(payload ?? {});
  },
  readPostRunLedgerEntry: () => {
    const payload = readStdinJson();
    return readPostRunLedgerEntry(payload ?? {});
  },
});
