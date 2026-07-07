/**
 * Review-start claim lifecycle predicates (Issue #417).
 *
 * Shared reclaim, hold-budget, launch-pending, and post-run visibility rules
 * consumed by the claim reaper, acquire path, and automated starters.
 */
import { printJson, readStdinJson, resolveBoundedInt, runAsyncStdinJsonCliMain } from './review-mechanical-cli.mjs';
import {
  isRunCoveringHead,
  normalizeLegacyReviewRunStatus,
  resolveAuthoritativeReviewRunStatus,
} from './review-reconcile-primitives.mjs';
import {
  DEFAULT_ATTEMPT_CEILING_MS,
  evaluateAttemptCeiling,
  evaluateReadinessEnvelopeWithPause,
  getMonotonicNowMs,
  resolveFirstAttemptMonotonicMs,
  resolveReadinessStartMonotonicMs,
} from './review-start-envelope-external-io.mjs';
import {
  asRecord,
  classifyReviewerLiveness,
  readCurrentBootHash,
  readProcStartTimeTicks,
  toArray,
} from './review-run-recovery.mjs';
import {
  evaluateLaunchPendingBudgetDecision,
  resolveBindingProjectNamespace,
  runMatchesBindingKey,
} from './review-start-claim-run-binding.mjs';

export const CLAIM_LIFECYCLE_SCHEMA_VERSION = 1;
export const DEFAULT_READINESS_ENVELOPE_MS = 30_000;
export const DEFAULT_HOLD_BUDGET_MS = 15_000;
export const DEFAULT_LAUNCH_PENDING_BUDGET_MS = 15_000;
export const DEFAULT_VISIBILITY_BUDGET_MS = 15_000;
export const DEFAULT_REAPER_PERIOD_SECONDS = 30;

export const COVERED_RUN_STATUSES = [
  'queued',
  'preparing',
  'running',
  'reviewing',
  'up_to_date',
  'changes_requested',
];

export const IN_FLIGHT_RUN_STATUSES = ['queued', 'preparing', 'running', 'reviewing'];

export const KNOWN_NON_COVERING_RUN_STATUSES = ['failed', 'cancelled', 'outdated'];

/** Terminal outcomes introduced by #417 and their retry eligibility. */
export const TERMINAL_OUTCOME_RETRY_ELIGIBLE = {
  recovered_stale: true,
  recovered_orphan_liveness: true,
  released_for_retry: true,
  released_after_run_terminalized: true,
  aborted_by_recheck: true,
  run_started: false,
  covered_by_run: false,
  hold_budget_exceeded: true,
  readiness_envelope_exceeded: true,
  readiness_attempt_ceiling_exceeded: false,
  launch_pending_budget_exceeded: false,
  run_not_visible_fenced: false,
  orphan_covered_run_unbound: false,
  foreign_holder_manual: false,
  escalated_ambiguous: false,
  operator_resolved_covered: false,
  operator_resolved_rearmed: true,
  operator_resolved_ambiguous: false,
};
function normalizeHeadSha(headSha) {
  return String(headSha ?? '').trim().toLowerCase();
}

function normalizeStatus(status) {
  return normalizeLegacyReviewRunStatus(String(status ?? '').trim());
}

function clampInt(value, fallback, min, max) {
  const parsed = resolveBoundedInt(value, fallback, min);
  return Math.min(parsed, max);
}

