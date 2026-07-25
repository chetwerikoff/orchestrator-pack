import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runProcess, type ProcessResult } from '../kernel/subprocess.ts';
import { JsonEpochAuthority } from './cutover/activation-epoch-authority.ts';
import { processStartTime } from './cutover/activation-platform-preflight.ts';
import { verifyRegistryHash, validateSchedulerRegistry } from './cutover/activation-registry-projection.ts';
import type { ProcessIdentity, RegistryChild, SchedulerRegistry } from './cutover/types.ts';

export interface SupervisorOptions {
  repoRoot: string;
  stateDir: string;
  registryPath: string;
  epochAuthorityFile: string;
  epochId: string;
  nonce: string;
  pollMs?: number;
  childEnv?: NodeJS.ProcessEnv;
}

export interface SupervisorStatus {
  epochId: string;
  registryHash: string;
  childId: string;
  supervisorPid: number | null;
  childPid: number | null;
  running: boolean;
}

interface ManagedScheduler {
  pid: number;
  controller: AbortController;
  completion: Promise<ProcessResult>;
  settled: boolean;
  result: ProcessResult | null;
}

const SUPERVISOR_LOCK = 'typescript-supervisor.lock';
const SUPERVISOR_OWNER = 'owner.json';
const CHILD_PID = 'typescript-supervisor-child.pid';

function childPidPath(stateDir: string): string { return resolve(stateDir, CHILD_PID); }
function supervisorLockDir(stateDir: string): string { return resolve(stateDir, SUPERVISOR_LOCK); }
function supervisorOwnerPath(stateDir: string): string { return join(supervisorLockDir(stateDir), SUPERVISOR_OWNER); }

function alive(identity: ProcessIdentity): boolean {
  try {
    process.kill(identity.pid, 0);
    return processStartTime(identity.pid) === identity.startTime;
  } catch {
    return false;
  }
}

export function loadCommittedRegistry(options: SupervisorOptions): { registry: SchedulerRegistry; registryHash: string; child: RegistryChild } {
  const authority = new JsonEpochAuthority(options.epochAuthorityFile);
  const core = authority.require(options.epochId, options.nonce);
  verifyRegistryHash(options.registryPath, core.registryHash);
  const registry = validateSchedulerRegistry(readFileSync(options.registryPath));
  return { registry, registryHash: core.registryHash, child: registry.children[0]! };
}

export function schedulerArgv(options: SupervisorOptions, child: RegistryChild): string[] {
  return [
    '--experimental-strip-types',
    resolve(options.repoRoot, 'scripts', child.script),
    '--supervised',
    '--repo-root', options.repoRoot,
    '--state-dir', options.stateDir,
    '--activation-epoch', options.epochId,
    '--activation-nonce', options.nonce,
    '--epoch-authority-file', options.epochAuthorityFile,
    '--registry-path', options.registryPath,
    ...(child.passProjectId ? ['--project-id', 'orchestrator-pack'] : []),
    ...(child.extraArgs ?? []),
  ];
}

export function startScheduler(options: SupervisorOptions, child: RegistryChild): ManagedScheduler {
  const controller = new AbortController();
  let pid = 0;
  const managed: ManagedScheduler = {
    pid: 0,
    controller,
    completion: Promise.resolve({
      outcome: 'spawn-failure', ok: false, exitCode: null, signal: null,
      stdout: '', stderr: '', timedOut: false, cancelled: false,
    }),
    settled: false,
    result: null,
  };
  managed.completion = runProcess({
    command: process.execPath,
    args: schedulerArgv(options, child),
    cwd: options.repoRoot,
    inheritParentEnv: true,
    env: {
      ...options.childEnv,
      OPK_ACTIVATION_EPOCH_ID: options.epochId,
      OPK_ACTIVATION_NONCE: options.nonce,
      ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: options.stateDir,
    },
    signal: controller.signal,
    allowEmptyStdout: true,
    onSpawn: (spawnedPid: number) => { pid = spawnedPid; managed.pid = spawnedPid; },
    onStdoutChunk: (chunk: string) => { process.stdout.write(chunk); },
    onStderrChunk: (chunk: string) => { process.stderr.write(chunk); },
  }).then((result: ProcessResult) => {
    managed.settled = true;
    managed.result = result;
    return result;
  });
  if (!pid) {
    controller.abort();
    throw new Error('scheduler_spawn_failed');
  }
  mkdirSync(options.stateDir, { recursive: true });
  writeFileSync(childPidPath(options.stateDir), `${pid}\n`, 'utf8');
  return managed;
}

