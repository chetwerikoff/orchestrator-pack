/**
 * Autonomous orchestrator worker recovery primitive (Issue #522).
 * Vitest: scripts/worker-recovery.test.ts
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve, normalize, join } from 'node:path';
import {
  AFFIRMATIVE_LIVE_RUNTIME,
  TERMINAL_RUNTIME_VALUES,
  classifyRuntimeField,
  hasRuntimeField,
  isRuntimeFieldLive,
  normalizeRuntimeValue,
} from './session-runtime-liveness.mjs';
import { readStdinJson, runAsyncStdinJsonCliMain } from './review-mechanical-cli.mjs';


function normalizePathSegments(value) {
  return normalize(String(value ?? ''))
    .split(/[/\\]/)
    .filter(Boolean)
    .join('/');
}

function isPathUnderPrefix(candidate, prefix) {
  const normalizedCandidate = normalizePathSegments(candidate);
  const normalizedPrefix = normalizePathSegments(prefix);
  if (!normalizedPrefix) {
    return false;
  }
  return normalizedCandidate === normalizedPrefix
    || normalizedCandidate.startsWith(`${normalizedPrefix}/`);
}

export const WORKER_RECOVERY_VERSION = 'worker-recovery/v1';
export const WORKER_RECOVERY_DEFAULT_RETRY_BUDGET = 3;
export const WORKER_RECOVERY_DEFAULT_BACKOFF_MS = 60_000;

export const RECOVERY_FINAL_OUTCOMES = new Set([
  'skipped_live',
  'skipped_ambiguous',
  'skipped_foreign_owner',
  'removed_dangling_gitdir',
  'removed_terminated_session',
  'spawn_denied',
  'spawn_started',
  'claim_lost',
  'partial_failure',
  'blocked_dirty_worktree',
  'blocked_stale_mapping',
  'escalated',
  'no_op',
]);

/**
 * @param {unknown} value
 */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 */
function toArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {string} pathValue
 */
export function canonicalizeRecoveryPath(pathValue) {
  const raw = String(pathValue ?? '').trim();
  if (!raw) {
    return { ok: false, reason: 'empty_path' };
  }
  try {
    const resolved = resolve(raw);
    let canonical = resolved;
    try {
      canonical = realpathSync.native ? realpathSync.native(resolved) : realpathSync(resolved);
    } catch {
      canonical = normalize(resolved);
    }
    return { ok: true, canonical, resolved };
  } catch {
    return { ok: false, reason: 'path_unresolvable' };
  }
}

/**
 * @param {string} sessionId
 * @param {string} canonicalPath
 */
export function deriveRecoveryClaimKey(sessionId, canonicalPath) {
  const session = String(sessionId ?? '').trim();
  if (session) {
    return `worker-${session}`;
  }
  const path = String(canonicalPath ?? '').trim();
  if (!path) {
    return '';
  }
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 16);
  return `worktree-${digest}`;
}

/**
 * @param {Record<string, unknown>} session
 */
export function classifyWorkerSessionLiveness(session) {
  const row = asRecord(session);
  if (!row) {
    return { verdict: 'ambiguous', reason: 'missing_session_row', runtimeClass: 'absent' };
  }
  const runtimeClass = classifyRuntimeField(row);
  if (runtimeClass === 'affirmative_live') {
    return { verdict: 'live', reason: 'runtime_alive', runtimeClass };
  }
  if (runtimeClass === 'terminal_death') {
    return { verdict: 'terminated', reason: normalizeRuntimeValue(row.runtime), runtimeClass };
  }
  if (runtimeClass === 'present_non_live') {
    return { verdict: 'ambiguous', reason: 'present_non_live_runtime', runtimeClass };
  }
  const status = String(row.status ?? '').trim().toLowerCase();
  if (status === 'terminated' || status === 'completed' || status === 'failed') {
    return { verdict: 'terminated', reason: `status_${status}`, runtimeClass };
  }
  if (status === 'working' || status === 'started' || status === 'waiting_input') {
    if (!hasRuntimeField(row) || isRuntimeFieldLive(row)) {
      return { verdict: 'live', reason: 'status_live_without_terminal_runtime', runtimeClass };
    }
  }
  return { verdict: 'ambiguous', reason: 'missing_or_ambiguous_liveness', runtimeClass };
}

/**
 * @param {object} input
 */
