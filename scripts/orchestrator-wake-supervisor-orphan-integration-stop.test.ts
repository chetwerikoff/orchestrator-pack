import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  issue613TimeoutMs,
  startDetachedSupervisor,
} from './orchestrator-wake-supervisor-orphan-integration.shared.js';
import {
  cleanupSupervisorTests,
  isAlive,
  makeStateDir,
  readMarker,
  runSupervisor,
  waitForMarker,
  waitForProcessesStopped,
} from './supervisor-recovery.test-helpers.js';

const survivingChildRole = 'review-trigger-reconcile' as const;

afterEach(() => {
  cleanupSupervisorTests();
});

describe('Issue #613 orphan supervisor discovery (integration stop)', () => {
  it(
    'Status discovers a detached supervisor when supervisor.pid is missing',
    async () => {
      const stateDir = makeStateDir();
      const { supervisorPid } = startDetachedSupervisor(stateDir, 'op-613-status-missing');
      await waitForMarker(stateDir, survivingChildRole);

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
      await waitForMarker(stateDir, survivingChildRole);
      const childBefore = await readMarker(stateDir, survivingChildRole);
      expect(isAlive(childBefore.pid)).toBe(true);

      fs.unlinkSync(path.join(stateDir, 'supervisor.pid'));

      const stop = runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
      expect(stop.status).toBe(0);
      await waitForProcessesStopped([supervisorPid, childBefore.pid], 25_000);

      const statusAfter = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(statusAfter.stdout).toContain('supervisor: stopped');
      expect(statusAfter.stdout).toMatch(/review-trigger-reconcile\s+stopped/);
    },
    issue613TimeoutMs,
  );
});
