import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupSupervisorTests,
  countLogMatches,
  makeStateDir,
  readChildRecovery,
  readMarker,
  readSupervisorLog,
  runSupervisor,
  startSupervisorBackground,
} from './supervisor-recovery.test-helpers.js';

const timeoutMs = 150_000;

afterEach(() => {
  cleanupSupervisorTests();
}, timeoutMs);

describe('supervisor prompt-block crash backoff (#701 cell B)', () => {
  it('prompt-block child without progress reaches crash backoff or circuit breaker', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-prompt-block-backoff'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_listener: 'prompt-block',
        AO_WAKE_SUPERVISOR_TEST_PROMPT_BLOCK_DELAY_MS: '5500',
        AO_WAKE_SUPERVISOR_CRASH_MAX_RAPID_EXITS: '2',
        AO_WAKE_SUPERVISOR_CRASH_TERMINAL_RAPID_EXITS: '5',
        AO_WAKE_SUPERVISOR_CRASH_BASE_BACKOFF_SECONDS: '4',
        AO_WAKE_SUPERVISOR_CRASH_RAPID_EXIT_THRESHOLD_MS: '5000',
      },
    );

    try {
      await readMarker(stateDir, 'listener', 20_000);
    } catch {
      // listener may restart quickly between attempts
    }

    const observedPids = new Set<number>();
    const deadline = Date.now() + 100_000;
    let supervisorLog = '';
    while (Date.now() < deadline) {
      try {
        const marker = await readMarker(stateDir, 'listener', 500);
        observedPids.add(marker.pid);
      } catch {
        // child may be between restarts
      }
      supervisorLog = readSupervisorLog(stateDir);
      if (
        /crash backoff: listener/.test(supervisorLog) ||
        /crash-loop circuit breaker: listener/.test(supervisorLog)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(supervisorLog).toMatch(/crash backoff: listener|crash-loop circuit breaker: listener/);
    expect(observedPids.size).toBeLessThanOrEqual(6);

    const recovery = readChildRecovery(stateDir, 'listener');
    const terminal =
      recovery.terminal === true ||
      Number(recovery.rapidExits ?? 0) >= 2 ||
      countLogMatches(supervisorLog, /crash backoff: listener/) > 0;
    expect(terminal).toBe(true);

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, timeoutMs);
});
