/**
 * Pack-owned post-run review failure enrichment and autonomous retry decision (Issue #539).
 * Vitest: scripts/autonomous-review-retry.test.ts
 */
import {
  INFRA_NO_TRUSTWORTHY_VERDICT_ESCALATION,
  isPreLaunchFailureClass,
  POST_RUN_RETRY_LEDGER_VERSION,
} from './post-run-retry-ledger.mjs';
import { resolveFailureEvidenceForRun } from './reviewer-failure-evidence.mjs';
import { fingerprintRun } from './review-run-recovery.mjs';
import { normalizeSha, toArray } from './review-reconcile-primitives.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export {
  INFRA_NO_TRUSTWORTHY_VERDICT_ESCALATION,
  isPreLaunchFailureClass,
  POST_RUN_RETRY_LEDGER_VERSION,
} from './post-run-retry-ledger.mjs';

export const TIMEOUT_NO_VERDICT_FAILURE_CLASS = 'timeout_no_verdict';
export const REPEATED_TIMEOUT_ESCALATION_REASON = 'repeated_timeout_no_verdict';
export const REVIEWER_EVIDENCE_PREFIX = 'reviewer-evidence:';
export const DEFAULT_POST_RUN_RETRY_MAX = 1;
export const DEFAULT_TIMEOUT_RETRY_MAX = 1;

function parseNonNegativeInt(raw, fallback) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function resolveTimeoutRetryMax(env = process.env) {
  return parseNonNegativeInt(env.AO_CODEX_REVIEW_TIMEOUT_RETRY_MAX, DEFAULT_TIMEOUT_RETRY_MAX);
}

/**
 * @param {string} text
 */
export function extractReviewerEvidenceFromText(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REVIEWER_EVIDENCE_PREFIX)) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed.slice(REVIEWER_EVIDENCE_PREFIX.length));
      if (parsed?.reviewer?.failureClass || typeof parsed?.reviewer?.effectiveBudgetMs === 'number') {
        return parsed;
      }
    } catch {
      // ignore malformed marker lines
    }
  }
  return null;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | null | undefined} run
 */
export function extractTerminationFailureClass(run) {
  const direct = run?.reviewer?.failureClass ?? run?.failureClass;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const termination = String(run?.terminationReason ?? '');
  const evidence = extractReviewerEvidenceFromText(termination);
  const fromEvidence = evidence?.reviewer?.failureClass;
  if (typeof fromEvidence === 'string' && fromEvidence.trim()) {
    return fromEvidence.trim();
  }
  if (/timeout before verdict/i.test(termination)) {
    return TIMEOUT_NO_VERDICT_FAILURE_CLASS;
  }
  return null;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} headSha
 */
function findFailedOrCancelledRunForHead(runs, prNumber, headSha) {
  const head = normalizeSha(headSha);
  const matches = toArray(runs).filter((run) => {
    const status = String(run?.status ?? '').toLowerCase();
    return (
      (status === 'failed' || status === 'cancelled') &&
      Number(run?.prNumber) === prNumber &&
      normalizeSha(run?.targetSha) === head
    );
  });
  if (matches.length === 0) {
    return null;
  }
  return [...matches].sort((a, b) => {
    const aMs = Date.parse(String(a?.createdAt ?? a?.startedAt ?? '')) || 0;
    const bMs = Date.parse(String(b?.createdAt ?? b?.startedAt ?? '')) || 0;
    return bMs - aMs;
  })[0];
}

export const FAILURE_CLASS_UNKNOWN = 'unknown';
export const FAILURE_CLASS_EMPTY_OUTPUT = 'empty_output';
export const FAILURE_CLASS_MALFORMED_OUTPUT = 'malformed_output';
export const FAILURE_CLASS_AUTH_FAILURE = 'auth_failure';
export const FAILURE_CLASS_QUOTA_EXCEEDED = 'quota_exceeded';
export const FAILURE_CLASS_USAGE_LIMIT = 'usage_limit';
export const FAILURE_CLASS_CONFIG_ERROR = 'config_error';
export const FAILURE_CLASS_DEPENDENCY_MISSING = 'dependency_missing';
export const FAILURE_CLASS_REVIEWER_PROCESS_CRASH = 'reviewer_process_crash';
export const FAILURE_CLASS_WORKSPACE_PREFLIGHT_TRANSIENT = 'workspace_preflight_transient';