export function evaluateOwnershipEvidence(input) {
  const projectId = String(input.projectId ?? 'orchestrator-pack').trim();
  const canonicalPath = String(input.canonicalPath ?? '').trim();
  const sessionId = String(input.sessionId ?? '').trim();
  const session = asRecord(input.session);
  const worktreeRecord = asRecord(input.worktreeRecord);
  const aoBaseDir = String(input.aoBaseDir ?? '').trim();
  const danglingGitdir = Boolean(input.danglingGitdir);

  if (!canonicalPath) {
    return { ok: false, confidence: 'none', reason: 'missing_canonical_path' };
  }

  const expectedNamespace = aoBaseDir
    ? join(normalize(aoBaseDir), 'projects', projectId, 'worktrees')
    : '';
  const pathUnderNamespace = expectedNamespace
    ? isPathUnderPrefix(canonicalPath, expectedNamespace)
    : /[/\\]worktrees[/\\]/.test(canonicalPath);

  const sessionWorktree = session ? String(session.worktree ?? session.workspace ?? '').trim() : '';
  let sessionPathMatch = false;
  if (sessionWorktree) {
    const canonSession = canonicalizeRecoveryPath(sessionWorktree);
    sessionPathMatch = canonSession.ok && canonSession.canonical === canonicalPath;
  }

  const recordSessionId = worktreeRecord ? String(worktreeRecord.sessionId ?? '').trim() : '';
  const sessionIdMatch = sessionId && recordSessionId && sessionId === recordSessionId;
  const pathSessionMatch = sessionId && canonicalPath.includes(sessionId);

  const foreignProject = worktreeRecord?.projectId
    && String(worktreeRecord.projectId).trim() !== projectId;

  if (foreignProject) {
    return { ok: false, confidence: 'foreign', reason: 'foreign_project_owner' };
  }

  const independentSignals = [sessionPathMatch, sessionIdMatch].filter(Boolean).length;
  if (independentSignals >= 2 || (sessionPathMatch && sessionId)) {
    return { ok: true, confidence: 'high', reason: 'consistent_pack_ownership' };
  }
  if (danglingGitdir && sessionIdMatch && pathUnderNamespace) {
    return { ok: true, confidence: 'high', reason: 'dangling_orphan_namespace_match' };
  }
  if (pathSessionMatch && pathUnderNamespace && sessionIdMatch) {
    return { ok: true, confidence: 'high', reason: 'consistent_pack_ownership' };
  }
  if (independentSignals === 1 || (pathSessionMatch && pathUnderNamespace)) {
    return { ok: false, confidence: 'low', reason: 'insufficient_ownership_proof' };
  }
  return { ok: false, confidence: 'none', reason: 'missing_ownership_proof' };
}

/**
 * @param {object} input
 */
export function evaluateArtifactPreservation(input) {
  const dirty = asRecord(input.dirtyState);
  if (!dirty) {
    return { blocked: false, reason: 'clean' };
  }
  if (dirty.trackedModifications || dirty.untrackedFiles || dirty.relevantIgnored || dirty.unpushedCommits) {
    return {
      blocked: true,
      reason: 'dirty_worktree',
      detail: {
        trackedModifications: Boolean(dirty.trackedModifications),
        untrackedFiles: Boolean(dirty.untrackedFiles),
        relevantIgnored: Boolean(dirty.relevantIgnored),
        unpushedCommits: Boolean(dirty.unpushedCommits),
      },
    };
  }
  return { blocked: false, reason: 'clean' };
}

/**
 * @param {object} input
 */
export function evaluateCleanupEligibility(input) {
  const liveness = classifyWorkerSessionLiveness(input.session);
  const ownership = evaluateOwnershipEvidence(input);
  const danglingGitdir = Boolean(input.danglingGitdir);
  const worktreePresent = Boolean(input.worktreePresent);

  if (!ownership.ok) {
    return { eligible: false, outcome: 'skipped_ambiguous', reason: ownership.reason, liveness, ownership };
  }

  if (danglingGitdir && !worktreePresent) {
    return { eligible: true, outcome: 'removed_dangling_gitdir', reason: 'dangling_gitdir_orphan', liveness, ownership };
  }

  if (liveness.verdict === 'live') {
    return { eligible: false, outcome: 'skipped_live', reason: 'session_live', liveness, ownership };
  }

  if (liveness.verdict === 'ambiguous') {
    return { eligible: false, outcome: 'skipped_ambiguous', reason: liveness.reason, liveness, ownership };
  }

  if (liveness.verdict === 'terminated' && worktreePresent) {
    const artifact = evaluateArtifactPreservation(input);
    if (artifact.blocked) {
      return {
        eligible: false,
        outcome: 'blocked_dirty_worktree',
        reason: artifact.reason,
        liveness,
        ownership,
        artifact,
      };
    }
    return { eligible: true, outcome: 'removed_terminated_session', reason: 'terminated_session_clean', liveness, ownership };
  }

  return { eligible: false, outcome: 'skipped_ambiguous', reason: 'no_cleanup_cell', liveness, ownership };
}

