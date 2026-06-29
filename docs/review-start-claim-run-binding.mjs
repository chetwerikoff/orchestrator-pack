/**
 * Review-start claim ↔ AO review run lifecycle binding (Issue #521).
 */
import { printJson, readStdinJson, runAsyncStdinJsonCliMain } from './review-mechanical-cli.mjs';
import {
  COVERED_RUN_STATUSES,
  IN_FLIGHT_RUN_STATUSES,
  KNOWN_NON_COVERING_RUN_STATUSES,
} from './review-start-claim-lifecycle.mjs';
import { toArray } from './review-run-recovery.mjs';

export const REVIEW_START_CLAIM_RUN_BINDING_VERSION = 'review-start-claim-run-binding/v1';

export const MISSING_CLAIM_FOR_REVIEW_RUN = 'missing_claim_for_review_run';

export const PACK_OWNED_AUTOMATED_SURFACES = [
  'review-trigger-reconcile',
  'review-wake-trigger',
  'review-trigger-reeval',
  'orchestrator-turn',
  'report-state-seed',
  'ci-green-wake-reconcile',
  'review-ready-report-state-seed',
];

export const PACK_OWNED_AUTOMATED_START_REASONS = [
  'orchestrator_turn',
  'handoff_wake',
  'completion_wake',
  'periodic=reconcile',
  'report_state_seed',
  'scoped_deferred_head_watch',
  'quiescent_worker_handoff_fallback',
  'review-trigger-reeval',
];

export const MANUAL_OPERATOR_PROVENANCE = [
  'manual-operator',
  'invoke-manual-review-run',
  'manual_operator',
  'operator_manual',
];

export const CURSOR_GUARD_OFF_SURFACES = [
  'cursor-worker',
  'cursor-cli',
];

const RECONCILED_CLAIM_TERMINAL_OUTCOMES = new Set([
  'run_started',
  'covered_by_run',
  'released_after_run_terminalized',
  'operator_resolved_covered',
]);

function normalizeHeadSha(headSha) {
  return String(headSha ?? '').trim().toLowerCase();
}

function normalizeProjectNamespace(projectId) {
  return String(projectId ?? 'orchestrator-pack').trim().toLowerCase();
}

function normalizeStatus(status) {
  return String(status ?? '').trim().toLowerCase();
}

function claimProjectMatches(claim, projectNamespace) {
  const claimProject = normalizeProjectNamespace(
    claim?.projectId ?? claim?.project ?? claim?.namespaceProjectId,
  );
  return claimProject === normalizeProjectNamespace(projectNamespace);
}

function runProjectMatches(run, projectNamespace) {
  const runProject = normalizeProjectNamespace(run?.project ?? run?.projectId);
  return runProject === normalizeProjectNamespace(projectNamespace);
}

export function claimMatchesRunKey(claim, prNumber, headSha, projectNamespace = 'orchestrator-pack') {
  const claimPr = Number(claim?.prNumber);
  if (!Number.isInteger(claimPr) || claimPr !== Number(prNumber)) return false;
  if (!claimProjectMatches(claim, projectNamespace)) return false;
  return normalizeHeadSha(claim?.headSha) === normalizeHeadSha(headSha);
}

export function runMatchesBindingKey(run, prNumber, headSha, projectNamespace = 'orchestrator-pack') {
  const runPr = Number(run?.prNumber);
  if (!Number.isInteger(runPr) || runPr !== Number(prNumber)) return false;
  if (!runProjectMatches(run, projectNamespace)) return false;
  return normalizeHeadSha(run?.targetSha ?? run?.headSha) === normalizeHeadSha(headSha);
}

export function isManualOperatorProvenance(input = {}) {
  const markers = [
    input.provenance,
    input.surface,
    input.startReason,
    input.holderSurface,
    input.run?.provenance,
    input.run?.startReason,
    input.run?.surface,
  ]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
  return markers.some((marker) => MANUAL_OPERATOR_PROVENANCE.includes(marker));
}

