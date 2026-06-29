/**
 * Review-start claim ↔ AO review run lifecycle binding (Issue #521).
 * Vitest: scripts/review-start-claim-run-binding.test.ts
 */
import {
  COVERED_RUN_STATUSES,
  IN_FLIGHT_RUN_STATUSES,
  findCoveringRunForKey,
} from './review-start-claim-lifecycle.mjs';
import { normalizeSha, toArray } from './review-trigger-reconcile.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const REVIEW_START_CLAIM_RUN_BINDING_VERSION = 'review-start-claim-run-binding/v1';
export const MISSING_CLAIM_FOR_REVIEW_RUN = 'missing_claim_for_review_run';

export const MANUAL_OPERATOR_PROVENANCE = new Set([
  'manual-operator',
  'invoke-manual-review-run',
  'manual_review_run',
  'manual',
]);

export const PACK_OWNED_AUTOMATED_SURFACES = new Set([
  'review-trigger-reconcile',
  'review-trigger-reeval',
  'review-wake-trigger',
  'orchestrator-claimed-review-run',
  'orchestrator-turn',
  'review-ready-report-state-seed',
  'cursor-autonomous-review-start',
]);

export const PACK_OWNED_AUTOMATED_START_REASONS = new Set([
  'periodic=reconcile',
  'completion_wake',
  'handoff_wake',
  'deferred_head_watch',
  'report_state_seed',
  'orchestrator_turn',
  'quiescent_worker_handoff_fallback',
]);

const VISIBLE_TERMINAL_RUN_STATUSES = new Set(['failed', 'cancelled']);

function normalizeHeadSha(headSha) {
  return normalizeSha(headSha);
}

function normalizeProjectId(projectId) {
  return String(projectId ?? 'orchestrator-pack').trim().toLowerCase();
}

function runMatchesBindingKey(run, prNumber, headSha, projectId) {
  const runPr = Number(run?.prNumber);
  if (!Number.isInteger(runPr) || runPr !== prNumber) return false;
  if (normalizeHeadSha(run?.targetSha) !== normalizeHeadSha(headSha)) return false;
  const runProject = normalizeProjectId(run?.projectId ?? run?.project);
  if (projectId && runProject && runProject !== normalizeProjectId(projectId)) return false;
  return true;
}

function claimMatchesBindingKey(claim, prNumber, headSha, projectId) {
  if (Number(claim?.prNumber) !== prNumber) return false;
  if (normalizeHeadSha(claim?.headSha) !== normalizeHeadSha(headSha)) return false;
  const claimProject = normalizeProjectId(claim?.projectId ?? claim?.namespaceProjectId);
  if (projectId && claimProject && claimProject !== normalizeProjectId(projectId)) return false;
  return true;
}

function isLiveClaim(claim) {
  return String(claim?.state ?? '') === 'active';
}

function isReconciledClaim(claim) {
  const state = String(claim?.state ?? '');
  if (state === 'active') return isLiveClaim(claim);
  if (state !== 'terminal') return false;
  const outcome = String(claim?.outcome ?? '');
  return outcome === 'run_started'
    || outcome === 'covered_by_run'
    || outcome === 'released_after_run_terminalized';
}

/**
 * @param {Record<string, unknown>} run
 * @param {{ surface?: string, provenanceAutonomous?: boolean }} [options]
 */
export function isPackOwnedAutomatedReviewRun(run, options = {}) {
  if (run?.manualOperator === true || options?.manualOperator === true) {
    return false;
  }
  const provenance = String(
    run?.provenance
    ?? run?.startReason
    ?? run?.starterSurface
    ?? options?.surface
    ?? '',
  ).trim().toLowerCase();
  if (!provenance) {
    return options?.provenanceAutonomous === true;
  }
  if (MANUAL_OPERATOR_PROVENANCE.has(provenance)) {
    return false;
  }
  if (options?.provenanceAutonomous === false) {
    return false;
  }
  if (PACK_OWNED_AUTOMATED_SURFACES.has(provenance)) {
    return true;
  }
  if (PACK_OWNED_AUTOMATED_START_REASONS.has(provenance)) {
    return true;
  }
  if (options?.provenanceAutonomous === true) {
    return true;
  }
  if (run?.packOwnedAutomated === true) {
    return true;
  }
  return false;
}

/**
 * @param {Record<string, unknown>} run
 */
export function isManualOperatorReviewRun(run) {
  return !isPackOwnedAutomatedReviewRun(run);
}

/**
 * @param {unknown[]} reviewRuns
 * @param {number} prNumber
 * @param {string} headSha
 * @param {string} [projectId]
 */
