import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AUTONOMOUS_RESPAWN_POLICY_VERSION,
  DEAD_WORKER_RECONCILER_VERSION,
  DEFAULT_DEAD_WORKER_BACKOFF_MS,
  DEFAULT_DEAD_WORKER_MAX_ATTEMPTS,
  buildDeadWorkerReconcileKey,
  classifyWorkerDeathEvidence,
  discoverAbsentSessions,
  parseIssueNumberFromWorkerBranch,
  classifyWorkerLivenessEvidence,
  commitDeadWorkerAction,
  evaluateDeadWorkerInterval,
  evaluateDeadWorkerRuntimeAdoption,
  expireStaleAttemptLeases,
  loadAutonomousRespawnPolicy,
  planDeadWorkerReconcile,
  probeRecoveryChecks,
  resolveAttemptLeaseTtlMs,
  resolveDeadWorkerBounds,
  classifyDeadWorkerRecoveryInvokeResult,
  parseAndClassifyDeadWorkerRecoveryOutput,
  resolveIssueOnlyPrLookup,
  issueLinkedTerminalPrs,
  isAoWorkerIterationBranch,
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

function compatibleWorkerStatusRow(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    schemaVersion: 1,
    producerCapability: 'pack-worker-status-store/v1',
    writerEpochObserved: true,
    lifecycleState: 'terminated',
    heartbeatTimestampMs: 1_780_000_105_500 - (16 * 60 * 1000),
    freshnessMs: 15 * 60 * 1000,
    generationToken: `${sessionId}-gen`,
    lastUpdatedMs: 1_780_000_105_500,
    ...overrides,
  };
}

