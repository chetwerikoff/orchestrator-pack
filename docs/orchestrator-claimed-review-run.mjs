/**
 * LLM-orchestrator claimed review-start gate (Issue #318).
 * Vitest: scripts/orchestrator-claimed-review-run.test.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateHeadReadyForReview,
  preRunHeadReadyRecheck,
  resolveCurrentPrHeadSha,
} from './review-head-ready.mjs';
import {
  COVERED_TERMINAL_REVIEW_STATUSES,
  IN_FLIGHT_REVIEW_STATUSES,
  findFailedOrCancelledRunForHead,
  hasFailedOrCancelledOnHead,
  isHeadCovered,
  isRunCoveringHead,
  normalizeLegacyReviewRunStatus,
  normalizeSha,
  resolveHeadCommittedAtMs,
  toArray,
} from './review-trigger-reconcile.mjs';
import { resolveFailedRunRetryEligibility } from './autonomous-review-retry.mjs';
import { isScopedGhInfraTransportFailure } from './review-start-preflight-shield.mjs';
import {
  evaluateAutonomousGatePreflight,
  loadAutonomousCapabilitiesInventory,
  loadMergedAutonomousCapabilitiesInventory,
  validateCapabilityInventory,
} from './autonomous-gate-preflight.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import { evaluateReviewCycleCapGate } from './review-cycle-cap.mjs';
export { validateCapabilityInventory };

export const ORCHESTRATOR_CLAIMED_REVIEW_RUN_GATE_VERSION =
  'orchestrator-claimed-review-run/v1';
export const ATOMIC_REVIEW_START_CLAIM_CAPABILITY = 'review-start-claim-atomic/v1';
export const ORCHESTRATOR_TURN_SURFACE = 'orchestrator-turn';
export const AUTONOMOUS_SURFACE_ENV = 'AO_SESSION_ID';
export const CLAIMED_REVIEW_RUN_BYPASS_ENV = 'AO_CLAIMED_REVIEW_RUN_BYPASS';


function resolveCoverageRetryEligible(latest, rows) {
  const prNumber = Number(latest?.prNumber);
  const headSha = normalizeSha(latest?.targetSha);
  if (!prNumber || !headSha) {
    return {
      retryEligible: (latest?.retryEligible ?? latest?.retryCount == null) !== false,
      escalationReason: null,
    };
  }
  const retryState = resolveFailedRunRetryEligibility(latest, rows, prNumber, headSha);
  return {
    retryEligible: retryState.retryEligible !== false,
    escalationReason: retryState.escalationReason ?? null,
  };
}

const KNOWN_RUN_STATUSES = new Set([
  ...IN_FLIGHT_REVIEW_STATUSES,
  ...COVERED_TERMINAL_REVIEW_STATUSES,
  'failed',
  'cancelled',
  'outdated',
]);

const SHA40 = /^[0-9a-f]{40}$/;

/**
 * @param {string | undefined | null} sha
 */
export function isNormalizedHeadSha(sha) {
  return SHA40.test(normalizeSha(sha));
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} reviewRuns
 * @param {number} prNumber
 * @param {string} headSha
 */
export function selectCurrentHeadRows(reviewRuns, prNumber, headSha) {
  const head = normalizeSha(headSha);
  return toArray(reviewRuns).filter(
    (run) => Number(run?.prNumber) === prNumber && normalizeSha(run?.targetSha) === head,
  );
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} rows
 */