export function isPackOwnedAutomatedProvenance(input = {}) {
  if (isManualOperatorProvenance(input)) {
    return false;
  }
  const run = input.run ?? input;
  const markers = [
    input.provenance,
    input.surface,
    input.startReason,
    input.holderSurface,
    run?.provenance,
    run?.startReason,
    run?.surface,
    run?.holder?.surface,
    run?.automatedProvenance,
  ]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);

  if (markers.some((marker) => MANUAL_OPERATOR_PROVENANCE.includes(marker))) {
    return false;
  }
  if (markers.some((marker) => PACK_OWNED_AUTOMATED_SURFACES.includes(marker))) {
    return true;
  }
  if (markers.some((marker) => PACK_OWNED_AUTOMATED_START_REASONS.includes(marker))) {
    return true;
  }
  if (input.claimedBypass === true || String(input.claimedBypassEnv ?? '') === '1') {
    return true;
  }
  if (run?.packOwnedAutomated === true || input.packOwnedAutomated === true) {
    return true;
  }
  return false;
}

export function isClaimLive(claim) {
  return String(claim?.state ?? '').trim().toLowerCase() === 'active';
}

export function isClaimReconciled(claim) {
  const state = String(claim?.state ?? '').trim().toLowerCase();
  if (state === 'active') {
    return Boolean(String(claim?.boundRunId ?? '').trim());
  }
  if (state !== 'terminal') return false;
  const outcome = String(claim?.terminalOutcome ?? claim?.outcome ?? '').trim();
  return RECONCILED_CLAIM_TERMINAL_OUTCOMES.has(outcome) || Boolean(String(claim?.boundRunId ?? '').trim());
}

export function findMatchingClaimForRun({
  claims,
  prNumber,
  headSha,
  projectNamespace = 'orchestrator-pack',
}) {
  const matches = toArray(claims).filter((claim) => claimMatchesRunKey(claim, prNumber, headSha, projectNamespace));
  const live = matches.filter((claim) => isClaimLive(claim));
  if (live.length === 1) {
    return { claim: live[0], lineage: 'live' };
  }
  if (live.length > 1) {
    return { claim: null, lineage: 'ambiguous_live', matches: live };
  }
  const reconciled = matches.filter((claim) => isClaimReconciled(claim));
  if (reconciled.length === 1) {
    return { claim: reconciled[0], lineage: 'reconciled' };
  }
  if (reconciled.length > 1) {
    return { claim: null, lineage: 'ambiguous_reconciled', matches: reconciled };
  }
  return { claim: null, lineage: 'none', matches };
}

export function evaluateAutomatedLaunchClaimGate({
  claim,
  claims,
  prNumber,
  headSha,
  projectNamespace = 'orchestrator-pack',
}) {
  const namespace = normalizeProjectNamespace(projectNamespace);
  const resolved = (() => {
    if (claim && claimMatchesRunKey(claim, prNumber, headSha, namespace)) {
      return {
        claim,
        lineage: isClaimLive(claim) ? 'live' : (isClaimReconciled(claim) ? 'reconciled' : 'none'),
      };
    }
    if (claim) {
      const fallback = findMatchingClaimForRun({ claims, prNumber, headSha, projectNamespace: namespace });
      return {
        ...fallback,
        lineage: fallback.claim ? fallback.lineage : 'direct_claim_key_mismatch',
      };
    }
    return findMatchingClaimForRun({ claims, prNumber, headSha, projectNamespace: namespace });
  })();

  if (!resolved.claim) {
    return {
      launch: false,
      reason: 'missing_live_claim_for_launch',
      lineage: resolved.lineage,
      prNumber: Number(prNumber),
      headSha: normalizeHeadSha(headSha),
      projectNamespace: normalizeProjectNamespace(projectNamespace),
    };
  }
  if (!isClaimLive(resolved.claim) && !isClaimReconciled(resolved.claim)) {
    return {
      launch: false,
      reason: 'missing_live_claim_for_launch',
      lineage: resolved.lineage,
      prNumber: Number(prNumber),
      headSha: normalizeHeadSha(headSha),
      projectNamespace: normalizeProjectNamespace(projectNamespace),
    };
  }
  if (!isClaimLive(resolved.claim)) {
    return {
      launch: false,
      reason: 'claim_not_live_for_launch',
      lineage: resolved.lineage,
      prNumber: Number(prNumber),
      headSha: normalizeHeadSha(headSha),
      projectNamespace: normalizeProjectNamespace(projectNamespace),
    };
  }
  return {
    launch: true,
    reason: 'live_claim_present',
    lineage: resolved.lineage,
    claimKey: String(resolved.claim?.key ?? ''),
    prNumber: Number(prNumber),
    headSha: normalizeHeadSha(headSha),
    projectNamespace: normalizeProjectNamespace(projectNamespace),
  };
}