/**
 * @param {object} input
 */
export function evaluatePostClaimRevalidation(input) {
  const selection = asRecord(input.selection);
  const current = asRecord(input.current);
  if (!selection || !current) {
    return { ok: false, reason: 'missing_snapshot' };
  }
  if (String(selection.canonicalPath ?? '') !== String(current.canonicalPath ?? '')) {
    return { ok: false, reason: 'canonical_path_changed' };
  }
  if (String(selection.sessionId ?? '') !== String(current.sessionId ?? '')) {
    return { ok: false, reason: 'session_identity_changed' };
  }
  const selectionLiveness = classifyWorkerSessionLiveness(selection.session);
  const currentLiveness = classifyWorkerSessionLiveness(current.session);
  if (currentLiveness.verdict === 'live') {
    return { ok: false, reason: 'became_live' };
  }
  if (selectionLiveness.verdict !== currentLiveness.verdict) {
    return { ok: false, reason: 'liveness_changed' };
  }
  const selectionRecord = asRecord(selection.worktreeRecord);
  const currentRecord = asRecord(current.worktreeRecord);
  if (selectionRecord && currentRecord) {
    const selectionHead = String(selectionRecord.head ?? '').trim();
    const currentHead = String(currentRecord.head ?? '').trim();
    if (selectionHead && currentHead && selectionHead !== currentHead) {
      return { ok: false, reason: 'worktree_head_changed' };
    }
    const selectionRecordSession = String(selectionRecord.sessionId ?? '').trim();
    const currentRecordSession = String(currentRecord.sessionId ?? '').trim();
    if (selectionRecordSession && currentRecordSession && selectionRecordSession !== currentRecordSession) {
      return { ok: false, reason: 'worktree_ownership_changed' };
    }
  }
  const ownership = evaluateOwnershipEvidence(current);
  if (!ownership.ok) {
    return { ok: false, reason: 'ownership_became_ambiguous' };
  }
  return { ok: true, reason: 'revalidation_passed' };
}

/**
 * @param {object} input
 */
export function evaluateTriggerAdmission(input) {
  const trigger = String(input.trigger ?? '').trim().toLowerCase();
  if (trigger === 'operator_request' || trigger === 'operator-recover' || trigger === 'operator_spawn') {
    return { admitted: true, reason: 'operator_requested' };
  }
  if (trigger === 'reconcile_dead_worker') {
    if (!input.probedDeadEvidence) {
      return { admitted: false, reason: 'missing_probed_dead_evidence' };
    }
    if (input.liveOwnerPresent) {
      return { admitted: false, reason: 'live_owner_present' };
    }
    return { admitted: true, reason: 'reconcile_dead_worker' };
  }
  if (trigger === 'stuck' || trigger === 'stale_activity') {
    return { admitted: false, reason: 'insufficient_trigger_evidence' };
  }
  return { admitted: false, reason: 'unknown_trigger' };
}

/**
 * @param {object} input
 */
export function evaluateSpawnFreshness(input) {
  const localSession = asRecord(input.localSession);
  const recoveryClaimSessionId = String(input.recoveryClaimSessionId ?? '').trim();
  const liveness = classifyWorkerSessionLiveness(localSession);
  const liveDifferentOwner = Boolean(input.liveDifferentOwner);
  const restClosedMerged = Boolean(input.restClosedMerged);
  const restUnavailable = Boolean(input.restUnavailable);

  if (liveDifferentOwner) {
    return { allowed: false, reason: 'live_different_owner' };
  }
  if (restClosedMerged && localSession && liveness.verdict !== 'terminated') {
    return { allowed: false, reason: 'stale_local_mapping', escalate: true };
  }
  if (liveness.verdict === 'live') {
    return { allowed: false, reason: 'local_session_live' };
  }
  if (liveness.verdict === 'terminated' || recoveryClaimSessionId) {
    return { allowed: true, reason: restUnavailable ? 'local_terminated_rest_unavailable' : 'local_gate_passed' };
  }
  return { allowed: false, reason: 'ambiguous_local_mapping' };
}