export function classifyCurrentHeadCoverage(rows) {
  const list = toArray(rows);
  if (list.length === 0) {
    return { verdict: 'not_covered', reason: 'no_current_head_rows' };
  }

  for (const run of list) {
    const sha = normalizeSha(run?.targetSha);
    if (!sha) {
      return { verdict: 'unknown', reason: 'malformed_head_sha' };
    }
    const status = normalizeLegacyReviewRunStatus(run?.status);
    if (!status) {
      return { verdict: 'unknown', reason: 'missing_status' };
    }
    if (!KNOWN_RUN_STATUSES.has(status)) {
      return { verdict: 'unknown', reason: 'unknown_status', status };
    }
    if (IN_FLIGHT_REVIEW_STATUSES.has(status)) {
      return { verdict: 'covered', reason: 'in_flight_precedence', status };
    }
  }

  const terminalRows = list.filter((run) => {
    const status = normalizeLegacyReviewRunStatus(run?.status);
    return status !== 'outdated';
  });
  if (terminalRows.length === 0) {
    return { verdict: 'not_covered', reason: 'only_outdated_rows' };
  }

  const sorted = [...terminalRows].sort((a, b) => {
    const aMs = Date.parse(String(a?.createdAt ?? a?.startedAt ?? '')) || 0;
    const bMs = Date.parse(String(b?.createdAt ?? b?.startedAt ?? '')) || 0;
    if (bMs !== aMs) {
      return bMs - aMs;
    }
    return String(b?.id ?? b?.runId ?? '').localeCompare(String(a?.id ?? a?.runId ?? ''));
  });
  const latest = sorted[0];
  const latestPeers = sorted.filter((run) => {
    const aMs = Date.parse(String(run?.createdAt ?? run?.startedAt ?? '')) || 0;
    const bMs = Date.parse(String(latest?.createdAt ?? latest?.startedAt ?? '')) || 0;
    return aMs === bMs;
  });
  if (latestPeers.length > 1) {
    const statuses = new Set(latestPeers.map((run) => normalizeLegacyReviewRunStatus(run?.status)));
    if (statuses.size > 1) {
      return { verdict: 'unknown', reason: 'ambiguous_latest_rows' };
    }
  }

  const status = String(latest?.status ?? '').toLowerCase();
  if (status === 'failed' || status === 'cancelled') {
    const findingCount = Number(latest?.findingCount ?? 0);
    const retry = resolveCoverageRetryEligible(latest, list);
    if (findingCount === 0 && status === 'failed') {
      return {
        verdict: 'failed_or_cancelled',
        reason: 'empty_failed_not_clean',
        status,
        retryEligible: retry.retryEligible,
        escalationReason: retry.escalationReason ?? undefined,
      };
    }
    return {
      verdict: 'failed_or_cancelled',
      reason: 'failed_or_cancelled_on_head',
      status,
      retryEligible: retry.retryEligible,
      escalationReason: retry.escalationReason ?? undefined,
    };
  }
  if (isRunCoveringHead(latest)) {
    return { verdict: 'covered', reason: 'covered_terminal', status };
  }
  return { verdict: 'not_covered', reason: 'latest_not_covering', status };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} reviewRuns
 * @param {number} prNumber
 * @param {string} headSha
 */
export function evaluateCurrentHeadCoverage(reviewRuns, prNumber, headSha) {
  const rows = selectCurrentHeadRows(reviewRuns, prNumber, headSha);
  return classifyCurrentHeadCoverage(rows);
}

/**
 * @param {object} input
 * @param {'free' | 'held_by_other' | 'prior_terminal'} input.claimWindow
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} input.reviewRuns
 * @param {number} input.prNumber
 * @param {string} input.headSha
 */
export function evaluateScenarioMatrixCell({ claimWindow, reviewRuns, prNumber, headSha }) {
  const coverage = evaluateCurrentHeadCoverage(reviewRuns, prNumber, headSha);
  if (coverage.verdict === 'unknown') {
    return { launch: false, reason: 'read_error_unknown', coverage };
  }
  if (claimWindow === 'held_by_other') {
    return { launch: false, reason: 'claim_lost_race', coverage };
  }
  if (coverage.verdict === 'covered') {
    return { launch: false, reason: 'head_covered', coverage };
  }
  if (coverage.verdict === 'failed_or_cancelled') {
    if (coverage.retryEligible === false) {
      return { launch: false, reason: 'retry_bound_exhausted', coverage };
    }
    return { launch: true, reason: 'failed_retry_once', coverage };
  }
  return { launch: true, reason: 'uncovered_start', coverage };
}

/**
 * @param {object} input
 * @param {number} input.prNumber
 * @param {string} [input.eventHeadSha]
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} [input.openPrs]
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} [input.reviewRuns]
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} [input.sessions]
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} [input.ciChecks]
 * @param {string[]} [input.requiredCheckNames]
 * @param {boolean} [input.requiredCheckLookupFailed]
 * @param {string} [input.sessionId]
 * @param {'free' | 'held_by_other' | 'prior_terminal'} [input.claimWindow]
 * @param {boolean} [input.provenanceAutonomous]
 * @param {Record<string, unknown>} [input.transportFailure]
 */