export function diagnoseMissingClaimForReviewRun({
  run,
  claims = [],
  projectNamespace = 'orchestrator-pack',
  detectionPoint = 'lifecycle_reconciler',
  surface = '',
  provenance = '',
}) {
  if (!run || !isPackOwnedAutomatedProvenance({ run, surface, provenance })) {
    return { emit: false, reason: 'not_pack_owned_automated' };
  }
  const prNumber = Number(run?.prNumber);
  const headSha = normalizeHeadSha(run?.targetSha ?? run?.headSha);
  if (!Number.isInteger(prNumber) || !headSha) {
    return { emit: false, reason: 'run_key_incomplete' };
  }
  const match = findMatchingClaimForRun({ claims, prNumber, headSha, projectNamespace });
  if (match.claim && (isClaimLive(match.claim) || isClaimReconciled(match.claim))) {
    return { emit: false, reason: 'matching_claim_present', lineage: match.lineage };
  }
  return {
    emit: true,
    diagnostic: {
      kind: MISSING_CLAIM_FOR_REVIEW_RUN,
      prNumber,
      headSha,
      projectNamespace: normalizeProjectNamespace(projectNamespace),
      runId: String(run?.id ?? run?.runId ?? ''),
      reviewerSessionId: String(run?.reviewerSessionId ?? ''),
      surface: String(surface || run?.surface || run?.holder?.surface || ''),
      provenance: String(provenance || run?.provenance || run?.startReason || ''),
      detectionPoint,
    },
  };
}

function findMatchingRunForClaim(reviewRuns, prNumber, headSha, projectNamespace = 'orchestrator-pack') {
  const normalized = normalizeHeadSha(headSha);
  const namespace = normalizeProjectNamespace(projectNamespace);
  let bestInFlight = null;
  let bestTerminal = null;
  for (const run of toArray(reviewRuns)) {
    if (!runMatchesBindingKey(run, prNumber, normalized, namespace)) continue;
    const status = normalizeStatus(run?.status);
    if (COVERED_RUN_STATUSES.includes(status)) {
      const entry = { run, status, runId: String(run?.id ?? run?.runId ?? '') };
      if (IN_FLIGHT_RUN_STATUSES.includes(status)) {
        bestInFlight = entry;
        continue;
      }
      bestTerminal = entry;
      continue;
    }
    if (KNOWN_NON_COVERING_RUN_STATUSES.includes(status)) {
      return {
        run,
        status,
        runId: String(run?.id ?? run?.runId ?? ''),
      };
    }
  }
  return bestInFlight ?? bestTerminal ?? null;
}

function resolveReviewerCompletion(reviewerEvidence, runId, reviewerSessionId) {
  const rows = toArray(reviewerEvidence);
  const match = rows.find((entry) => {
    const entryRunId = String(entry?.runId ?? '').trim();
    const entrySession = String(entry?.reviewerSessionId ?? entry?.sessionId ?? '').trim();
    if (runId && entryRunId && entryRunId === runId) return true;
    if (reviewerSessionId && entrySession && entrySession === reviewerSessionId) return true;
    return false;
  });
  if (!match) return { completed: false, reason: 'reviewer_evidence_absent' };
  const exitCode = Number(match.exitCode);
  const completionStatus = String(match.completionStatus ?? '').trim().toLowerCase();
  if (exitCode === 0 && completionStatus === 'normal') {
    return { completed: true, reason: 'reviewer_completed_normally', evidence: match };
  }
  return {
    completed: false,
    reason: 'reviewer_not_completed_normally',
    evidence: match,
  };
}

function resolveVisibleRunTerminalOutcome(status) {
  const normalized = normalizeStatus(status);
  if (IN_FLIGHT_RUN_STATUSES.includes(normalized)) {
    return { outcome: 'run_started', reason: 'matching_run_in_flight' };
  }
  if (normalized === 'failed' || normalized === 'cancelled') {
    return { outcome: 'released_after_run_terminalized', reason: `matching_run_${normalized}` };
  }
  if (COVERED_RUN_STATUSES.includes(normalized)) {
    return { outcome: 'covered_by_run', reason: `matching_run_${normalized}` };
  }
  if (KNOWN_NON_COVERING_RUN_STATUSES.includes(normalized)) {
    return { outcome: 'released_after_run_terminalized', reason: `matching_run_${normalized}` };
  }
  return null;
}

/**
 * When launch-pending budget would fire, reconcile to a visible AO run instead.
 */
