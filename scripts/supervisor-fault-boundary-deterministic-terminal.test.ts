import { describe, expect, it } from 'vitest';
import {
  supervisorTestTimeoutMs,
  isAlive,
  makeStateDir,
  runSupervisor,
  startSupervisorBackground,
  waitForSupervisorLogMatch,
  stopSupervisorChild,
  assertTerminalHeartbeatStopped,
} from './supervisor-fault-boundary.shared.js';

describe.sequential('supervisor deterministic terminal (Issue #450 C7)', () => {
  it('enters terminal degraded for deterministic defects while supervisor keeps running', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-deterministic-terminal'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_heartbeat: 'deterministic-defect',
        AO_WAKE_SUPERVISOR_TEST_FAILURE_CLASS_heartbeat: 'deterministic',
        AO_WAKE_SUPERVISOR_DEGRADED_DETERMINISTIC_TERMINAL_ATTEMPTS: '1',
        AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '1',
        AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF: '1',
      },
    );

    await waitForSupervisorLogMatch(
      stateDir,
      /heartbeat terminal degraded: deterministic defect/,
      25_000,
    );

    const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(status.stdout).toContain('supervisor: running');
    await assertTerminalHeartbeatStopped(stateDir);

    await stopSupervisorChild(child, stateDir);
  }, supervisorTestTimeoutMs);

  it('enters terminal degraded from progress failureClass without test env override', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-deterministic-progress'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_heartbeat: 'deterministic-defect',
        AO_WAKE_SUPERVISOR_DEGRADED_DETERMINISTIC_TERMINAL_ATTEMPTS: '1',
        AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '1',
        AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF: '1',
      },
    );

    await waitForSupervisorLogMatch(
      stateDir,
      /heartbeat terminal degraded: deterministic defect/,
      25_000,
    );

    await stopSupervisorChild(child, stateDir);
  }, supervisorTestTimeoutMs);
});