/** @type {ReadonlySet<string>} */
export const RECOVERABLE_POST_RUN_FAILURE_CLASSES = new Set([
  TIMEOUT_NO_VERDICT_FAILURE_CLASS,
  FAILURE_CLASS_REVIEWER_PROCESS_CRASH,
  FAILURE_CLASS_WORKSPACE_PREFLIGHT_TRANSIENT,
]);

/** @type {ReadonlySet<string>} */
export const NON_RETRYABLE_POST_RUN_FAILURE_CLASSES = new Set([
  FAILURE_CLASS_EMPTY_OUTPUT,
  FAILURE_CLASS_MALFORMED_OUTPUT,
  FAILURE_CLASS_AUTH_FAILURE,
  FAILURE_CLASS_QUOTA_EXCEEDED,
  FAILURE_CLASS_USAGE_LIMIT,
  FAILURE_CLASS_CONFIG_ERROR,
  FAILURE_CLASS_DEPENDENCY_MISSING,
  FAILURE_CLASS_UNKNOWN,
]);

/**
 * @param {string} text
 */
function classifyFromTerminationHeuristics(text) {
  const lower = String(text ?? '').toLowerCase();
  if (!lower.trim()) {
    return null;
  }
  if (/empty output|zero findings.*empty|reviewer produced empty/i.test(lower)) {
    return FAILURE_CLASS_EMPTY_OUTPUT;
  }
  if (/malformed|invalid json|parse error|unparseable/i.test(lower)) {
    return FAILURE_CLASS_MALFORMED_OUTPUT;
  }
  if (/auth|unauthorized|401|403|credential|permission denied/i.test(lower)) {
    return FAILURE_CLASS_AUTH_FAILURE;
  }
  if (/quota exceeded|rate limit|too many requests|429/i.test(lower)) {
    return FAILURE_CLASS_QUOTA_EXCEEDED;
  }
  if (/usage limit|billing|insufficient.*quota/i.test(lower)) {
    return FAILURE_CLASS_USAGE_LIMIT;
  }
  if (/config|misconfig|invalid configuration/i.test(lower)) {
    return FAILURE_CLASS_CONFIG_ERROR;
  }
  if (/not found|enoent|missing binary|command not found|dependency/i.test(lower)) {
    return FAILURE_CLASS_DEPENDENCY_MISSING;
  }
  if (/preflight.*transient|workspace preflight.*retry|transient.*preflight/i.test(lower)) {
    return FAILURE_CLASS_WORKSPACE_PREFLIGHT_TRANSIENT;
  }
  if (
    /signal|segfault|aborted|process crash|wrapper exited abnormally|terminated_by_signal/i.test(
      lower,
    )
  ) {
    return FAILURE_CLASS_REVIEWER_PROCESS_CRASH;
  }
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} artifact
 */
export function extractFailureClassFromArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return null;
  }
  const chunks = [
    artifact.stderrTail,
    artifact.stdoutTail,
    artifact.terminationReason,
  ];
  for (const chunk of chunks) {
    const fromMarker = extractReviewerEvidenceFromText(String(chunk ?? ''));
    const klass = fromMarker?.reviewer?.failureClass;
    if (typeof klass === 'string' && klass.trim()) {
      return klass.trim();
    }
    const heuristic = classifyFromTerminationHeuristics(String(chunk ?? ''));
    if (heuristic) {
      return heuristic;
    }
  }
  const completion = String(artifact.completionStatus ?? '').toLowerCase();
  if (completion === 'abnormal' && Number(artifact.exitCode) !== 0) {
    return FAILURE_CLASS_REVIEWER_PROCESS_CRASH;
  }
  return null;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun} run
 * @param {Record<string, unknown> | null | undefined} artifact
 * @param {Record<string, unknown> | null | undefined} [pointer]
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} [allRuns]
 */
