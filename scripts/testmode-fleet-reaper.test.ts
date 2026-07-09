import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupSupervisorTests,
  isAlive,
  makeStateDir,
  readMarker,
  repoRoot,
  runSupervisor,
  startSupervisorBackground,
  waitForMarkers,
  waitForProcessesStopped,
} from './supervisor-recovery.test-helpers.js';
import {
  getCanonicalDefaultLeaseRoot,
  getProcessStartTimeIdentity,
  isolatedLeaseRoot,
  isAlive as harnessIsAlive,
  killProcess,
  registerLaneLease,
  runPwshFile,
  runReaperCli,
  seedStaleLeaseRecord,
  writeCorruptLeaseRecord,
  type LaneLease,
} from './testmode-fleet-harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const supervisorLib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
const testChildScript = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor-test-child.ps1');
const reaperScript = path.join(repoRoot, 'scripts/invoke-testmode-fleet-reaper.ps1');

const spawnLeaseEnv = {
  AO_TESTMODE_FLEET_LEASE_TTL_SECONDS: '120',
  AO_TESTMODE_FLEET_HEARTBEAT_GRACE_SECONDS: '90',
  AO_TESTMODE_FLEET_NO_PROGRESS_SECONDS: '120',
  AO_TESTMODE_FLEET_HEARTBEAT_INTERVAL_SECONDS: '2',
};

const ttlLeaseEnv = {
  AO_TESTMODE_FLEET_LEASE_TTL_SECONDS: '90',
  AO_TESTMODE_FLEET_HEARTBEAT_GRACE_SECONDS: '4',
  AO_TESTMODE_FLEET_NO_PROGRESS_SECONDS: '8',
  AO_TESTMODE_FLEET_HEARTBEAT_INTERVAL_SECONDS: '2',
};

function runPwsh(command: string, env: Record<string, string> = {}) {
  return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

const trackedLeaseRoots: string[] = [];

function withLeaseEnv(leaseRoot: string, leaseId: string, extra: Record<string, string> = {}) {
  if (!trackedLeaseRoots.includes(leaseRoot)) {
    trackedLeaseRoots.push(leaseRoot);
  }
  return {
    OPK_TESTMODE_LEASE_ROOT: leaseRoot,
    AO_TESTMODE_FLEET_LANE_LEASE_ID: leaseId,
    AO_WAKE_SUPERVISOR_TEST_FAST_STOP: '1',
    ...spawnLeaseEnv,
    ...extra,
  };
}

function startLeaseHeartbeat(leaseRoot: string, leaseId: string): ReturnType<typeof setInterval> {
  return setInterval(() => {
    runReaperCli('heartbeat', { LeaseId: leaseId }, { OPK_TESTMODE_LEASE_ROOT: leaseRoot });
  }, 2000);
}

function startRenewalOwner(): { child: ReturnType<typeof spawn>; pid: number; startTime: string } {
  const child = spawn('sleep', ['3600'], { stdio: 'ignore', detached: true });
  child.unref();
  const pid = child.pid ?? 0;
  const startTime = getProcessStartTimeIdentity(pid);
  return { child, pid, startTime };
}

function registerLeaseForOwner(
  leaseRoot: string,
  ownerPid: number,
  ownerStartTime: string,
  laneId: string,
): LaneLease {
  const { stdout, status } = runReaperCli(
    'register-lane',
    {
      RunId: `test-${Date.now()}`,
      LaneId: laneId,
      OwnerPid: ownerPid,
      OwnerStartTime: ownerStartTime,
      WorkspaceRoot: repoRoot,
    },
    { OPK_TESTMODE_LEASE_ROOT: leaseRoot, ...spawnLeaseEnv },
  );
  expect(status).toBe(0);
  return JSON.parse(stdout) as LaneLease;
}

function spawnOrphanTestModeChild(stateDir: string): number {
  const markerDir = path.join(stateDir, 'markers');
  fs.mkdirSync(markerDir, { recursive: true });
  const child = spawn(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', testChildScript, '-Role', 'listener'],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        AO_WAKE_SUPERVISOR_TEST_MARKER_DIR: markerDir,
        AO_SIDE_PROCESS_STATE_DIR: stateDir,
      },
    },
  );
  child.unref();
  return child.pid ?? 0;
}


