import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AUTONOMOUS_RESPAWN_POLICY_VERSION,
  DEAD_WORKER_RECONCILER_VERSION,
  DEFAULT_DEAD_WORKER_BACKOFF_MS,
  DEFAULT_DEAD_WORKER_MAX_ATTEMPTS,
  buildDeadWorkerReconcileKey,
  classifyWorkerDeathEvidence,
  commitDeadWorkerAction,
  evaluateDeadWorkerInterval,
  evaluateDeadWorkerRuntimeAdoption,
  expireStaleAttemptLeases,
  loadAutonomousRespawnPolicy,
  planDeadWorkerReconcile,
  probeRecoveryChecks,
  resolveAttemptLeaseTtlMs,
  resolveDeadWorkerBounds,
  resolveIssueOnlyPrLookup,
  resolveRecoveryRoute,
  resolveShutdownSuppressionWindowMs,
  validateAutonomousRespawnPolicy,
  validateDeadWorkerGates,
} from '../docs/dead-worker-reconciler.mjs';

const repoRoot = join(import.meta.dirname, '..');
const capturesDir = join(repoRoot, 'tests/external-output-references/captures/dead-worker-reconciler');
const fixturesDir = join(repoRoot, 'scripts/fixtures/dead-worker-reconciler');

function readCapture(name: string) {
  return JSON.parse(readFileSync(join(capturesDir, name), 'utf8'));
}

function enabledPlanInput(overrides: Record<string, unknown> = {}) {
  return {
    respawnPolicy: {
      version: AUTONOMOUS_RESPAWN_POLICY_VERSION,
      allowReconcileDeadWorkerRespawn: true,
    },
    recoveryChecks: { workerRecoveryAvailable: true, branchSafeRecoveryAvailable: true },
    effectiveRuntimePolicy: 'allow',
    bounds: { maxAttempts: DEFAULT_DEAD_WORKER_MAX_ATTEMPTS, backoffMs: DEFAULT_DEAD_WORKER_BACKOFF_MS, concurrency: 1 },
    tracking: { attempts: {}, leases: {}, audit: [] },
    issueOnlyPrAmbiguous: false,
    prLookupFailed: false,
    nowMs: 1_780_000_105_500,
    ...overrides,
  };
}

