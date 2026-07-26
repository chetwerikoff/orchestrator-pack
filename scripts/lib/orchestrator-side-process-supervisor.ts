import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import { FileEpochAuthority } from './cutover/activation-epoch-authority.ts';
import { readProcessIdentity } from './cutover/activation-cordon.ts';
import { writeDurableJson } from './cutover/activation-evidence.ts';
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
  supervisorStartTicks: string;
  registryHash: string | null;
  registrySource: string;
  childId: 'pr2-scheduler';
  childPid: number | null;
  childGeneration: number;
  childRestarts: number;
  restartState: 'starting' | 'running' | 'waiting-restart' | 'stopping' | 'refused';
  startedAt: string;
  lastChildStartAt: string | null;
  cordonReason: 'post-cas-epoch-owner';
  refusalReason: string | null;
}

function statusPath(options: Pick<SupervisorOptions, 'stateDir'>): string {
  return path.join(options.stateDir, 'typescript-supervisor-status.json');
}

function verifyEpochAndProjection(options: SupervisorOptions): { registryHash: string; cadenceSeconds: number } {
  const core = new FileEpochAuthority(options.epochAuthorityPath).verify(options.epochId, options.nonce);
  const projected = projectRegistry(options.targetRegistryPath, options.projectedRegistryPath);
  if (projected.registryHash !== core.registryHash) throw new Error('supervisor_registry_hash_mismatch');
  const registry = validateSchedulerRegistry(readFileSync(options.projectedRegistryPath));
  return { registryHash: projected.registryHash, cadenceSeconds: registry.children[0].cadenceSeconds };
}

function writeStatus(options: SupervisorOptions, value: SupervisorStatus): void {
  writeDurableJson(statusPath(options), value);
}

export function readSupervisorStatus(options: Pick<SupervisorOptions, 'stateDir'>): SupervisorStatus | null {
  const file = statusPath(options);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as SupervisorStatus;
}

export async function runSupervisor(options: SupervisorOptions): Promise<never> {
  const self = readProcessIdentity(process.pid);
  if (!self) throw new Error('supervisor_process_identity_unreadable');
  const state: SupervisorStatus = {
    schemaVersion: 1,
    epochId: options.epochId,
    nonce: options.nonce,
    supervisorPid: process.pid,
    supervisorStartTicks: self.startTicks,
    registryHash: null,
    registrySource: path.resolve(options.targetRegistryPath),
    childId: 'pr2-scheduler',
    childPid: null,
    childGeneration: 0,
    childRestarts: 0,
    restartState: 'starting',
    startedAt: new Date().toISOString(),
    lastChildStartAt: null,
    cordonReason: 'post-cas-epoch-owner',
    refusalReason: null,
  };
  const verify = (): { registryHash: string; cadenceSeconds: number } => {
    try {
      const verified = verifyEpochAndProjection(options);
      state.registryHash = verified.registryHash;
      state.refusalReason = null;
      return verified;
    } catch (error) {
      state.restartState = 'refused';
      state.childPid = null;
      state.refusalReason = error instanceof Error ? error.message : String(error);
      writeStatus(options, state);
      throw error;
    }
  };

  verify();
  writeStatus(options, state);
  let stopping = false;
  let currentAbort: AbortController | null = null;
  const stop = (): void => {
    stopping = true;
    state.restartState = 'stopping';
    writeStatus(options, state);
    currentAbort?.abort();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  while (!stopping) {
    const verified = verify();
    const registry = validateSchedulerRegistry(readFileSync(options.projectedRegistryPath));
    const child = registry.children[0];
    const schedulerPath = path.join(options.repoRoot, 'scripts', child.script);
    currentAbort = new AbortController();
    state.childGeneration += 1;
    state.restartState = 'starting';
    writeStatus(options, state);
    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', schedulerPath, 'tick'],
      cwd: options.repoRoot,
      inheritParentEnv: true,
      env: {
        ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: options.epochAuthorityPath,
        ORCHESTRATOR_CUTOVER_EPOCH_ID: options.epochId,
        ORCHESTRATOR_CUTOVER_NONCE: options.nonce,
        ORCHESTRATOR_CUTOVER_STATE_DIR: options.stateDir,
      },
      signal: currentAbort.signal,
      allowEmptyStdout: true,
      onSpawn: (pid) => {
        state.childPid = pid;
        state.lastChildStartAt = new Date().toISOString();
        state.restartState = 'running';
        writeStatus(options, state);
      },
    });
    currentAbort = null;
    state.childPid = null;
    if (stopping) break;
    state.childRestarts += 1;
    state.restartState = 'waiting-restart';
    state.refusalReason = result.ok ? null : `scheduler_child_${result.outcome}:${result.error ?? result.stderr ?? result.exitCode ?? 'unknown'}`;
    writeStatus(options, state);
    await new Promise((resolve) => setTimeout(resolve, options.restartDelayMs ?? verified.cadenceSeconds * 1_000));
  }
  state.childPid = null;
  state.restartState = 'stopping';
  writeStatus(options, state);
  process.exit(0);
  throw new Error('unreachable');
}
