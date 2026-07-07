import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '..');
export const supervisorScript = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1');
export const fixtureDir = path.join(repoRoot, 'scripts/fixtures/orchestrator-wake-supervisor');

const supervisorHookTimeoutMs = 120_000;
const tmpRoots: string[] = [];

export const managedChildRoles = [
  'listener',
  'heartbeat',
  'review-trigger-reconcile',
  'review-trigger-reeval',
  'review-ready-report-state-seed',
  'ci-green-wake-reconcile',
  'review-run-recovery',
  'review-stuck-run-reaper',
  'review-start-claim-reaper',
  'ci-failure-notification-reconcile',
  'ci-failure-notification-reaction',
  'review-finding-delivery-confirm',
  'worker-message-submit-reconcile',
] as const;

export type ManagedChildRole = (typeof managedChildRoles)[number];

export type WakeMarker = {
  role: string;
  pid: number;
  orchestratorSessionId: string;
  projectId?: string;
};

export function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-supervisor-test-'));
  tmpRoots.push(dir);
  fs.mkdirSync(path.join(dir, 'markers'), { recursive: true });
  return dir;
}

export function cleanupSupervisorTests(): void {
  for (const root of tmpRoots.splice(0)) {
    try {
      execFileSync(
        'pwsh',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          supervisorScript,
          '-Action',
          'Stop',
          '-StateDir',
          root,
        ],
        { cwd: repoRoot, stdio: 'pipe', timeout: supervisorHookTimeoutMs },
      );
    } catch {
      // best effort
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function runSupervisor(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisorScript, ...args],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  for (const [key, previous] of Object.entries(savedEnv)) {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

export function startSupervisorBackground(
  stateDir: string,
  extraArgs: string[] = [],
  env: Record<string, string> = {},
): ChildProcess {
  const args = [
    '-Action',
    'Start',
    '-Foreground',
    '-TestMode',
    '-SkipInitialWait',
    '-StateDir',
    stateDir,
    '-PollSeconds',
    '1',
    ...extraArgs,
  ];
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  const child = spawn(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisorScript, ...args],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'ignore',
    },
  );
  child.on('exit', () => {
    for (const [key, previous] of Object.entries(savedEnv)) {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
  return child;
}

export async function waitForMarkers(
  stateDir: string,
  timeoutMs = 25_000,
  roles: readonly ManagedChildRole[] = managedChildRoles,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = roles.every((role) =>
      fs.existsSync(path.join(stateDir, 'markers', `${role}.marker.json`)),
    );
    if (ready) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for supervisor child markers: ${roles.join(', ')}`);
}

export async function waitForMarker(
  stateDir: string,
  role: string,
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(stateDir, 'markers', `${role}.marker.json`))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${role} marker`);
}

export async function readMarker(
  stateDir: string,
  role: ManagedChildRole | string,
  timeoutMs = 5000,
): Promise<WakeMarker> {
  const markerPath = path.join(stateDir, 'markers', `${role}.marker.json`);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (!fs.existsSync(markerPath)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      const raw = fs.readFileSync(markerPath, 'utf8').trim();
      if (!raw) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      return JSON.parse(raw) as WakeMarker;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError ?? new Error(`timed out reading ${role} marker at ${markerPath}`);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function countLogMatches(log: string, pattern: RegExp): number {
  return (log.match(pattern) ?? []).length;
}

export function readSupervisorLog(stateDir: string): string {
  const logPath = path.join(stateDir, 'supervisor.log');
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

export function readChildRecovery(
  stateDir: string,
  childId: string,
): Record<string, unknown> {
  const statePath = path.join(stateDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    return {};
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    childRecovery?: Record<string, Record<string, unknown>>;
  };
  return state.childRecovery?.[childId] ?? {};
}

export function readChildPid(stateDir: string, childId: string): number {
  const pidPath = path.join(stateDir, `${childId}.pid`);
  return Number(fs.readFileSync(pidPath, 'utf8').trim());
}

export async function waitForSupervisorLogMatch(
  stateDir: string,
  pattern: RegExp,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = readSupervisorLog(stateDir);
    if (pattern.test(log)) {
      return log;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timed out waiting for supervisor log match: ${pattern}`);
}

export function runPwsh(script: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

export function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
