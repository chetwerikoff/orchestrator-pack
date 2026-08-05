import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import { FileEpochAuthority } from './cutover/activation-epoch-authority.ts';
import { readProcessIdentity } from './cutover/activation-cordon.ts';
import { writeDurableJson } from './cutover/activation-evidence.ts';
import { projectRegistry, validateSchedulerRegistry } from './cutover/activation-registry-projection.ts';
import {
  EMPTY_CRASH_BACKOFF_STATE,
  recordChildExit,
  restartDecisionAt,
  type CrashBackoffState,
} from '../runtime/crash-backoff.ts';
import {
  acquireSingleInstanceLease,
  releaseSingleInstanceLease,
} from '../runtime/single-instance-lease.ts';

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
  crashBackoff: CrashBackoffState;
}

function statusPath(options: Pick<SupervisorOptions, 'stateDir'>): string {
  return path.join(options.stateDir, 'typescript-supervisor-status.json');
}

function supervisorLockPath(options: Pick<SupervisorOptions, 'stateDir'>): string {
  return path.join(options.stateDir, 'typescript-supervisor.lock');
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/**
 * Runtime-neutral side-process supervisor. The singleton lease binds to the
 * exact supervisor process generation. Child restart backoff is a pure
 * TypeScript transition and never derives health from AO or another daemon.
 */
export async function runSupervisor(options: SupervisorOptions): Promise<never> {
  const self = readProcessIdentity(process.pid);
  if (!self) throw new Error('supervisor_process_identity_unreadable');
  const lease = acquireSingleInstanceLease({
    lockDir: supervisorLockPath(options),
    metadata: { epochId: options.epochId, nonce: options.nonce },
  });
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
    crashBackoff: EMPTY_CRASH_BACKOFF_STATE,
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

  try {
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
      const beforeRestart = restartDecisionAt(state.crashBackoff, Date.now());
      if (!beforeRestart.restartAllowed) {
        if (beforeRestart.reason === 'terminal') {
          state.restartState = 'refused';
          state.refusalReason = beforeRestart.terminalReason ?? 'supervisor_child_terminal_crash_loop';
          writeStatus(options, state);
          throw new Error(state.refusalReason);
        }
        state.restartState = 'waiting-restart';
        writeStatus(options, state);
        await delay(beforeRestart.waitMs);
        if (stopping) break;
      }

      const registry = validateSchedulerRegistry(readFileSync(options.projectedRegistryPath));
      const child = registry.children[0];
      const schedulerPath = path.join(options.repoRoot, 'scripts', child.script);
      currentAbort = new AbortController();
      state.childGeneration += 1;
      state.restartState = 'starting';
      writeStatus(options, state);
      let childStartedAtMs = 0;
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
          childStartedAtMs = Date.now();
          state.childPid = pid;
          state.lastChildStartAt = new Date(childStartedAtMs).toISOString();
          state.restartState = 'running';
          writeStatus(options, state);
        },
      });
      currentAbort = null;
      state.childPid = null;
      if (stopping) break;
      state.childRestarts += 1;
      const exitedAtMs = Date.now();
      const crash = recordChildExit({
        previous: state.crashBackoff,
        startedAtMs: childStartedAtMs,
        exitedAtMs,
        progressObserved: result.ok,
      });
      state.crashBackoff = {
        rapidExits: crash.rapidExits,
        backoffUntilMs: crash.backoffUntilMs,
        lastExitMs: crash.lastExitMs,
        terminal: crash.terminal,
        terminalReason: crash.terminalReason,
      };
      state.restartState = crash.terminal ? 'refused' : 'waiting-restart';
      state.refusalReason = crash.terminal
        ? crash.terminalReason
        : result.ok
          ? null
          : `scheduler_child_${result.outcome}:${result.error ?? result.stderr ?? result.exitCode ?? 'unknown'}`;
      writeStatus(options, state);
      if (crash.terminal) throw new Error(crash.terminalReason ?? 'supervisor_child_terminal_crash_loop');
      const cadenceDelay = options.restartDelayMs ?? verified.cadenceSeconds * 1_000;
      await delay(Math.max(cadenceDelay, crash.waitMs));
    }
    state.childPid = null;
    state.restartState = 'stopping';
    writeStatus(options, state);
  } finally {
    releaseSingleInstanceLease(lease);
  }
  process.exit(0);
  throw new Error('unreachable');
}