export function validateSidecarJoin(run, artifact, pointer = null, allRuns = []) {
  const runId = String(run?.id ?? run?.runId ?? '').trim();
  if (!runId) {
    return { ok: false, reason: 'missing_run_id' };
  }
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, reason: 'missing_sidecar' };
  }
  if (pointer && typeof pointer === 'object') {
    const pointerRunId = String(pointer.runId ?? '').trim();
    if (!pointerRunId || pointerRunId !== runId) {
      return { ok: false, reason: 'stale_or_missing_by_run_pointer' };
    }
    const pointerSession = String(pointer.reviewerSessionId ?? '').trim();
    const artifactSession = String(artifact.reviewerSessionId ?? '').trim();
    if (pointerSession && artifactSession && pointerSession !== artifactSession) {
      return { ok: false, reason: 'pointer_session_mismatch' };
    }
  }
  const artifactRunId = String(artifact.runId ?? '').trim();
  if (artifactRunId && artifactRunId !== runId) {
    return { ok: false, reason: 'run_id_mismatch' };
  }
  const fingerprint = String(artifact.runFingerprint ?? '').trim();
  if (fingerprint && fingerprint !== fingerprintRun(run)) {
    return { ok: false, reason: 'run_fingerprint_mismatch' };
  }
  const artifactPr = Number(artifact.prNumber);
  const runPr = Number(run?.prNumber);
  if (Number.isInteger(artifactPr) && artifactPr > 0 && runPr > 0 && artifactPr !== runPr) {
    return { ok: false, reason: 'pr_number_mismatch' };
  }
  const artifactHead = normalizeSha(String(artifact.targetSha ?? artifact.headSha ?? ''));
  const runHead = normalizeSha(String(run?.targetSha ?? ''));
  if (artifactHead && runHead && artifactHead !== runHead) {
    return { ok: false, reason: 'head_sha_mismatch' };
  }
  const reviewerSessionId = String(artifact.reviewerSessionId ?? run?.reviewerSessionId ?? '').trim();
  if (reviewerSessionId) {
    for (const other of toArray(allRuns)) {
      const otherId = String(other?.id ?? other?.runId ?? '').trim();
      if (!otherId || otherId === runId) {
        continue;
      }
      const otherSession = String(other?.reviewerSessionId ?? '').trim();
      if (otherSession === reviewerSessionId) {
        return { ok: false, reason: 'reviewer_session_reused_across_runs' };
      }
    }
  }
  return { ok: true };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun} run
 * @param {{ artifact?: Record<string, unknown>, pointer?: Record<string, unknown>, joinRejected?: boolean }} [evidence]
 */
export function classifyPostRunFailure(run, evidence = {}) {
  if (evidence.joinRejected) {
    return { failureClass: FAILURE_CLASS_UNKNOWN, source: 'join_rejected' };
  }
  if (evidence.artifact) {
    const join = validateSidecarJoin(run, evidence.artifact, evidence.pointer);
    if (!join.ok) {
      return { failureClass: FAILURE_CLASS_UNKNOWN, source: join.reason };
    }
    const fromArtifact = extractFailureClassFromArtifact(evidence.artifact);
    if (fromArtifact) {
      return { failureClass: fromArtifact, source: 'sidecar' };
    }
  }

  const direct = run?.failureClass ?? run?.reviewer?.failureClass;
  if (typeof direct === 'string' && direct.trim()) {
    return { failureClass: direct.trim(), source: 'run_field' };
  }

  const fromTermination = extractTerminationFailureClass(run);
  if (fromTermination) {
    return { failureClass: fromTermination, source: 'termination_reason' };
  }

  const heuristic = classifyFromTerminationHeuristics(String(run?.terminationReason ?? ''));
  if (heuristic) {
    return { failureClass: heuristic, source: 'termination_heuristic' };
  }

  return { failureClass: FAILURE_CLASS_UNKNOWN, source: 'none' };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun} run
 * @param {object} options
 * @param {Record<string, { artifact?: Record<string, unknown>, pointer?: Record<string, unknown> }>} [options.evidenceByRunId]
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} [options.allRuns]
 */
