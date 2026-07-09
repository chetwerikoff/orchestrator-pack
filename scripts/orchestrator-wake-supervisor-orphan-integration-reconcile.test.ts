import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  issue613TimeoutMs,
  startDetachedSupervisor,
  supervisorLib,
  waitForListenerMarker,
} from './orchestrator-wake-supervisor-orphan-integration.shared.js';
import {
  cleanupSupervisorTests,
  isAlive,
  makeStateDir,
  runPwsh,
  runSupervisor,
} from './supervisor-recovery.test-helpers.js';

afterEach(() => {
  cleanupSupervisorTests();
});

describe('Issue #613 orphan supervisor discovery (integration reconcile)', () => {
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
