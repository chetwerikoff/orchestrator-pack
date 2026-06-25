import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupSupervisorTests,
  countLogMatches,
  isAlive,
  makeStateDir,
  readChildPid,
  readChildRecovery,
  readSupervisorLog,
  readChildPid,
  runSupervisor,
  startSupervisorBackground,
  waitForMarker,
  waitForSupervisorLogMatch,
} from './supervisor-recovery.test-helpers.js';

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
    const recoveringCount = countLogMatches(supervisorLog, /heartbeat recovering \(degraded attempt/g);
    const backoffCount = countLogMatches(supervisorLog, /degraded backoff: heartbeat/g);

    expect(supervisorLog).toMatch(/degraded backoff: heartbeat/);
    expect(recoveringCount).toBeLessThanOrEqual(3);
    expect(backoffCount).toBeGreaterThan(0);

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, timeoutMs);

  it('preserves degraded recovery state across a crash cycle', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-degraded-crash-preserve'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_heartbeat: 'tick-error',
        AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '3',
        AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF: '1',
        AO_WAKE_SUPERVISOR_DEGRADED_STABLE_WORKING_POLLS: '2',
      },
    );

    await waitForMarker(stateDir, 'heartbeat', 25_000);
    await waitForSupervisorLogMatch(stateDir, /degraded backoff: heartbeat/, 20_000);

    let beforeCrash: Record<string, unknown> = {};
    let killed = false;
    const killDeadline = Date.now() + 20_000;
    while (Date.now() < killDeadline && !killed) {
      const recovery = readChildRecovery(stateDir, 'heartbeat');
      if (Number(recovery.degradedAttempts ?? 0) > 0) {
        if (Number(beforeCrash.degradedAttempts ?? 0) === 0) {
          beforeCrash = recovery;
        }
        try {
          const heartbeatPid = readChildPid(stateDir, 'heartbeat');
          if (heartbeatPid > 0 && isAlive(heartbeatPid)) {
            process.kill(heartbeatPid, 'SIGKILL');
            killed = true;
          }
        } catch {
          // pid file may be absent briefly during degraded-path restart
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    expect(killed).toBe(true);
    expect(Number(beforeCrash.degradedAttempts ?? 0)).toBeGreaterThan(0);
    await waitForSupervisorLogMatch(
      stateDir,
      /heartbeat (exited; restarting|crash backoff)/,
      20_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const afterCrash = readChildRecovery(stateDir, 'heartbeat');
    expect(Number(afterCrash.degradedAttempts ?? 0)).toBeGreaterThanOrEqual(
      Number(beforeCrash.degradedAttempts ?? 0),
    );
    expect(Number(afterCrash.deterministicReasonStreak ?? 0)).toBeGreaterThanOrEqual(
      Number(beforeCrash.deterministicReasonStreak ?? 0),
    );
    expect(String(afterCrash.failureClass ?? '')).toBe(String(beforeCrash.failureClass ?? ''));

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, timeoutMs);
});