/**
 * @param {object} input
 */
export function evaluateLiveDifferentOwner(input) {
  const recoverySessionId = String(input.recoveryClaimSessionId ?? '').trim();
  const canonicalPath = String(input.canonicalPath ?? '').trim();
  if (!recoverySessionId || !canonicalPath) {
    return { liveDifferentOwner: false, reason: 'missing_inputs' };
  }
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  for (const entry of sessions) {
    const row = asRecord(entry);
    if (!row) continue;
    const sessionId = String(row.name ?? row.sessionId ?? '').trim();
    if (!sessionId || sessionId === recoverySessionId) continue;
    const session = asRecord(row.session) ?? row;
    const liveness = classifyWorkerSessionLiveness(session);
    if (liveness.verdict !== 'live') continue;
    const worktree = String(session.worktree ?? session.workspace ?? '').trim();
    if (!worktree) continue;
    const canon = canonicalizeRecoveryPath(worktree);
    if (canon.ok && canon.canonical === canonicalPath) {
      return { liveDifferentOwner: true, reason: 'live_different_owner', ownerSessionId: sessionId };
    }
  }
  return { liveDifferentOwner: false, reason: 'no_live_different_owner' };
}

/**
 * @param {object} input
 */
export function evaluateBoundedRetry(input) {
  const attempt = Number(input.attempt ?? 0);
  const budget = Number(input.budget ?? WORKER_RECOVERY_DEFAULT_RETRY_BUDGET);
  const lastAttemptMs = Number(input.lastAttemptMs ?? 0);
  const nowMs = Number(input.nowMs ?? Date.now());
  const backoffMs = Number(input.backoffMs ?? WORKER_RECOVERY_DEFAULT_BACKOFF_MS);
  if (attempt >= budget) {
    return { shouldRetry: false, escalate: true, reason: 'budget_exhausted' };
  }
  if (lastAttemptMs && nowMs - lastAttemptMs < backoffMs) {
    return { shouldRetry: false, escalate: false, reason: 'backoff' };
  }
  return { shouldRetry: true, escalate: false, reason: 'retry_allowed' };
}

/**
 * @param {string} porcelain
 */
export function parseWorktreeListPorcelain(porcelain) {
  const lines = String(porcelain ?? '').split(/\r?\n/);
  const records = [];
  let current = null;
  for (const line of lines) {
    if (!line.trim()) {
      if (current) {
        records.push(current);
        current = null;
      }
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { worktree: line.slice('worktree '.length).trim(), branch: null, head: null, bare: false, detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).trim();
    if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).trim();
    if (line === 'bare') current.bare = true;
    if (line === 'detached') current.detached = true;
    if (line.startsWith('prunable')) current.prunable = line;
  }
  if (current) records.push(current);
  return records;
}

/**
 * @param {string[]} argv
 */
export function parseWorktreeRemoveForceArgv(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  const worktreeIndex = list.findIndex((token, index) => {
    if (token.toLowerCase() !== 'worktree') return false;
    return index === 0 || !list[index - 1].startsWith('-');
  });
  if (worktreeIndex < 0 || worktreeIndex + 1 >= list.length) {
    return { ok: false, reason: 'not_worktree' };
  }
  if (list[worktreeIndex + 1].toLowerCase() !== 'remove') {
    return { ok: false, reason: 'not_worktree_remove' };
  }
  let cursor = worktreeIndex + 2;
  let force = false;
  let target = null;
  while (cursor < list.length) {
    const token = list[cursor];
    if (token === '--force' || token === '-f') {
      force = true;
      cursor += 1;
      continue;
    }
    if (!token.startsWith('-')) {
      target = token;
      break;
    }
    cursor += 1;
  }
  if (!force || !target) {
    return { ok: false, reason: 'not_force_remove' };
  }
  return { ok: true, target, force };
}

/**
 * @param {object} input
 */