async function waitForLiveChildPids(
  stateDir: string,
  timeoutMs = 30_000,
): Promise<{ listener: number; heartbeat: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listenerPath = path.join(stateDir, 'listener.pid');
    const heartbeatPath = path.join(stateDir, 'heartbeat.pid');
    if (fs.existsSync(listenerPath) && fs.existsSync(heartbeatPath)) {
      return {
        listener: Number(fs.readFileSync(listenerPath, 'utf8').trim()),
        heartbeat: Number(fs.readFileSync(heartbeatPath, 'utf8').trim()),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for live supervisor child pid files');
}

async function startLiveDetachedSupervisor(stateDir: string): Promise<number> {
  const fixturePath = path.join(repoRoot, 'scripts/fixtures/orchestrator-wake-supervisor/status-orchestrator-op-old.json');
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AO_TESTMODE_FLEET_LANE_LEASE_ID;
  delete env.OPK_TESTMODE_LEASE_ROOT;
  const start = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1'),
      '-Action',
      'Start',
      '-SkipInitialWait',
      '-FixturePath',
      fixturePath,
      '-OrchestratorSessionId',
      'op-live-inert',
      '-StateDir',
      stateDir,
      '-PollSeconds',
      '1',
    ],
    {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  expect(start.status).toBe(0);
  await waitForLiveChildPids(stateDir, 30_000);
  return Number(fs.readFileSync(path.join(stateDir, 'supervisor.pid'), 'utf8').trim());
}

async function startDetachedTestModeFleet(stateDir: string, env: Record<string, string>) {
  const leaseId = env.AO_TESTMODE_FLEET_LANE_LEASE_ID ?? '';
  const leaseRoot = env.OPK_TESTMODE_LEASE_ROOT ?? '';
  const heartbeat = leaseId && leaseRoot ? startLeaseHeartbeat(leaseRoot, leaseId) : undefined;
  try {
    const start = runSupervisor(
      [
        '-Action',
        'Start',
        '-TestMode',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'op-testmode-fleet',
        '-StateDir',
        stateDir,
        '-PollSeconds',
        '1',
      ],
      env,
    );
    expect(start.status).toBe(0);
    expect(start.stdout).toContain('supervisor detached');
    const supervisorPid = Number(fs.readFileSync(path.join(stateDir, 'supervisor.pid'), 'utf8').trim());
    await waitForMarkers(stateDir, 30_000, ['listener', 'heartbeat']);
    const listener = await readMarker(stateDir, 'listener');
    const heartbeatMarker = await readMarker(stateDir, 'heartbeat');
    return { supervisorPid, listener, heartbeat: heartbeatMarker };
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
}

afterEach(() => {
  for (const leaseRoot of trackedLeaseRoots.splice(0)) {
    try {
      const indexPath = path.join(leaseRoot, 'index.json');
      if (fs.existsSync(indexPath)) {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { leaseIds?: string[] };
        for (const leaseId of index.leaseIds ?? []) {
          runReaperCli('teardown', { LeaseId: leaseId }, {
            OPK_TESTMODE_LEASE_ROOT: leaseRoot,
            AO_TESTMODE_FLEET_LANE_LEASE_ID: leaseId,
            AO_WAKE_SUPERVISOR_TEST_FAST_STOP: '1',
          });
        }
      }
    } catch {
      // best-effort lane cleanup
    }
  }
  cleanupSupervisorTests();
});

describe('Issue #710 TestMode fleet lease TTL (AC#1)', () => {
  it.skipIf(process.platform === 'win32')(
    'TestMode supervisor and children self-exit when renewal-owner dies',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const owner = startRenewalOwner();
      const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'ttl-lane');
      const stateDir = makeStateDir();
      const fleet = await startDetachedTestModeFleet(
        stateDir,
        withLeaseEnv(leaseRoot, lane.leaseId, ttlLeaseEnv),
      );

      killProcess(owner.pid);
      await waitForProcessesStopped(
        [fleet.supervisorPid, fleet.listener.pid, fleet.heartbeat.pid],
        45_000,
      );
      expect(isAlive(fleet.supervisorPid)).toBe(false);
      expect(isAlive(fleet.listener.pid)).toBe(false);
      expect(isAlive(fleet.heartbeat.pid)).toBe(false);
    },
    90_000,
  );
});

describe('Issue #710 bootstrap pre-sweep (AC#2, AC#7)', () => {
  it.skipIf(process.platform === 'win32')(
    'bootstrap pre-sweep clears stale leaked fleets and keeps concurrent live lane',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const staleState = makeStateDir();
      const staleLease = seedStaleLeaseRecord(leaseRoot, staleState);
      const orphanPid = spawnOrphanTestModeChild(staleState);
      expect(harnessIsAlive(orphanPid)).toBe(true);

      const liveOwner = startRenewalOwner();
      const liveLane = registerLeaseForOwner(leaseRoot, liveOwner.pid, liveOwner.startTime, 'live-lane');
      const liveState = makeStateDir();
      const liveHeartbeat = startLeaseHeartbeat(leaseRoot, liveLane.leaseId);
      const liveFleet = await startDetachedTestModeFleet(
        liveState,
        withLeaseEnv(leaseRoot, liveLane.leaseId),
      );

      clearInterval(liveHeartbeat);

      const currentLane = registerLaneLease({ leaseRoot, laneId: 'bootstrap-lane' });
      const bootstrap = runReaperCli('bootstrap', {}, withLeaseEnv(leaseRoot, currentLane.leaseId));
      expect(bootstrap.status, bootstrap.stderr || bootstrap.stdout).toBe(0);
      await waitForProcessesStopped([orphanPid], 20_000);
      expect(harnessIsAlive(orphanPid)).toBe(false);
      expect(isAlive(liveFleet.supervisorPid)).toBe(true);
      expect(isAlive(liveFleet.listener.pid)).toBe(true);

      runReaperCli('teardown', { LeaseId: liveLane.leaseId }, withLeaseEnv(leaseRoot, liveLane.leaseId));
      killProcess(liveOwner.pid);
    },
    120_000,
  );

  it.skipIf(process.platform === 'win32')(
    'supervisor crash leaves orphans recovered by bootstrap pre-sweep',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const owner = startRenewalOwner();
      const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'crash-lane');
      const stateDir = makeStateDir();
      const fleet = await startDetachedTestModeFleet(stateDir, withLeaseEnv(leaseRoot, lane.leaseId));
      killProcess(fleet.supervisorPid);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(isAlive(fleet.listener.pid)).toBe(true);
      killProcess(owner.pid);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const recoveryLane = registerLaneLease({ leaseRoot, laneId: 'recovery-lane' });
      const bootstrap = runReaperCli('bootstrap', {}, withLeaseEnv(leaseRoot, recoveryLane.leaseId));
      expect(bootstrap.status, bootstrap.stderr || bootstrap.stdout).toBe(0);
      await waitForProcessesStopped([fleet.listener.pid, fleet.heartbeat.pid], 45_000);
      expect(isAlive(fleet.listener.pid)).toBe(false);
    },
    120_000,
  );

  it('treats corrupt lease records as stale during bootstrap', () => {
    const leaseRoot = isolatedLeaseRoot();
    const leaseId = 'corrupt-lease';
    writeCorruptLeaseRecord(leaseRoot, leaseId);
    const result = runPwsh(
      `. '${supervisorLib.replace(/'/g, "''")}'; . '${path.join(repoRoot, 'scripts/lib/Invoke-TestModeFleetReaper.ps1').replace(/'/g, "''")}'; $d = Test-TestModeFleetLeaseStale -Record $null -TreatCorruptAsStale; Write-Output $d.stale`,
      { OPK_TESTMODE_LEASE_ROOT: leaseRoot },
    );
    expect(result.stdout.trim()).toBe('True');
  });

  it('uses durable default lease root when leaseRoot omitted', () => {
    const savedRoot = process.env.OPK_TESTMODE_LEASE_ROOT;
    delete process.env.OPK_TESTMODE_LEASE_ROOT;
    try {
      expect(getCanonicalDefaultLeaseRoot()).toContain('opk-testmode-fleet-leases');
    } finally {
      if (savedRoot !== undefined) {
        process.env.OPK_TESTMODE_LEASE_ROOT = savedRoot;
      } else {
        delete process.env.OPK_TESTMODE_LEASE_ROOT;
      }
    }
  });

  it.skipIf(process.platform === 'win32')(
    'bootstrap reaps orphans linked to corrupt indexed lease records',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const stateDir = makeStateDir();
      const leaseId = 'corrupt-bootstrap';
      writeCorruptLeaseRecord(leaseRoot, leaseId);
      fs.writeFileSync(path.join(stateDir, 'testmode-lane-lease.id'), leaseId);
      const orphanPid = spawnOrphanTestModeChild(stateDir);
      expect(harnessIsAlive(orphanPid)).toBe(true);

      const recovery = registerLaneLease({ leaseRoot, laneId: 'recovery-corrupt' });
      const bootstrap = runReaperCli('bootstrap', {}, withLeaseEnv(leaseRoot, recovery.leaseId));
      expect(bootstrap.status).toBe(0);
      await waitForProcessesStopped([orphanPid], 20_000);
      expect(harnessIsAlive(orphanPid)).toBe(false);
    },
    90_000,
  );
});

