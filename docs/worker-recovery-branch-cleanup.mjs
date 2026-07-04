/**
 * Worker recovery orphan branch classification and cleanup (Issue #592).
 * Vitest: scripts/worker-recovery-branch-cleanup.test.ts
 */
import {
  asRecord,
  runAsyncStdinJsonSubcommandCli,
  scanArgvForceTarget,
  toArray,
} from './review-mechanical-cli.mjs';

export const WORKER_RECOVERY_BRANCH_CLEANUP_VERSION = 'worker-recovery-branch-cleanup/v1';
export const DEFAULT_BRANCH_OBSERVATION_TTL_SECONDS = 60;

const OID_RE = /^[0-9a-f]{40}$/;

/**
 * @param {string} branch
 */
export function normalizeWorkerBranchRef(branch) {
  const raw = String(branch ?? '').trim();
  if (!raw) {
    return { ok: false, reason: 'branch_missing' };
  }
  const stripped = raw.replace(/^refs\/heads\//i, '');
  if (!stripped || stripped.includes('..') || stripped.startsWith('/')) {
    return { ok: false, reason: 'branch_invalid' };
  }
  return { ok: true, branch: stripped };
}

/**
 * @param {string[]} argv
 */
export function parseBranchDeleteForceArgv(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  const branchIndex = list.findIndex((token, index) => {
    if (token.toLowerCase() !== 'branch') return false;
    return index === 0 || !list[index - 1].startsWith('-');
  });
  if (branchIndex < 0 || branchIndex + 1 >= list.length) {
    return { ok: false, reason: 'not_branch' };
  }
  const { force, target } = scanArgvForceTarget(list, branchIndex + 1, ['-D', '--delete', '-d']);
  if (!force || !target) {
    return { ok: false, reason: 'not_force_delete' };
  }
  const normalized = normalizeWorkerBranchRef(target);
  if (!normalized.ok) {
    return { ok: false, reason: normalized.reason };
  }
  return { ok: true, branch: normalized.branch, force };
}

/**
 * @param {object} input
 */
export function evaluateBranchObservationFreshness(input) {
  const observedAtUtc = String(input.observedAtUtc ?? '').trim();
  const ttlSeconds = Number(input.ttlSeconds ?? DEFAULT_BRANCH_OBSERVATION_TTL_SECONDS);
  if (!observedAtUtc) {
    return { fresh: false, reason: 'observation_missing' };
  }
  const observedMs = Date.parse(observedAtUtc);
  if (!Number.isFinite(observedMs)) {
    return { fresh: false, reason: 'observation_unparseable' };
  }
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const ageMs = nowMs - observedMs;
  if (ageMs < 0 || ageMs > ttlSeconds * 1000) {
    return { fresh: false, reason: 'observation_stale', ageMs };
  }
  return { fresh: true, reason: 'observation_fresh', ageMs };
}

/**
 * @param {object} input
 */
export function evaluateOpenPrTriState(input) {
  const branch = normalizeWorkerBranchRef(String(input.branch ?? ''));
  if (!branch.ok) {
    return { state: 'unknown', reason: branch.reason };
  }
  if (input.fetchFailed) {
    if (input.rateLimited) {
      return { state: 'unknown', reason: 'blocked_rate_limit_pr_unknown' };
    }
    return { state: 'unknown', reason: 'blocked_pr_unknown' };
  }
  const freshness = evaluateBranchObservationFreshness(input);
  if (!freshness.fresh) {
    return { state: 'unknown', reason: 'blocked_pr_unknown' };
  }
  const byHeadRefName = asRecord(input.openPrByHeadRefName) ?? {};
  if (byHeadRefName[branch.branch]) {
    return { state: 'confirmed_present', reason: 'open_pr_present' };
  }
  return { state: 'confirmed_absent', reason: 'open_pr_absent' };
}

/**
 * @param {string} oid
 */
function normalizeOid(oid) {
  const value = String(oid ?? '').trim().toLowerCase();
  if (!OID_RE.test(value)) {
    return '';
  }
  return value;
}

/**
 * @param {object} input
 */
export function evaluateBranchRemoteState(input) {
  const branchHeadOid = normalizeOid(input.branchHeadOid);
  const grantStartOid = normalizeOid(input.grantStartOid);
  if (!branchHeadOid) {
    return { ok: false, reason: 'branch_head_missing', preserve: true };
  }
  if (grantStartOid && branchHeadOid !== grantStartOid) {
    return { ok: false, reason: 'blocked_head_mismatch', preserve: true };
  }
  if (input.fetchFailed) {
    if (input.rateLimited) {
      return { ok: false, reason: 'blocked_rate_limit_remote_unknown', preserve: true };
    }
    return { ok: false, reason: 'blocked_remote_unknown', preserve: true };
  }
  const freshness = evaluateBranchObservationFreshness(input);
  if (!freshness.fresh) {
    return { ok: false, reason: 'blocked_remote_unknown', preserve: true };
  }
  const localOnly = Number(input.localAheadCount ?? 0) > 0;
  const remoteOnly = Number(input.remoteAheadCount ?? 0) > 0;
  const diverged = Boolean(input.diverged);
  if (localOnly) {
    return { ok: false, reason: 'blocked_local_only_commits', preserve: true };
  }
  if (remoteOnly) {
    return { ok: false, reason: 'blocked_remote_only_commits', preserve: true };
  }
  if (diverged) {
    return { ok: false, reason: 'blocked_diverged', preserve: true };
  }
  if (input.remoteAdvancedAfterObservation) {
    return { ok: false, reason: 'blocked_remote_advanced', preserve: true };
  }
  return { ok: true, reason: 'remote_state_clean', preserve: false };
}

/**
 * @param {object} input
 */
export function evaluateReflogSurvivingWork(input) {
  const grantStartOid = normalizeOid(input.grantStartOid);
  if (!grantStartOid) {
    return { preserve: false, reason: 'grant_start_missing' };
  }
  const entries = toArray(input.reflogEntries).map((row) => asRecord(row)).filter(Boolean);
  for (const entry of entries) {
    const newOid = normalizeOid(entry.newOid);
    const oldOid = normalizeOid(entry.oldOid);
    if (newOid && newOid !== grantStartOid) {
      return { preserve: true, reason: 'blocked_reflog_surviving_work' };
    }
    if (oldOid && oldOid !== grantStartOid) {
      return { preserve: true, reason: 'blocked_reflog_surviving_work' };
    }
  }
  if (Number(input.danglingReachableCount ?? 0) > 0) {
    return { preserve: true, reason: 'blocked_reflog_surviving_work' };
  }
  return { preserve: false, reason: 'no_reflog_surviving_work' };
}

/**
 * @param {object} input
 */
export function evaluateConsumedGrantLineage(input) {
  const grant = asRecord(input.grant);
  if (!grant) {
    return { ok: false, reason: 'blocked_grant_absent' };
  }
  if (!grant.consumed) {
    return { ok: false, reason: 'blocked_grant_not_consumed' };
  }
  const sessionId = String(input.sessionId ?? '').trim();
  const canonicalPath = String(input.canonicalPath ?? '').trim();
  const consumedPath = String(grant.consumedCanonicalPath ?? '').trim();
  const authorized = toArray(grant.authorizedWorktreeNames).map((name) => String(name));
  const pathMatch = Boolean(consumedPath && canonicalPath && consumedPath.endsWith(canonicalPath.split('/').pop() ?? ''));
  const sessionMatch = Boolean(sessionId && authorized.includes(sessionId));
  if (!pathMatch && !sessionMatch) {
    return { ok: false, reason: 'blocked_grant_session_mismatch' };
  }
  const branch = normalizeWorkerBranchRef(String(input.branch ?? grant.expectedBranch ?? ''));
  if (!branch.ok) {
    return { ok: false, reason: branch.reason };
  }
  const expectedBranch = normalizeWorkerBranchRef(String(grant.expectedBranch ?? ''));
  const authorizedBranches = toArray(grant.authorizedWorkerBranches).map((name) => {
    const normalized = normalizeWorkerBranchRef(String(name));
    return normalized.ok ? normalized.branch : '';
  }).filter(Boolean);
  if (expectedBranch.ok && branch.branch !== expectedBranch.branch && !authorizedBranches.includes(branch.branch)) {
    return { ok: false, reason: 'blocked_branch_lineage_mismatch' };
  }
  return {
    ok: true,
    reason: 'grant_lineage_ok',
    grantStartOid: normalizeOid(grant.expectedCommitOid),
    branch: branch.branch,
  };
}

/**
 * @param {object} input
 */
export function evaluateBranchWorktreeOccupancy(input) {
  const branch = normalizeWorkerBranchRef(String(input.branch ?? ''));
  if (!branch.ok) {
    return { occupied: false, reason: branch.reason };
  }
  const branchRef = `refs/heads/${branch.branch}`;
  const records = toArray(input.worktreeRecords);
  for (const row of records) {
    const record = asRecord(row);
    if (!record) continue;
    const recordBranch = String(record.branch ?? '').trim();
    if (recordBranch === branchRef || recordBranch === branch.branch) {
      return { occupied: true, reason: 'blocked_worktree_occupied' };
    }
  }
  return { occupied: false, reason: 'branch_not_checked_out' };
}

/**
 * @param {object} input
 */
export function evaluateRecoveryTaskEligibility(input) {
  if (input.liveDifferentOwner) {
    return { eligible: false, reason: 'blocked_live_different_owner' };
  }
  if (input.taskClosed || input.taskCancelled || input.taskSuperseded) {
    return { eligible: false, reason: 'blocked_task_ineligible' };
  }
  return { eligible: true, reason: 'task_eligible' };
}

/**
 * @param {object} input
 */
export function evaluateDisposableWorkerBranch(input) {
  const lineage = evaluateConsumedGrantLineage(input);
  if (!lineage.ok) {
    return {
      disposable: false,
      action: 'preserve',
      reason: lineage.reason,
      escalation: lineage.reason,
    };
  }
  const branch = lineage.branch;
  const grantStartOid = lineage.grantStartOid;
  const occupancy = evaluateBranchWorktreeOccupancy({
    branch,
    worktreeRecords: input.worktreeRecords,
  });
  if (occupancy.occupied) {
    return {
      disposable: false,
      action: 'preserve',
      reason: occupancy.reason,
      escalation: occupancy.reason,
      branch,
    };
  }
  const prState = evaluateOpenPrTriState({
    branch,
    openPrByHeadRefName: input.openPrByHeadRefName,
    observedAtUtc: input.observedAtUtc,
    ttlSeconds: input.ttlSeconds,
    nowMs: input.nowMs,
    fetchFailed: input.prFetchFailed ?? input.fetchFailed,
    rateLimited: input.prRateLimited ?? input.rateLimited,
  });
  if (prState.state === 'confirmed_present') {
    return {
      disposable: false,
      action: 'preserve',
      reason: 'blocked_open_pr_present',
      escalation: 'blocked_open_pr_present',
      branch,
    };
  }
  if (prState.state === 'unknown') {
    return {
      disposable: false,
      action: 'preserve',
      reason: prState.reason,
      escalation: prState.reason,
      branch,
    };
  }
  const remote = evaluateBranchRemoteState({
    branchHeadOid: input.branchHeadOid,
    grantStartOid,
    localAheadCount: input.localAheadCount,
    remoteAheadCount: input.remoteAheadCount,
    diverged: input.diverged,
    remoteAdvancedAfterObservation: input.remoteAdvancedAfterObservation,
    observedAtUtc: input.observedAtUtc,
    ttlSeconds: input.ttlSeconds,
    nowMs: input.nowMs,
    fetchFailed: input.remoteFetchFailed ?? input.fetchFailed,
    rateLimited: input.remoteRateLimited ?? input.rateLimited,
  });
  if (!remote.ok) {
    return {
      disposable: false,
      action: 'preserve',
      reason: remote.reason,
      escalation: remote.reason,
      branch,
    };
  }
  const reflog = evaluateReflogSurvivingWork({
    grantStartOid,
    reflogEntries: input.reflogEntries,
    danglingReachableCount: input.danglingReachableCount,
  });
  if (reflog.preserve) {
    return {
      disposable: false,
      action: 'preserve',
      reason: reflog.reason,
      escalation: reflog.reason,
      branch,
    };
  }
  const task = evaluateRecoveryTaskEligibility(input);
  if (!task.eligible) {
    return {
      disposable: false,
      action: 'preserve',
      reason: task.reason,
      escalation: task.reason,
      branch,
    };
  }
  return {
    disposable: true,
    action: 'delete',
    reason: 'disposable_orphan_branch',
    escalation: null,
    branch,
    grantStartOid,
    expectedDeleteOid: normalizeOid(input.branchHeadOid),
  };
}

/**
 * @param {object} input
 */
export function evaluateBranchDeletionRevalidation(input) {
  const expectedOid = normalizeOid(input.expectedDeleteOid);
  const currentOid = normalizeOid(input.branchHeadOid);
  if (expectedOid && currentOid && expectedOid !== currentOid) {
    return { ok: false, reason: 'blocked_oid_race', preserve: true };
  }
  const classification = evaluateDisposableWorkerBranch(input);
  if (!classification.disposable) {
    return {
      ok: false,
      reason: classification.escalation ?? classification.reason,
      preserve: true,
    };
  }
  const validatedExpectedOid = normalizeOid(input.expectedDeleteOid ?? classification.expectedDeleteOid);
  const validatedCurrentOid = normalizeOid(input.branchHeadOid);
  if (!validatedExpectedOid || !validatedCurrentOid || validatedExpectedOid !== validatedCurrentOid) {
    return { ok: false, reason: 'blocked_oid_race', preserve: true };
  }
  const occupancy = evaluateBranchWorktreeOccupancy({
    branch: classification.branch,
    worktreeRecords: input.worktreeRecords,
  });
  if (occupancy.occupied) {
    return { ok: false, reason: 'blocked_worktree_occupied', preserve: true };
  }
  return {
    ok: true,
    reason: 'revalidation_passed',
    branch: classification.branch,
    expectedDeleteOid: expectedOid,
  };
}

/**
 * @param {object} input
 */
export function evaluateBranchPreexistsClassification(input) {
  if (!input.branchExists) {
    return { preexists: false, reason: 'branch_absent' };
  }
  const classification = evaluateDisposableWorkerBranch(input);
  if (classification.disposable) {
    return {
      preexists: true,
      reason: 'branch_preexists_disposable',
      action: 'delete',
      branch: classification.branch,
    };
  }
  return {
    preexists: true,
    reason: 'branch_preexists_preserved',
    action: 'preserve',
    escalation: classification.escalation ?? classification.reason,
    branch: classification.branch,
  };
}

/**
 * @param {object} input
 */
export function evaluateWorkerRecoveryBranchGitAllow(input) {
  const parsed = parseBranchDeleteForceArgv(input.argv);
  if (!parsed.ok) {
    return { allowed: false, reason: parsed.reason };
  }
  if (!input.recoveryParent) {
    return { allowed: false, reason: 'missing_recovery_parent' };
  }
  const boundBranch = normalizeWorkerBranchRef(String(input.boundBranch ?? ''));
  if (!boundBranch.ok) {
    return { allowed: false, reason: 'bound_branch_missing' };
  }
  if (boundBranch.branch !== parsed.branch) {
    return { allowed: false, reason: 'branch_not_in_claim_set' };
  }
  const sessionId = String(input.claimSessionId ?? '').trim();
  const claimSessionId = String(input.boundSessionId ?? '').trim();
  if (sessionId && claimSessionId && sessionId !== claimSessionId) {
    return { allowed: false, reason: 'session_not_in_claim_set' };
  }
  return {
    allowed: true,
    reason: 'recovery_branch_delete_allow',
    branch: parsed.branch,
  };
}

/**
 * @param {object} input
 */
export function buildBranchCleanupAuditRecord(input) {
  return {
    schemaVersion: WORKER_RECOVERY_BRANCH_CLEANUP_VERSION,
    kind: String(input.kind ?? 'branch_cleanup'),
    attemptId: String(input.attemptId ?? ''),
    sessionId: String(input.sessionId ?? ''),
    taskId: String(input.taskId ?? ''),
    branch: String(input.branch ?? ''),
    repoIdentity: String(input.repoIdentity ?? ''),
    deletedHeadOid: String(input.deletedHeadOid ?? ''),
    predicates: asRecord(input.predicates) ?? {},
    observation: asRecord(input.observation) ?? {},
    respawnHandoffId: String(input.respawnHandoffId ?? ''),
    escalation: input.escalation ? String(input.escalation) : null,
    recordedAtUtc: new Date().toISOString(),
  };
}

/**
 * @param {object} payload
 */
function handleCliSubcommand(subcommand, payload) {
  switch (subcommand) {
    case 'normalizeBranchRef':
      return normalizeWorkerBranchRef(payload.branch);
    case 'parseBranchDeleteArgv':
      return parseBranchDeleteForceArgv(payload.argv);
    case 'evaluateObservationFreshness':
      return evaluateBranchObservationFreshness(payload);
    case 'evaluateOpenPrTriState':
      return evaluateOpenPrTriState(payload);
    case 'evaluateRemoteState':
      return evaluateBranchRemoteState(payload);
    case 'evaluateReflogSurvivingWork':
      return evaluateReflogSurvivingWork(payload);
    case 'evaluateGrantLineage':
      return evaluateConsumedGrantLineage(payload);
    case 'evaluateWorktreeOccupancy':
      return evaluateBranchWorktreeOccupancy(payload);
    case 'evaluateTaskEligibility':
      return evaluateRecoveryTaskEligibility(payload);
    case 'evaluateDisposableBranch':
      return evaluateDisposableWorkerBranch(payload);
    case 'evaluateDeletionRevalidation':
      return evaluateBranchDeletionRevalidation(payload);
    case 'evaluateBranchPreexists':
      return evaluateBranchPreexistsClassification(payload);
    case 'evaluateBranchGitAllow':
      return evaluateWorkerRecoveryBranchGitAllow(payload);
    case 'buildBranchCleanupAudit':
      return buildBranchCleanupAuditRecord(payload);
    default:
      return { ok: false, reason: 'unknown_subcommand' };
  }
}

runAsyncStdinJsonSubcommandCli('worker-recovery-branch-cleanup.mjs', handleCliSubcommand);
