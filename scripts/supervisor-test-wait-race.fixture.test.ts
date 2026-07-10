import { describe, expect, it } from 'vitest';
import {
  fixedObservationWindow,
  isAlive,
  makeStateDir,
  readMarker,
  readSupervisorLog,
  sleepMs,
  waitForCondition,
  waitForProcessesStopped,
  waitForStdoutContains,
  waitForSupervisorLogMatchFromOffset,
} from './supervisor-recovery.test-helpers.js';

describe('supervisor test wait race/stale-state fixtures (Issue #693)', () => {
  it('log-generation-boundary ignores prior-run tail', async () => {
    const stateDir = makeStateDir();
    const staleTail = '[2020-01-01T00:00:00.0000000+00:00] orchestrator-wake-supervisor stale tail marker-generation';
    const logPath = `${stateDir}/supervisor.log`;
    await import('node:fs').then((fs) => fs.writeFileSync(logPath, staleTail, 'utf8'));
    const generationStart = readSupervisorLog(stateDir).length;
    await import('node:fs').then((fs) =>
      fs.appendFileSync(
        logPath,
        '\n[2026-01-01T00:00:00.0000000+00:00] orchestrator-wake-supervisor fresh marker-generation\n',
        'utf8',
      ),
    );
    const matched = await waitForSupervisorLogMatchFromOffset(
      stateDir,
      /fresh marker-generation/,
      generationStart,
      2000,
    );
    expect(matched.slice(generationStart)).toMatch(/fresh marker-generation/);
    expect(matched.slice(generationStart)).not.toMatch(/stale tail marker-generation/);
  });

  it('marker-generation-boundary ignores prior pid file content', async () => {
    const stateDir = makeStateDir();
    const markersDir = `${stateDir}/markers`;
    await import('node:fs').then((fs) => {
      fs.mkdirSync(markersDir, { recursive: true });
      fs.writeFileSync(
        `${markersDir}/listener.marker.json`,
        JSON.stringify({ role: 'listener', pid: 999001, orchestratorSessionId: 'stale' }),
        'utf8',
      );
    });
    const priorPid = (await readMarker(stateDir, 'listener')).pid;
    await import('node:fs').then((fs) =>
      fs.writeFileSync(
        `${markersDir}/listener.marker.json`,
        JSON.stringify({ role: 'listener', pid: 999002, orchestratorSessionId: 'fresh' }),
        'utf8',
      ),
    );
    await waitForCondition(
      async () => (await readMarker(stateDir, 'listener', 500)).pid === 999002,
      2000,
      undefined,
      'fresh listener marker pid',
    );
    const current = await readMarker(stateDir, 'listener');
    expect(current.pid).toBe(999002);
    expect(current.pid).not.toBe(priorPid);
  });

  it('waitForCondition performs a final check at the timeout boundary', async () => {
    const start = Date.now();
    const readyAt = start + 480;
    await waitForCondition(() => Date.now() >= readyAt, 500, 200, 'late-ready');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(470);
    expect(elapsed).toBeLessThan(650);
  });

  it('stdout-generation-boundary ignores buffered prefix', async () => {
    let stdout = 'stale stdout prefix noise';
    const generationStart = stdout.length;
    const appendFresh = () => {
      stdout += ' fresh stdout fragment';
    };
    setTimeout(appendFresh, 50);
    await waitForStdoutContains(() => stdout.slice(generationStart), 'fresh stdout fragment', 2000);
    expect(stdout.slice(generationStart)).toContain('fresh stdout fragment');
    expect(stdout.slice(generationStart)).not.toContain('stale stdout prefix');
  });

  it('process-exit-generation-boundary waits for current pid only', async () => {
    const stateDir = makeStateDir();
    const pidPath = `${stateDir}/probe.pid`;
    const stalePid = process.pid;
    await import('node:fs').then((fs) => fs.writeFileSync(pidPath, String(stalePid), 'utf8'));
    expect(isAlive(stalePid)).toBe(true);
    const child = await import('node:child_process').then(({ spawn }) =>
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' }),
    );
    const currentPid = child.pid ?? 0;
    expect(currentPid).toBeGreaterThan(0);
    await import('node:fs').then((fs) => fs.writeFileSync(pidPath, String(currentPid), 'utf8'));
    child.kill('SIGKILL');
    await waitForProcessesStopped([currentPid], 5000);
    expect(isAlive(currentPid)).toBe(false);
    expect(isAlive(stalePid)).toBe(true);
    await waitForCondition(() => !isAlive(currentPid), 1000);
    await fixedObservationWindow(100);
    await sleepMs(50);
  });
});
