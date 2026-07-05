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
export const OPERATOR_SHUTDOWN_SUPPRESSION_MS = 120_000;
export const DEFAULT_SHUTDOWN_SUPPRESSION_WINDOW_MS = 120_000;

export function resolveShutdownSuppressionWindowMs(policy) {
  const configured = numberOrZero(policy?.shutdownSuppressionWindowMs);
  if (configured > 0) return configured;
  return DEFAULT_SHUTDOWN_SUPPRESSION_WINDOW_MS;
}

export function resolveAttemptLeaseTtlMs(bounds = {}) {
  const backoffMs = numberOrZero(bounds.backoffMs) || DEFAULT_DEAD_WORKER_BACKOFF_MS;
  const maxAttempts = numberOrZero(bounds.maxAttempts) || DEFAULT_DEAD_WORKER_MAX_ATTEMPTS;
  const configured = numberOrZero(bounds.attemptLeaseTtlMs);
  if (configured > 0) return configured;
  return Math.max(backoffMs * (2 ** Math.max(0, maxAttempts - 1)) + backoffMs, backoffMs * 2);
}

export function expireStaleAttemptLeases(tracking = {}, bounds = {}, nowMs = Date.now()) {
  const leaseTtlMs = resolveAttemptLeaseTtlMs(bounds);
  const leases = { ...(tracking.leases ?? {}) };
  const audit = [...toArray(tracking.audit)];
  let changed = false;
  for (const [key, lease] of Object.entries(leases)) {
    if (lease?.outcome !== 'attempt_started') continue;
    const startedAtMs = numberOrZero(lease.startedAtMs);
    if (startedAtMs > 0 && nowMs - startedAtMs >= leaseTtlMs) {
      delete leases[key];
      audit.push({
        key,
        outcome: 'lease_expired',
        reason: 'stale_attempt_lease',
        sessionId: lease.sessionId,
        recordedAtMs: nowMs,
        classifierVersion: DEAD_WORKER_RECONCILER_VERSION,
      });
      changed = true;
    }
  }
  return changed ? { ...tracking, leases, audit } : tracking;
}

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

