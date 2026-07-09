import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  supervisorTestTimeoutMs,
  countLogMatches,
  isAlive,
  makeStateDir,
  readSupervisorLog,
  runSupervisor,
  startSupervisorBackground,
  waitForMarker,
  waitForSupervisorLogMatch,
  stopSupervisorChild,
  assertTerminalHeartbeatStopped,
  readChildRecovery,
} from './supervisor-fault-boundary.shared.js';

describe.sequential('supervisor-fault-boundary escalate (Issue #450 C5)', () => {
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
    await assertTerminalHeartbeatStopped(stateDir);

    await stopSupervisorChild(child, stateDir);
  }, supervisorTestTimeoutMs);
});
