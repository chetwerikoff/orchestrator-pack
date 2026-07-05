/**
 * Autonomous dead-worker reconciliation planner (Issue #593).
 * Vitest: scripts/dead-worker-reconcile.test.ts
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  readStdinJson,
  runStdinJsonCli,
  toArray,
} from './review-mechanical-cli.mjs';

export const DEAD_WORKER_RECONCILER_VERSION = 'dead-worker-reconciler/v1';
export const AUTONOMOUS_RESPAWN_POLICY_VERSION = 'autonomous-respawn-policy/v1';
export const DEFAULT_DEAD_WORKER_INTERVAL_MS = 60_000;
export const DEFAULT_DEAD_WORKER_MAX_ATTEMPTS = 3;
export const DEFAULT_DEAD_WORKER_BACKOFF_MS = 60_000;
export const DEFAULT_DEAD_WORKER_CONCURRENCY = 1;
export const OPERATOR_SHUTDOWN_SUPPRESSION_MS = 5 * 60_000;

export function validateAutonomousRespawnPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return { ok: false, reason: 'respawn_policy_missing' };
  }
  if (policy.version !== AUTONOMOUS_RESPAWN_POLICY_VERSION) {
    return { ok: false, reason: 'respawn_policy_version_mismatch' };
  }
  if (typeof policy.allowReconcileDeadWorkerRespawn !== 'boolean') {
    return { ok: false, reason: 'respawn_policy_toggle_missing' };
  }
  return {
    ok: true,
    policy: {
      allowReconcileDeadWorkerRespawn: policy.allowReconcileDeadWorkerRespawn,
    },
  };
}

export function loadAutonomousRespawnPolicy(packRoot) {
  try {
    const text = readFileSync(`${packRoot}/docs/autonomous-respawn-policy.json`, 'utf8');
    return validateAutonomousRespawnPolicy(JSON.parse(text));
  } catch {
    return { ok: false, reason: 'respawn_policy_load_failed' };
  }
}

function normalizeString(value) {
  return String(value ?? '').trim();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getSessionId(session) {
  return normalizeString(session?.sessionId ?? session?.id ?? session?.name);
}

function getIssueNumber(session) {
  const issue = numberOrZero(session?.issueNumber ?? session?.issue);
  return issue > 0 ? issue : 0;
}

function getPrNumber(session) {
  const pr = numberOrZero(session?.prNumber ?? session?.pr);
  return pr > 0 ? pr : 0;
}

function getBranch(session) {
  return normalizeString(session?.branch ?? session?.headBranch ?? session?.headRefName);
}

function getWorktree(session) {
  return normalizeString(session?.worktree ?? session?.workspace ?? session?.worktreePath);
}

function eventType(event) {
  return normalizeLower(event?.type ?? event?.event ?? event?.name ?? event?.kind);
}

function eventSessionId(event) {
  return normalizeString(event?.sessionId ?? event?.session?.sessionId ?? event?.session?.id ?? event?.session?.name);
}

function eventReason(event) {
  return normalizeLower(event?.reason ?? event?.data?.reason ?? event?.payload?.reason);
}

function eventTimestampMs(event) {
  const raw = event?.timestampMs ?? event?.timeMs ?? event?.createdAtMs ?? event?.tsEpoch;
  const numeric = numberOrZero(raw);
  if (numeric > 0) return numeric;
  const text = normalizeString(event?.timestamp ?? event?.createdAt ?? event?.time);
  const parsed = text ? Date.parse(text) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventId(event, fallback) {
  return normalizeString(event?.id ?? event?.eventId ?? event?.uuid) || `event-${fallback}`;
}

function isTerminalRuntime(session) {
  const runtime = normalizeLower(session?.runtime);
  const status = normalizeLower(session?.status ?? session?.reportState);
  return ['exited', 'dead', 'terminated', 'failed', 'completed', 'stopped'].includes(runtime)
    || ['terminated', 'failed', 'completed', 'stopped'].includes(status);
}

function hasAssignedTask(session) {
  return getIssueNumber(session) > 0 || getPrNumber(session) > 0;
}

export function classifyWorkerDeathEvidence(session, aoEvents = [], nowMs = Date.now()) {
  const sessionId = getSessionId(session);
  const events = toArray(aoEvents);
  const matches = [];
  let manualKill = null;
  let operatorShutdown = null;
  let projectShutdown = null;
  let ptyLost = null;
  let death = null;

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const type = eventType(event);
    const reason = eventReason(event);
    const ts = eventTimestampMs(event);
    if (type === 'project.shutdown_started' || type === 'orchestrator.shutdown_started') {
      projectShutdown = {
        id: eventId(event, index),
        type,
        reason,
        timestampMs: ts,
      };
      continue;
    }
    if (eventSessionId(event) !== sessionId) continue;
    const row = {
      id: eventId(event, index),
      type,
      reason,
      timestampMs: ts,
    };
    matches.push(row);
    if ((type === 'session.kill_started' || type === 'session.killed') && reason === 'manually_killed') {
      manualKill = row;
    }
    if ((type === 'session.kill_started' || type === 'session.killed') && ['operator_shutdown', 'orchestrator_shutdown'].includes(reason)) {
      operatorShutdown = row;
    }
    if (type === 'ui.terminal_pty_lost') {
      ptyLost = row;
    }
    if (
      type === 'agent_process_exited' ||
      (type === 'session.killed' && reason !== 'manually_killed') ||
      (type === 'session.exited' && reason !== 'manually_killed') ||
      (type === 'worker.exited' && reason !== 'manually_killed') ||
      (type === 'session.kill_started' && reason && !['manually_killed', 'operator_shutdown', 'orchestrator_shutdown'].includes(reason))
    ) {
      death = row;
    }
  }

  if (manualKill) {
    return { verdict: 'suppressed', reason: 'operator_kill', event: manualKill, matchedEvents: matches };
  }
  if (operatorShutdown && nowMs - operatorShutdown.timestampMs <= OPERATOR_SHUTDOWN_SUPPRESSION_MS) {
    return { verdict: 'suppressed', reason: 'operator_shutdown_window', event: operatorShutdown, matchedEvents: matches };
  }
  if (projectShutdown && nowMs - projectShutdown.timestampMs <= OPERATOR_SHUTDOWN_SUPPRESSION_MS) {
    return { verdict: 'suppressed', reason: 'operator_shutdown_window', event: projectShutdown, matchedEvents: matches };
  }
  if (death) {
    return { verdict: 'dead', reason: 'probed_dead_event', event: death, matchedEvents: matches };
  }
  if (ptyLost && !isTerminalRuntime(session)) {
    return { verdict: 'audit_only', reason: 'pty_lost_insufficient', event: ptyLost, matchedEvents: matches };
  }
  if (ptyLost && isTerminalRuntime(session)) {
    return { verdict: 'dead', reason: 'pty_lost_with_terminal_runtime', event: ptyLost, matchedEvents: matches };
  }
  if (isTerminalRuntime(session)) {
    return { verdict: 'audit_only', reason: 'terminal_runtime_without_capture', event: null, matchedEvents: matches };
  }
  return { verdict: 'live_or_unknown', reason: 'no_dead_evidence', event: null, matchedEvents: matches };
}

export function buildDeadWorkerReconcileKey(candidate) {
  const parts = [
    DEAD_WORKER_RECONCILER_VERSION,
    normalizeString(candidate.sessionId),
    String(candidate.issueNumber || 0),
    String(candidate.prNumber || 0),
    normalizeString(candidate.branch),
    normalizeString(candidate.worktree),
    normalizeString(candidate.deathEventId),
    String(candidate.deathTimestampMs || 0),
  ];
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 20);
  return `dead-worker-${digest}`;
}

export function resolveRecoveryRoute(session, evidence, input = {}) {
  const issueNumber = getIssueNumber(session);
  const prNumber = getPrNumber(session);
  if (prNumber > 0) {
    return { ok: true, spawnAction: 'claim-pr-resume', prNumber, issueNumber };
  }
  if (issueNumber <= 0) {
    return { ok: false, reason: 'missing_assigned_task' };
  }
  if (input.prLookupFailed) {
    return { ok: false, reason: 'blocked_rate_limit_pr_unknown', escalate: true };
  }
  if (input.issueOnlyPrAmbiguous !== false) {
    return { ok: false, reason: 'issue_only_pr_ambiguity' };
  }
  return { ok: true, spawnAction: 'spawn-new', issueNumber, prNumber: 0 };
}

export function validateDeadWorkerGates(input = {}) {
  const policy = validateAutonomousRespawnPolicy(input.respawnPolicy);
  if (!policy.ok) return { ok: false, reason: policy.reason };
  if (!policy.policy.allowReconcileDeadWorkerRespawn) {
    return { ok: false, reason: 'respawn_policy_off' };
  }

  const bounds = input.bounds ?? {};
  const maxAttempts = numberOrZero(bounds.maxAttempts || DEFAULT_DEAD_WORKER_MAX_ATTEMPTS);
  const backoffMs = numberOrZero(bounds.backoffMs || DEFAULT_DEAD_WORKER_BACKOFF_MS);
  const concurrency = numberOrZero(bounds.concurrency || DEFAULT_DEAD_WORKER_CONCURRENCY);
  if (maxAttempts < 1 || maxAttempts > DEFAULT_DEAD_WORKER_MAX_ATTEMPTS) {
    return { ok: false, reason: 'invalid_retry_bound' };
  }
  if (backoffMs < DEFAULT_DEAD_WORKER_BACKOFF_MS) {
    return { ok: false, reason: 'invalid_backoff_bound' };
  }
  if (concurrency < 1 || concurrency > DEFAULT_DEAD_WORKER_CONCURRENCY) {
    return { ok: false, reason: 'invalid_concurrency_bound' };
  }

  const checks = input.recoveryChecks ?? {};
  if (checks.workerRecoveryAvailable !== true) {
    return { ok: false, reason: 'worker_recovery_checks_failed' };
  }
  if (checks.branchSafeRecoveryAvailable !== true) {
    return { ok: false, reason: 'branch_safe_recovery_unavailable' };
  }
  if (input.effectiveRuntimePolicy !== 'allow') {
    return { ok: false, reason: 'runtime_policy_not_allow' };
  }
  return { ok: true, bounds: { maxAttempts, backoffMs, concurrency } };
}

function evaluateRetryAndLease(key, tracking, bounds, nowMs) {
  const attempts = tracking.attempts ?? {};
  const leases = tracking.leases ?? {};
  const prior = attempts[key] ?? {};
  const activeLeases = Object.values(leases).filter((lease) => lease?.outcome === 'attempt_started');
  if (activeLeases.length >= bounds.concurrency) {
    return { ok: false, outcome: 'suppressed', reason: 'concurrency_cap_reached' };
  }
  const attempt = numberOrZero(prior.attempt);
  if (attempt >= bounds.maxAttempts) {
    return { ok: false, outcome: 'escalated', reason: 'retry_budget_exhausted', attempt };
  }
  const lastAttemptMs = numberOrZero(prior.lastAttemptMs);
  if (attempt > 0 && nowMs - lastAttemptMs < bounds.backoffMs * (2 ** (attempt - 1))) {
    return { ok: false, outcome: 'suppressed', reason: 'backoff_not_elapsed', attempt };
  }
  return { ok: true, attempt: attempt + 1 };
}

export function planDeadWorkerReconcile(input = {}) {
  const nowMs = numberOrZero(input.nowMs) || Date.now();
  const tracking = input.tracking ?? {};
  const actions = [];
  const gates = validateDeadWorkerGates(input);
  const sessions = toArray(input.sessions);

  for (const session of sessions) {
    const sessionId = getSessionId(session);
    if (!sessionId || !hasAssignedTask(session)) {
      continue;
    }
    const evidence = classifyWorkerDeathEvidence(session, input.aoEvents, nowMs);
    if (evidence.verdict === 'live_or_unknown') {
      continue;
    }
    const route = resolveRecoveryRoute(session, evidence, input);
    const deathEvent = evidence.event ?? {};
    const candidate = {
      sessionId,
      issueNumber: getIssueNumber(session),
      prNumber: getPrNumber(session),
      branch: getBranch(session),
      worktree: getWorktree(session),
      deathEventId: deathEvent.id ?? '',
      deathTimestampMs: deathEvent.timestampMs ?? 0,
      classifierVersion: DEAD_WORKER_RECONCILER_VERSION,
    };
    const key = buildDeadWorkerReconcileKey(candidate);
    const base = {
      key,
      sessionId,
      issueNumber: candidate.issueNumber,
      prNumber: candidate.prNumber,
      branch: candidate.branch,
      worktree: candidate.worktree,
      deathEventId: candidate.deathEventId,
      deathTimestampMs: candidate.deathTimestampMs,
      classifierVersion: DEAD_WORKER_RECONCILER_VERSION,
      evidence,
    };

    if (evidence.verdict === 'suppressed') {
      actions.push({ ...base, type: 'suppressed', outcome: 'suppressed', reason: evidence.reason });
      continue;
    }
    if (evidence.verdict !== 'dead') {
      actions.push({ ...base, type: 'audit_only', outcome: 'audit-only', reason: evidence.reason });
      continue;
    }
    if (!route.ok) {
      actions.push({
        ...base,
        type: route.escalate ? 'escalated' : 'audit_only',
        outcome: route.escalate ? 'escalated' : 'audit-only',
        reason: route.reason,
      });
      continue;
    }
    if (!gates.ok) {
      actions.push({ ...base, type: 'audit_only', outcome: 'audit-only', reason: gates.reason });
      continue;
    }

    const retry = evaluateRetryAndLease(key, tracking, gates.bounds, nowMs);
    if (!retry.ok) {
      actions.push({ ...base, type: retry.outcome, outcome: retry.outcome, reason: retry.reason, attempt: retry.attempt });
      continue;
    }

    actions.push({
      ...base,
      type: 'attempt_started',
      outcome: 'attempt_started',
      reason: 'recoverable_dead_worker',
      attempt: retry.attempt,
      spawnAction: route.spawnAction,
      issueNumber: route.issueNumber,
      prNumber: route.prNumber,
      invoke: {
        trigger: 'reconcile_dead_worker',
        probedDeadEvidence: true,
        sessionId,
        worktreePath: candidate.worktree,
        spawnAction: route.spawnAction,
        issueNumber: route.issueNumber,
        prNumber: route.prNumber,
      },
    });
  }

  return { actions, gates };
}

export function commitDeadWorkerAction(tracking = {}, action, nowMs = Date.now()) {
  const attempts = { ...(tracking.attempts ?? {}) };
  const leases = { ...(tracking.leases ?? {}) };
  const audit = toArray(tracking.audit);
  const key = normalizeString(action?.key);
  if (!key) return tracking;
  const record = {
    key,
    outcome: action.outcome ?? action.type,
    reason: action.reason,
    sessionId: action.sessionId,
    issueNumber: action.issueNumber,
    prNumber: action.prNumber,
    branch: action.branch,
    worktree: action.worktree,
    deathEventId: action.deathEventId,
    deathTimestampMs: action.deathTimestampMs,
    classifierVersion: DEAD_WORKER_RECONCILER_VERSION,
    recordedAtMs: nowMs,
  };
  audit.push(record);
  if (action.type === 'attempt_started') {
    attempts[key] = { attempt: numberOrZero(action.attempt), lastAttemptMs: nowMs };
    leases[key] = { outcome: 'attempt_started', startedAtMs: nowMs, sessionId: action.sessionId };
  } else if (['recovered', 'suppressed', 'escalated', 'audit_only'].includes(action.type)) {
    delete leases[key];
  }
  return { ...tracking, attempts, leases, audit };
}

export function evaluateDeadWorkerInterval({ nowMs, lastTickMs, intervalMs }) {
  const interval = Math.max(1, numberOrZero(intervalMs) || DEFAULT_DEAD_WORKER_INTERVAL_MS);
  if (!lastTickMs || nowMs - lastTickMs >= interval) {
    return { ok: true, intervalMs: interval };
  }
  return { ok: false, reason: 'interval_not_elapsed', intervalMs: interval };
}

export function probeRecoveryChecks(packRoot) {
  const root = normalizeString(packRoot) || process.cwd();
  const workerRecoveryAvailable = existsSync(`${root}/scripts/invoke-worker-recovery.ps1`)
    && existsSync(`${root}/scripts/lib/Worker-Recovery.ps1`);
  let branchSafeRecoveryAvailable = existsSync(`${root}/docs/worker-recovery-branch-cleanup.mjs`);
  if (branchSafeRecoveryAvailable) {
    const text = readFileSync(`${root}/docs/worker-recovery-branch-cleanup.mjs`, 'utf8');
    branchSafeRecoveryAvailable = /parseRecoveryBranchDeleteArgv/.test(text)
      && /evaluateBranchGitAllow/.test(text);
  }
  return { workerRecoveryAvailable, branchSafeRecoveryAvailable };
}

runStdinJsonCli('dead-worker-reconciler.mjs', {
  plan: () => planDeadWorkerReconcile(readStdinJson()),
  commit: () => {
    const payload = readStdinJson();
    return { tracking: commitDeadWorkerAction(payload.tracking ?? {}, payload.action, numberOrZero(payload.nowMs) || Date.now()) };
  },
  interval: () => {
    const payload = readStdinJson();
    return evaluateDeadWorkerInterval({
      nowMs: numberOrZero(payload.nowMs) || Date.now(),
      lastTickMs: numberOrZero(payload.lastTickMs),
      intervalMs: numberOrZero(payload.intervalMs),
    });
  },
  'probe-checks': () => probeRecoveryChecks(readStdinJson().packRoot),
  'validate-policy': () => validateAutonomousRespawnPolicy(readStdinJson().policy),
});
