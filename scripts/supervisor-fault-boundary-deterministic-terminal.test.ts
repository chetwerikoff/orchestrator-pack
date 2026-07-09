import { describe, expect, it } from 'vitest';
import {
  isAlive,
  makeStateDir,
  runSupervisor,
  startSupervisorBackground,
  waitForMarker,
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
        AO_WAKE_SUPERVISOR_DEGRADED_DETERMINISTIC_TERMINAL_ATTEMPTS: '2',
        AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '1',
        AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF: '1',
        AO_WAKE_SUPERVISOR_TEST_STALL_SECONDS_heartbeat: '2',
        AO_WAKE_SUPERVISOR_RESTART_STAGGER_MS: '0',
      },
    );

    await waitForMarker(stateDir, 'heartbeat', 25_000);
    await waitForSupervisorLogMatch(
      stateDir,
      /heartbeat terminal degraded: deterministic defect/,
      180_000,
    );

    let statusText = '';
    const statusDeadline = Date.now() + 30_000;
    while (Date.now() < statusDeadline) {
      const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      statusText = `${status.stdout ?? ''}${status.stderr ?? ''}`;
      if (/supervisor: running/i.test(statusText)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(statusText).toMatch(/supervisor: running/i);
    await assertTerminalHeartbeatStopped(stateDir);

    await stopSupervisorChild(child, stateDir);
  }, 300_000);

  it('enters terminal degraded from progress failureClass without test env override', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-deterministic-progress'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_heartbeat: 'deterministic-defect',
        AO_WAKE_SUPERVISOR_DEGRADED_DETERMINISTIC_TERMINAL_ATTEMPTS: '2',
        AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '1',
        AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF: '1',
        AO_WAKE_SUPERVISOR_TEST_STALL_SECONDS_heartbeat: '2',
        AO_WAKE_SUPERVISOR_RESTART_STAGGER_MS: '0',
      },
    );

    await waitForMarker(stateDir, 'heartbeat', 25_000);
    await waitForSupervisorLogMatch(
      stateDir,
      /heartbeat terminal degraded: deterministic defect/,
      180_000,
    );

    await stopSupervisorChild(child, stateDir);
  }, 300_000);
});