export function resolveClaimLifecycleConfig(config = {}, env = process.env) {
  const readinessEnvelopeMs = clampInt(
    config.readinessEnvelopeMs ?? env.AO_REVIEW_CLAIM_READINESS_ENVELOPE_MS,
    DEFAULT_READINESS_ENVELOPE_MS,
    5_000,
    DEFAULT_READINESS_ENVELOPE_MS,
  );
  const holdBudgetMs = clampInt(
    config.holdBudgetMs ?? env.AO_REVIEW_CLAIM_HOLD_BUDGET_MS,
    DEFAULT_HOLD_BUDGET_MS,
    1_000,
    readinessEnvelopeMs,
  );
  const launchPendingBudgetMs = clampInt(
    config.launchPendingBudgetMs ?? env.AO_REVIEW_CLAIM_LAUNCH_PENDING_BUDGET_MS,
    DEFAULT_LAUNCH_PENDING_BUDGET_MS,
    1_000,
    readinessEnvelopeMs,
  );
  const visibilityBudgetMs = clampInt(
    config.visibilityBudgetMs ?? env.AO_REVIEW_CLAIM_VISIBILITY_BUDGET_MS,
    DEFAULT_VISIBILITY_BUDGET_MS,
    1_000,
    readinessEnvelopeMs,
  );
  const reaperPeriodSeconds = clampInt(
    config.reaperPeriodSeconds ?? env.AO_REVIEW_CLAIM_REAPER_PERIOD_SECONDS,
    DEFAULT_REAPER_PERIOD_SECONDS,
    5,
    DEFAULT_REAPER_PERIOD_SECONDS,
  );
  const attemptCeilingMs = clampInt(
    config.attemptCeilingMs ?? env.AO_REVIEW_CLAIM_ATTEMPT_CEILING_MS,
    DEFAULT_ATTEMPT_CEILING_MS,
    60_000,
    DEFAULT_ATTEMPT_CEILING_MS,
  );
  return {
    readinessEnvelopeMs,
    holdBudgetMs,
    launchPendingBudgetMs,
    visibilityBudgetMs,
    reaperPeriodSeconds,
    attemptCeilingMs,
  };
}
export function holderToLivenessSidecar(holder) {
  const h = asRecord(holder) ?? {};
  return {
    identity: {
      kind: 'linux_proc_pid_starttime_boot',
      process: {
        pid: Number(h.pid),
        startTimeTicks: String(h.startTimeTicks ?? ''),
        bootIdHash: String(h.bootIdHash ?? ''),
      },
    },
  };
}

export function classifyClaimHolderLiveness(holder, options = {}) {
  const h = asRecord(holder) ?? {};
  const localHost = String(options.localHost ?? '').trim().toLowerCase();
  const holderHost = String(h.host ?? '').trim().toLowerCase();
  if (localHost && holderHost && holderHost !== localHost) {
    return { outcome: 'foreign_host', reason: 'non_local_holder' };
  }
  const pid = Number(h.pid);
  if (!h.startTimeTicks || !h.bootIdHash) {
    if (Number.isInteger(pid) && pid > 0 && process.platform === 'linux') {
      const actualStart = options.procStartTimeTicks ?? readProcStartTimeTicks(pid);
      if (!actualStart) {
        return { outcome: 'provably_not_alive', reason: 'proc_entry_missing' };
      }
    }
    return { outcome: 'legacy', reason: 'missing_process_identity' };
  }
  if (Number.isInteger(pid) && pid > 0 && process.platform === 'linux') {
    const actualStart = options.procStartTimeTicks ?? readProcStartTimeTicks(pid);
    if (!actualStart) {
      return { outcome: 'provably_not_alive', reason: 'proc_entry_missing' };
    }
  }
  const liveness = classifyReviewerLiveness(holderToLivenessSidecar(holder), {
    bootIdHash: options.bootIdHash ?? readCurrentBootHash(),
    procStartTimeTicks: options.procStartTimeTicks,
    allowNonLinuxProc: options.allowNonLinuxProc,
  });
  return liveness;
}

function runMatchesKey(run, prNumber, normalizedHeadSha) {
  const runPr = Number(run?.prNumber);
  if (!Number.isInteger(runPr) || runPr !== prNumber) return false;
  return normalizeHeadSha(run?.targetSha) === normalizedHeadSha;
}


export function evaluateMatchingRunEvidenceForKey(reviewRuns, prNumber, headSha) {
  const normalized = normalizeHeadSha(headSha);
  const ambiguousRuns = [];
  for (const run of toArray(reviewRuns)) {
    if (!runMatchesKey(run, prNumber, normalized)) continue;
    const status = normalizeStatus(resolveAuthoritativeReviewRunStatus(run));
    if (!status) {
      ambiguousRuns.push({ runId: String(run?.id ?? run?.runId ?? ''), status: '' });
      continue;
    }
    if (COVERED_RUN_STATUSES.includes(status) || KNOWN_NON_COVERING_RUN_STATUSES.includes(status)) {
      continue;
    }
    ambiguousRuns.push({ runId: String(run?.id ?? run?.runId ?? ''), status });
  }
  return {
    corruptEvidence: ambiguousRuns.length > 0,
    ambiguousRuns,
  };
}