describe('Issue #710 teardown post-sweep (AC#3)', () => {
  it.skipIf(process.platform === 'win32')(
    'teardown reaps this run TestMode fleet on hook-executable exit path',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const owner = startRenewalOwner();
      const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'teardown-lane');
      const stateDir = makeStateDir();
      const fleet = await startDetachedTestModeFleet(stateDir, withLeaseEnv(leaseRoot, lane.leaseId));
      const teardown = runReaperCli('teardown', { LeaseId: lane.leaseId }, withLeaseEnv(leaseRoot, lane.leaseId));
      expect(teardown.status).toBe(0);
      await waitForProcessesStopped(
        [fleet.supervisorPid, fleet.listener.pid, fleet.heartbeat.pid],
        20_000,
      );
      killProcess(owner.pid);
    },
    90_000,
  );
});

describe('Issue #710 live fleet inert (AC#4)', () => {
  it.skipIf(process.platform === 'win32')(
    'reaper and TTL paths leave live supervisor Start without -TestMode running',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const lane = registerLaneLease({ leaseRoot, laneId: 'live-negative' });
      const stateDir = makeStateDir();
      const supervisorPid = await startLiveDetachedSupervisor(stateDir);
      const liveChildren = await waitForLiveChildPids(stateDir);
      const listener = { pid: liveChildren.listener };
      const heartbeat = { pid: liveChildren.heartbeat };

      const fixture = spawn('sleep', ['3600'], { stdio: 'ignore', detached: true });
      fixture.unref();
      const fixturePid = fixture.pid ?? 0;

      runReaperCli('bootstrap', {}, withLeaseEnv(leaseRoot, lane.leaseId));
      runReaperCli('teardown', { LeaseId: lane.leaseId }, withLeaseEnv(leaseRoot, lane.leaseId));

      expect(isAlive(listener.pid)).toBe(true);
      expect(isAlive(heartbeat.pid)).toBe(true);
      expect(isAlive(supervisorPid)).toBe(true);
      expect(harnessIsAlive(fixturePid)).toBe(true);

      killProcess(fixturePid);
      runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    },
    120_000,
  );
});

