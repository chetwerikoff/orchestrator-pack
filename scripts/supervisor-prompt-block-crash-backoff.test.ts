import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  cleanupSupervisorTests,
  countLogMatches,
  makeStateDir,
  readChildRecovery,
  readMarker,
  readSupervisorLog,
  runSupervisor,
  startSupervisorBackground,
} from './supervisor-recovery.test-helpers.js';

const timeoutMs = 200_000;

afterEach(() => {
  cleanupSupervisorTests();
}, timeoutMs);

describe('supervisor prompt-block crash backoff (#701 cell B)', () => {
  it('prompt-block child without progress reaches crash backoff or circuit breaker', async () => {
    const stateDir = makeStateDir();
    const childRole = 'review-trigger-reconcile' as const;
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-prompt-block-backoff'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_review_trigger_reconcile: 'prompt-block',
        AO_WAKE_SUPERVISOR_TEST_PROMPT_BLOCK_DELAY_MS: '5500',
        AO_WAKE_SUPERVISOR_CRASH_MAX_RAPID_EXITS: '2',
        AO_WAKE_SUPERVISOR_CRASH_TERMINAL_RAPID_EXITS: '5',
        AO_WAKE_SUPERVISOR_CRASH_BASE_BACKOFF_SECONDS: '4',
        AO_WAKE_SUPERVISOR_CRASH_RAPID_EXIT_THRESHOLD_MS: '5000',
      },
    );

    try {
      await readMarker(stateDir, childRole, 20_000);
    } catch {
      // The child may restart quickly between attempts.
    }

    const observedPids = new Set<number>();
    const deadline = Date.now() + 170_000;
    let supervisorLog = '';
    while (Date.now() < deadline) {
      try {
        const marker = await readMarker(stateDir, childRole, 500);
        observedPids.add(marker.pid);
      } catch {
        // child may be between restarts
      }
      supervisorLog = readSupervisorLog(stateDir);
      if (
        /crash backoff: review-trigger-reconcile/.test(supervisorLog) ||
        /crash-loop circuit breaker: review-trigger-reconcile/.test(supervisorLog)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(supervisorLog).toMatch(/crash backoff: review-trigger-reconcile|crash-loop circuit breaker: review-trigger-reconcile/);
    expect(observedPids.size).toBeLessThanOrEqual(6);

    const recovery = readChildRecovery(stateDir, childRole);
    const terminal =
      recovery.terminal === true ||
      Number(recovery.rapidExits ?? 0) >= 2 ||
      countLogMatches(supervisorLog, /crash backoff: review-trigger-reconcile/) > 0;
    expect(terminal).toBe(true);

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, timeoutMs);

  it('records outage-class terminal provenance and preserves the existing outage episode on retrip', async () => {
    const stateDir = makeStateDir();
    const repoRoot = process.cwd();
    const aoStub = path.join(
      repoRoot,
      'scripts',
      'fixtures',
      'orchestrator-wake-supervisor',
      'ao-stub.ps1',
    );
    const healthyFixture = path.join(
      repoRoot,
      'scripts',
      'fixtures',
      'orchestrator-wake-supervisor',
      'status-orchestrator-op-old.json',
    );
    const supervisorLib = path.join(repoRoot, 'scripts', 'lib', 'Orchestrator-SideProcessSupervisor.ps1');
    const scriptPath = path.join(stateDir, 'outage-provenance.ps1');

    const ps = `
      . '${supervisorLib.replace(/'/g, "''")}';
      $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot '${stateDir.replace(/'/g, "''")}';
      Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $paths -ChildId 'review-trigger-reconcile' -RecoveryEntry @{
        terminal = $false
        terminalEpisodeId = 'reconcile-outage-episode-1'
        terminalRearmAttempts = 1
        lastDaemonHealthClass = 'healthy'
      };
      $log = { param([string]$Message) };
      $null = Test-OrchestratorWakeSupervisorChildCrashRestartAllowed -Paths $paths -ChildId 'review-trigger-reconcile' -ChildStartedMs 0 -ChildPid 0 -AoCommand '${aoStub.replace(/'/g, "''")}' -LogWriter $log;
      $decision = Test-OrchestratorWakeSupervisorChildCrashRestartAllowed -Paths $paths -ChildId 'review-trigger-reconcile' -ChildStartedMs 0 -ChildPid 0 -AoCommand '${aoStub.replace(/'/g, "''")}' -LogWriter $log;
      $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $paths -ChildId 'review-trigger-reconcile';
      [pscustomobject]@{
        allowed = [bool]$decision.allowed
        reason = [string]$decision.reason
        terminal = [bool]$recovery.terminal
        terminalDaemonHealthClass = [string]$recovery.terminalDaemonHealthClass
        terminalEpisodeId = [string]$recovery.terminalEpisodeId
        terminalRearmAttempts = [int]$recovery.terminalRearmAttempts
      } | ConvertTo-Json -Compress
    `;
    writeFileSync(scriptPath, ps, 'utf8');
    const result = spawnSync(
      'bash',
      ['-lc', `timeout 20s pwsh -NoProfile -ExecutionPolicy Bypass -File '${scriptPath.replace(/'/g, "'\\''")}'`],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AO_WAKE_SUPERVISOR_FIXTURE: healthyFixture,
          AO_WAKE_SUPERVISOR_STATUS_FAILURE: 'connection-refused',
          AO_WAKE_SUPERVISOR_CRASH_MAX_RAPID_EXITS: '99',
          AO_WAKE_SUPERVISOR_CRASH_TERMINAL_RAPID_EXITS: '2',
          AO_WAKE_SUPERVISOR_CRASH_BASE_BACKOFF_SECONDS: '1',
          AO_WAKE_SUPERVISOR_CRASH_RAPID_EXIT_THRESHOLD_MS: '5000',
        },
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(payload.allowed).toBe(false);
    expect(payload.reason).toBe('circuit_breaker');
    expect(payload.terminal).toBe(true);
    expect(payload.terminalDaemonHealthClass).toBe('unhealthy-confirmed');
    expect(payload.terminalEpisodeId).toBe('reconcile-outage-episode-1');
    expect(payload.terminalRearmAttempts).toBe(1);
  }, timeoutMs);
});