export function evaluateOrchestratorTurnGate(input) {
  const prNumber = Number(input.prNumber);
  if (!prNumber) {
    return {
      launch: false,
      reason: 'preflight_pr_missing',
      stage: 'head_resolution',
      auditShape: 'per_start_denial',
    };
  }

  if (input.provenanceAutonomous === false) {
    return {
      launch: false,
      reason: 'provenance_not_autonomous',
      stage: 'provenance',
      auditShape: 'per_start_denial',
    };
  }

  const targetStateDenial = /** @type {Record<string, unknown>} */ (input.targetStateDenial ?? null);
  if (targetStateDenial && targetStateDenial.ok === false) {
    return {
      launch: false,
      reason: String(targetStateDenial.reason ?? 'pr_not_open'),
      stage: 'head_resolution',
      auditShape: 'per_start_denial',
    };
  }

  const transportFailure = /** @type {Record<string, unknown>} */ (input.transportFailure ?? null);
  if (transportFailure && transportFailure.ok === false) {
    const reason = String(transportFailure.reason ?? 'scoped_gh_read_infrastructure_failure');
    if (isScopedGhInfraTransportFailure(transportFailure)) {
      return {
        launch: false,
        reason,
        stage: 'head_resolution',
        auditShape: 'infrastructure_denial',
        scopedGhReadInfrastructure: true,
      };
    }
    return {
      launch: false,
      reason,
      stage: 'head_resolution',
      auditShape: 'per_start_denial',
    };
  }

  const currentHead = normalizeSha(resolveCurrentPrHeadSha(input.openPrs, prNumber));
  if (!currentHead) {
    return {
      launch: false,
      reason: 'head_resolution_failed',
      stage: 'head_resolution',
      auditShape: 'per_start_denial',
      eventHeadSha: normalizeSha(input.eventHeadSha ?? ''),
    };
  }

  const eventHead = normalizeSha(input.eventHeadSha ?? '');
  const staleEventHead = Boolean(eventHead && eventHead !== currentHead);

  const openPr = toArray(input.openPrs).find((pr) => Number(pr?.number) === prNumber);
  if (!openPr || openPr?.isDraft === true) {
    return {
      launch: false,
      reason: 'pr_not_review_ready',
      stage: 'review_ready',
      auditShape: 'per_start_denial',
      currentHeadSha: currentHead,
    };
  }

  const capGate = evaluateReviewCycleCapGate({
    prNumber,
    currentHeadSha: currentHead,
    openPrs: input.openPrs,
    reviewRuns: toArray(input.reviewRuns),
    capState: input.capCycleState ?? {},
    issueBody: input.issueBody,
    mergedPrNumbers: input.mergedPrNumbers,
    producer: 'orchestrator-turn',
    nowMs: input.nowMs,
  });
  if (!capGate.allowStart) {
    return {
      launch: false,
      reason: capGate.reason,
      stage: 'review_cycle_cap',
      auditShape: 'per_start_denial',
      currentHeadSha: currentHead,
      staleEventHead,
      capCycleState: capGate.capState,
      mergeEligible: capGate.mergeEligible,
      atCapRecord: capGate.atCapRecord ?? undefined,
    };
  }

  const headReady = evaluateHeadReadyForReview({
    reviewRuns: toArray(input.reviewRuns),
    prNumber,
    headSha: currentHead,
    session: input.sessionId
      ? toArray(input.sessions).find((s) => String(s?.sessionId ?? s?.id ?? s?.name ?? '') === input.sessionId) ?? null
      : null,
    ciChecks: toArray(input.ciChecks),
    requiredCheckNames: toArray(input.requiredCheckNames),
    requiredCheckLookupFailed: Boolean(input.requiredCheckLookupFailed),
    headCommittedAtMs: resolveHeadCommittedAtMs(input.openPrs, prNumber),
  });
  if (!headReady.eligible && hasFailedOrCancelledOnHead(toArray(input.reviewRuns), prNumber, currentHead)) {
    const failed = findFailedOrCancelledRunForHead(toArray(input.reviewRuns), prNumber, currentHead);
    const retryState = resolveFailedRunRetryEligibility(
      failed,
      toArray(input.reviewRuns),
      prNumber,
      currentHead,
    );
    if (retryState.retryEligible === false) {
      return {
        launch: false,
        reason: 'retry_bound_exhausted',
        stage: 'coverage',
        auditShape: 'per_start_denial',
        currentHeadSha: currentHead,
        staleEventHead,
        escalationReason: retryState.escalationReason ?? undefined,
        capCycleState: capGate.capState,
      };
    }
  } else if (!headReady.eligible) {
    return {
      launch: false,
      reason: headReady.reason,
      stage: 'review_ready',
      auditShape: 'per_start_denial',
      currentHeadSha: currentHead,
      staleEventHead,
      capCycleState: capGate.capState,
    };
  }

  const claimWindow = input.claimWindow ?? 'free';
  const matrix = evaluateScenarioMatrixCell({
    claimWindow,
    reviewRuns: toArray(input.reviewRuns),
    prNumber,
    headSha: currentHead,
  });
  if (!matrix.launch) {
    return {
      launch: false,
      reason: matrix.reason,
      stage: matrix.reason === 'claim_lost_race' ? 'claim' : 'coverage',
      auditShape: 'per_start_denial',
      currentHeadSha: currentHead,
      staleEventHead,
      coverage: matrix.coverage,
      capCycleState: capGate.capState,
    };
  }

  const recheck = preRunHeadReadyRecheck(
    { prNumber, headSha: currentHead, sessionId: input.sessionId ?? '' },
    {
      openPrs: input.openPrs,
      reviewRuns: input.reviewRuns,
      sessions: input.sessions,
      ciChecks: input.ciChecks,
      requiredCheckNames: input.requiredCheckNames,
      requiredCheckLookupFailed: input.requiredCheckLookupFailed,
    },
  );
  if (!recheck.emitReviewRun) {
    return {
      launch: false,
      reason: recheck.reason,
      stage: 'coverage_recheck',
      auditShape: 'per_start_denial',
      currentHeadSha: currentHead,
      staleEventHead,
      capCycleState: capGate.capState,
    };
  }

  return {
    launch: true,
    reason: recheck.reason,
    stage: 'launch',
    auditShape: 'none',
    currentHeadSha: currentHead,
    staleEventHead,
    sessionId: input.sessionId,
    capCycleState: capGate.capState,
    mergeEligible: capGate.mergeEligible,
  };
}