export function findCoveringRunForKey(reviewRuns, prNumber, headSha, projectNamespace) {
  const normalized = normalizeHeadSha(headSha);
  const namespaceScoped = String(projectNamespace ?? '').trim() !== '';
  let bestInFlight = null;
  let bestTerminal = null;
  for (const run of toArray(reviewRuns)) {
    const keyMatch = namespaceScoped
      ? runMatchesBindingKey(run, prNumber, normalized, projectNamespace)
      : runMatchesKey(run, prNumber, normalized);
    if (!keyMatch) continue;
    if (!isRunCoveringHead(run)) continue;
    const status = normalizeStatus(resolveAuthoritativeReviewRunStatus(run));
    if (!COVERED_RUN_STATUSES.includes(status)) continue;
    const entry = { run, status, runId: String(run?.id ?? run?.runId ?? '') };
    if (IN_FLIGHT_RUN_STATUSES.includes(status)) {
      bestInFlight = entry;
      continue;
    }
    bestTerminal = entry;
  }
  return bestInFlight ?? bestTerminal ?? null;
}

export function hasInFlightCoveringRun(reviewRuns, prNumber, headSha) {
  const match = findCoveringRunForKey(reviewRuns, prNumber, headSha);
  return Boolean(match && IN_FLIGHT_RUN_STATUSES.includes(match.status));
}

function parseUtcMs(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}


export function resolveHoldBudgetStartMs(claim) {
  const holdMs = parseUtcMs(claim?.holdStartedAtUtc);
  const acquiredMs = parseUtcMs(claim?.acquiredAtUtc);
  const launchPendingMs = parseUtcMs(asRecord(claim?.launchPending)?.atUtc);
  const launchInvokedMs = parseUtcMs(claim?.launchPendingInvokedAtUtc);

  if (launchPendingMs != null || launchInvokedMs != null) {
    return holdMs ?? launchPendingMs ?? launchInvokedMs;
  }
  if (holdMs == null) {
    return null;
  }
  // Legacy acquire-time hold markers predate launch-gate rescoping; do not charge pre-launch work.
  if (acquiredMs != null && holdMs <= acquiredMs + 1000) {
    return null;
  }
  return holdMs;
}

export function evaluateLaunchPending({
  claim,
  nowMs,
  nowMonotonicMs,
  config = resolveClaimLifecycleConfig(),
}) {
  const mono = Number.isFinite(nowMonotonicMs)
    ? Number(nowMonotonicMs)
    : (resolveFirstAttemptMonotonicMs(claim) != null ? getMonotonicNowMs() : null);
  const pending = asRecord(claim?.launchPending);
  if (!pending?.atUtc) {
    return { active: false, expired: false, reason: 'absent' };
  }
  const startedMs = parseUtcMs(pending.atUtc);
  if (startedMs == null) {
    return { active: false, expired: false, reason: 'invalid_timestamp' };
  }
  const envelope = evaluateReadinessEnvelope({ claim, nowMs, nowMonotonicMs: mono, config });
  if (envelope.exceeded) {
    return {
      active: false,
      expired: true,
      ageMs: Math.max(0, nowMs - startedMs),
      budgetMs: Number(pending.budgetMs) > 0 ? Number(pending.budgetMs) : config.launchPendingBudgetMs,
      envelope,
      reason: 'envelope_exceeded',
    };
  }
  const ageMs = Math.max(0, nowMs - startedMs);
  const configuredBudget = Number(pending.budgetMs) > 0 ? Number(pending.budgetMs) : config.launchPendingBudgetMs;
  const readinessStartMs = parseUtcMs(claim?.acquiredAtUtc) ?? startedMs;
  const envelopeRemainingAtLaunch = Math.max(0, config.readinessEnvelopeMs - Math.max(0, startedMs - readinessStartMs));
  const budgetMs = Math.min(configuredBudget, envelopeRemainingAtLaunch);
  if (ageMs >= budgetMs) {
    return { active: false, expired: true, ageMs, budgetMs, envelope, reason: 'budget_exceeded' };
  }
  return { active: true, expired: false, ageMs, budgetMs, envelope, reason: 'active' };
}

