import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupSupervisorTests,
  countLogMatches,
  makeStateDir,
  readMarker,
  readSupervisorLog,
  runSupervisor,
  startSupervisorBackground,
  waitForMarker,
} from './supervisor-recovery.test-helpers';

const timeoutMs = 45_000;

afterEach(() => {
  cleanupSupervisorTests();
}, timeoutMs);

describe('supervisor-degraded-backoff (Issue #450 C3)', () => {
  it('emits at most one degraded-path restart per configured backoff window under sustained degraded health', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-degraded-backoff'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_heartbeat: 'tick-error',
        AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '4',
        AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF: '1',
        AO_WAKE_SUPERVISOR_DEGRADED_STABLE_WORKING_POLLS: '2',
      },
    );

    await waitForMarker(stateDir, 'heartbeat', 25_000);

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const supervisorLog = readSupervisorLog(stateDir);
    const recoveringCount = countLogMatches(supervisorLog, /heartbeat recovering \(attempt/g);
    const backoffCount = countLogMatches(supervisorLog, /degraded backoff: heartbeat/g);

    expect(supervisorLog).toMatch(/degraded backoff: heartbeat/);
    expect(recoveringCount).toBeLessThanOrEqual(3);
    expect(backoffCount).toBeGreaterThan(0);

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, timeoutMs);
});
