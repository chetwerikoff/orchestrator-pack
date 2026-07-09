import { describe, expect, it } from 'vitest';
import * as bdb from './supervisor-degraded-backoff.shared.js';

describe('supervisor-degraded-backoff crash preserve (Issue #450 C3)', () => {
  it('preserves degraded recovery state across a crash cycle', async () => {
    const stateDir = bdb.makeStateDir();
    const child = bdb.startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-degraded-crash-preserve'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_heartbeat: 'tick-error',
        AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS: '3',
        AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF: '1',
        AO_WAKE_SUPERVISOR_DEGRADED_STABLE_WORKING_POLLS: '2',
      },
    );

    await bdb.waitForMarker(stateDir, 'heartbeat', 30_000);
    await bdb.waitForSupervisorLogMatch(stateDir, /degraded backoff: heartbeat/, 30_000);

    let beforeCrash: Record<string, unknown> = {};
    let killed = false;
    let killedPid = 0;
    const killDeadline = Date.now() + 45_000;
    while (Date.now() < killDeadline && !killed) {
      const recovery = bdb.readChildRecovery(stateDir, 'heartbeat');
      if (Number(recovery.degradedAttempts ?? 0) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      let heartbeatPid = 0;
      try {
        heartbeatPid = bdb.readChildPid(stateDir, 'heartbeat');
      } catch {
        try {
          const marker = await bdb.readMarker(stateDir, 'heartbeat', 500);
          heartbeatPid = marker.pid;
        } catch {
          // pid file and marker may be absent briefly during degraded-path restart
        }
      }
      if (heartbeatPid > 0 && bdb.isAlive(heartbeatPid)) {
        beforeCrash = { ...recovery };
        process.kill(heartbeatPid, 'SIGKILL');
        killedPid = heartbeatPid;
        killed = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(killed).toBe(true);
    expect(Number(beforeCrash.degradedAttempts ?? 0)).toBeGreaterThan(0);

    const crashDeadline = Date.now() + 60_000;
    let crashObserved = false;
    while (Date.now() < crashDeadline) {
      const recovery = bdb.readChildRecovery(stateDir, 'heartbeat');
      const log = bdb.readSupervisorLog(stateDir);
      let heartbeatPid = 0;
      try {
        heartbeatPid = bdb.readChildPid(stateDir, 'heartbeat');
      } catch {
        // absent until supervisor restarts the child
      }
      crashObserved =
        Number(recovery.lastExitMs ?? 0) > Number(beforeCrash.lastExitMs ?? 0) ||
        Number(recovery.rapidExits ?? 0) > Number(beforeCrash.rapidExits ?? 0) ||
        (killedPid > 0 && heartbeatPid > 0 && heartbeatPid !== killedPid) ||
        /(heartbeat exited; restarting|crash backoff: heartbeat)/.test(log);
      if (crashObserved) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(crashObserved).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const afterCrash = bdb.readChildRecovery(stateDir, 'heartbeat');
    expect(Number(afterCrash.degradedAttempts ?? 0)).toBeGreaterThanOrEqual(
      Number(beforeCrash.degradedAttempts ?? 0),
    );
    expect(Number(afterCrash.deterministicReasonStreak ?? 0)).toBeGreaterThanOrEqual(
      Number(beforeCrash.deterministicReasonStreak ?? 0),
    );
    expect(String(afterCrash.failureClass ?? '')).toBe(String(beforeCrash.failureClass ?? ''));

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    bdb.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, bdb.degradedBackoffTimeoutMs);
});