export function evaluateReadinessEnvelope({
  claim,
  nowMs,
  nowMonotonicMs,
  config = resolveClaimLifecycleConfig(),
}) {
  const mono = Number.isFinite(nowMonotonicMs)
    ? Number(nowMonotonicMs)
    : (resolveReadinessStartMonotonicMs(claim) != null ? getMonotonicNowMs() : null);
  return evaluateReadinessEnvelopeWithPause({
    claim,
    nowMs,
    nowMonotonicMs: mono,
    config,
  });
}

export function evaluateHoldBudget({
  claim,
  nowMs,
  nowMonotonicMs,
  config = resolveClaimLifecycleConfig(),
}) {
  const startedMs = resolveHoldBudgetStartMs(claim);
  const mono = Number.isFinite(nowMonotonicMs)
    ? Number(nowMonotonicMs)
    : (resolveFirstAttemptMonotonicMs(claim) != null ? getMonotonicNowMs() : null);
  const envelope = evaluateReadinessEnvelope({ claim, nowMs, nowMonotonicMs: mono, config });
  if (startedMs == null) {
    const acquiredMs = parseUtcMs(claim?.acquiredAtUtc);
    const preLaunchAgeMs = acquiredMs == null ? 0 : Math.max(0, nowMs - acquiredMs);
    return {
      exceeded: false,
      reason: 'hold_not_started',
      phase: 'pre_launch',
      ageMs: 0,
      preLaunchAgeMs,
      budgetMs: config.holdBudgetMs,
      envelope,
    };
  }
  const ageMs = Math.max(0, nowMs - startedMs);
  const budgetMs = Math.min(config.holdBudgetMs, envelope.budgetMs);
  const exceeded = envelope.exceeded || ageMs >= budgetMs;
  return {
    exceeded,
    ageMs,
    budgetMs,
    envelope,
    phase: 'post_launch_gate',
    reason: envelope.exceeded ? 'envelope_exceeded' : (ageMs >= budgetMs ? 'budget_exceeded' : 'within_budget'),
  };
}

export function evaluateVisibilityFence({
  claim,
  reviewRuns,
  nowMs,
  nowMonotonicMs,
  config = resolveClaimLifecycleConfig(),
}) {
  const mono = Number.isFinite(nowMonotonicMs)
    ? Number(nowMonotonicMs)
    : (resolveFirstAttemptMonotonicMs(claim) != null ? getMonotonicNowMs() : null);
  const pendingMs = parseUtcMs(claim?.visibilityPendingAtUtc);
  if (pendingMs == null) {
    return { shouldFence: false, reason: 'not_pending' };
  }
  const envelope = evaluateReadinessEnvelope({ claim, nowMs, nowMonotonicMs: mono, config });
  const ageMs = Math.max(0, nowMs - pendingMs);
  const covered = findCoveringRunForKey(reviewRuns, Number(claim?.prNumber), String(claim?.headSha ?? ''));
  if (covered) {
    return { shouldFence: false, reason: 'run_visible', coveredRunId: covered.runId, envelope };
  }
  const readinessStartMs = parseUtcMs(claim?.acquiredAtUtc) ?? pendingMs;
  const envelopeRemainingAtPending = Math.max(0, config.readinessEnvelopeMs - Math.max(0, pendingMs - readinessStartMs));
  const budgetMs = Math.min(config.visibilityBudgetMs, envelopeRemainingAtPending);
  if (envelope.exceeded || ageMs >= budgetMs) {
    return {
      shouldFence: true,
      reason: envelope.exceeded ? 'readiness_envelope_exceeded' : 'visibility_budget_exceeded',
      ageMs,
      budgetMs,
      envelope,
    };
  }
  return { shouldFence: false, reason: 'within_visibility_budget', ageMs, budgetMs, envelope };
}

