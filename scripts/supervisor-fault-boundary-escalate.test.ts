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
  assertTerminalEscalationRouterStopped,
} from './supervisor-fault-boundary.shared.js';

describe.sequential('supervisor-fault-boundary escalate (Issue #450 C5)', () => {
  it('escalates a deterministically-throwing child to terminal while supervisor and siblings survive', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-fault-boundary-escalate'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_escalation_router: 'tick-error',
        AO_WAKE_SUPERVISOR_TEST_INJECT_FAULT_escalation_router: 'status-entry',
        AO_WAKE_SUPERVISOR_DEGRADED_DETERMINISTIC_TERMINAL_ATTEMPTS: '2',
        AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '2',
        AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF: '1',
      },
    );

    await waitForMarker(stateDir, 'escalation-router', 25_000);
    await waitForMarker(stateDir, 'listener', 25_000);
    await waitForSupervisorLogMatch(
      stateDir,
      /escalation-router terminal degraded: deterministic defect/,
      25_000,
    );

    const supervisorPid = Number(fs.readFileSync(`${stateDir}/supervisor.pid`, 'utf8').trim());
    expect(isAlive(supervisorPid)).toBe(true);

    const supervisorLog = readSupervisorLog(stateDir);
    expect(countLogMatches(supervisorLog, /fault boundary: escalation-router:/)).toBeGreaterThan(0);
    expect(countLogMatches(supervisorLog, /escalation-router recovering \(degraded attempt/)).toBe(
      0,
    );

    const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(status.stdout).toContain('supervisor: running');
    await assertTerminalEscalationRouterStopped(stateDir);

    await stopSupervisorChild(child, stateDir);
  }, supervisorTestTimeoutMs);
});
