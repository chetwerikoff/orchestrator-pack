import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { FileEpochAuthority } from './cutover/activation-epoch-authority.ts';
import { projectRegistry, validateSchedulerRegistry } from './cutover/activation-registry-projection.ts';

export interface SupervisorOptions {
  stateDir: string;
  repoRoot: string;
  epochAuthorityPath: string;
  epochId: string;
  nonce: string;
  targetRegistryPath: string;
  projectedRegistryPath: string;
  restartDelayMs?: number;
}

export interface SupervisorStatus {
  schemaVersion: 1;
  epochId: string;
  nonce: string;
  supervisorPid: number;
  childPid: number | null;
  childRestarts: number;
  startedAt: string;
  lastChildStartAt: string | null;
}

function statusPath(options: SupervisorOptions): string {
  return path.join(options.stateDir, 'typescript-supervisor-status.json');
}

function verifyEpochAndProjection(options: SupervisorOptions): void {
  const core = new FileEpochAuthority(options.epochAuthorityPath).verify(options.epochId, options.nonce);
  const projected = projectRegistry(options.targetRegistryPath, options.projectedRegistryPath);
  if (projected.registryHash !== core.registryHash) throw new Error('supervisor_registry_hash_mismatch');
  validateSchedulerRegistry(readFileSync(options.projectedRegistryPath));
}

function writeStatus(options: SupervisorOptions, value: SupervisorStatus): void {
  mkdirSync(options.stateDir, { recursive: true });
  writeFileSync(statusPath(options), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readSupervisorStatus(options: Pick<SupervisorOptions, 'stateDir'>): SupervisorStatus | null {
  const file = path.join(options.stateDir, 'typescript-supervisor-status.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as SupervisorStatus;
}

export async function runSupervisor(options: SupervisorOptions): Promise<never> {
  verifyEpochAndProjection(options);
  const registry = validateSchedulerRegistry(readFileSync(options.projectedRegistryPath));
  const child = registry.children[0];
  const schedulerPath = path.join(options.repoRoot, 'scripts', child.script);
  const state: SupervisorStatus = {
    schemaVersion: 1,
    epochId: options.epochId,
    nonce: options.nonce,
    supervisorPid: process.pid,
    childPid: null,
    childRestarts: 0,
    startedAt: new Date().toISOString(),
    lastChildStartAt: null,
  };
  let stopping = false;
  let current: ChildProcess | null = null;
  const stop = (): void => {
    stopping = true;
    current?.kill('SIGTERM');
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  while (!stopping) {
    verifyEpochAndProjection(options);
    current = spawn(process.execPath, ['--experimental-strip-types', schedulerPath, 'run'], {
      cwd: options.repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: options.epochAuthorityPath,
        ORCHESTRATOR_CUTOVER_EPOCH_ID: options.epochId,
        ORCHESTRATOR_CUTOVER_NONCE: options.nonce,
        ORCHESTRATOR_CUTOVER_STATE_DIR: options.stateDir,
      },
    });
    state.childPid = current.pid ?? null;
    state.lastChildStartAt = new Date().toISOString();
    writeStatus(options, state);
    await new Promise<void>((resolve) => current!.once('exit', () => resolve()));
    state.childPid = null;
    writeStatus(options, state);
    if (stopping) break;
    state.childRestarts += 1;
    await new Promise((resolve) => setTimeout(resolve, options.restartDelayMs ?? 1_000));
  }
  process.exit(0);
  throw new Error('unreachable');
}
