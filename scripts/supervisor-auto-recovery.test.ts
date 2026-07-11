import { supervisorTestTimeoutMs } from './supervisor-recovery.test-setup.js';
import { describe, expect, it } from 'vitest';
import {
  countLogMatches,
  isAlive,
  makeStateDir,
  readMarker,
  readSupervisorLog,
  runSupervisor,
  startSupervisorBackground,
  waitForMarker,
} from './supervisor-recovery.test-helpers.js';

describe('supervisor-auto-recovery (Issue #450 C3)', () => {
  it('auto-resumes a degraded child after dependency failure clears without operator intervention', async () => {
    const stateDir = makeStateDir();
    const errorUntilMs = String(Date.now() + 6000);
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-auto-recovery'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_escalation_router: 'tick-error',
        AO_WAKE_SUPERVISOR_TEST_ERROR_UNTIL_MS: errorUntilMs,
        AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '2',
        AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF: '1',
        AO_WAKE_SUPERVISOR_DEGRADED_STABLE_WORKING_POLLS: '2',
      },
    );

    await waitForMarker(stateDir, 'escalation-router', 25_000);
    await waitForMarker(stateDir, 'listener', 25_000);

    const listener = await readMarker(stateDir, 'listener');
    expect(isAlive(listener.pid)).toBe(true);

    const deadline = Date.now() + 20_000;
    let recoveringAfterHeal = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const log = readSupervisorLog(stateDir);
      recoveringAfterHeal = countLogMatches(log, /escalation-router recovering \(degraded attempt/g);
      if (Date.now() > Number(errorUntilMs) + 8000) {
        break;
      }
    }

    const router = await readMarker(stateDir, 'escalation-router');
    expect(isAlive(router.pid)).toBe(true);
    expect(isAlive(listener.pid)).toBe(true);
    expect(recoveringAfterHeal).toBeLessThanOrEqual(4);

    const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('supervisor: running');

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, supervisorTestTimeoutMs);
});