export function evaluateLegacyPreInvokeOrphan({
  claim,
  reviewRuns,
  postAcquireSideEffectAudit = false,
}) {
  const boundRunId = String(claim?.boundRunId ?? '').trim();
  if (boundRunId) {
    return { reclaimable: false, reason: 'bound_run_id_present' };
  }
  if (asRecord(claim?.launchPending)) {
    return { reclaimable: false, reason: 'launch_pending_present' };
  }
  if (claim?.invokeCompletedAtUtc || claim?.launchPendingInvokedAtUtc) {
    return { reclaimable: false, reason: 'invoke_evidence_present' };
  }
  if (postAcquireSideEffectAudit) {
    return { reclaimable: false, reason: 'side_effect_audit_present' };
  }
  const covered = findCoveringRunForKey(reviewRuns, Number(claim?.prNumber), String(claim?.headSha ?? ''));
  if (covered && IN_FLIGHT_RUN_STATUSES.includes(covered.status)) {
    return { reclaimable: false, reason: 'covering_run_present' };
  }
  return { reclaimable: true, reason: 'legacy_pre_invoke_orphan' };
}


function resolveEnvelopeExceededOutcome({ claim, reviewRuns, nowMs, nowMonotonicMs, config, projectNamespace }) {
  const mono = Number.isFinite(nowMonotonicMs)
    ? Number(nowMonotonicMs)
    : (resolveFirstAttemptMonotonicMs(claim) != null ? getMonotonicNowMs() : null);
  if (claim?.visibilityPendingAtUtc) {
    const visibility = evaluateVisibilityFence({ claim, reviewRuns, nowMs, nowMonotonicMs: mono, config });
    const coveringNamespace = String(projectNamespace ?? '').trim() !== ''
      ? resolveBindingProjectNamespace({ claim, projectNamespace })
      : undefined;
    if (
      visibility.shouldFence
      || !findCoveringRunForKey(
        reviewRuns,
        Number(claim?.prNumber),
        String(claim?.headSha ?? ''),
        coveringNamespace,
      )
    ) {
      return {
        action: 'terminalize',
        outcome: 'run_not_visible_fenced',
        reason: visibility.reason ?? 'readiness_envelope_exceeded',
        visibility,
        envelope: evaluateReadinessEnvelope({ claim, nowMs, nowMonotonicMs: mono, config }),
      };
    }
  }
  const launch = evaluateLaunchPending({ claim, nowMs, nowMonotonicMs: mono, config });
  if (launch.expired || asRecord(claim?.launchPending)?.atUtc || claim?.launchPendingInvokedAtUtc) {
    const binding = evaluateLaunchPendingBudgetDecision({
      claim,
      reviewRuns,
      nowMs,
      projectNamespace,
    });
    if (binding.action === 'reconcile') {
      return {
        action: 'reconcile',
        outcome: binding.outcome,
        reason: binding.reason,
        launch,
        binding: binding.binding,
        envelope: evaluateReadinessEnvelope({ claim, nowMs, nowMonotonicMs: mono, config }),
      };
    }
    return {
      action: 'terminalize',
      outcome: 'launch_pending_budget_exceeded',
      reason: 'readiness_envelope_exceeded',
      launch,
      envelope: evaluateReadinessEnvelope({ claim, nowMs, nowMonotonicMs: mono, config }),
    };
  }
  const hold = evaluateHoldBudget({ claim, nowMs, nowMonotonicMs: mono, config });
  const envelope = evaluateReadinessEnvelope({ claim, nowMs, nowMonotonicMs: mono, config });
  if (hold.phase === 'pre_launch' || hold.reason === 'hold_not_started') {
    return {
      action: 'terminalize',
      outcome: 'readiness_envelope_exceeded',
      reason: 'pre_launch_envelope_exceeded',
      hold,
      envelope,
    };
  }
  return {
    action: 'terminalize',
    outcome: 'hold_budget_exceeded',
    reason: 'hold_budget_exceeded',
    hold,
    envelope,
  };
}