export function findVisibleMatchingRun(reviewRuns, prNumber, headSha, projectId = '') {
  const normalized = normalizeHeadSha(headSha);
  let bestInFlight = null;
  let bestCoveredTerminal = null;
  let bestFailedTerminal = null;
  for (const run of toArray(reviewRuns)) {
    if (!runMatchesBindingKey(run, prNumber, normalized, projectId)) continue;
    const status = String(run?.status ?? '').trim().toLowerCase();
    const entry = {
      run,
      status,
      runId: String(run?.id ?? run?.runId ?? ''),
      reviewerSessionId: String(run?.reviewerSessionId ?? ''),
      createdAt: String(run?.createdAt ?? run?.startedAt ?? ''),
    };
    if (IN_FLIGHT_RUN_STATUSES.includes(status)) {
      bestInFlight = entry;
      continue;
    }
    if (COVERED_RUN_STATUSES.includes(status)) {
      bestCoveredTerminal = entry;
      continue;
    }
    if (VISIBLE_TERMINAL_RUN_STATUSES.has(status)) {
      bestFailedTerminal = entry;
    }
  }
  return bestInFlight ?? bestCoveredTerminal ?? bestFailedTerminal ?? null;
}

/**
 * @param {unknown[]} claims
 * @param {Record<string, unknown>} run
 * @param {string} [projectId]
 */