describe('Issue #710 marker identification (AC#5)', () => {
  it('classifies supervisor cmdline identity using fixtures', () => {
    const stateDir = makeStateDir();
    const fixturePath = path.join(stateDir, 'cmdline-fixture.json');
    const cmdline = [
      'pwsh', '-File', path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1'),
      '-Action', 'Start', '-SupervisorLoop', '-StateDir', stateDir, '-TestMode',
    ].join(' ');
    fs.writeFileSync(fixturePath, JSON.stringify({ '424242': cmdline }));
    const result = runPwsh(
      `$env:AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE='${fixturePath.replace(/'/g, "''")}'; . '${supervisorLib.replace(/'/g, "''")}'; . '${path.join(repoRoot, 'scripts/lib/Invoke-TestModeFleetReaper.ps1').replace(/'/g, "''")}'; $c = Get-TestModeFleetProcessClassification -ProcessId 424242; Write-Output $c.kind`,
    );
    expect(result.stdout.trim()).toBe('testmode_supervisor');
  });

  it.skipIf(process.platform === 'win32')(
    'real spawned pwsh e2e matches TestMode marker and not live root',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const owner = startRenewalOwner();
      const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'identity-lane');
      const stateDir = makeStateDir();
      await startDetachedTestModeFleet(stateDir, withLeaseEnv(leaseRoot, lane.leaseId));
      const observe = runPwshFile(reaperScript, ['observe'], withLeaseEnv(leaseRoot, lane.leaseId));
      const payload = JSON.parse(observe.stdout) as { matched?: number; survivors?: number[] };
      expect((payload.matched ?? 0) > 0 || (payload.survivors?.length ?? 0) > 0).toBe(true);
      runReaperCli('teardown', { LeaseId: lane.leaseId }, withLeaseEnv(leaseRoot, lane.leaseId));
      killProcess(owner.pid);
    },
    120_000,
  );
});