export function classifyWorkerDeathEvidence(session, aoEvents = [], nowMs = Date.now(), options = {}) {
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
  const shutdownSuppressionWindowMs = resolveShutdownSuppressionWindowMs(options.respawnPolicy ?? options);
  if (operatorShutdown && nowMs - operatorShutdown.timestampMs <= shutdownSuppressionWindowMs) {
    return { verdict: 'suppressed', reason: 'operator_shutdown_window', event: operatorShutdown, matchedEvents: matches };
  }
  if (projectShutdown && nowMs - projectShutdown.timestampMs <= shutdownSuppressionWindowMs) {
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

export function issueLinkedWorkerBranches(issueNumber) {
  const issue = numberOrZero(issueNumber);
  if (issue <= 0) {
    return [];
  }
  return [`feat/${issue}`, `feat/issue-${issue}`, `opk-${issue}`];
}

export function issueLinkedOpenPrs(issueNumber, openPrs = [], session = null) {
  const issue = numberOrZero(issueNumber);
  if (issue <= 0) {
    return [];
  }
  const authorized = new Set(issueLinkedWorkerBranches(issue));
  const sessionBranch = getBranch(session);
  return toArray(openPrs).filter((pr) => {
    const head = normalizeString(pr?.headRefName ?? pr?.head);
    if (!head) {
      return false;
    }
    if (authorized.has(head)) {
      return true;
    }
    return Boolean(sessionBranch && sessionBranch === head);
  });
}

/**
 * Derive issue-only PR linkage for live ticks (openPrs supplied). Fixtures without
 * openPrs keep the explicit issueOnlyPrAmbiguous / prLookupFailed contract.
 */
export function resolveIssueOnlyPrLookup(session, input = {}) {
  if (input.prLookupFailed) {
    return { prLookupFailed: true };
  }
  if (input.openPrs === undefined) {
    return { issueOnlyPrAmbiguous: input.issueOnlyPrAmbiguous !== false };
  }
  const issueNumber = getIssueNumber(session);
  const matches = issueLinkedOpenPrs(issueNumber, input.openPrs, session);
  if (matches.length > 1) {
    return {
      issueOnlyPrAmbiguous: true,
      matchedPrNumbers: matches.map((pr) => numberOrZero(pr.number)).filter((n) => n > 0),
    };
  }
  if (matches.length === 1) {
    return { issueOnlyPrAmbiguous: false, resolvedPrNumber: numberOrZero(matches[0].number) };
  }
  return { issueOnlyPrAmbiguous: false, resolvedPrNumber: 0 };
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
  const lookup = resolveIssueOnlyPrLookup(session, input);
  if (lookup.prLookupFailed) {
    return { ok: false, reason: 'blocked_rate_limit_pr_unknown', escalate: true };
  }
  const resolvedPr = numberOrZero(lookup.resolvedPrNumber);
  if (resolvedPr > 0) {
    return { ok: true, spawnAction: 'claim-pr-resume', prNumber: resolvedPr, issueNumber };
  }
  if (lookup.issueOnlyPrAmbiguous) {
    return { ok: false, reason: 'issue_only_pr_ambiguity' };
  }
  return { ok: true, spawnAction: 'spawn-new', issueNumber, prNumber: 0 };
}

export const DEAD_WORKER_RUNTIME_ADOPTION_MARKERS = [
  'DEAD WORKER RECONCILE',
  'dead-worker-reconcile.ps1',
  'allowReconcileDeadWorkerRespawn',
  '-ProbedDeadEvidence',
];

function validateResolvedDeadWorkerBounds(bounds) {
  const maxAttempts = numberOrZero(bounds.maxAttempts);
  const backoffMs = numberOrZero(bounds.backoffMs);
  const concurrency = numberOrZero(bounds.concurrency);
  if (maxAttempts < 1 || maxAttempts > DEFAULT_DEAD_WORKER_MAX_ATTEMPTS) {
    return { ok: false, reason: 'invalid_retry_bound' };
  }
  if (backoffMs < DEFAULT_DEAD_WORKER_BACKOFF_MS) {
    return { ok: false, reason: 'invalid_backoff_bound' };
  }
  if (concurrency < 1 || concurrency > DEFAULT_DEAD_WORKER_CONCURRENCY) {
    return { ok: false, reason: 'invalid_concurrency_bound' };
  }
  return { ok: true, bounds: { maxAttempts, backoffMs, concurrency } };
}

export function resolveDeadWorkerBounds(policy, overrideBounds = null) {
  const validated = validateAutonomousRespawnPolicy(policy);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }
  const source = overrideBounds && typeof overrideBounds === 'object' && !Array.isArray(overrideBounds)
    ? overrideBounds
    : policy;
  return validateResolvedDeadWorkerBounds({
    maxAttempts: source?.maxAttempts ?? DEFAULT_DEAD_WORKER_MAX_ATTEMPTS,
    backoffMs: source?.backoffMs ?? DEFAULT_DEAD_WORKER_BACKOFF_MS,
    concurrency: source?.concurrency ?? DEFAULT_DEAD_WORKER_CONCURRENCY,
  });
}

export function evaluateDeadWorkerRuntimeAdoption(input = {}) {
  const rules = normalizeString(input.orchestratorRules);
  const missing = DEAD_WORKER_RUNTIME_ADOPTION_MARKERS.filter((phrase) => !rules.includes(phrase));
  if (missing.length > 0) {
    return {
      ok: false,
      effectiveRuntimePolicy: 'deny',
      reason: 'runtime_policy_not_adopted',
      missing,
    };
  }
  return {
    ok: true,
    effectiveRuntimePolicy: 'allow',
    reason: 'runtime_policy_adopted',
    missing: [],
  };
}

export function validateDeadWorkerGates(input = {}) {
  const policy = validateAutonomousRespawnPolicy(input.respawnPolicy);
  if (!policy.ok) return { ok: false, reason: policy.reason };
  if (!policy.policy.allowReconcileDeadWorkerRespawn) {
    return { ok: false, reason: 'respawn_policy_off' };
  }

  const boundResolution = input.bounds
    ? validateResolvedDeadWorkerBounds(input.bounds)
    : resolveDeadWorkerBounds(input.respawnPolicy);
  if (!boundResolution.ok) {
    return { ok: false, reason: boundResolution.reason };
  }
  const { maxAttempts, backoffMs, concurrency } = boundResolution.bounds;

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

function countActiveAttemptLeases(leases, nowMs, leaseTtlMs) {
  return Object.values(leases).filter((lease) => {
    if (lease?.outcome !== 'attempt_started') return false;
    const startedAtMs = numberOrZero(lease.startedAtMs);
    return startedAtMs > 0 && nowMs - startedAtMs < leaseTtlMs;
  }).length;
}

function reservePlanAttemptLease(tracking, key, sessionId, nowMs) {
  const leases = { ...(tracking.leases ?? {}) };
  leases[key] = { outcome: 'attempt_started', startedAtMs: nowMs, sessionId };
  return { ...tracking, leases };
}

function hasRecoveredReconcileKey(tracking, key) {
  const normalizedKey = normalizeString(key);
  if (!normalizedKey) {
    return false;
  }
  return toArray(tracking.audit).some((row) => {
    if (normalizeString(row?.key) !== normalizedKey) {
      return false;
    }
    const outcome = normalizeString(row?.outcome ?? row?.type);
    return outcome === 'recovered';
  });
}

function evaluateRetryAndLease(key, tracking, bounds, nowMs) {
  if (hasRecoveredReconcileKey(tracking, key)) {
    return { ok: false, outcome: 'suppressed', reason: 'already_recovered' };
  }
  const attempts = tracking.attempts ?? {};
  const leases = tracking.leases ?? {};
  const prior = attempts[key] ?? {};
  const leaseTtlMs = resolveAttemptLeaseTtlMs(bounds);
  const activeLeases = countActiveAttemptLeases(leases, nowMs, leaseTtlMs);
  if (activeLeases >= bounds.concurrency) {
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
  const boundResolution = input.bounds
    ? validateResolvedDeadWorkerBounds(input.bounds)
    : resolveDeadWorkerBounds(input.respawnPolicy);
  const bounds = boundResolution.ok ? boundResolution.bounds : {
    maxAttempts: DEFAULT_DEAD_WORKER_MAX_ATTEMPTS,
    backoffMs: DEFAULT_DEAD_WORKER_BACKOFF_MS,
    concurrency: DEFAULT_DEAD_WORKER_CONCURRENCY,
  };
  const tracking = expireStaleAttemptLeases(input.tracking ?? {}, bounds, nowMs);
  let planningTracking = tracking;
  const actions = [];
  const gates = validateDeadWorkerGates(input);
  const sessions = toArray(input.sessions);

  for (const session of sessions) {
    const sessionId = getSessionId(session);
    if (!sessionId || !hasAssignedTask(session)) {
      continue;
    }
    const evidence = classifyWorkerDeathEvidence(session, input.aoEvents, nowMs, { respawnPolicy: input.respawnPolicy });
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

    const retry = evaluateRetryAndLease(key, planningTracking, gates.bounds, nowMs);
    if (!retry.ok) {
      actions.push({ ...base, type: retry.outcome, outcome: retry.outcome, reason: retry.reason, attempt: retry.attempt });
      continue;
    }

    const attemptAction = {
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
    };
    actions.push(attemptAction);
    planningTracking = reservePlanAttemptLease(planningTracking, key, sessionId, nowMs);
  }

  return { actions, gates, tracking };
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

export const DEAD_WORKER_RECOVERY_SUCCESS_OUTCOMES = new Set([
  'removed_terminated_session',
  'removed_dangling_gitdir',
  'orphan_branch_pending',
]);

function extractBalancedJsonObject(text, startIndex) {
  if (text[startIndex] !== '{') {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index++) {
    const ch = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }
  return null;
}

function isWorkerRecoveryInvokeResult(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && ('ok' in value || 'outcome' in value));
}

export function parseWorkerRecoveryInvokeOutput(rawOutput) {
  const text = String(rawOutput ?? '').trim();
  if (!text) {
    return { ok: false, reason: 'empty_recovery_output' };
  }

  try {
    const direct = JSON.parse(text);
    if (isWorkerRecoveryInvokeResult(direct)) {
      return { ok: true, result: direct };
    }
  } catch {
    // fall through to balanced-object scan
  }

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf('{', searchFrom);
    if (start < 0) {
      break;
    }
    const candidate = extractBalancedJsonObject(text, start);
    searchFrom = start + 1;
    if (!candidate) {
      continue;
    }
    try {
      const result = JSON.parse(candidate);
      if (isWorkerRecoveryInvokeResult(result)) {
        return { ok: true, result };
      }
    } catch {
      continue;
    }
  }

  if (!text.includes('{')) {
    return { ok: false, reason: 'recovery_output_not_json' };
  }
  return { ok: false, reason: 'recovery_output_parse_failed' };
}

export function classifyDeadWorkerRecoveryInvokeResult(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, deadWorkerOutcome: 'escalated', reason: 'recovery_result_missing' };
  }
  if (result.ok === false) {
    const outcome = normalizeString(result.outcome);
    return {
      ok: false,
      deadWorkerOutcome: 'escalated',
      reason: outcome || 'recovery_failed',
      recoveryOutcome: outcome,
    };
  }
  const outcome = normalizeString(result.outcome);
  const spawn = normalizeString(result.spawn);
  const spawnStarted = spawn === 'spawn_started';
  const cleanupSucceeded = DEAD_WORKER_RECOVERY_SUCCESS_OUTCOMES.has(outcome);
  if (spawnStarted || cleanupSucceeded) {
    return {
      ok: true,
      deadWorkerOutcome: 'recovered',
      reason: spawnStarted ? spawn : outcome,
      recoveryOutcome: outcome,
      spawn,
    };
  }
  if (outcome === 'claim_lost' || outcome === 'no_op') {
    return {
      ok: true,
      deadWorkerOutcome: 'suppressed',
      reason: outcome,
      recoveryOutcome: outcome,
      spawn,
    };
  }
  return {
    ok: true,
    deadWorkerOutcome: 'audit_only',
    reason: outcome || 'recovery_non_terminal',
    recoveryOutcome: outcome,
    spawn,
  };
}

export function parseAndClassifyDeadWorkerRecoveryOutput(rawOutput) {
  const parsed = parseWorkerRecoveryInvokeOutput(rawOutput);
  if (!parsed.ok) {
    return { ok: false, deadWorkerOutcome: 'escalated', reason: parsed.reason };
  }
  return classifyDeadWorkerRecoveryInvokeResult(parsed.result);
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
  'resolve-bounds': () => {
    const payload = readStdinJson();
    return resolveDeadWorkerBounds(payload.policy, payload.bounds ?? null);
  },
  'evaluate-adoption': () => evaluateDeadWorkerRuntimeAdoption(readStdinJson()),
  'parse-recovery-output': () => parseAndClassifyDeadWorkerRecoveryOutput(readStdinJson().output),
});
