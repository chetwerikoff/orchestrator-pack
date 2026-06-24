/**
 * Review-start claim lifecycle predicates (Issue #417).
 *
 * Shared reclaim, hold-budget, launch-pending, and post-run visibility rules
 * consumed by the claim reaper, acquire path, and automated starters.
 */
import { printJson, readStdinJson, resolveBoundedInt, runAsyncStdinJsonCliMain } from './review-mechanical-cli.mjs';
import {
  asRecord,
  classifyReviewerLiveness,
  readCurrentBootHash,
  readProcStartTimeTicks,
  toArray,
} from './review-run-recovery.mjs';

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
  'clean',
  'needs_triage',
  'waiting_update',
];

export const IN_FLIGHT_RUN_STATUSES = ['queued', 'preparing', 'running', 'reviewing'];

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
  return String(status ?? '').trim().toLowerCase();
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
    120_000,
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
    120,
  );
  return {
    readinessEnvelopeMs,
    holdBudgetMs,
    launchPendingBudgetMs,
    visibilityBudgetMs,
    reaperPeriodSeconds,
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
  if (!h.startTimeTicks || !h.bootIdHash) {
    return { outcome: 'legacy', reason: 'missing_process_identity' };
  }
  const pid = Number(h.pid);
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

export function findCoveringRunForKey(reviewRuns, prNumber, headSha) {
  const normalized = normalizeHeadSha(headSha);
  let bestInFlight = null;
  let bestTerminal = null;
  for (const run of toArray(reviewRuns)) {
    if (!runMatchesKey(run, prNumber, normalized)) continue;
    const status = normalizeStatus(run?.status);
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

export function evaluateLaunchPending({ claim, nowMs, config = resolveClaimLifecycleConfig() }) {
  const pending = asRecord(claim?.launchPending);
  if (!pending?.atUtc) {
    return { active: false, expired: false, reason: 'absent' };
  }
  const startedMs = parseUtcMs(pending.atUtc);
  if (startedMs == null) {
    return { active: false, expired: false, reason: 'invalid_timestamp' };
  }
  const ageMs = Math.max(0, nowMs - startedMs);
  const budgetMs = Number(pending.budgetMs) > 0 ? Number(pending.budgetMs) : config.launchPendingBudgetMs;
  if (ageMs >= budgetMs) {
    return { active: false, expired: true, ageMs, budgetMs, reason: 'budget_exceeded' };
  }
  return { active: true, expired: false, ageMs, budgetMs, reason: 'active' };
}

export function evaluateHoldBudget({ claim, nowMs, config = resolveClaimLifecycleConfig() }) {
  const startedMs = parseUtcMs(claim?.holdStartedAtUtc ?? claim?.acquiredAtUtc);
  if (startedMs == null) {
    return { exceeded: false, reason: 'no_hold_start' };
  }
  const ageMs = Math.max(0, nowMs - startedMs);
  return {
    exceeded: ageMs >= config.holdBudgetMs,
    ageMs,
    budgetMs: config.holdBudgetMs,
    reason: ageMs >= config.holdBudgetMs ? 'budget_exceeded' : 'within_budget',
  };
}

export function evaluateVisibilityFence({ claim, reviewRuns, nowMs, config = resolveClaimLifecycleConfig() }) {
  const pendingMs = parseUtcMs(claim?.visibilityPendingAtUtc);
  if (pendingMs == null) {
    return { shouldFence: false, reason: 'not_pending' };
  }
  const ageMs = Math.max(0, nowMs - pendingMs);
  const covered = findCoveringRunForKey(reviewRuns, Number(claim?.prNumber), String(claim?.headSha ?? ''));
  if (covered) {
    return { shouldFence: false, reason: 'run_visible', coveredRunId: covered.runId };
  }
  if (ageMs >= config.visibilityBudgetMs) {
    return { shouldFence: true, reason: 'visibility_budget_exceeded', ageMs, budgetMs: config.visibilityBudgetMs };
  }
  return { shouldFence: false, reason: 'within_visibility_budget', ageMs, budgetMs: config.visibilityBudgetMs };
}

export function evaluateLegacyPreInvokeOrphan({ claim, reviewRuns }) {
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
  const covered = findCoveringRunForKey(reviewRuns, Number(claim?.prNumber), String(claim?.headSha ?? ''));
  if (covered) {
    return { reclaimable: false, reason: 'covering_run_present' };
  }
  return { reclaimable: true, reason: 'legacy_pre_invoke_orphan' };
}

export function evaluateReclaimDecision({
  claim,
  holderLiveness,
  reviewRuns,
  nowMs,
  config = resolveClaimLifecycleConfig(),
  corruptEvidence = false,
}) {
  if (String(claim?.state ?? '') !== 'active') {
    return { action: 'skip', reason: 'not_active' };
  }
  if (corruptEvidence) {
    return { action: 'block', reason: 'corrupt_run_store_evidence' };
  }

  const prNumber = Number(claim?.prNumber);
  const headSha = String(claim?.headSha ?? '');
  const covered = findCoveringRunForKey(reviewRuns, prNumber, headSha);
  if (covered && IN_FLIGHT_RUN_STATUSES.includes(covered.status)) {
    return { action: 'skip', reason: 'in_flight_covering_run', runId: covered.runId };
  }

  const launch = evaluateLaunchPending({ claim, nowMs, config });
  if (launch.active) {
    return { action: 'skip', reason: 'launch_pending_active', launch };
  }
  if (launch.expired) {
    return {
      action: 'terminalize',
      outcome: 'launch_pending_budget_exceeded',
      reason: 'launch_pending_budget_exceeded',
      launch,
    };
  }

  const hold = evaluateHoldBudget({ claim, nowMs, config });
  const liveness = holderLiveness ?? { outcome: 'ambiguous', reason: 'not_evaluated' };

  if (liveness.outcome === 'foreign_host') {
    return {
      action: 'mark_manual',
      outcome: 'foreign_holder_manual',
      reason: 'non_local_holder',
    };
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
    const visibility = evaluateVisibilityFence({ claim, reviewRuns, nowMs, config });
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

  if (liveness.outcome === 'provably_not_alive' || liveness.outcome === 'legacy') {
    if (liveness.outcome === 'legacy') {
      const legacy = evaluateLegacyPreInvokeOrphan({ claim, reviewRuns });
      if (!legacy.reclaimable) {
        return { action: 'skip', reason: legacy.reason, legacy };
      }
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
      reason: liveness.outcome === 'legacy' ? 'legacy_orphan_reclaim' : 'dead_local_holder',
      liveness,
    };
  }

  return { action: 'skip', reason: 'holder_liveness_ambiguous', liveness };
}

export function evaluateSweep({
  activeClaims,
  reviewRuns,
  nowMs,
  localHost,
  config = resolveClaimLifecycleConfig(),
  corruptKeys = [],
}) {
  const corruptSet = new Set(toArray(corruptKeys).map((key) => String(key)));
  const actions = [];
  for (const claim of toArray(activeClaims)) {
    const key = String(claim?.key ?? '');
    const holderLiveness = classifyClaimHolderLiveness(claim?.holder, { localHost });
    const decision = evaluateReclaimDecision({
      claim,
      holderLiveness,
      reviewRuns,
      nowMs,
      config,
      corruptEvidence: corruptSet.has(key),
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
    return evaluateReclaimDecision({
      claim: payload?.claim,
      holderLiveness,
      reviewRuns: toArray(payload?.reviewRuns),
      nowMs,
      config,
      corruptEvidence: Boolean(payload?.corruptEvidence),
    });
  }
  if (subcommand === 'sweep') {
    const config = resolveClaimLifecycleConfig(payload?.config ?? {});
    const nowMs = Number(payload?.nowMs) > 0 ? Number(payload.nowMs) : Date.now();
    return evaluateSweep({
      activeClaims: toArray(payload?.activeClaims),
      reviewRuns: toArray(payload?.reviewRuns),
      nowMs,
      localHost: payload?.localHost,
      config,
      corruptKeys: toArray(payload?.corruptKeys),
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
  if (subcommand === 'visibility-fence') {
    const config = resolveClaimLifecycleConfig(payload?.config ?? {});
    const nowMs = Number(payload?.nowMs) > 0 ? Number(payload.nowMs) : Date.now();
    return evaluateVisibilityFence({
      claim: payload?.claim,
      reviewRuns: toArray(payload?.reviewRuns),
      nowMs,
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