describe('Issue #710 CI hygiene assertion (AC#6)', () => {
  it.skipIf(process.platform === 'win32')('observe exits non-zero when this-run survivors remain', async () => {
    const leaseRoot = isolatedLeaseRoot();
    const owner = startRenewalOwner();
    const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'ci-lane');
    const stateDir = makeStateDir();
    const fleet = await startDetachedTestModeFleet(stateDir, withLeaseEnv(leaseRoot, lane.leaseId));
    expect(isAlive(fleet.supervisorPid)).toBe(true);

    const observe = runPwshFile(reaperScript, ['observe'], withLeaseEnv(leaseRoot, lane.leaseId));
    expect(observe.status).not.toBe(0);

    runReaperCli('teardown', { LeaseId: lane.leaseId }, withLeaseEnv(leaseRoot, lane.leaseId));
    killProcess(owner.pid);
  }, 90_000);

  it.skipIf(process.platform === 'win32')('cleanup reports masked leak when survivors required post-run kill', async () => {
    const leaseRoot = isolatedLeaseRoot();
    const owner = startRenewalOwner();
    const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'ci-mask-lane');
    const stateDir = makeStateDir();
    await startDetachedTestModeFleet(stateDir, withLeaseEnv(leaseRoot, lane.leaseId));

    const cleanup = runPwshFile(reaperScript, ['cleanup'], withLeaseEnv(leaseRoot, lane.leaseId));
    expect(cleanup.status).not.toBe(0);
    const payload = JSON.parse(cleanup.stdout) as { maskedLeak?: boolean };
    expect(payload.maskedLeak).toBe(true);
    killProcess(owner.pid);
  }, 90_000);
});
