import fs from 'node:fs';
import { expect } from 'vitest';
import { supervisorTestTimeoutMs } from './supervisor-recovery.test-setup.js';

export { supervisorTestTimeoutMs };

export {
  countLogMatches,
  isAlive,
  makeStateDir,
  readChildRecovery,
  readChildPid,
  readSupervisorLog,
  runSupervisor,
  startSupervisorBackground,
  waitForMarker,
  waitForSupervisorLogMatch,
} from './supervisor-recovery.test-helpers.js';

import {
  isAlive,
  makeStateDir,
  readChildPid,
  readChildRecovery,
  runSupervisor,
  startSupervisorBackground,
  waitForMarker,
  waitForSupervisorLogMatch,
} from './supervisor-recovery.test-helpers.js';

export async function runFaultBoundaryInjectionCase(inject: string): Promise<void> {
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
  const supervisorLog = await waitForSupervisorLogMatch(
    stateDir,
    /fault boundary: heartbeat:/,
    25_000,
  );

  const supervisorPid = Number(fs.readFileSync(`${stateDir}/supervisor.pid`, 'utf8').trim());
  expect(isAlive(supervisorPid)).toBe(true);
  expect(supervisorLog).toMatch(/fault boundary: heartbeat:/);

  const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
  expect(status.stdout).toContain('supervisor: running');

  await stopSupervisorChild(child, stateDir);
}

export async function stopSupervisorChild(
  child: { kill: (signal: NodeJS.Signals) => void },
  stateDir: string,
): Promise<void> {
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
}

export async function assertTerminalHeartbeatStopped(stateDir: string): Promise<void> {
  const heartbeatRecovery = readChildRecovery(stateDir, 'heartbeat');
  expect(heartbeatRecovery.terminal).toBe(true);
  try {
    const heartbeatPid = readChildPid(stateDir, 'heartbeat');
    expect(isAlive(heartbeatPid)).toBe(false);
  } catch {
    // pid file removed after terminal stop is acceptable
  }
}