export function evaluateWorkerRecoveryGitAllow(input) {
  const parsed = parseWorktreeRemoveForceArgv(input.argv);
  if (!parsed.ok) {
    return { allowed: false, reason: parsed.reason };
  }
  const targetCanon = canonicalizeRecoveryPath(parsed.target);
  if (!targetCanon.ok) {
    return { allowed: false, reason: 'target_unresolvable' };
  }
  const bound = toArray(input.boundCandidates).map((row) => {
    const canon = canonicalizeRecoveryPath(row);
    return canon.ok ? canon.canonical : '';
  }).filter(Boolean);
  if (!bound.includes(targetCanon.canonical)) {
    return { allowed: false, reason: 'target_not_in_claim_set' };
  }
  if (!input.recoveryParent) {
    return { allowed: false, reason: 'missing_recovery_parent' };
  }
  return { allowed: true, reason: 'recovery_worktree_remove_allow', canonicalPath: targetCanon.canonical };
}

/**
 * @param {object} input
 */
export function evaluateRecoverySpawnRoute(input) {
  const policy = asRecord(input.policy);
  const policyLoadOk = Boolean(input.policyLoadOk);
  if (!policyLoadOk || !policy) {
    return { allowed: false, reason: 'spawn_policy_missing_or_unreadable' };
  }
  const action = String(input.spawnAction ?? 'spawn-new');
  if (action === 'spawn-new' && policy.allowSpawnNew !== true) {
    return { allowed: false, reason: 'spawn_new_denied' };
  }
  if (action === 'claim-pr-resume' && policy.allowClaimPrResume !== true) {
    return { allowed: false, reason: 'claim_pr_resume_denied' };
  }
  if (input.grantDenied) {
    return { allowed: false, reason: String(input.grantReason ?? 'spawn_grant_denied') };
  }
  return { allowed: true, reason: 'policy_and_grant_ok' };
}

/**
 * @param {object} input
 */
export function buildRecoveryAuditRecord(input) {
  const record = {
    schemaVersion: WORKER_RECOVERY_VERSION,
    attemptId: String(input.attemptId ?? ''),
    candidate: asRecord(input.candidate) ?? {},
    sourceEvidence: asRecord(input.sourceEvidence) ?? {},
    canonicalPath: String(input.canonicalPath ?? ''),
    livenessVerdict: String(input.livenessVerdict ?? ''),
    ownershipProof: asRecord(input.ownershipProof) ?? {},
    claimHolder: asRecord(input.claimHolder) ?? {},
    claimOutcome: String(input.claimOutcome ?? ''),
    cleanupDecision: String(input.cleanupDecision ?? ''),
    spawnDecision: String(input.spawnDecision ?? ''),
    finalState: String(input.finalState ?? ''),
    recordedAtUtc: new Date().toISOString(),
  };
  return record;
}

/**
 * @param {object} payload
 */
function handleCliSubcommand(subcommand, payload) {
  switch (subcommand) {
    case 'canonicalizePath':
      return canonicalizeRecoveryPath(payload.path);
    case 'classifyLiveness':
      return classifyWorkerSessionLiveness(payload.session);
    case 'evaluateOwnership':
      return evaluateOwnershipEvidence(payload);
    case 'evaluateCleanup':
      return evaluateCleanupEligibility(payload);
    case 'evaluatePostClaim':
      return evaluatePostClaimRevalidation(payload);
    case 'evaluateTrigger':
      return evaluateTriggerAdmission(payload);
    case 'evaluateSpawnFreshness':
      return evaluateSpawnFreshness(payload);
    case 'evaluateLiveDifferentOwner':
      return evaluateLiveDifferentOwner(payload);
    case 'evaluateRetry':
      return evaluateBoundedRetry(payload);
    case 'evaluateGitAllow':
      return evaluateWorkerRecoveryGitAllow(payload);
    case 'evaluateSpawnRoute':
      return evaluateRecoverySpawnRoute(payload);
    case 'deriveRecoveryClaimKey':
      return { claimKey: deriveRecoveryClaimKey(payload.sessionId, payload.canonicalPath) };
    case 'buildRecoveryAuditRecord':
      return buildRecoveryAuditRecord(payload);
    case 'parseWorktreeList':
      return { records: parseWorktreeListPorcelain(payload.porcelain) };
    default:
      return { ok: false, reason: 'unknown_subcommand' };
  }
}

async function main() {
  const subcommand = process.argv[2] ?? '';
  const payload = await readStdinJson();
  return handleCliSubcommand(subcommand, payload ?? {});
}

runAsyncStdinJsonCliMain('worker-recovery.mjs', main);

export { AFFIRMATIVE_LIVE_RUNTIME, TERMINAL_RUNTIME_VALUES, classifyRuntimeField };
