import { supervisorTestTimeoutMs } from './supervisor-recovery.test-setup.js';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  countLogMatches,
  isAlive,
  makeStateDir,
  readChildRecovery,
  readSupervisorLog,
  runSupervisor,
  startSupervisorBackground,
  waitForMarker,
  waitForSupervisorLogMatch,
} from './supervisor-recovery.test-helpers.js';

describe.sequential('supervisor-fault-boundary (Issue #450 C5)', () => {
  for (const [label, inject] of [
    ['redirect ObjectDisposedException', 'redirect-disposed'],
    ['ChildEntry null binding', 'child-entry-null'],
    ['status-entry fault', 'status-entry'],
    ['recovery-stop fault', 'recovery-stop'],
  ] as const) {
    it(`keeps supervisor alive after ${label}`, async () => {
      const stateDir = makeStateDir();
      const child = startSupervisorBackground(
        stateDir,
        ['-OrchestratorSessionId', 'op-fault-boundary'],
        {
          AO_WAKE_SUPERVISOR_TEST_MODE_heartbeat: 'tick-error',
          AO_WAKE_SUPERVISOR_TEST_INJECT_FAULT_heartbeat: inject,
          AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '3',
        },
      );

      await waitForMarker(stateDir, 'heartbeat', 25_000);
      await new Promise((resolve) => setTimeout(resolve, 6000));

      const supervisorPid = Number(fs.readFileSync(`${stateDir}/supervisor.pid`, 'utf8').trim());
      expect(isAlive(supervisorPid)).toBe(true);

      const supervisorLog = readSupervisorLog(stateDir);
      expect(supervisorLog).toMatch(/fault boundary: heartbeat:/);

      const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(status.stdout).toContain('supervisor: running');

      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    }, supervisorTestTimeoutMs);
  }

  it('escalates a deterministically-throwing child to terminal while supervisor and siblings survive', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-fault-boundary-escalate'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_heartbeat: 'tick-error',
        AO_WAKE_SUPERVISOR_TEST_INJECT_FAULT_heartbeat: 'status-entry',
        AO_WAKE_SUPERVISOR_DEGRADED_DETERMINISTIC_TERMINAL_ATTEMPTS: '2',
        AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '2',
        AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF: '1',
      },
    );

    await waitForMarker(stateDir, 'heartbeat', 25_000);
    await waitForMarker(stateDir, 'listener', 25_000);
    await waitForSupervisorLogMatch(
      stateDir,
      /heartbeat terminal degraded: deterministic defect/,
      25_000,
    );

    const supervisorPid = Number(fs.readFileSync(`${stateDir}/supervisor.pid`, 'utf8').trim());
    expect(isAlive(supervisorPid)).toBe(true);

    const supervisorLog = readSupervisorLog(stateDir);
    expect(countLogMatches(supervisorLog, /fault boundary: heartbeat:/)).toBeGreaterThan(0);
    expect(countLogMatches(supervisorLog, /heartbeat recovering \(degraded attempt/)).toBe(0);

    const heartbeatRecovery = readChildRecovery(stateDir, 'heartbeat');
    expect(heartbeatRecovery.terminal).toBe(true);

    const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(status.stdout).toContain('supervisor: running');
    expect(status.stdout).toMatch(/listener:/);

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, supervisorTestTimeoutMs);
});

describe.sequential('supervisor deterministic terminal (Issue #450 C7)', () => {
  it('enters terminal degraded for deterministic defects while supervisor keeps running', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-deterministic-terminal'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_heartbeat: 'deterministic-defect',
        AO_WAKE_SUPERVISOR_TEST_FAILURE_CLASS_heartbeat: 'deterministic',
        AO_WAKE_SUPERVISOR_DEGRADED_DETERMINISTIC_TERMINAL_ATTEMPTS: '2',
        AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '1',
        AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF: '1',
      },
    );

    await waitForMarker(stateDir, 'heartbeat', 25_000);

    const deadline = Date.now() + 20_000;
    let sawTerminal = false;
    while (Date.now() < deadline) {
      const log = readSupervisorLog(stateDir);
      if (/heartbeat terminal degraded: deterministic defect/.test(log)) {
        sawTerminal = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(sawTerminal).toBe(true);

    const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(status.stdout).toContain('supervisor: running');

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, supervisorTestTimeoutMs);
});
