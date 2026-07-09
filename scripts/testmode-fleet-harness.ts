import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const reaperScript = path.join(repoRoot, 'scripts/invoke-testmode-fleet-reaper.ps1');

export type LaneLease = {
  leaseId: string;
  runId: string;
  laneId: string;
  ownerPid: number;
  ownerStartTime: string;
  leaseRoot: string;
};

export function isolatedLeaseRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opk-testmode-lease-'));
}

export function getCanonicalDefaultLeaseRoot(): string {
  const home = process.env.HOME ?? os.homedir();
  const stateBase = process.env.XDG_STATE_HOME?.trim()
    || process.env.LOCALAPPDATA?.trim()
    || path.join(home, '.local', 'state');
  return path.join(stateBase, 'opk-testmode-fleet-leases');
}

export function getDefaultLeaseRoot(): string {
  const fromEnv = process.env.OPK_TESTMODE_LEASE_ROOT?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return getCanonicalDefaultLeaseRoot();
}

export function getVitestLaneContextFileName(): string {
  const shard = process.env.VITEST_HEAVY_SHARD?.trim();
  if (shard) {
    return `vitest-lane-context-shard-${shard}.json`;
  }
  if (process.env.VITEST_CI_LIGHT_LANE === '1') {
    return 'vitest-lane-context-light.json';
  }
  return 'vitest-lane-context.json';
}

export function writeVitestLaneLeaseContext(lease: LaneLease): void {
  const contextPath = path.join(lease.leaseRoot, getVitestLaneContextFileName());
  fs.mkdirSync(lease.leaseRoot, { recursive: true });
  fs.writeFileSync(
    contextPath,
    JSON.stringify({
      leaseId: lease.leaseId,
      leaseRoot: lease.leaseRoot,
      laneId: lease.laneId,
      runId: lease.runId,
      ownerPid: lease.ownerPid,
      ownerStartTime: lease.ownerStartTime,
      vitestShard: process.env.VITEST_HEAVY_SHARD ?? '',
      lightLane: process.env.VITEST_CI_LIGHT_LANE === '1',
      writtenMs: Date.now(),
    }),
  );
}

export function writeVitestLaneLeaseContextFromEnv(): void {
  const leaseId = process.env.AO_TESTMODE_FLEET_LANE_LEASE_ID?.trim();
  const leaseRoot = process.env.OPK_TESTMODE_LEASE_ROOT?.trim();
  if (!leaseId || !leaseRoot) {
    return;
  }
  writeVitestLaneLeaseContext({
    leaseId,
    leaseRoot,
    laneId: process.env.VITEST_HEAVY_SHARD
      ? `heavy-shard-${process.env.VITEST_HEAVY_SHARD}`
      : process.env.VITEST_CI_LIGHT_LANE === '1'
        ? 'light-lane'
        : 'default-lane',
    runId: process.env.GITHUB_RUN_ID ? `gh-${process.env.GITHUB_RUN_ID}` : `local-${process.pid}`,
    ownerPid: process.pid,
    ownerStartTime: getProcessStartTimeIdentity(process.pid),
  });
}

export function runReaperCli(
  action: string,
  args: Record<string, string | number> = {},
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
  const argv = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    reaperScript,
    action,
  ];
  for (const [key, value] of Object.entries(args)) {
    if (key === 'LeaseId') {
      argv.push('-LeaseId', String(value));
    } else if (key === 'RunId') {
      argv.push('-RunId', String(value));
    } else if (key === 'LaneId') {
      argv.push('-LaneId', String(value));
    } else if (key === 'WorkspaceRoot') {
      argv.push('-WorkspaceRoot', String(value));
    } else if (key === 'StateRoot') {
      argv.push('-StateRoot', String(value));
    } else if (key === 'OwnerPid') {
      argv.push('-OwnerPid', String(value));
    } else if (key === 'OwnerStartTime') {
      argv.push('-OwnerStartTime', String(value));
    }
  }
  const result = spawnSync('pwsh', argv, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status: result.status,
  };
}

