import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect } from 'vitest';
import {
  cleanupSupervisorTests,
  isAlive,
  makeStateDir,
  readMarker,
  repoRoot,
  runSupervisor,
  waitForMarkers,
} from './supervisor-recovery.test-helpers.js';
import {
  getProcessStartTimeIdentity,
  runReaperCli,
  type LaneLease,
} from './testmode-fleet-harness.js';

export const supervisorLib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
export const testChildScript = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor-test-child.ps1');
export const reaperScript = path.join(repoRoot, 'scripts/invoke-testmode-fleet-reaper.ps1');

export const spawnLeaseEnv = {
  AO_TESTMODE_FLEET_LEASE_TTL_SECONDS: '45',
  AO_TESTMODE_FLEET_HEARTBEAT_GRACE_SECONDS: '8',
  AO_TESTMODE_FLEET_NO_PROGRESS_SECONDS: '12',
  AO_TESTMODE_FLEET_HEARTBEAT_INTERVAL_SECONDS: '1',
};

export const ttlLeaseEnv = {
  AO_TESTMODE_FLEET_LEASE_TTL_SECONDS: '75',
  AO_TESTMODE_FLEET_HEARTBEAT_GRACE_SECONDS: '3',
  AO_TESTMODE_FLEET_NO_PROGRESS_SECONDS: '5',
  AO_TESTMODE_FLEET_HEARTBEAT_INTERVAL_SECONDS: '1',
};

export function runPwsh(command: string, env: Record<string, string> = {}) {
  return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

export const trackedLeaseRoots: string[] = [];

export function withLeaseEnv(leaseRoot: string, leaseId: string, extra: Record<string, string> = {}) {
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

export function startLeaseHeartbeat(leaseRoot: string, leaseId: string): ReturnType<typeof setInterval> {
  return setInterval(() => {
    runReaperCli('heartbeat', { LeaseId: leaseId }, { OPK_TESTMODE_LEASE_ROOT: leaseRoot });
  }, 1000);
}

export function startRenewalOwner(): { child: ReturnType<typeof spawn>; pid: number; startTime: string } {
  const child = spawn('sleep', ['3600'], { stdio: 'ignore', detached: true });
  child.unref();
  const pid = child.pid ?? 0;
  const startTime = getProcessStartTimeIdentity(pid);
  return { child, pid, startTime };
}

export function registerLeaseForOwner(
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

export function spawnOrphanTestModeChild(stateDir: string): number {
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

export async function waitForLiveChildPids(
  stateDir: string,
  timeoutMs = 20_000,
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for live supervisor child pid files');
}

export async function startLiveDetachedSupervisor(stateDir: string): Promise<number> {
  const fixturePath = path.join(repoRoot, 'scripts/fixtures/orchestrator-wake-supervisor/status-orchestrator-op-old.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AO_WAKE_SUPERVISOR_TEST_FAST_STOP: '1',
  };
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
  await waitForLiveChildPids(stateDir, 20_000);
  return Number(fs.readFileSync(path.join(stateDir, 'supervisor.pid'), 'utf8').trim());
}

export async function startDetachedTestModeFleet(stateDir: string, env: Record<string, string>) {
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
    await waitForMarkers(stateDir, 20_000, ['listener', 'heartbeat']);
    const listener = await readMarker(stateDir, 'listener');
    const heartbeatMarker = await readMarker(stateDir, 'heartbeat');
    return { supervisorPid, listener, heartbeat: heartbeatMarker };
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
}

export function registerFleetReaperAfterEach(): void {
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
}