export function evaluateReclaimDecision({
  claim,
  holderLiveness,
  reviewRuns,
  nowMs,
  nowMonotonicMs,
  config = resolveClaimLifecycleConfig(),
  corruptEvidence = false,
  postAcquireSideEffectAudit = false,
  reviewerEvidence = [],
  projectNamespace,
}) {
  if (String(claim?.state ?? '') !== 'active') {
    return { action: 'skip', reason: 'not_active' };
  }
  const prNumber = Number(claim?.prNumber);
  const headSha = String(claim?.headSha ?? '');
  const matchingEvidence = evaluateMatchingRunEvidenceForKey(reviewRuns, prNumber, headSha);
  if (corruptEvidence || matchingEvidence.corruptEvidence) {
    return {
      action: 'block',
      reason: 'corrupt_run_store_evidence',
      ambiguousRuns: matchingEvidence.ambiguousRuns,
    };
  }
  const mono = Number.isFinite(nowMonotonicMs)
    ? Number(nowMonotonicMs)
    : (resolveFirstAttemptMonotonicMs(claim) != null ? getMonotonicNowMs() : null);
  if (mono != null) {
    const ceiling = evaluateAttemptCeiling({
      claim,
      nowMonotonicMs: mono,
      reviewRuns,
      config,
    });
    if (ceiling.exceeded) {
      return {
        action: 'terminalize',
        outcome: 'readiness_attempt_ceiling_exceeded',
        reason: 'readiness_attempt_ceiling_exceeded',
        ceiling,
      };
    }
  }

  const coveringNamespace = String(projectNamespace ?? '').trim() !== ''
    ? resolveBindingProjectNamespace({ claim, projectNamespace })
    : undefined;
  const covered = findCoveringRunForKey(reviewRuns, prNumber, headSha, coveringNamespace);
  if (covered && IN_FLIGHT_RUN_STATUSES.includes(covered.status)) {
    return { action: 'skip', reason: 'in_flight_covering_run', runId: covered.runId };
  }

  const envelope = evaluateReadinessEnvelope({ claim, nowMs, nowMonotonicMs: mono, config });
  const hold = evaluateHoldBudget({ claim, nowMs, nowMonotonicMs: mono, config });
  const liveness = holderLiveness ?? { outcome: 'ambiguous', reason: 'not_evaluated' };

  if (liveness.outcome === 'foreign_host') {
    if (claim?.manualResolutionRequired) {
      return { action: 'skip', reason: 'foreign_holder_manual_pending' };
    }
    return {
      action: 'mark_manual',
      outcome: 'foreign_holder_manual',
      reason: 'non_local_holder',
    };
  }

  const launch = evaluateLaunchPending({ claim, nowMs, nowMonotonicMs: mono, config });
  if (launch.active) {
    return { action: 'skip', reason: 'launch_pending_active', launch };
  }

  if (claim?.invokeCompletedAtUtc || claim?.visibilityPendingAtUtc) {
    const visibility = evaluateVisibilityFence({ claim, reviewRuns, nowMs, nowMonotonicMs: mono, config });
    if (visibility.shouldFence) {
      return {
        action: 'terminalize',
        outcome: 'run_not_visible_fenced',
        reason: visibility.reason,
        visibility,
      };
    }
    if (liveness.outcome === 'alive' || liveness.outcome === 'legacy') {
      return { action: 'skip', reason: 'visibility_pending', visibility };
    }
  }

  if (launch.expired) {
    const binding = evaluateLaunchPendingBudgetDecision({
      claim,
      reviewRuns,
      reviewerEvidence: toArray(reviewerEvidence),
      nowMs,
      projectNamespace,
    });
    if (binding.action === 'reconcile') {
      return {
        action: 'reconcile',
        outcome: binding.outcome,
        reason: binding.reason,
        launch,
        binding: binding.binding,
        runId: binding.runId,
      };
    }
    return {
      action: 'terminalize',
      outcome: 'launch_pending_budget_exceeded',
      reason: 'launch_pending_budget_exceeded',
      launch,
    };
  }

  if (liveness.outcome === 'provably_not_alive') {
    const legacy = evaluateLegacyPreInvokeOrphan({ claim, reviewRuns, postAcquireSideEffectAudit });
    if (!legacy.reclaimable) {
      if (
        legacy.reason === 'bound_run_id_present'
        || legacy.reason === 'invoke_evidence_present'
        || legacy.reason === 'launch_pending_present'
        || legacy.reason === 'side_effect_audit_present'
      ) {
        return {
          action: 'terminalize',
          outcome: 'run_not_visible_fenced',
          reason: legacy.reason,
          legacy,
        };
      }
      return { action: 'skip', reason: legacy.reason, legacy };
    }
    if (covered && !IN_FLIGHT_RUN_STATUSES.includes(covered.status)) {
      return {
        action: 'terminalize',
        outcome: 'orphan_covered_run_unbound',
        reason: 'dead_holder_terminal_covered_run',
        coveredRunId: covered.runId,
        warn: true,
      };
    }
    return {
      action: 'terminalize',
      outcome: 'recovered_orphan_liveness',
      reason: 'dead_local_holder',
      liveness,
    };
  }

  if (envelope.exceeded) {
    if (liveness.outcome === 'legacy') {
      return { action: 'skip', reason: 'legacy_holder_unverified', liveness, envelope };
    }
    return resolveEnvelopeExceededOutcome({ claim, reviewRuns, nowMs, nowMonotonicMs: mono, config, projectNamespace });
  }

  if (hold.exceeded && liveness.outcome === 'alive') {
    return {
      action: 'terminalize',
      outcome: 'hold_budget_exceeded',
      reason: 'hold_budget_exceeded',
      hold,
    };
  }

  if (liveness.outcome === 'alive') {
    const visibility = evaluateVisibilityFence({ claim, reviewRuns, nowMs, nowMonotonicMs: mono, config });
    if (visibility.shouldFence) {
      return {
        action: 'terminalize',
        outcome: 'run_not_visible_fenced',
        reason: visibility.reason,
        visibility,
      };
    }
    if (covered && !String(claim?.boundRunId ?? '').trim()) {
      return {
        action: 'terminalize',
        outcome: 'orphan_covered_run_unbound',
        reason: 'terminal_covered_run_unbound_claim',
        coveredRunId: covered.runId,
        warn: true,
      };
    }
    return { action: 'skip', reason: 'holder_alive', hold, visibility };
  }

  if (liveness.outcome === 'legacy') {
    return { action: 'skip', reason: 'legacy_holder_unverified', liveness };
  }

  return { action: 'skip', reason: 'holder_liveness_ambiguous', liveness };
}