export function enrichReviewRun(run, options = {}) {
  const runId = String(run?.id ?? run?.runId ?? '').trim();
  const evidenceByRunId = options.evidenceByRunId ?? {};
  const evidenceContext = evidenceByRunId[runId] ?? {};
  const status = String(run?.status ?? '').toLowerCase();
  const isPostRunTerminal = status === 'failed' || status === 'cancelled';

  if (!isPostRunTerminal) {
    return { ...run };
  }

  const classified = classifyPostRunFailure(run, evidenceContext);
  const failureClass = classified.failureClass;
  const prNumber = Number(run?.prNumber);
  const headSha = normalizeSha(String(run?.targetSha ?? ''));
  const reviewRuns = options.allRuns ?? options.reviewRuns ?? [run];
  const decision = evaluatePostRunRetryDecision(run, reviewRuns, prNumber, headSha, {
    failureClass,
    maxRetries: options.maxRetries,
  });

  return {
    ...run,
    failureClass,
    retryEligible: decision.retryEligible,
    escalationReason: decision.escalationReason ?? undefined,
    failureClassSource: classified.source,
  };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} runs
 * @param {object} [options]
 */


/**
 * @param {string} storeDir
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} runs
 */
export function buildEvidenceByRunIdFromStore(storeDir, runs) {
  /** @type {Record<string, { artifact?: Record<string, unknown>, pointer?: Record<string, unknown> }>} */
  const evidenceByRunId = {};
  if (!storeDir) {
    return evidenceByRunId;
  }
  for (const run of toArray(runs)) {
    const runId = String(run?.id ?? run?.runId ?? '').trim();
    if (!runId) {
      continue;
    }
    const resolved = resolveFailureEvidenceForRun(storeDir, run);
    if (resolved.ok && resolved.artifact) {
      evidenceByRunId[runId] = { artifact: resolved.artifact };
    }
  }
  return evidenceByRunId;
}

export function enrichReviewRuns(runs, options = {}) {
  const list = toArray(runs);
  const evidenceByRunId = {
    ...(options.evidenceByRunId ?? {}),
    ...buildEvidenceByRunIdFromStore(String(options.storeDir ?? ''), list),
  };
  return list.map((run) =>
    enrichReviewRun(run, {
      ...options,
      evidenceByRunId,
      allRuns: list,
      reviewRuns: list,
    }),
  );
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} headSha
 * @param {string} failureClass
 */
export function countSameHeadFailuresByClass(runs, prNumber, headSha, failureClass) {
  const head = normalizeSha(headSha);
  const klass = String(failureClass ?? '').trim();
  if (!klass) {
    return 0;
  }
  return toArray(runs).filter((run) => {
    const status = String(run?.status ?? '').toLowerCase();
    if (status !== 'failed' && status !== 'cancelled') {
      return false;
    }
    if (Number(run?.prNumber) !== prNumber || normalizeSha(run?.targetSha) !== head) {
      return false;
    }
    const enriched = run?.failureClass
      ? String(run.failureClass)
      : classifyPostRunFailure(run).failureClass;
    return enriched === klass;
  }).length;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | null | undefined} run
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} reviewRuns
 * @param {number} prNumber
 * @param {string} headSha
 * @param {{ failureClass?: string, maxRetries?: number }} [options]
 */
export function evaluatePostRunRetryDecision(run, reviewRuns, prNumber, headSha, options = {}) {
  const failedRun = run ?? findFailedOrCancelledRunForHead(reviewRuns, prNumber, headSha);
  if (!failedRun) {
    return {
      failureClass: null,
      retryEligible: true,
      escalationReason: null,
      failureCount: 0,
    };
  }

  const failureClass =
    options.failureClass ??
    failedRun.failureClass ??
    classifyPostRunFailure(failedRun).failureClass;

  if (isPreLaunchFailureClass(failureClass)) {
    return {
      failureClass,
      retryEligible: false,
      escalationReason: null,
      failureCount: 0,
      preLaunchOwnedBy516: true,
    };
  }

  if (NON_RETRYABLE_POST_RUN_FAILURE_CLASSES.has(failureClass)) {
    return {
      failureClass,
      retryEligible: false,
      escalationReason: null,
      failureCount: countSameHeadFailuresByClass(reviewRuns, prNumber, headSha, failureClass),
    };
  }

  if (!RECOVERABLE_POST_RUN_FAILURE_CLASSES.has(failureClass)) {
    return {
      failureClass,
      retryEligible: failedRun.retryEligible === true,
      escalationReason: null,
      failureCount: 0,
    };
  }

  const failureCount = countSameHeadFailuresByClass(
    reviewRuns,
    prNumber,
    headSha,
    failureClass,
  );
  const maxRetries = Number(
    options.maxRetries ??
      (failureClass === TIMEOUT_NO_VERDICT_FAILURE_CLASS
        ? resolveTimeoutRetryMax()
        : DEFAULT_POST_RUN_RETRY_MAX),
  );
  const retryEligible = failureCount <= maxRetries;
  let escalationReason = null;
  if (!retryEligible) {
    escalationReason =
      failureClass === TIMEOUT_NO_VERDICT_FAILURE_CLASS
        ? REPEATED_TIMEOUT_ESCALATION_REASON
        : INFRA_NO_TRUSTWORTHY_VERDICT_ESCALATION;
  }

  return {
    failureClass,
    retryEligible,
    escalationReason,
    failureCount,
    maxRetries,
  };
}