export function evaluateLaunchPendingRunBinding({
  claim,
  reviewRuns,
  reviewerEvidence = [],
  nowMs = Date.now(),
}) {
  const prNumber = Number(claim?.prNumber);
  const headSha = String(claim?.headSha ?? '');
  const projectNamespace = normalizeProjectNamespace(claim?.projectId ?? claim?.project ?? 'orchestrator-pack');
  const covered = findMatchingRunForClaim(reviewRuns, prNumber, headSha, projectNamespace);
  if (!covered) {
    return {
      reconcile: false,
      reason: 'no_matching_visible_run',
      nowMs,
    };
  }

  const runId = String(covered.runId ?? '');
  const reviewerSessionId = String(covered.run?.reviewerSessionId ?? '');
  const terminal = resolveVisibleRunTerminalOutcome(covered.status);
  const reviewer = resolveReviewerCompletion(reviewerEvidence, runId, reviewerSessionId);

  if (terminal) {
    return {
      reconcile: true,
      action: 'reconcile',
      outcome: reviewer.completed && terminal.outcome === 'covered_by_run'
        ? 'covered_by_run'
        : terminal.outcome,
      reason: reviewer.completed ? 'completed_reviewer_visible_run' : terminal.reason,
      runId,
      reviewerSessionId,
      runStatus: covered.status,
      reviewer,
      nowMs,
    };
  }

  return {
    reconcile: false,
    reason: 'matching_run_not_reconcilable',
    runId,
    runStatus: covered.status,
    nowMs,
  };
}

/**
 * Reaper-facing decision: visible AO run beats launch_pending_budget_exceeded.
 */
export function evaluateLaunchPendingBudgetDecision(input) {
  const binding = evaluateLaunchPendingRunBinding(input);
  if (binding.reconcile) {
    return {
      action: 'reconcile',
      outcome: binding.outcome,
      reason: binding.reason,
      runId: binding.runId,
      reviewerSessionId: binding.reviewerSessionId,
      binding,
    };
  }
  return {
    action: 'terminalize',
    outcome: 'launch_pending_budget_exceeded',
    reason: 'launch_pending_budget_exceeded',
    binding,
  };
}

export function evaluateClaimRunBinding({
  claim,
  run,
  claims = [],
  reviewRuns = [],
  reviewerEvidence = [],
  projectNamespace = 'orchestrator-pack',
  detectionPoint = 'lifecycle_reconciler',
}) {
  const prNumber = Number(run?.prNumber ?? claim?.prNumber);
  const headSha = normalizeHeadSha(run?.targetSha ?? run?.headSha ?? claim?.headSha);
  const namespace = normalizeProjectNamespace(projectNamespace);

  if (run && isPackOwnedAutomatedProvenance({ run })) {
    const diagnostic = diagnoseMissingClaimForReviewRun({
      run,
      claims,
      projectNamespace: namespace,
      detectionPoint,
    });
    if (diagnostic.emit) {
      return { direction: 'run_to_claim', diagnostic: diagnostic.diagnostic };
    }
  }

  if (claim && isClaimLive(claim)) {
    const binding = evaluateLaunchPendingRunBinding({
      claim,
      reviewRuns,
      reviewerEvidence,
    });
    if (binding.reconcile) {
      return {
        direction: 'claim_to_run',
        reconcile: binding,
        prNumber,
        headSha,
        projectNamespace: namespace,
      };
    }
  }

  return {
    direction: 'none',
    prNumber,
    headSha,
    projectNamespace: namespace,
  };
}

async function main() {
  const subcommand = process.argv[2] ?? 'evaluate';
  const payload = await readStdinJson();

  if (subcommand === 'launch-gate') {
    return evaluateAutomatedLaunchClaimGate(payload ?? {});
  }
  if (subcommand === 'diagnose-missing-claim') {
    return diagnoseMissingClaimForReviewRun(payload ?? {});
  }
  if (subcommand === 'launch-pending-binding') {
    return evaluateLaunchPendingRunBinding(payload ?? {});
  }
  if (subcommand === 'launch-pending-budget') {
    return evaluateLaunchPendingBudgetDecision(payload ?? {});
  }
  if (subcommand === 'binding') {
    return evaluateClaimRunBinding(payload ?? {});
  }
  if (subcommand === 'provenance') {
    return {
      packOwnedAutomated: isPackOwnedAutomatedProvenance(payload ?? {}),
      manualOperator: isManualOperatorProvenance(payload ?? {}),
    };
  }

  throw new Error(`unknown subcommand: ${subcommand}`);
}

runAsyncStdinJsonCliMain('review-start-claim-run-binding.mjs', main);
