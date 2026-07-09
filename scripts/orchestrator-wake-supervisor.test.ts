import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupSupervisorTests,
  isAlive,
  makeStateDir,
  repoRoot,
  runSupervisor,
  waitForSupervisorHealthyStatus,
} from './supervisor-recovery.test-helpers.js';

const supervisorScript = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1');
const fleetTimeoutMs = 180_000;

afterEach(() => {
  cleanupSupervisorTests();
}, fleetTimeoutMs);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLease(stateDir: string, timeoutMs = 120_000): Promise<void> {
  const leasePath = path.join(stateDir, 'supervisor.lock');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(leasePath) && fs.readFileSync(leasePath, 'utf8').trim().length > 0) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for supervisor.lock at ${leasePath}`);
}

function readLease(stateDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'supervisor.lock'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function makeForeignCheckoutDir(): string {
  const checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-checkout-b-'));
  const scriptsDir = path.join(checkoutDir, 'scripts');
  const libDir = path.join(scriptsDir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.copyFileSync(supervisorScript, path.join(scriptsDir, 'orchestrator-wake-supervisor.ps1'));
  for (const name of fs.readdirSync(path.join(repoRoot, 'scripts/lib'))) {
    if (!name.endsWith('.ps1')) {
      continue;
    }
    fs.copyFileSync(path.join(repoRoot, 'scripts/lib', name), path.join(libDir, name));
  }
  return path.join(scriptsDir, 'orchestrator-wake-supervisor.ps1');
}

function startDetachedLeaseHolder(stateDir: string, sessionId: string) {
  return runSupervisor([
    '-Action',
    'Start',
    '-SkipInitialWait',
    '-OrchestratorSessionId',
    sessionId,
    '-StateDir',
    stateDir,
    '-PollSeconds',
    '5',
  ]);
}

function startTestSupervisorLoop(stateDir: string, sessionId: string) {
  return spawn(
    'pwsh',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      supervisorScript,
      '-Action',
      'Start',
      '-SupervisorLoop',
      '-TestMode',
      '-SkipInitialWait',
      '-StateDir',
      stateDir,
      '-OrchestratorSessionId',
      sessionId,
      '-PollSeconds',
      '5',
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
}

describe('orchestrator-wake-supervisor fleet cardinality (#709)', () => {
  it(
    'C1: second Start on same checkout is idempotent when lease holder is live',
    async () => {
      const stateDir = makeStateDir();
      const first = startDetachedLeaseHolder(stateDir, 'fleet-c1');
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('supervisor detached');
      await waitForLease(stateDir);

      const second = runSupervisor([
        '-Action',
        'Start',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'fleet-c1',
        '-StateDir',
        stateDir,
      ]);
      expect(second.status).toBe(0);
      expect(second.stderr + second.stdout).toMatch(/already running/i);

      runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir]);
    },
    fleetTimeoutMs,
  );

  it(
    'C3: cross-checkout Start refuses when state-root lease is already held',
    async () => {
      const stateDir = makeStateDir();
      const foreignScript = makeForeignCheckoutDir();
      const holder = startDetachedLeaseHolder(stateDir, 'fleet-c3-holder');
      expect(holder.status).toBe(0);
      await waitForLease(stateDir);
      await waitForSupervisorHealthyStatus(stateDir, 120_000);

      const blocked = spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          foreignScript,
          '-Action',
          'Start',
          '-SkipInitialWait',
          '-OrchestratorSessionId',
          'fleet-c3',
          '-StateDir',
          stateDir,
          '-PollSeconds',
          '5',
        ],
        { cwd: path.dirname(foreignScript), encoding: 'utf8', timeout: fleetTimeoutMs },
      );
      expect(blocked.status).not.toBe(0);
      expect((blocked.stderr ?? '') + (blocked.stdout ?? '')).toMatch(
        /cross-checkout|foreign|already running/i,
      );

      const lease = readLease(stateDir);
      const holderPid = Number(lease.holderPid);
      expect(holderPid).toBeGreaterThan(0);
      expect(isAlive(holderPid)).toBe(true);

      runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir]);
    },
    fleetTimeoutMs,
  );

  it(
    'C10: ordinary Stop blocks on ambiguous fleet; Force clears supervisors and children',
    async () => {
      const stateDir = makeStateDir();
      const first = startTestSupervisorLoop(stateDir, 'fleet-c10-a');
      await waitForSupervisorHealthyStatus(stateDir, 120_000);
      const second = startTestSupervisorLoop(stateDir, 'fleet-c10-b');
      await sleep(15000);

      const ordinary = runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
      expect(ordinary.status).not.toBe(0);
      expect(ordinary.stderr + ordinary.stdout).toMatch(/ambiguous|blocked|Force/i);

      const forced = runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir]);
      expect(forced.status).toBe(0);
      expect(forced.stdout + forced.stderr).toMatch(/wake-supervisor-audit kind=force-stop/);

      first.kill('SIGTERM');
      second.kill('SIGTERM');
      await sleep(2000);
      const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(status.stdout).toContain('supervisor: stopped');
    },
    fleetTimeoutMs,
  );

  it(
    'lease file is created and held by detached supervisor loop (#552 / AC#13-14)',
    async () => {
      const stateDir = makeStateDir();
      const start = startDetachedLeaseHolder(stateDir, 'fleet-lease-detach');
      expect(start.status).toBe(0);
      await waitForLease(stateDir);
      const lease = readLease(stateDir);
      const holderPid = Number(lease.holderPid);
      expect(holderPid).toBeGreaterThan(0);
      expect(isAlive(holderPid)).toBe(true);
      expect(fs.readFileSync(path.join(stateDir, 'supervisor.pid'), 'utf8').trim()).toBe(
        String(holderPid),
      );

      runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir]);
    },
    fleetTimeoutMs,
  );

  it('legacy no-lock holder blocks Start until Force (AC#8b)', async () => {
    const stateDir = makeStateDir();
    const legacy = startTestSupervisorLoop(stateDir, 'fleet-legacy');
    await waitForSupervisorHealthyStatus(stateDir, 90_000);
    if (fs.existsSync(path.join(stateDir, 'supervisor.lock'))) {
      fs.unlinkSync(path.join(stateDir, 'supervisor.lock'));
    }
    await sleep(16000);

    const blocked = runSupervisor([
      '-Action',
      'Start',
      '-SkipInitialWait',
      '-OrchestratorSessionId',
      'fleet-legacy-2',
      '-StateDir',
      stateDir,
    ]);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr + blocked.stdout).toMatch(/already running|legacy/i);

    legacy.kill('SIGTERM');
    runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir]);
  }, fleetTimeoutMs);
});