export function evaluateSweep({
  activeClaims,
  reviewRuns,
  nowMs,
  nowMonotonicMs,
  localHost,
  config = resolveClaimLifecycleConfig(),
  corruptKeys = [],
  projectNamespace,
}) {
  const corruptSet = new Set(toArray(corruptKeys).map((key) => String(key)));
  const mono = Number.isFinite(nowMonotonicMs) ? Number(nowMonotonicMs) : getMonotonicNowMs();
  const actions = [];
  for (const claim of toArray(activeClaims)) {
    const key = String(claim?.key ?? '');
    const holderLiveness = classifyClaimHolderLiveness(claim?.holder, { localHost });
    const matchingEvidence = evaluateMatchingRunEvidenceForKey(
      reviewRuns,
      Number(claim?.prNumber),
      String(claim?.headSha ?? ''),
    );
    const decision = evaluateReclaimDecision({
      claim,
      holderLiveness,
      reviewRuns,
      nowMs,
      nowMonotonicMs: mono,
      config,
      corruptEvidence: corruptSet.has(key) || matchingEvidence.corruptEvidence,
      projectNamespace,
    });
    actions.push({
      key,
      prNumber: claim?.prNumber,
      headSha: claim?.headSha,
      holderLiveness,
      decision,
    });
  }
  return {
    ok: true,
    nowMs,
    config,
    runStoreBatchReads: 1,
    actions,
  };
}

