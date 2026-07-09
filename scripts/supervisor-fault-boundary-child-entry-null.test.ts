import { supervisorTestTimeoutMs } from './supervisor-recovery.test-setup.js';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
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

describe.sequential('supervisor-fault-boundary (Issue #450 C5)', () => {
  it('keeps supervisor alive after ChildEntry null binding', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-fault-boundary'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_heartbeat: 'tick-error',
        AO_WAKE_SUPERVISOR_TEST_INJECT_FAULT_heartbeat: 'child-entry-null',
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

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, supervisorTestTimeoutMs);
});