describe('dead-worker-reconciler (Issue #593)', () => {
  it('validates default-OFF autonomous respawn policy', () => {
    const loaded = loadAutonomousRespawnPolicy(repoRoot);
    expect(loaded.ok).toBe(true);
    expect(loaded.policy?.allowReconcileDeadWorkerRespawn).toBe(false);
    expect(validateAutonomousRespawnPolicy({ version: AUTONOMOUS_RESPAWN_POLICY_VERSION, allowReconcileDeadWorkerRespawn: false }).ok).toBe(true);
    expect(validateAutonomousRespawnPolicy({ version: AUTONOMOUS_RESPAWN_POLICY_VERSION, allowReconcileDeadWorkerRespawn: 'yes' }).ok).toBe(false);
  });

  it('enablement gate is audit-only when toggle is OFF', () => {
    const gate = validateDeadWorkerGates({
      respawnPolicy: { version: AUTONOMOUS_RESPAWN_POLICY_VERSION, allowReconcileDeadWorkerRespawn: false },
      recoveryChecks: { workerRecoveryAvailable: true, branchSafeRecoveryAvailable: true },
      effectiveRuntimePolicy: 'allow',
      bounds: { maxAttempts: 3, backoffMs: 60000, concurrency: 1 },
    });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe('respawn_policy_off');
  });

  it('enablement gate passes when toggle ON and prerequisites present', () => {
    const gate = validateDeadWorkerGates(enabledPlanInput());
    expect(gate.ok).toBe(true);
  });

  it('honors configured shutdown suppression window from policy JSON', () => {
    const session = { name: 'opk-593', issueNumber: 593, status: 'terminated', runtime: 'exited' };
    const shutdownMs = 1_780_000_000_000;
    const events = [
      { name: 'orchestrator.shutdown_started', timestampMs: shutdownMs },
      { name: 'agent_process_exited', sessionId: 'opk-593', timestampMs: shutdownMs + 1_000 },
    ];
    const nowMs = shutdownMs + 150_000;
    const shortWindow = classifyWorkerDeathEvidence(session, events, nowMs, {
      respawnPolicy: { shutdownSuppressionWindowMs: 120_000 },
    });
    expect(shortWindow.verdict).toBe('dead');
    const longWindow = classifyWorkerDeathEvidence(session, events, nowMs, {
      respawnPolicy: { shutdownSuppressionWindowMs: 300_000 },
    });
    expect(longWindow.verdict).toBe('suppressed');
    expect(resolveShutdownSuppressionWindowMs({ shutdownSuppressionWindowMs: 120_000 })).toBe(120_000);
  });

  it('expires stale attempt_started leases before concurrency gate', () => {
    const fixture = readCapture('recoverable-crash.raw.json');
    const nowMs = 1_780_000_105_500;
    const bounds = { maxAttempts: 3, backoffMs: 60_000, concurrency: 1 };
    const leaseTtlMs = resolveAttemptLeaseTtlMs(bounds);
    const staleStartedAt = nowMs - leaseTtlMs - 1_000;
    const enabled = enabledPlanInput({
      sessions: [fixture.session],
      aoEvents: fixture.events,
      nowMs,
    });
    const baseline = planDeadWorkerReconcile(enabled);
    const recoverKey = baseline.actions.find((a: { type: string }) => a.type === 'attempt_started')?.key as string;
    expect(recoverKey).toBeTruthy();
    const blocked = planDeadWorkerReconcile({
      ...enabled,
      tracking: {
        attempts: { [recoverKey]: { attempt: 1, lastAttemptMs: staleStartedAt } },
        leases: { [recoverKey]: { outcome: 'attempt_started', startedAtMs: staleStartedAt, sessionId: 'opk-593' } },
        audit: [],
      },
    });
    expect(blocked.actions.some((a: { reason?: string }) => a.reason === 'concurrency_cap_reached')).toBe(false);
    expect(blocked.actions.some((a: { type: string }) => a.type === 'attempt_started')).toBe(true);
    const pruned = expireStaleAttemptLeases(blocked.tracking ?? {}, bounds, nowMs) as {
      leases?: Record<string, unknown>;
      audit?: Array<{ outcome?: string }>;
    };
    expect(pruned.leases?.[recoverKey]).toBeUndefined();
    expect(pruned.audit?.some((row: { outcome?: string }) => row.outcome === 'lease_expired')).toBe(true);
  });

  it('operator manual kill suppresses respawn (opk-128 shape)', () => {
    const fixture = readCapture('operator-manual-kill.raw.json');
    const evidence = classifyWorkerDeathEvidence(fixture.session, fixture.events, 1_780_000_001_500);
    expect(evidence.verdict).toBe('suppressed');
    const plan = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [fixture.session],
      aoEvents: fixture.events,
    }));
    expect(plan.actions.some((a: { type: string }) => a.type === 'attempt_started')).toBe(false);
    expect(plan.actions.some((a: { type: string }) => a.type === 'suppressed')).toBe(true);
  });

  it('recoverable crash plans recovery when enabled', () => {
    const fixture = readCapture('recoverable-crash.raw.json');
    const evidence = classifyWorkerDeathEvidence(fixture.session, fixture.events, 1_780_000_105_500);
    expect(evidence.verdict).toBe('dead');
    const plan = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [fixture.session],
      aoEvents: fixture.events,
    }));
    const recover = plan.actions.filter((a: { type: string }) => a.type === 'attempt_started');
    expect(recover).toHaveLength(1);
    expect(recover[0].invoke?.probedDeadEvidence).toBe(true);
    expect(recover[0].invoke?.trigger).toBe('reconcile_dead_worker');
  });

  it('PTY loss alone is audit-only without terminal runtime', () => {
    const fixture = readCapture('pty-lost-only.raw.json');
    const evidence = classifyWorkerDeathEvidence(fixture.session, fixture.events, 1_780_000_200_000);
    expect(evidence.verdict).toBe('audit_only');
    expect(evidence.reason).toBe('pty_lost_insufficient');
  });

  it('project shutdown window suppresses via operator shutdown reason', () => {
    const session = { name: 'opk-shutdown-worker', role: 'worker', status: 'terminated', runtime: 'exited', issue: 593, worktree: '/wt' };
    const events = [
      { name: 'session.kill_started', sessionId: 'opk-shutdown-worker', timestampMs: Date.now() - 1000, data: { reason: 'operator_shutdown' } },
      { name: 'agent_process_exited', sessionId: 'opk-shutdown-worker', timestampMs: Date.now() - 500 },
    ];
    const evidence = classifyWorkerDeathEvidence(session, events, Date.now());
    expect(evidence.verdict).toBe('suppressed');
  });

  it('issue-only PR ambiguity fails closed', () => {
    const route = resolveRecoveryRoute(
      { name: 'opk-593', issue: 593, branch: 'feat/593', worktree: '/wt' },
      { verdict: 'dead', reason: 'probed_dead_event' },
      { issueOnlyPrAmbiguous: true },
    );
    expect(route.ok).toBe(false);
    expect(route.reason).toBe('issue_only_pr_ambiguity');

    const rateLimited = resolveRecoveryRoute(
      { name: 'opk-593', issue: 593, branch: 'feat/593', worktree: '/wt' },
      { verdict: 'dead', reason: 'probed_dead_event' },
      { prLookupFailed: true },
    );
    expect(rateLimited.reason).toBe('blocked_rate_limit_pr_unknown');
    expect(rateLimited.escalate).toBe(true);
  });

  it('derives issue-only PR linkage from open PR list', () => {
    const session = { name: 'opk-593', issue: 593, branch: 'feat/593', worktree: '/wt' };
    const evidence = { verdict: 'dead', reason: 'probed_dead_event' } as const;

    const spawnNew = resolveRecoveryRoute(session, evidence, { openPrs: [] });
    expect(spawnNew.ok).toBe(true);
    expect(spawnNew.spawnAction).toBe('spawn-new');

    const claimPr = resolveRecoveryRoute(session, evidence, {
      openPrs: [{ number: 605, headRefName: 'feat/593' }],
    });
    expect(claimPr.ok).toBe(true);
    expect(claimPr.spawnAction).toBe('claim-pr-resume');
    expect(claimPr.prNumber).toBe(605);

    const ambiguous = resolveRecoveryRoute(session, evidence, {
      openPrs: [
        { number: 605, headRefName: 'feat/593' },
        { number: 606, headRefName: 'feat/issue-593' },
      ],
    });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.reason).toBe('issue_only_pr_ambiguity');

    const lookup = resolveIssueOnlyPrLookup(session, { prLookupFailed: true });
    expect(lookup.prLookupFailed).toBe(true);
  });

  it('enforces concurrency cap within a single plan tick', () => {
    const fixture = readCapture('recoverable-crash.raw.json');
    const session2 = {
      ...fixture.session,
      name: 'opk-dead-594',
      issue: 594,
      branch: 'feat/594',
      worktree: '/home/operator/.agent-orchestrator/projects/orchestrator-pack/worktrees/opk-dead-594',
    };
    const events2 = fixture.events.map((event: Record<string, unknown>) => ({
      ...event,
      sessionId: 'opk-dead-594',
    }));
    const plan = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [fixture.session, session2],
      aoEvents: [...fixture.events, ...events2],
      bounds: { maxAttempts: 3, backoffMs: 60_000, concurrency: 1 },
    }));
    const attempts = plan.actions.filter((a: { type: string }) => a.type === 'attempt_started');
    expect(attempts).toHaveLength(1);
    expect(plan.actions.some((a: { reason?: string }) => a.reason === 'concurrency_cap_reached')).toBe(true);
  });

  it('retry budget exhausts and escalates', () => {
    const fixture = readCapture('recoverable-crash.raw.json');
    const pre = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [fixture.session],
      aoEvents: fixture.events,
    }));
    const recover = pre.actions.find((a: { type: string }) => a.type === 'attempt_started');
    expect(recover).toBeTruthy();
    const plan = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [fixture.session],
      aoEvents: fixture.events,
      tracking: {
        attempts: { [recover!.key]: { attempt: 3, lastAttemptMs: Date.now() - 1 } },
        leases: {},
        audit: [],
      },
    }));
    expect(plan.actions.some((a: { type: string; reason?: string }) => a.type === 'escalated' || a.reason === 'retry_budget_exhausted')).toBe(true);
  });

  it('does not retry keys that already recovered', () => {
    const fixture = readCapture('recoverable-crash.raw.json');
    const pre = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [fixture.session],
      aoEvents: fixture.events,
    }));
    const recover = pre.actions.find((a: { type: string }) => a.type === 'attempt_started');
    expect(recover).toBeTruthy();
    const tracking = commitDeadWorkerAction(
      {
        attempts: { [recover!.key]: { attempt: 1, lastAttemptMs: 1_780_000_105_000 } },
        leases: {},
        audit: [],
      },
      {
        ...recover,
        type: 'recovered',
        outcome: 'recovered',
        reason: 'recovered',
      },
      1_780_000_106_000,
    );
    const plan = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [fixture.session],
      aoEvents: fixture.events,
      tracking,
      nowMs: 1_780_000_200_000,
    }));
    expect(plan.actions.some((a: { type: string }) => a.type === 'attempt_started')).toBe(false);
    expect(plan.actions.some((a: { reason?: string }) => a.reason === 'already_recovered')).toBe(true);
  });

  it('reconciliation key is stable and versioned', () => {
    const key = buildDeadWorkerReconcileKey({
      sessionId: 'opk-593',
      issueNumber: 593,
      branch: 'feat/593',
      worktree: '/tmp/wt',
      deathEventId: 'agent_process_exited',
      deathTimestampMs: 1000,
    });
    expect(key.startsWith('dead-worker-')).toBe(true);
    expect(key.length).toBeGreaterThan(20);
  });

  it('does not plan recovery for unassigned sessions', () => {
    const plan = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [{ name: 'opk-unassigned', role: 'worker', status: 'terminated', runtime: 'exited' }],
      aoEvents: [{ name: 'agent_process_exited', sessionId: 'opk-unassigned', timestampMs: Date.now() }],
    }));
    expect(plan.actions).toHaveLength(0);
  });

  it('durable cursor records attempt_started lease', () => {
    const action = {
      key: 'dead-worker-test',
      type: 'attempt_started',
      outcome: 'attempt_started',
      sessionId: 'opk-593',
      attempt: 1,
    };
    const tracking = commitDeadWorkerAction({}, action, Date.now()) as {
      leases: Record<string, { outcome?: string }>;
      attempts: Record<string, { attempt?: number }>;
    };
    expect(tracking.leases['dead-worker-test']?.outcome).toBe('attempt_started');
    expect(tracking.attempts['dead-worker-test']?.attempt).toBe(1);
  });

  it('probe recovery checks finds #522 and #194 surfaces', () => {
    const checks = probeRecoveryChecks(repoRoot);
    expect(checks.workerRecoveryAvailable).toBe(true);
    expect(checks.branchSafeRecoveryAvailable).toBe(true);
  });

  it('resolves retry bounds from autonomous respawn policy JSON', () => {
    const resolved = resolveDeadWorkerBounds({
      version: AUTONOMOUS_RESPAWN_POLICY_VERSION,
      allowReconcileDeadWorkerRespawn: false,
      maxAttempts: 3,
      backoffMs: 120000,
      concurrency: 1,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.bounds?.backoffMs).toBe(120000);
  });

  it('requires adopted orchestratorRules before allowing runtime policy', () => {
    const denied = evaluateDeadWorkerRuntimeAdoption({ orchestratorRules: '' });
    expect(denied.ok).toBe(false);
    expect(denied.effectiveRuntimePolicy).toBe('deny');

    const exampleRules = readFileSync(join(repoRoot, 'agent-orchestrator.yaml.example'), 'utf8');
    const adopted = evaluateDeadWorkerRuntimeAdoption({ orchestratorRules: exampleRules });
    expect(adopted.ok).toBe(true);
    expect(adopted.effectiveRuntimePolicy).toBe('allow');
  });

  it('audit-only when runtime policy is not adopted even with toggle enabled', () => {
    const fixture = readCapture('recoverable-crash.raw.json');
    const plan = planDeadWorkerReconcile({
      sessions: [fixture.session],
      aoEvents: fixture.events,
      respawnPolicy: { version: AUTONOMOUS_RESPAWN_POLICY_VERSION, allowReconcileDeadWorkerRespawn: true },
      recoveryChecks: { workerRecoveryAvailable: true, branchSafeRecoveryAvailable: true },
      effectiveRuntimePolicy: 'deny',
      tracking: { attempts: {}, leases: {}, audit: [] },
      nowMs: 1_780_000_105_500,
    });
    expect(plan.actions.every((a: { type: string }) => a.type !== 'attempt_started')).toBe(true);
    expect(plan.gates.reason).toBe('runtime_policy_not_allow');
  });

  it('invokes recovery script with spaces in worktree path via Linux pwsh', () => {
    const fixturePath = join(fixturesDir, 'recoverable-crash-tick.json');
    const statePath = join(repoRoot, '.ao-test-dead-worker-state.json');
    const output = execFileSync(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        join(repoRoot, 'scripts/dead-worker-reconcile.ps1'),
        '-Once',
        '-DryRun',
        '-FixturePath',
        fixturePath,
        '-StateFile',
        statePath,
      ],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, AO_DEAD_WORKER_RECONCILE_STATE: statePath } },
    );
    expect(output).toMatch(/dead-worker-reconcile/);
    expect(output).toMatch(/attempt_started|dry-run|recoverable/i);
  });

  it('audit-only when enablement gate fails even for recoverable death', () => {
    const fixture = readCapture('recoverable-crash.raw.json');
    const plan = planDeadWorkerReconcile({
      sessions: [fixture.session],
      aoEvents: fixture.events,
      respawnPolicy: { version: AUTONOMOUS_RESPAWN_POLICY_VERSION, allowReconcileDeadWorkerRespawn: false },
      recoveryChecks: { workerRecoveryAvailable: true, branchSafeRecoveryAvailable: true },
      effectiveRuntimePolicy: 'allow',
      bounds: { maxAttempts: 3, backoffMs: 60000, concurrency: 1 },
      tracking: { attempts: {}, leases: {}, audit: [] },
      nowMs: 1_780_000_105_500,
    });
    expect(plan.actions.every((a: { type: string }) => a.type !== 'attempt_started')).toBe(true);
    expect(plan.actions.some((a: { type: string }) => a.type === 'audit_only')).toBe(true);
  });

  it('interval gate defaults to one minute', () => {
    const gate = evaluateDeadWorkerInterval({ nowMs: 120_000, lastTickMs: 0, intervalMs: 60_000 });
    expect(gate.ok).toBe(true);
    expect(gate.intervalMs).toBe(60_000);
  });

  it('classifier version is exported', () => {
    expect(DEAD_WORKER_RECONCILER_VERSION).toMatch(/dead-worker-reconciler/);
  });
});