export function findMatchingClaimForRun(claims, run, projectId = '') {
  const prNumber = Number(run?.prNumber);
  const headSha = normalizeHeadSha(run?.targetSha);
  if (!prNumber || !headSha) return null;
  for (const claim of toArray(claims)) {
    if (!claimMatchesBindingKey(claim, prNumber, headSha, projectId)) continue;
    if (isLiveClaim(claim) || isReconciledClaim(claim)) {
      return claim;
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} claim
 * @param {number} prNumber
 * @param {string} headSha
 * @param {string} [projectId]
 * @param {string} [surface]
 */
export function evaluateAutomatedLaunchClaimGate({
  claim,
  prNumber,
  headSha,
  projectId = '',
  surface = '',
}) {
  if (!claim || !isLiveClaim(claim)) {
    return {
      allowed: false,
      reason: 'missing_live_claim',
      failClosed: true,
      surface,
      prNumber,
      headSha: normalizeHeadSha(headSha),
      projectId: normalizeProjectId(projectId),
    };
  }
  if (!claimMatchesBindingKey(claim, prNumber, headSha, projectId)) {
    return {
      allowed: false,
      reason: 'claim_binding_mismatch',
      failClosed: true,
      surface,
      prNumber,
      headSha: normalizeHeadSha(headSha),
      projectId: normalizeProjectId(projectId),
    };
  }
  return {
    allowed: true,
    reason: 'live_claim_bound',
    surface,
    prNumber,
    headSha: normalizeHeadSha(headSha),
    projectId: normalizeProjectId(projectId),
    claimKey: String(claim?.key ?? ''),
  };
}

function reviewerCompletedNormally(reviewerEvidence, run) {
  const evidence = reviewerEvidence ?? {};
  const exitCode = Number(evidence.exitCode ?? run?.reviewerExitCode);
  const completionStatus = String(evidence.completionStatus ?? run?.completionStatus ?? '').toLowerCase();
  if (completionStatus === 'normal' && exitCode === 0) {
    return true;
  }
  return false;
}

/**
 * @param {object} input
 */
export function evaluateLaunchPendingRunReconciliation({
  claim,
  reviewRuns,
  reviewerEvidence = null,
  nowMs = Date.now(),
  projectId = '',
}) {
  const prNumber = Number(claim?.prNumber);
  const headSha = normalizeHeadSha(claim?.headSha);
  const visible = findVisibleMatchingRun(reviewRuns, prNumber, headSha, projectId);
  if (visible) {
    if (IN_FLIGHT_RUN_STATUSES.includes(visible.status)) {
      return {
        reconcile: true,
        outcome: 'run_started',
        reason: 'launch_pending_visible_in_flight_run',
        runId: visible.runId,
        reviewerSessionId: visible.reviewerSessionId || undefined,
        nowMs,
      };
    }
    if (COVERED_RUN_STATUSES.includes(visible.status)) {
      return {
        reconcile: true,
        outcome: 'run_started',
        reason: 'launch_pending_visible_terminal_run',
        runId: visible.runId,
        reviewerSessionId: visible.reviewerSessionId || undefined,
        nowMs,
      };
    }
    if (VISIBLE_TERMINAL_RUN_STATUSES.has(visible.status)) {
      return {
        reconcile: true,
        outcome: 'released_after_run_terminalized',
        reason: 'launch_pending_visible_failed_or_cancelled_run',
        runId: visible.runId,
        reviewerSessionId: visible.reviewerSessionId || undefined,
        nowMs,
      };
    }
  }

  if (reviewerCompletedNormally(reviewerEvidence, visible?.run)) {
    return {
      reconcile: true,
      outcome: 'run_started',
      reason: 'launch_pending_completed_reviewer',
      runId: String(reviewerEvidence?.runId ?? visible?.runId ?? claim?.boundRunId ?? ''),
      reviewerSessionId: String(reviewerEvidence?.reviewerSessionId ?? visible?.reviewerSessionId ?? ''),
      nowMs,
    };
  }

  const covered = findCoveringRunForKey(reviewRuns, prNumber, headSha);
  if (covered && reviewerCompletedNormally(reviewerEvidence, covered.run)) {
    return {
      reconcile: true,
      outcome: 'run_started',
      reason: 'launch_pending_completed_reviewer',
      runId: covered.runId,
      reviewerSessionId: String(reviewerEvidence?.reviewerSessionId ?? covered.run?.reviewerSessionId ?? ''),
      nowMs,
    };
  }

  return { reconcile: false, nowMs };
}

/**
 * @param {object} input
 */
export function applyRunBindingToReclaimDecision({
  decision,
  claim,
  reviewRuns,
  reviewerEvidence = null,
  nowMs = Date.now(),
  projectId = '',
}) {
  const base = decision ?? { action: 'skip', reason: 'no_decision' };
  const launchPendingRelevant = Boolean(
    base.outcome === 'launch_pending_budget_exceeded'
    || base.reason === 'launch_pending_active'
    || base.reason === 'launch_pending_budget_exceeded'
    || asRecord(claim?.launchPending)?.atUtc
    || claim?.launchPendingInvokedAtUtc,
  );
  if (!launchPendingRelevant) {
    return base;
  }
  const binding = evaluateLaunchPendingRunReconciliation({
    claim,
    reviewRuns,
    reviewerEvidence,
    nowMs,
    projectId,
  });
  if (!binding.reconcile) {
    return base;
  }
  return {
    action: 'terminalize',
    outcome: binding.outcome,
    reason: binding.reason,
    runId: binding.runId,
    reviewerSessionId: binding.reviewerSessionId,
    binding,
    replacedOutcome: base.outcome,
  };
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * @param {object} input
 */
export function diagnoseMissingClaimForReviewRun({
  run,
  claims = [],
  projectId = '',
  reviewerEvidence = null,
  detectionPoint = 'lifecycle_reconciler',
  surface = '',
}) {
  if (!isPackOwnedAutomatedReviewRun(run, { surface, provenanceAutonomous: run?.provenanceAutonomous })) {
    return null;
  }
  const matching = findMatchingClaimForRun(claims, run, projectId);
  if (matching) {
    return null;
  }
  return {
    diagnostic: MISSING_CLAIM_FOR_REVIEW_RUN,
    projectId: normalizeProjectId(projectId || run?.projectId || run?.project),
    prNumber: Number(run?.prNumber),
    headSha: normalizeHeadSha(run?.targetSha),
    runId: String(run?.id ?? run?.runId ?? ''),
    reviewerSessionId: String(
      reviewerEvidence?.reviewerSessionId
      ?? run?.reviewerSessionId
      ?? '',
    ) || undefined,
    surface: String(surface || run?.starterSurface || run?.provenance || run?.startReason || ''),
    provenance: String(run?.provenance ?? run?.startReason ?? surface ?? ''),
    detectionPoint,
  };
}

/**
 * @param {object} input
 */
export function evaluateCursorGuardOffSurface({
  autonomousSurfaceActive = false,
  guardInstalled = true,
  liveClaim = null,
  run = null,
  claims = [],
  projectId = '',
}) {
  if (autonomousSurfaceActive) {
    return {
      covered: true,
      reason: 'autonomous_surface_guarded',
      launchAllowed: Boolean(liveClaim && isLiveClaim(liveClaim)),
    };
  }
  if (!guardInstalled) {
    return {
      covered: false,
      reason: 'cursor_guard_off_manual_only',
      launchAllowed: false,
      manualOnly: true,
    };
  }
  const diagnostic = run
    ? diagnoseMissingClaimForReviewRun({
      run,
      claims,
      projectId,
      detectionPoint: 'cursor_guard_off_observed_run',
      surface: 'cursor-autonomous-review-start',
    })
    : null;
  const launchGate = evaluateAutomatedLaunchClaimGate({
    claim: liveClaim,
    prNumber: Number(run?.prNumber ?? liveClaim?.prNumber ?? 0),
    headSha: String(run?.targetSha ?? liveClaim?.headSha ?? ''),
    projectId,
    surface: 'cursor-autonomous-review-start',
  });
  return {
    covered: true,
    reason: 'cursor_guard_inventory',
    launchAllowed: launchGate.allowed,
    diagnostic,
    manualOnly: !autonomousSurfaceActive,
  };
}

runStdinJsonCli('review-start-claim-run-binding.mjs', {
  evaluateLaunchGate: () => evaluateAutomatedLaunchClaimGate(readStdinJson()),
  diagnoseMissingClaim: () => diagnoseMissingClaimForReviewRun(readStdinJson()),
  evaluateLaunchPendingReconciliation: () => evaluateLaunchPendingRunReconciliation(readStdinJson()),
  applyReclaimBinding: () => applyRunBindingToReclaimDecision(readStdinJson()),
  evaluateCursorGuardOff: () => evaluateCursorGuardOffSurface(readStdinJson()),
});