/**
 * @param {string} commandLine
 */
export function containsRawReviewRunInvocation(commandLine) {
  const text = String(commandLine ?? '');
  return /\bao(?:\.cmd)?\s+review\s+run\b/i.test(text)
    || /\breview\s+run\b.*--execute\b/i.test(text);
}

/**
 * @param {string} segment
 */
function containsUnquotedShellCompoundOperator(segment) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (char === ';' || char === '|') {
        return true;
      }
      if (char === '&' && segment[index + 1] === '&') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Claimed-review git parent provenance: review-run must precede mutating git on the line,
 * and git must not appear as a separate compound-shell command after review-run.
 * @param {string} commandLine
 */
export function isClaimedReviewRunParentCommandLine(commandLine) {
  const text = String(commandLine ?? '');
  const aoReviewRun = /\bao(?:\.cmd)?\s+review\s+run\b/i.exec(text)
    ?? /\breview\s+run\b.*--execute\b/i.exec(text);
  if (!aoReviewRun) {
    return false;
  }
  const gitPrimary = /\bgit\s+(?:-[a-zA-Z]|branch|checkout|switch|worktree|reset|commit|merge|rebase|pull|tag|stash|push|fetch)\b/i.exec(text);
  if (!gitPrimary) {
    return true;
  }
  if (gitPrimary.index < aoReviewRun.index) {
    return false;
  }
  const reviewRunEnd = aoReviewRun.index + aoReviewRun[0].length;
  const between = text.slice(reviewRunEnd, gitPrimary.index);
  if (containsUnquotedShellCompoundOperator(between)) {
    return false;
  }
  return true;
}

/**
 * AO-owned worktree setup encoded in review-run --command (not reviewer-side git).
 * @param {string} commandLine
 */
export function isAoReviewRunGitWorktreeSetupCommandLine(commandLine) {
  const text = String(commandLine ?? '');
  const aoReviewRun = /\bao(?:\.cmd)?\s+review\s+run\b/i.exec(text)
    ?? /\breview\s+run\b.*--execute\b/i.exec(text);
  if (!aoReviewRun) {
    return false;
  }
  const gitWorktree = /\bgit\s+worktree\s+add\b/i.exec(text);
  if (!gitWorktree) {
    return false;
  }
  if (gitWorktree.index < aoReviewRun.index) {
    return false;
  }
  const reviewRunEnd = aoReviewRun.index + aoReviewRun[0].length;
  const between = text.slice(reviewRunEnd, gitWorktree.index);
  if (containsUnquotedShellCompoundOperator(between)) {
    return false;
  }
  return true;
}