/**
 * Shared entry for gates — replaces resolveFailedRunRetryEligibility.
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | null | undefined} run
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} reviewRuns
 * @param {number} prNumber
 * @param {string} headSha
 * @param {{ maxRetries?: number, evidenceByRunId?: Record<string, unknown> }} [options]
 */
export function resolveFailedRunRetryEligibility(run, reviewRuns, prNumber, headSha, options = {}) {
  const enrichedRuns = enrichReviewRuns(reviewRuns, {
    evidenceByRunId: options.evidenceByRunId,
    maxRetries: options.maxRetries,
  });
  const runId = String(run?.id ?? run?.runId ?? '').trim();
  const enrichedRun =
    enrichedRuns.find((row) => String(row?.id ?? row?.runId ?? '') === runId) ??
    (run ? enrichReviewRun(run, { ...options, allRuns: enrichedRuns }) : null);

  const decision = evaluatePostRunRetryDecision(
    enrichedRun,
    enrichedRuns,
    prNumber,
    headSha,
    { maxRetries: options.maxRetries },
  );

  return {
    failureClass: decision.failureClass,
    retryEligible: decision.retryEligible,
    escalationReason: decision.escalationReason,
    timeoutFailureCount: decision.failureCount,
    failureCount: decision.failureCount,
  };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} reviewRuns
 * @param {number} prNumber
 * @param {string} headSha
 */
export function shouldRouteNeedsTriageToSend(reviewRuns, prNumber, headSha) {
  const head = normalizeSha(headSha);
  return toArray(reviewRuns).some((run) => {
    if (Number(run?.prNumber) !== prNumber || normalizeSha(run?.targetSha) !== head) {
      return false;
    }
    if (String(run?.status ?? '').toLowerCase() !== 'needs_triage') {
      return false;
    }
    const openFindingCount = Number(run?.openFindingCount ?? run?.findingCount ?? 0);
    const sentFindingCount = Number(run?.sentFindingCount ?? 0);
    return openFindingCount > 0 && sentFindingCount === 0;
  });
}

runStdinJsonCli('autonomous-review-retry.mjs', {
  enrichReviewRuns: () => {
    const payload = readStdinJson();
    return enrichReviewRuns(payload?.runs ?? [], payload?.options ?? payload ?? {});
  },
  enrichReviewRun: () => {
    const payload = readStdinJson();
    return enrichReviewRun(payload?.run ?? {}, payload?.options ?? {});
  },
  evaluatePostRunRetryDecision: () => {
    const payload = readStdinJson();
    return evaluatePostRunRetryDecision(
      payload?.run,
      payload?.reviewRuns ?? [],
      Number(payload?.prNumber),
      String(payload?.headSha ?? ''),
      payload?.options ?? {},
    );
  },
  resolveFailedRunRetryEligibility: () => {
    const payload = readStdinJson();
    return resolveFailedRunRetryEligibility(
      payload?.run,
      payload?.reviewRuns ?? [],
      Number(payload?.prNumber),
      String(payload?.headSha ?? ''),
      payload?.options ?? {},
    );
  },
  classifyPostRunFailure: () => {
    const payload = readStdinJson();
    return classifyPostRunFailure(payload?.run ?? {}, payload?.evidence ?? {});
  },
  validateSidecarJoin: () => {
    const payload = readStdinJson();
    return validateSidecarJoin(
      payload?.run ?? {},
      payload?.artifact,
      payload?.pointer,
      payload?.allRuns ?? [],
    );
  },
});