export function registerLaneLease(options: {
  leaseRoot?: string;
  runId?: string;
  laneId?: string;
  ownerPid?: number;
  workspaceRoot?: string;
} = {}): LaneLease {
  const leaseRoot = options.leaseRoot ?? process.env.OPK_TESTMODE_LEASE_ROOT?.trim() ?? getDefaultLeaseRoot();
  const { stdout, status } = runReaperCli(
    'register-lane',
    {
      RunId: options.runId ?? `vitest-${process.pid}`,
      LaneId: options.laneId ?? process.env.VITEST_HEAVY_SHARD ?? 'lane-0',
      OwnerPid: options.ownerPid ?? process.pid,
      WorkspaceRoot: options.workspaceRoot ?? repoRoot,
    },
    { OPK_TESTMODE_LEASE_ROOT: leaseRoot },
  );
  if (status !== 0) {
    throw new Error(`register-lane failed: ${stdout}`);
  }
  const parsed = JSON.parse(stdout) as LaneLease;
  process.env.OPK_TESTMODE_LEASE_ROOT = leaseRoot;
  process.env.AO_TESTMODE_FLEET_LANE_LEASE_ID = parsed.leaseId;
  writeVitestLaneLeaseContext({ ...parsed, leaseRoot });
  return { ...parsed, leaseRoot };
}

export function getProcessStartTimeIdentity(pid: number): string {
  if (pid <= 0) {
    return '';
  }
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) {
      return '';
    }
    const fields = stat.slice(close + 2).split(/\s+/);
    return fields[19] ?? '';
  }
  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-Command',
    `. '${path.join(repoRoot, 'scripts/lib/TestMode-FleetLease.ps1').replace(/'/g, "''")}'; Write-Output (Get-ProcessStartTimeIdentity -ProcessId ${pid})`,
  ], { encoding: 'utf8' });
  return (result.stdout ?? '').trim();
}

export function writeCorruptLeaseRecord(leaseRoot: string, leaseId: string): void {
  const dir = path.join(leaseRoot, 'leases');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${leaseId}.json`), '{ truncated');
  const indexPath = path.join(leaseRoot, 'index.json');
  const index = fs.existsSync(indexPath)
    ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { leaseIds?: string[] }
    : { leaseIds: [] };
  if (!index.leaseIds?.includes(leaseId)) {
    index.leaseIds = [...(index.leaseIds ?? []), leaseId];
    fs.writeFileSync(indexPath, JSON.stringify(index));
  }
}

export function seedStaleLeaseRecord(leaseRoot: string, stateRoot: string): LaneLease {
  const deadOwnerPid = 999_999_991;
  const record = {
    leaseId: `stale-${Date.now()}`,
    runId: 'prior-run',
    laneId: 'prior-lane',
    ownerPid: deadOwnerPid,
    ownerStartTime: '0',
    heartbeatMs: 0,
    progressCounter: 0,
    progressUpdatedMs: 0,
    createdMs: 0,
    workspaceRoot: repoRoot,
    stateRoots: [path.resolve(stateRoot)],
  };
  const leasesDir = path.join(leaseRoot, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  const target = path.join(leasesDir, `${record.leaseId}.json`);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record));
  fs.renameSync(temp, target);
  const indexPath = path.join(leaseRoot, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify({ leaseIds: [record.leaseId] }));
  fs.writeFileSync(path.join(stateRoot, 'testmode-lane-lease.id'), record.leaseId);
  return { ...record, leaseRoot };
}

export function countTestModeTaggedPwsh(markerDir?: string): number {
  const result = spawnSync(
    'pgrep',
    ['-a', 'pwsh'],
    { encoding: 'utf8' },
  );
  const lines = (result.stdout ?? '').split('\n').filter(Boolean);
  if (!markerDir) {
    return lines.length;
  }
  return lines.filter((line) => line.includes(markerDir)).length;
}

export function killProcess(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ignore
  }
}

export { isAlive } from './supervisor-recovery.test-helpers.js';

export function runPwshFile(script: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

export function touchLeaseProgress(): void {
  const leaseId = process.env.AO_TESTMODE_FLEET_LANE_LEASE_ID;
  if (!leaseId) {
    return;
  }
  runReaperCli('progress', { LeaseId: leaseId });
}

export function touchLeaseHeartbeat(): void {
  const leaseId = process.env.AO_TESTMODE_FLEET_LANE_LEASE_ID;
  if (!leaseId) {
    return;
  }
  runReaperCli('heartbeat', { LeaseId: leaseId });
}

export { repoRoot, reaperScript };