/**
 * @param {string} commandLine
 */
export function isRawReviewRunInvocation(commandLine) {
  return containsRawReviewRunInvocation(commandLine);
}

/**
 * @param {object} input
 * @param {string} [input.commandLine]
 * @param {boolean} [input.autonomousSurface]
 * @param {boolean} [input.claimedBypass]
 */
export function evaluateAutonomousReviewRunBoundary(input) {
  const commandLine = String(input.commandLine ?? '');
  if (!isRawReviewRunInvocation(commandLine)) {
    return { allowed: true, reason: 'not_review_run' };
  }
  if (!input.autonomousSurface) {
    return { allowed: true, reason: 'manual_surface' };
  }
  if (input.claimedBypass) {
    return { allowed: true, reason: 'claimed_bypass' };
  }
  return { allowed: false, reason: 'autonomous_raw_review_run_denied' };
}

/**
 * @param {string[]} commandLines
 */
export function findForbiddenAutonomousReviewRunInvocations(commandLines) {
  return toArray(commandLines)
    .map((commandLine) => ({
      commandLine,
      verdict: evaluateAutonomousReviewRunBoundary({
        commandLine,
        autonomousSurface: true,
        claimedBypass: false,
      }),
    }))
    .filter((entry) => !entry.verdict.allowed);
}

/**
 * @param {object} input
 * @param {string} input.loadedGateVersion
 * @param {boolean} [input.atomicClaimPresent]
 * @param {Array<{ id: string, classification: string }>} [input.liveCapabilities]
 */
export function evaluateGatePreflight(input) {
  return evaluateAutonomousGatePreflight(input, {
    expectedGateVersion: ORCHESTRATOR_CLAIMED_REVIEW_RUN_GATE_VERSION,
    atomicClaimCapability: ATOMIC_REVIEW_START_CLAIM_CAPABILITY,
    rawCapabilityId: 'ao-review-run-raw',
    rawNotUnavailableReason: 'raw_review_run_not_unavailable',
    extraRequiredUnavailable: ['ao-spawn-raw', 'git-mutating-direct', 'turn-visible-real-binary-env'],
  });
}

/**
 * @param {object} record
 */
export function buildRedactedAuditRecord(record) {
  const allowed = new Set([
    'kind',
    'reason',
    'provenance',
    'claimOutcome',
    'prNumber',
    'headSha',
    'markerState',
    'count',
    'firstAtUtc',
    'lastAtUtc',
    'gateVersion',
  ]);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (!allowed.has(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {object} input
 */
export function buildDenialCoalesceKey(input) {
  return [
    input.repo ?? 'orchestrator-pack',
    input.prNumber ?? '',
    normalizeSha(input.headSha ?? ''),
    input.provenance ?? ORCHESTRATOR_TURN_SURFACE,
    input.reason ?? '',
  ].join('|');
}

/**
 * @param {object} existing
 * @param {object} incoming
 */
export function coalesceDenialAudit(existing, incoming) {
  const now = String(incoming.atUtc ?? new Date().toISOString());
  if (!existing) {
    return {
      ...incoming,
      count: 1,
      firstAtUtc: now,
      lastAtUtc: now,
    };
  }
  return {
    ...existing,
    ...incoming,
    count: Number(existing.count ?? 1) + 1,
    firstAtUtc: existing.firstAtUtc ?? now,
    lastAtUtc: now,
  };
}

/**
 * @param {string} [inventoryPath]
 */
export function loadAutonomousReviewStartCapabilities(inventoryPath) {
  return loadMergedAutonomousCapabilitiesInventory(inventoryPath, 'docs/autonomous-review-start-capabilities.json');
}

/**
 * @param {object} input
 * @param {Array<{ id: string, classification: string }>} input.repoInventory
 * @param {Array<{ id: string, classification?: string }>} [input.liveSurfaces]
 */
runStdinJsonCli('orchestrator-claimed-review-run.mjs', {
  evaluateTurnGate: () => evaluateOrchestratorTurnGate(readStdinJson()),
  evaluateBoundary: () => evaluateAutonomousReviewRunBoundary(readStdinJson()),
  evaluatePreflight: () => evaluateGatePreflight(readStdinJson()),
  evaluateScenario: () => evaluateScenarioMatrixCell(readStdinJson()),
  evaluateCoverage: () => {
    const input = readStdinJson();
    return evaluateCurrentHeadCoverage(input.reviewRuns, input.prNumber, input.headSha);
  },
});