async function main() {
  const subcommand = process.argv[2] ?? 'evaluate';
  const payload = await readStdinJson();
  if (subcommand === 'evaluate') {
    const config = resolveClaimLifecycleConfig(payload?.config ?? {});
    const nowMs = Number(payload?.nowMs) > 0 ? Number(payload.nowMs) : Date.now();
    const holderLiveness = payload?.holderLiveness
      ?? classifyClaimHolderLiveness(payload?.claim?.holder, { localHost: payload?.localHost });
    const nowMonotonicMs = Number(payload?.nowMonotonicMs) > 0
      ? Number(payload.nowMonotonicMs)
      : undefined;
    return evaluateReclaimDecision({
      claim: payload?.claim,
      holderLiveness,
      reviewRuns: toArray(payload?.reviewRuns),
      nowMs,
      nowMonotonicMs,
      config,
      corruptEvidence: Boolean(payload?.corruptEvidence),
      postAcquireSideEffectAudit: Boolean(payload?.postAcquireSideEffectAudit),
      reviewerEvidence: toArray(payload?.reviewerEvidence),
      projectNamespace: payload?.projectNamespace,
    });
  }
  if (subcommand === 'sweep') {
    const config = resolveClaimLifecycleConfig(payload?.config ?? {});
    const nowMs = Number(payload?.nowMs) > 0 ? Number(payload.nowMs) : Date.now();
    const nowMonotonicMs = Number(payload?.nowMonotonicMs) > 0
      ? Number(payload.nowMonotonicMs)
      : undefined;
    return evaluateSweep({
      activeClaims: toArray(payload?.activeClaims),
      reviewRuns: toArray(payload?.reviewRuns),
      nowMs,
      nowMonotonicMs,
      localHost: payload?.localHost,
      config,
      corruptKeys: toArray(payload?.corruptKeys),
      projectNamespace: payload?.projectNamespace,
    });
  }
  if (subcommand === 'classify-holder') {
    return classifyClaimHolderLiveness(payload?.holder, {
      localHost: payload?.localHost,
      bootIdHash: payload?.bootIdHash,
      procStartTimeTicks: payload?.procStartTimeTicks,
      allowNonLinuxProc: payload?.allowNonLinuxProc,
    });
  }
  if (subcommand === 'hold-budget') {
    const config = resolveClaimLifecycleConfig(payload?.config ?? {});
    const nowMs = Number(payload?.nowMs) > 0 ? Number(payload.nowMs) : Date.now();
    const nowMonotonicMs = Number(payload?.nowMonotonicMs) > 0
      ? Number(payload.nowMonotonicMs)
      : undefined;
    return evaluateHoldBudget({
      claim: payload?.claim,
      nowMs,
      nowMonotonicMs,
      config,
    });
  }
  if (subcommand === 'readiness-envelope') {
    const config = resolveClaimLifecycleConfig(payload?.config ?? {});
    const nowMs = Number(payload?.nowMs) > 0 ? Number(payload?.nowMs) : Date.now();
    const nowMonotonicMs = Number(payload?.nowMonotonicMs) > 0
      ? Number(payload.nowMonotonicMs)
      : undefined;
    return evaluateReadinessEnvelope({
      claim: payload?.claim,
      nowMs,
      nowMonotonicMs,
      config,
    });
  }
  if (subcommand === 'visibility-fence') {
    const config = resolveClaimLifecycleConfig(payload?.config ?? {});
    const nowMs = Number(payload?.nowMs) > 0 ? Number(payload.nowMs) : Date.now();
    const nowMonotonicMs = Number(payload?.nowMonotonicMs) > 0
      ? Number(payload.nowMonotonicMs)
      : undefined;
    return evaluateVisibilityFence({
      claim: payload?.claim,
      reviewRuns: toArray(payload?.reviewRuns),
      nowMs,
      nowMonotonicMs,
      config,
    });
  }
  if (subcommand === 'validate-config') {
    const config = resolveClaimLifecycleConfig(payload?.config ?? {});
    return { ok: true, config };
  }
  throw new Error(`Unknown review-start-claim-lifecycle subcommand: ${subcommand}`);
}

runAsyncStdinJsonCliMain('review-start-claim-lifecycle.mjs', main);
