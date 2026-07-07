import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupSupervisorTests,
  isAlive,
  makeStateDir,
  readMarker,
  repoRoot,
  runPwsh,
  runSupervisor,
} from './supervisor-recovery.test-helpers.js';

const supervisorLib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
const issue613TimeoutMs = 90_000;

vi.setConfig({ testTimeout: issue613TimeoutMs, hookTimeout: 30_000 });

afterEach(() => {
  cleanupSupervisorTests();
});

function startDetachedSupervisor(
  stateDir: string,
  sessionId: string,
): { supervisorPid: number; start: ReturnType<typeof runSupervisor> } {
  const start = runSupervisor([
    '-Action',
    'Start',
    '-TestMode',
    '-SkipInitialWait',
    '-OrchestratorSessionId',
    sessionId,
    '-StateDir',
    stateDir,
    '-PollSeconds',
    '1',
  ]);
  expect(start.status).toBe(0);
  const supervisorPid = Number(
    fs.readFileSync(path.join(stateDir, 'supervisor.pid'), 'utf8').trim(),
  );
  expect(supervisorPid).toBeGreaterThan(0);
  return { supervisorPid, start };
}

async function waitForListenerMarker(stateDir: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(stateDir, 'markers', 'listener.marker.json'))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for listener marker');
}

describe('Issue #613 orphan supervisor discovery (integration)', () => {
  it(
    'Status discovers a detached supervisor when supervisor.pid is missing',
    async () => {
      const stateDir = makeStateDir();
      const { supervisorPid } = startDetachedSupervisor(stateDir, 'op-613-status-missing');
      await waitForListenerMarker(stateDir);

      fs.unlinkSync(path.join(stateDir, 'supervisor.pid'));

      const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(status.stdout).toContain('supervisor: running');
      expect(status.stdout).toContain(`(pid=${supervisorPid})`);
      expect(status.stdout).not.toContain('supervisor: stopped (pid=0)');
      expect(isAlive(supervisorPid)).toBe(true);

      runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    },
    issue613TimeoutMs,
  );

  it(
    'Stop terminates a detached supervisor when supervisor.pid is missing and children stay down',
    async () => {
      const stateDir = makeStateDir();
      const { supervisorPid } = startDetachedSupervisor(stateDir, 'op-613-stop-missing');
      await waitForListenerMarker(stateDir);
      const listenerBefore = await readMarker(stateDir, 'listener');
      expect(isAlive(listenerBefore.pid)).toBe(true);

      fs.unlinkSync(path.join(stateDir, 'supervisor.pid'));

      const stop = runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
      expect(stop.status).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(isAlive(supervisorPid)).toBe(false);
      expect(isAlive(listenerBefore.pid)).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 2500));
      const statusAfter = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(statusAfter.stdout).toContain('supervisor: stopped');
      expect(statusAfter.stdout).toMatch(/listener:\s+stopped/);
    },
    issue613TimeoutMs,
  );

  it(
    'Status and Stop reconcile empty and stale supervisor.pid values',
    async () => {
      const stateDir = makeStateDir();
      const { supervisorPid } = startDetachedSupervisor(stateDir, 'op-613-stale-empty');
      await waitForListenerMarker(stateDir);

      fs.writeFileSync(path.join(stateDir, 'supervisor.pid'), '');
      const statusEmpty = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(statusEmpty.stdout).toContain('supervisor: running');
      expect(statusEmpty.stdout).toContain(`(pid=${supervisorPid})`);

      fs.writeFileSync(path.join(stateDir, 'supervisor.pid'), '999999');
      const statusStale = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(statusStale.stdout).toContain('supervisor: running');
      expect(statusStale.stdout).toContain(`(pid=${supervisorPid})`);
      expect(statusStale.stdout).toMatch(/stale|unrelated|discovered/i);

      fs.writeFileSync(path.join(stateDir, 'supervisor.pid'), '999999');
      const stop = runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
      expect(stop.status).toBe(0);
      expect(isAlive(supervisorPid)).toBe(false);
    },
    issue613TimeoutMs,
  );

  it(
    'Start adopts an orphaned detached supervisor instead of launching a duplicate',
    async () => {
      const stateDir = makeStateDir();
      const { supervisorPid } = startDetachedSupervisor(stateDir, 'op-613-adopt');
      await waitForListenerMarker(stateDir);
      fs.unlinkSync(path.join(stateDir, 'supervisor.pid'));

      const secondStart = runSupervisor([
        '-Action',
        'Start',
        '-TestMode',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'op-613-adopt',
        '-StateDir',
        stateDir,
        '-PollSeconds',
        '1',
      ]);
      expect(secondStart.status).toBe(0);
      expect(secondStart.stdout).toContain('supervisor: running');
      expect(fs.readFileSync(path.join(stateDir, 'supervisor.pid'), 'utf8').trim()).toBe(
        String(supervisorPid),
      );

      const candidates = runPwsh(
        `. '${supervisorLib.replace(/'/g, "''")}'; @(Find-OrchestratorWakeSupervisorManagedSupervisorCandidates -ProjectId 'orchestrator-pack' -StateRoot '${stateDir.replace(/'/g, "''")}') -join ','`,
      ).stdout.trim();
      expect(candidates).toBe(String(supervisorPid));

      runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    },
    issue613TimeoutMs,
  );
});
