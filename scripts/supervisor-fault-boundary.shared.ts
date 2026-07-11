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
  stopSupervisorChild,
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
  stopSupervisorChild,
  waitForCondition,
  waitForMarker,
  waitForSupervisorLogMatch,
} from './supervisor-recovery.test-helpers.js';

export async function runFaultBoundaryInjectionCase(inject: string): Promise<void> {
  const stateDir = makeStateDir();
  const child = startSupervisorBackground(
    stateDir,
    ['-OrchestratorSessionId', 'op-fault-boundary'],
    {
      AO_WAKE_SUPERVISOR_TEST_MODE_escalation_router: 'tick-error',
      AO_WAKE_SUPERVISOR_TEST_INJECT_FAULT_escalation_router: inject,
      AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '3',
    },
  );

  await waitForMarker(stateDir, 'escalation-router', 25_000);
  const supervisorLog = await waitForSupervisorLogMatch(
    stateDir,
    /fault boundary: escalation-router:/,
    25_000,
  );

  const supervisorPid = Number(fs.readFileSync(`${stateDir}/supervisor.pid`, 'utf8').trim());
  expect(isAlive(supervisorPid)).toBe(true);
  expect(supervisorLog).toMatch(/fault boundary: escalation-router:/);

  const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
  expect(status.stdout).toContain('supervisor: running');

  await stopSupervisorChild(child, stateDir);
}

export async function assertTerminalEscalationRouterStopped(stateDir: string): Promise<void> {
  await waitForCondition(
    async () => readChildRecovery(stateDir, 'escalation-router').terminal === true,
    25_000,
    undefined,
    'escalation-router child recovery terminal',
  );
  try {
    const routerPid = readChildPid(stateDir, 'escalation-router');
    expect(isAlive(routerPid)).toBe(false);
  } catch {
    // pid file removed after terminal stop is acceptable
  }
}