function readSupervisorOwner(stateDir: string): ProcessIdentity | null {
  const path = supervisorOwnerPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ProcessIdentity;
    if (!Number.isInteger(value.pid) || value.pid <= 0 || !value.startTime) return null;
    return value;
  } catch {
    return null;
  }
}

export function acquireSupervisorSingleton(options: SupervisorOptions): ProcessIdentity {
  mkdirSync(options.stateDir, { recursive: true });
  const lock = supervisorLockDir(options.stateDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock);
      const identity: ProcessIdentity = { pid: process.pid, startTime: processStartTime(process.pid), role: 'typescript-supervisor' };
      writeFileSync(supervisorOwnerPath(options.stateDir), `${JSON.stringify(identity)}\n`, 'utf8');
      return identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = readSupervisorOwner(options.stateDir);
      if (owner && alive(owner)) throw new Error(`typescript_supervisor_already_running:${owner.pid}`);
      rmSync(lock, { recursive: true, force: true });
    }
  }
  throw new Error('typescript_supervisor_singleton_unavailable');
}

export function releaseSupervisorSingleton(options: SupervisorOptions, owner: ProcessIdentity): void {
  const current = readSupervisorOwner(options.stateDir);
  if (current && current.pid === owner.pid && current.startTime === owner.startTime) {
    rmSync(supervisorLockDir(options.stateDir), { recursive: true, force: true });
  }
}

export function status(options: SupervisorOptions): SupervisorStatus {
  const { registryHash, child } = loadCommittedRegistry(options);
  const owner = readSupervisorOwner(options.stateDir);
  let childPid: number | null = null;
  const file = childPidPath(options.stateDir);
  if (existsSync(file)) {
    const parsed = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) childPid = parsed;
  }
  let childRunning = false;
  if (childPid) {
    try { process.kill(childPid, 0); childRunning = true; } catch { childRunning = false; }
  }
  return {
    epochId: options.epochId,
    registryHash,
    childId: child.id,
    supervisorPid: owner && alive(owner) ? owner.pid : null,
    childPid,
    running: Boolean(owner && alive(owner) && childRunning),
  };
}

export function stop(options: SupervisorOptions): void {
  const current = status(options);
  if (current.childPid) {
    try { process.kill(current.childPid, 'SIGTERM'); } catch { /* already exited */ }
  }
  if (current.supervisorPid && current.supervisorPid !== process.pid) {
    try { process.kill(current.supervisorPid, 'SIGTERM'); } catch { /* already exited */ }
  }
  rmSync(childPidPath(options.stateDir), { force: true });
}

export async function supervise(options: SupervisorOptions, signal?: AbortSignal): Promise<void> {
  const pollMs = Math.max(100, options.pollMs ?? 1000);
  const { child } = loadCommittedRegistry(options);
  let active: ManagedScheduler | null = null;
  while (!signal?.aborted) {
    new JsonEpochAuthority(options.epochAuthorityFile).require(options.epochId, options.nonce);
    const latest = loadCommittedRegistry(options);
    if (latest.child.id !== child.id || latest.child.script !== child.script) throw new Error('scheduler_registry_identity_changed');
    if (!active || active.settled) {
      if (active?.result && active.result.ok === false && active.result.cancelled === false) {
        process.stderr.write(`scheduler_exit:${active.result.outcome}:${active.result.exitCode ?? 'none'}\n`);
      }
      active = startScheduler(options, child);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  if (active && !active.settled) {
    active.controller.abort();
    await active.completion;
  }
  rmSync(childPidPath(options.stateDir), { force: true });
}

export async function runSupervisorOwned(options: SupervisorOptions, signal?: AbortSignal): Promise<void> {
  const owner = acquireSupervisorSingleton(options);
  try {
    await supervise(options, signal);
  } finally {
    releaseSupervisorSingleton(options, owner);
  }
}