function actualWorkerStatusStoreRow(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    schemaVersion: 1,
    status: 'dead',
    derivedStatus: 'dead',
    winningSource: 'os_liveness',
    diagnostics: [],
    lastUpdatedMs: 1_780_000_105_500 - (16 * 60 * 1000),
    freshnessMs: 15 * 60 * 1000,
    freshnessBoundMs: 15 * 60 * 1000,
    generationVector: { repoTickGeneration: 1, reportStoreGeneration: 1, journalCursor: 1, bindingCacheGeneration: 1 },
    sourceGeneration: { repoTickGeneration: 1, reportStoreGeneration: 1, journalCursor: 1, bindingCacheGeneration: 1 },
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

    const spawnNew = resolveRecoveryRoute(session, evidence, { openPrs: [], terminalPrs: [] });
    expect(spawnNew.ok).toBe(true);
    expect(spawnNew.spawnAction).toBe('spawn-new');

    const terminalBlocked = resolveRecoveryRoute(session, evidence, {
      openPrs: [],
      terminalPrs: [{ number: 604, headRefName: 'feat/593', state: 'MERGED' }],
    });
    expect(terminalBlocked.ok).toBe(false);
    expect(terminalBlocked.reason).toBe('terminal_pr_state');

    const terminalAmbiguous = resolveRecoveryRoute(session, evidence, {
      openPrs: [],
      terminalPrs: [
        { number: 604, headRefName: 'feat/593', state: 'MERGED' },
        { number: 605, headRefName: 'feat/issue-593', state: 'CLOSED' },
      ],
    });
    expect(terminalAmbiguous.ok).toBe(false);
    expect(terminalAmbiguous.reason).toBe('issue_only_pr_ambiguity');
    expect(issueLinkedTerminalPrs(593, [
      { number: 604, headRefName: 'feat/593', state: 'MERGED' },
    ], session)).toHaveLength(1);

    const iterationSession = { name: 'opk-143', issue: 593, branch: 'opk-143', worktree: '/wt' };
    const claimIteration = resolveRecoveryRoute(iterationSession, evidence, {
      openPrs: [{ number: 605, headRefName: 'opk-143' }],
      terminalPrs: [],
    });
    expect(isAoWorkerIterationBranch('opk-143')).toBe(true);
    expect(claimIteration.ok).toBe(true);
    expect(claimIteration.spawnAction).toBe('claim-pr-resume');
    expect(claimIteration.prNumber).toBe(605);

    const staleBranchSession = { name: 'opk-593', issue: 593, branch: 'feat/999-stale', worktree: '/wt' };
    const unrelatedPr = resolveRecoveryRoute(staleBranchSession, evidence, {
      openPrs: [{ number: 999, headRefName: 'feat/999-stale' }],
      terminalPrs: [],
    });
    expect(unrelatedPr.ok).toBe(true);
    expect(unrelatedPr.spawnAction).toBe('spawn-new');
    expect(unrelatedPr.prNumber).toBe(0);

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

  it('classifies worker recovery child JSON before recording recovered', () => {
    const recovered = classifyDeadWorkerRecoveryInvokeResult({
      ok: true,
      outcome: 'removed_terminated_session',
      spawn: 'spawn_started',
    });
    expect(recovered.deadWorkerOutcome).toBe('recovered');

    const claimLost = classifyDeadWorkerRecoveryInvokeResult({
      ok: true,
      outcome: 'claim_lost',
      reason: 'holder_mismatch',
    });
    expect(claimLost.deadWorkerOutcome).toBe('suppressed');
    expect(claimLost.reason).toBe('claim_lost');

    const noOp = classifyDeadWorkerRecoveryInvokeResult({ ok: true, outcome: 'no_op', reason: 'backoff_not_elapsed' });
    expect(noOp.deadWorkerOutcome).toBe('suppressed');

    const parsed = parseAndClassifyDeadWorkerRecoveryOutput(
      'noise\n{"ok":true,"outcome":"claim_lost","spawn":"not_attempted"}',
    );
    expect(parsed.deadWorkerOutcome).toBe('suppressed');

    const nested = JSON.stringify({
      ok: true,
      outcome: 'removed_terminated_session',
      spawn: 'spawn_started',
      audit: { finalState: 'removed_terminated_session', schemaVersion: 'worker-recovery/v1' },
      branch: { ok: true, reason: 'not_attempted' },
    });
    const nestedParsed = parseAndClassifyDeadWorkerRecoveryOutput(`worker-recovery log\n${nested}`);
    expect(nestedParsed.deadWorkerOutcome).toBe('recovered');
    expect(nestedParsed.reason).toBe('spawn_started');
  });

  it('does not treat claim_lost as already recovered on a later tick', () => {
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
        type: 'suppressed',
        outcome: 'suppressed',
        reason: 'claim_lost',
      },
      1_780_000_106_000,
    );
    const plan = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [fixture.session],
      aoEvents: fixture.events,
      tracking,
      nowMs: 1_780_000_200_000,
    }));
    expect(plan.actions.some((a: { type: string }) => a.type === 'attempt_started')).toBe(true);
    expect(plan.actions.some((a: { reason?: string }) => a.reason === 'already_recovered')).toBe(false);
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

  it('completes a live-shaped tick when terminal PR JSON is prefixed before JSON payload', () => {
    const tempDir = mkdtempSync(join(repoRoot, '.tmp-dead-worker-live-'));
    const statePath = join(tempDir, 'dead-worker-state.json');
    const livePayloadPath = join(tempDir, 'live-payload.json');
    const openPrsPath = join(tempDir, 'open-prs.json');
    const mergedRawPath = join(tempDir, 'merged-raw.txt');
    const closedRawPath = join(tempDir, 'closed-raw.txt');
    const policyPath = join(tempDir, 'respawn-policy.json');
    writeFileSync(openPrsPath, '[]');
    writeFileSync(mergedRawPath, '[notifier] prefixed terminal list\n[]\n');
    writeFileSync(closedRawPath, '[notifier] prefixed terminal list\n[]\n');
    writeFileSync(policyPath, JSON.stringify({
      version: AUTONOMOUS_RESPAWN_POLICY_VERSION,
      allowReconcileDeadWorkerRespawn: true,
    }));
    writeFileSync(livePayloadPath, JSON.stringify({
      sessions: [{
        sessionId: 'opk-live-prefixed',
        issueNumber: 688,
        prNumber: 688,
        status: 'terminated',
        worktree: '/tmp/opk-live-prefixed',
      }],
      workerStatusStore: {
        schemaVersion: 1,
        records: {
          'opk-live-prefixed': compatibleWorkerStatusRow('opk-live-prefixed'),
        },
      },
      livenessContext: {
        osLiveness: { 'opk-live-prefixed': 'pane-gone' },
        sanctionedKillSurface: { healthy: true, records: [] },
      },
    }));

    const output = execFileSync(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        join(repoRoot, 'scripts/dead-worker-reconcile.ps1'),
        '-Once',
        '-DryRun',
        '-StateFile',
        statePath,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AO_DEAD_WORKER_LIVE_PAYLOAD_FIXTURE: livePayloadPath,
          AO_DEAD_WORKER_OPEN_PRS_FIXTURE: openPrsPath,
          AO_DEAD_WORKER_GH_MERGED_RAW_FIXTURE: mergedRawPath,
          AO_DEAD_WORKER_GH_CLOSED_RAW_FIXTURE: closedRawPath,
          AO_DEAD_WORKER_RESPAWN_POLICY_FIXTURE: policyPath,
          AO_DEAD_WORKER_EFFECTIVE_RUNTIME_POLICY: 'allow',
          AO_DEAD_WORKER_RECONCILE_STATE: statePath,
        },
      },
    );

    expect(output).toMatch(/tick complete/);
    expect(output).not.toMatch(/ConvertFrom-Json/);
  });

  it('clears quarantine only when no pending or quarantined actions remain', () => {
    const tempDir = mkdtempSync(join(repoRoot, '.tmp-dead-worker-clear-'));
    const statePath = join(tempDir, 'dead-worker-state.json');
    writeFileSync(statePath, JSON.stringify({
      schemaVersion: 'dead-worker-reconcile/v2',
      attempts: {},
      leases: {},
      audit: [],
      pendingActions: {},
      quarantinedActions: {},
      lastTickMs: null,
      _recovery: { fenceTrusted: false, reason: 'unparseable_no_backup', quarantined: '/tmp/corrupt' },
    }));

    const cleared = JSON.parse(execFileSync(
      'pwsh',
      ['-NoProfile', '-File', join(repoRoot, 'scripts/clear-dead-worker-reconcile-quarantine.ps1'), '-StateFile', statePath],
      { cwd: repoRoot, encoding: 'utf8' },
    ));
    expect(cleared.ok).toBe(true);
    expect(cleared.outcome).toBe('cleared');

    writeFileSync(statePath, JSON.stringify({
      schemaVersion: 'dead-worker-reconcile/v2',
      attempts: {},
      leases: {},
      audit: [],
      pendingActions: { one: { sessionId: 'opk-688' } },
      quarantinedActions: {},
      lastTickMs: null,
      _recovery: { fenceTrusted: false, reason: 'unparseable_no_backup', quarantined: '/tmp/corrupt' },
    }));

    expect(() => execFileSync(
      'pwsh',
      ['-NoProfile', '-File', join(repoRoot, 'scripts/clear-dead-worker-reconcile-quarantine.ps1'), '-StateFile', statePath],
      { cwd: repoRoot, encoding: 'utf8' },
    )).toThrow(/cannot clear dead-worker reconcile quarantine/i);
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


  it('requires issue/PR-bound sanctioned kill records (sessionId-only entries do not suppress)', () => {
    const session = {
      sessionId: 'opk-688-new-session',
      issueNumber: 688,
      status: 'terminated',
    };
    const evidence = classifyWorkerLivenessEvidence(session, {
      osLiveness: { [session.sessionId]: 'pane-gone' },
      sanctionedKillSurface: {
        healthy: true,
        records: [{ sessionId: 'opk-688-old-session', issueNumber: 688, prNumber: 0, killKind: 'manual', timestampMs: 1 }],
      },
    });
    expect(evidence.verdict).toBe('audit_only');
    expect(evidence.reason).toBe('missing_worker_status_row');
  });

  it('does not suppress reused sessionId when kill record issue binding differs', () => {
    const session = {
      sessionId: 'opk-reused',
      issueNumber: 689,
      status: 'terminated',
    };
    const evidence = classifyWorkerLivenessEvidence(session, {
      osLiveness: { [session.sessionId]: 'pane-gone' },
      sanctionedKillSurface: {
        healthy: true,
        records: [{ sessionId: 'opk-reused', issueNumber: 688, prNumber: 0, killKind: 'manual', timestampMs: 1 }],
      },
    });
    expect(evidence.verdict).toBe('audit_only');
    expect(evidence.reason).toBe('missing_worker_status_row');
  });

  it('suppresses when sessionId and issue binding both match', () => {
    const session = {
      sessionId: 'opk-reused',
      issueNumber: 688,
      status: 'terminated',
    };
    const evidence = classifyWorkerLivenessEvidence(session, {
      osLiveness: { [session.sessionId]: 'pane-gone' },
      sanctionedKillSurface: {
        healthy: true,
        records: [{ sessionId: 'opk-reused', issueNumber: 688, prNumber: 0, killKind: 'manual', timestampMs: 1 }],
      },
    });
    expect(evidence.verdict).toBe('suppressed');
    expect(evidence.reason).toBe('sanctioned_kill');
  });

  it('detects AO 0.10 terminated session row plus stale heartbeat and dead OS as pack-owned dead', () => {
    const capture = JSON.parse(readFileSync(join(repoRoot, 'tests/external-output-references/captures/ao-0-10-cli/session-get-terminated.raw.json'), 'utf8'));
    const session = {
      ...capture.session,
      sessionId: capture.session.id,
      issueNumber: Number(capture.session.issueId),
    };
    const evidence = classifyWorkerLivenessEvidence(session, {
      osLiveness: { [session.sessionId]: 'pane-gone' },
      sanctionedKillSurface: { healthy: true, records: [] },
      workerStatusRows: [compatibleWorkerStatusRow(session.sessionId)],
      evaluationNowMs: 1_780_000_105_500,
    });
    expect(evidence.verdict).toBe('dead');
    expect(evidence.reason).toBe('pack_owned_liveness_dead');
  });

  it('classifies the pack-owned liveness decision matrix', () => {
    const cases = [
      { row: compatibleWorkerStatusRow('opk-live-fresh', { heartbeatTimestampMs: 1_780_000_105_500 }), os: 'pane-alive', expected: 'live_or_unknown' },
      { row: compatibleWorkerStatusRow('opk-live-stale'), os: 'pane-alive', expected: 'live_or_unknown' },
      { row: compatibleWorkerStatusRow('opk-dead-fresh', { heartbeatTimestampMs: 1_780_000_105_500 }), os: 'pane-gone', expected: 'live_or_unknown' },
      { row: compatibleWorkerStatusRow('opk-dead-stale'), os: 'pane-gone', expected: 'dead' },
      { row: compatibleWorkerStatusRow('opk-dead-no-generation', { generationToken: '' }), os: 'pane-gone', expected: 'audit_only', reason: 'missing_generation_token' },
      { row: compatibleWorkerStatusRow('opk-dead-missing-heartbeat', { heartbeatTimestampMs: 0 }), os: 'pane-gone', expected: 'audit_only', reason: 'missing_heartbeat_timestamp' },
      { row: compatibleWorkerStatusRow('opk-dead-last-updated-only', { heartbeatTimestampMs: 0, lastUpdatedMs: 1_780_000_105_500 - (16 * 60 * 1000) }), os: 'pane-gone', expected: 'audit_only', reason: 'missing_heartbeat_timestamp' },
      { row: null, os: 'pane-gone', sessionId: 'opk-missing-row', expected: 'audit_only', reason: 'missing_worker_status_row' },
      { row: compatibleWorkerStatusRow('opk-os-unknown'), os: 'unknown', expected: 'audit_only', reason: 'os_liveness_unknown' },
      { row: compatibleWorkerStatusRow('opk-row-unknown', { rowValidity: 'unknown' }), os: 'pane-gone', expected: 'audit_only', reason: 'unknown_row_validity' },
      { row: compatibleWorkerStatusRow('opk-lifecycle', { lifecycleState: 'active' }), os: 'pane-gone', expected: 'audit_only', reason: 'ineligible_lifecycle_state' },
      { row: compatibleWorkerStatusRow('opk-epoch', { abandonedProducerEpoch: true }), os: 'pane-gone', expected: 'audit_only', reason: 'abandoned_producer_epoch' },
      { row: compatibleWorkerStatusRow('opk-schema', { schemaVersion: 999 }), os: 'pane-gone', expected: 'audit_only', reason: 'unsupported_worker_status_schema' },
      { row: compatibleWorkerStatusRow('opk-capability', { producerCapability: 'future-capability/v2' }), os: 'pane-gone', expected: 'audit_only', reason: 'unsupported_worker_status_producer' },
    ] as const;

    for (const testCase of cases) {
      const sessionId = 'sessionId' in testCase
        ? testCase.sessionId
        : (testCase.row?.sessionId ?? 'opk-test');
      const evidence = classifyWorkerLivenessEvidence(
        { sessionId, issueNumber: 688, status: 'terminated' },
        {
          osLiveness: { [sessionId]: testCase.os },
          sanctionedKillSurface: { healthy: true, records: [] },
          workerStatusRows: testCase.row ? [testCase.row] : [],
          evaluationNowMs: 1_780_000_105_500,
        },
      );
      expect(evidence.verdict, sessionId).toBe(testCase.expected);
      if ('reason' in testCase) {
        expect(evidence.reason, sessionId).toBe(testCase.reason);
      }
    }

    const conflicting = classifyWorkerLivenessEvidence(
      { sessionId: 'opk-conflict', issueNumber: 688, status: 'terminated' },
      {
        osLiveness: { 'opk-conflict': 'pane-gone' },
        sanctionedKillSurface: { healthy: true, records: [] },
        workerStatusRows: [
          compatibleWorkerStatusRow('opk-conflict', { heartbeatTimestampMs: 1_780_000_105_500 }),
          compatibleWorkerStatusRow('opk-conflict', { heartbeatTimestampMs: 1_780_000_105_500 - (16 * 60 * 1000) }),
        ],
        evaluationNowMs: 1_780_000_105_500,
      },
    );
    expect(conflicting.verdict).toBe('audit_only');
    expect(conflicting.reason).toBe('conflicting_duplicate_rows');
  });

  it('accepts the canonical worker-status store row shape without explicit producerCapability', () => {
    const session = {
      sessionId: 'opk-store-shape',
      status: 'terminated',
    };
    const evidence = classifyWorkerLivenessEvidence(session, {
      osLiveness: { [session.sessionId]: 'pane-gone' },
      sanctionedKillSurface: { healthy: true, records: [] },
      workerStatusStore: {
        schemaVersion: 1,
        records: {
          [session.sessionId]: actualWorkerStatusStoreRow(session.sessionId, {
            heartbeatTimestampMs: 1_780_000_105_500 - (16 * 60 * 1000),
          }),
        },
      },
      evaluationNowMs: 1_780_000_105_500,
    });
    expect(evidence.verdict).toBe('dead');
    expect(evidence.reason).toBe('pack_owned_liveness_dead');
    expect(evidence.evidence).toBeDefined();
    expect(evidence.evidence?.generationToken).toBe(
      '{"bindingCacheGeneration":1,"journalCursor":1,"reportStoreGeneration":1,"repoTickGeneration":1}',
    );
  });

  it('uses livenessContext for absent sessions and escalates unreadable kill record surface as audit-only', () => {
    const plan = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [],
      absentSessions: [{ sessionId: 'opk-688-absent', issueNumber: 688, status: 'absent' }],
      livenessContext: {
        osLiveness: { 'opk-688-absent': 'pane-gone' },
        sanctionedKillSurface: { healthy: true, records: [] },
        workerStatusRows: [compatibleWorkerStatusRow('opk-688-absent')],
        evaluationNowMs: 1_780_000_105_500,
      },
    }));
    expect(plan.actions.some((a) => a.type === 'attempt_started' && a.sessionId === 'opk-688-absent')).toBe(true);

    const unreadable = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [{ sessionId: 'opk-688-unreadable', issueNumber: 688, status: 'terminated' }],
      livenessContext: {
        osLiveness: { 'opk-688-unreadable': 'pane-gone' },
        sanctionedKillSurface: { healthy: false, reason: 'sanctioned_kill_record_unreadable' },
        workerStatusRows: [compatibleWorkerStatusRow('opk-688-unreadable')],
      },
    }));
    expect(unreadable.actions[0]?.type).toBe('audit_only');
    expect(unreadable.actions[0]?.escalate).toBe(true);

    const absentSurface = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [{ sessionId: 'opk-688-absent-surface', issueNumber: 688, status: 'terminated' }],
      livenessContext: {
        osLiveness: { 'opk-688-absent-surface': 'pane-gone' },
        sanctionedKillSurface: { healthy: false, reason: 'sanctioned_kill_record_surface_absent' },
        workerStatusRows: [compatibleWorkerStatusRow('opk-688-absent-surface')],
      },
    }));
    expect(absentSurface.actions[0]?.type).toBe('audit_only');
    expect(absentSurface.actions[0]?.escalate).toBe(true);
  });

  it('interval gate defaults to one minute', () => {
    const gate = evaluateDeadWorkerInterval({ nowMs: 120_000, lastTickMs: 0, intervalMs: 60_000 });
    expect(gate.ok).toBe(true);
    expect(gate.intervalMs).toBe(60_000);
  });

  it('classifier version is exported', () => {
    expect(DEAD_WORKER_RECONCILER_VERSION).toMatch(/dead-worker-reconciler/);
  });

  it('passes the validated generation token into the recovery invoke', () => {
    const reconcileText = readFileSync(
      join(repoRoot, 'scripts/dead-worker-reconcile.ps1'),
      'utf8',
    );
    const invokeText = readFileSync(
      join(repoRoot, 'scripts/invoke-worker-recovery.ps1'),
      'utf8',
    );
    expect(reconcileText).toMatch(/'-GenerationToken', \[string\]\$Action\.generationToken/);
    expect(invokeText).toMatch(/\[string\]\$GenerationToken = ''/);
    expect(invokeText).toMatch(/GenerationToken = \$GenerationToken/);
  });

  it('discovers assigned workers absent from ao session ls via worktree and audit candidates', () => {
    const absentSessions = discoverAbsentSessions({
      sessions: [{ sessionId: 'orchestrator-pack-7', issueNumber: 619, status: 'active' }],
      worktreeRecords: [{
        sessionId: 'opk-688-absent-live',
        worktree: '/home/test/.agent-orchestrator/projects/orchestrator-pack/worktrees/opk-688-absent-live',
        branch: 'refs/heads/feat/issue-688-ao-010-event-consumer-rebind',
      }],
      auditCandidates: [{ sessionId: 'opk-688-audit-only', issueNumber: 688 }],
    });
    expect(absentSessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'opk-688-absent-live', issueNumber: 688, status: 'absent' }),
      expect.objectContaining({ sessionId: 'opk-688-audit-only', issueNumber: 688, status: 'absent' }),
    ]));
    expect(absentSessions.find((row) => row.sessionId === 'orchestrator-pack-7')).toBeUndefined();
  });

  it('parses issue numbers from production worker branch shapes', () => {
    expect(parseIssueNumberFromWorkerBranch('refs/heads/feat/issue-688-ao-010-event-consumer-rebind')).toBe(688);
    expect(parseIssueNumberFromWorkerBranch('feat/593')).toBe(593);
    expect(parseIssueNumberFromWorkerBranch('opk-522')).toBe(522);
  });

  it('live dead-worker reconcile populates absentSessions from discovery helpers', () => {
    const src = readFileSync(join(repoRoot, 'scripts/dead-worker-reconcile.ps1'), 'utf8');
    expect(src).toMatch(/function Get-DeadWorkerAbsentSessions/);
    expect(src).toMatch(/discover-absent-sessions/);
    expect(src).toMatch(/absentSessions = @\(\$absentSessions\)/);
    expect(src).toMatch(/Get-DeadWorkerLivenessContext -Sessions \$livenessProbeSessions/);
    expect(src).not.toMatch(/Get-AoEventsSince/);
    expect(src).not.toMatch(/aoEvents =/);
  });

  it('pre-kill revalidation accepts attempt_started actions for absent sessions', () => {
    const tempDir = mkdtempSync(join(repoRoot, '.tmp-dead-worker-live-'));
    const livePayloadPath = join(tempDir, 'live-payload.json');
    const actionPath = join(tempDir, 'action.json');
    const bootstrapPath = join(repoRoot, 'scripts', `.tmp-dead-worker-prekill-${Date.now()}.ps1`);
    const absentSession = { sessionId: 'opk-688-absent-prekill', issueNumber: 688, status: 'absent' };
    const plan = planDeadWorkerReconcile(enabledPlanInput({
      sessions: [],
      absentSessions: [absentSession],
      livenessContext: {
        osLiveness: { [absentSession.sessionId]: 'pane-gone' },
        sanctionedKillSurface: { healthy: true, records: [] },
        workerStatusRows: [compatibleWorkerStatusRow(absentSession.sessionId)],
        evaluationNowMs: 1_780_000_105_500,
      },
    }));
    const action = plan.actions.find((candidate) => candidate.type === 'attempt_started' && candidate.sessionId === absentSession.sessionId);
    expect(action).toBeTruthy();
    writeFileSync(actionPath, JSON.stringify(action));
    const reconcileSource = readFileSync(join(repoRoot, 'scripts/dead-worker-reconcile.ps1'), 'utf8');
    writeFileSync(
      bootstrapPath,
      [
        reconcileSource.replace(/\$intervalMs =[\s\S]*$/, ''),
        `$env:AO_DEAD_WORKER_LIVE_PAYLOAD_FIXTURE = '${livePayloadPath.replace(/'/g, "''")}'`,
        `$action = Get-Content -LiteralPath '${actionPath.replace(/'/g, "''")}' -Raw | ConvertFrom-Json`,
        '$result = Test-DeadWorkerPreKillRevalidation -Action $action',
        '$result | ConvertTo-Json -Depth 10 -Compress',
      ].join('\n'),
    );
    writeFileSync(livePayloadPath, JSON.stringify({
      sessions: [],
      absentSessions: [absentSession],
      workerStatusStore: {
        schemaVersion: 1,
        records: {
          [absentSession.sessionId]: compatibleWorkerStatusRow(absentSession.sessionId),
        },
      },
      livenessContext: {
        osLiveness: { [absentSession.sessionId]: 'pane-gone' },
        sanctionedKillSurface: { healthy: true, records: [] },
      },
    }));
    try {
      const output = execFileSync(
        'pwsh',
        ['-NoProfile', '-File', bootstrapPath],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      const result = JSON.parse(output);
      expect(result.ok).toBe(true);
      expect(result.session.sessionId).toBe(absentSession.sessionId);
    } finally {
      rmSync(bootstrapPath, { force: true });
    }
  });
});
