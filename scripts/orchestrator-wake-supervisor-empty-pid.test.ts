import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupSupervisorTests,
  fixtureDir,
  isAlive,
  makeStateDir,
  managedChildRoles,
  readMarker,
  repoRoot,
  runSupervisor,
  startSupervisorBackground,
  supervisorScript,
  waitForMarkers,
  waitForSupervisorHealthyStatus,
  waitForProcessesStopped,
  type ManagedChildRole,
  type WakeMarker,
} from './supervisor-recovery.test-helpers.js';

const aoStub = path.join(fixtureDir, 'ao-stub.sh');
const supervisorHookTimeoutMs = 120_000;

afterEach(() => {
  cleanupSupervisorTests();
}, supervisorHookTimeoutMs);

const detachedSupervisorTimeoutMs = 60_000;

describe('Issue #388 empty pid files', () => {
  const supervisorLib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
  const issue388TimeoutMs = 60_000;

  function readPidViaHelper(pidPath: string): number {
    return Number(
      execFileSync(
        'pwsh',
        [
          '-NoProfile',
          '-Command',
          `. '${supervisorLib.replace(/'/g, "''")}'; Write-Output (Read-OrchestratorWakeSupervisorPidFile -Path '${pidPath.replace(/'/g, "''")}')`,
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      ).trim(),
    );
  }

  function seedEmptyPidFixture(childRole = 'ci-green-wake-reconcile'): {
    stateDir: string;
    childPidPath: string;
  } {
    const stateDir = makeStateDir();
    const childPidPath = path.join(stateDir, `${childRole}.pid`);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(childPidPath, '');
    return { stateDir, childPidPath };
  }

  it('Read-OrchestratorWakeSupervisorPidFile treats zero-byte files as pid 0', () => {
    const stateDir = makeStateDir();
    const pidPath = path.join(stateDir, 'probe.pid');
    fs.writeFileSync(pidPath, '');
    expect(readPidViaHelper(pidPath)).toBe(0);
  });

  it('Read-OrchestratorWakeSupervisorPidFile treats whitespace-only files as pid 0', () => {
    const stateDir = makeStateDir();
    const pidPath = path.join(stateDir, 'probe.pid');
    fs.writeFileSync(pidPath, '  \n  ');
    expect(readPidViaHelper(pidPath)).toBe(0);
  });

  it('Read-OrchestratorWakeSupervisorPidFile still parses valid positive integers', () => {
    const stateDir = makeStateDir();
    const pidPath = path.join(stateDir, 'probe.pid');
    fs.writeFileSync(pidPath, '12345');
    expect(readPidViaHelper(pidPath)).toBe(12345);
  });

  it('Status tolerates zero-byte child pid files and removes them', () => {
    const { stateDir, childPidPath } = seedEmptyPidFixture();
    const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(status.stderr).not.toContain('null-valued expression');
    expect(status.stdout).toContain('ci-green-wake-reconcile');
    expect(status.stdout).toMatch(/ci-green-wake-reconcile\s+stopped \(pid=0\)/);
    expect(fs.existsSync(childPidPath)).toBe(false);
  });

  it(
    'Start tolerates zero-byte child pid files and prints status output',
    () => {
      const { stateDir } = seedEmptyPidFixture();
      const start = runSupervisor(
        [
          '-Action',
          'Start',
          '-TestMode',
          '-SkipInitialWait',
          '-OrchestratorSessionId',
          'op-empty-child-pid',
          '-StateDir',
          stateDir,
        ],
        { AO_WAKE_SUPERVISOR_TEST_MODE_ci_green_wake_reconcile: 'instant-exit' },
      );
      expect(start.stderr).not.toContain('null-valued expression');
      expect(start.status).toBe(0);
      expect(start.stdout).toContain('supervisor:');
      expect(start.stdout).toContain('state:');
    },
    issue388TimeoutMs,
  );

  it('Status tolerates zero-byte supervisor.pid', () => {
    const stateDir = makeStateDir();
    const supervisorPidPath = path.join(stateDir, 'supervisor.pid');
    fs.writeFileSync(supervisorPidPath, '');
    const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(status.stderr).not.toContain('null-valued expression');
    expect(status.stdout).toContain('supervisor: stopped (pid=0)');
    expect(fs.existsSync(supervisorPidPath)).toBe(false);
  });

  it(
    'Start tolerates zero-byte supervisor.pid',
    () => {
      const stateDir = makeStateDir();
      const supervisorPidPath = path.join(stateDir, 'supervisor.pid');
      fs.writeFileSync(supervisorPidPath, '');
      const start = runSupervisor([
        '-Action',
        'Start',
        '-TestMode',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'op-empty-supervisor-pid',
        '-StateDir',
        stateDir,
      ]);
      expect(start.stderr).not.toContain('null-valued expression');
      expect(start.status).toBe(0);
      expect(start.stdout).toContain('supervisor:');
    },
    issue388TimeoutMs,
  );
});
