import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import { FileEpochAuthority } from './cutover/activation-epoch-authority.ts';
import { readProcessIdentity } from './cutover/activation-cordon.ts';
import { writeDurableJson } from './cutover/activation-evidence.ts';
import { projectRegistry, validateSchedulerRegistry } from './cutover/activation-registry-projection.ts';
import { sha256Bytes } from './cutover/stable-stringify.ts';
import {
  EMPTY_CRASH_BACKOFF_STATE,
  crashBackoffPolicyFromEnv,
  recordChildExit,
  restartDecisionAt,
  type CrashBackoffPolicy,
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

interface SupervisorStatusBase {
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
  consecutiveStallTerminations: number;
  lastTerminationReason: string | null;
}

/** Current truthful-liveness status. A running child is live only with matching startTicks. */
export interface SupervisorStatus extends SupervisorStatusBase {
  schemaVersion: 2;
  childStartTicks: string | null;
}

/** Persisted pre-#1484 status is readable for diagnosis but never proves current liveness. */
export interface LegacySupervisorStatus extends SupervisorStatusBase {
  schemaVersion: 1;
  childStartTicks?: never;
}

export type SupervisorStatusRecord = SupervisorStatus | LegacySupervisorStatus;

export interface SupervisorChildProcessResult {
  readonly ok: boolean;
  readonly outcome: string;
  readonly error?: string | null;
  readonly stderr?: string | null;
  readonly exitCode?: number | null;
}

export interface SupervisorChildExitTransition {
  readonly crashBackoff: CrashBackoffState;
  readonly restartState: 'waiting-restart' | 'refused';
  readonly refusalReason: string | null;
  readonly waitMs: number;
}

function statusPath(options: Pick<SupervisorOptions, 'stateDir'>): string {
  return path.join(options.stateDir, 'typescript-supervisor-status.json');
}

function supervisorLockPath(options: Pick<SupervisorOptions, 'stateDir'>): string {
  return path.join(options.stateDir, 'typescript-supervisor.lock');
}

function verifyEpochAndProjection(options: SupervisorOptions): { registryHash: string; cadenceSeconds: number; stallGraceMultiplier: number } {
  const core = new FileEpochAuthority(options.epochAuthorityPath).verify(options.epochId, options.nonce);
  const projected = projectRegistry(options.targetRegistryPath, options.projectedRegistryPath);
  if (projected.registryHash !== core.registryHash) throw new Error('supervisor_registry_hash_mismatch');
  const registry = validateSchedulerRegistry(readFileSync(options.projectedRegistryPath), { requireStallGraceMultiplier: true });
  return {
    registryHash: projected.registryHash,
    cadenceSeconds: registry.children[0].cadenceSeconds,
    stallGraceMultiplier: registry.children[0].stallGraceMultiplier,
  };
}

function writeStatus(options: SupervisorOptions, value: SupervisorStatus): void {
  writeDurableJson(statusPath(options), value);
}

export function readSupervisorStatus(options: Pick<SupervisorOptions, 'stateDir'>): SupervisorStatusRecord | null {
  const file = statusPath(options);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as SupervisorStatusRecord;
}

export function processIdentityMatches(pid: number, startTicks: string | null | undefined): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || typeof startTicks !== 'string' || !startTicks.trim()) return false;
  try {
    return readProcessIdentity(pid).startTicks === startTicks;
  } catch {
    return false;
  }
}

/** `supervisor-process-alive`: exact schema-v2 supervisor PID/start-ticks identity. */
export function isLiveSupervisorStatus(status: SupervisorStatusRecord | null): status is SupervisorStatus {
  return Boolean(
    status
    && status.schemaVersion === 2
    && processIdentityMatches(status.supervisorPid, status.supervisorStartTicks),
  );
}

/** Strict instantaneous child occupancy. Do not broaden this predicate to inter-tick health. */
export function isLiveRunningSupervisorChild(status: SupervisorStatus): boolean {
  return status.restartState === 'running'
    && status.childPid !== null
    && processIdentityMatches(status.childPid, status.childStartTicks);
}

/**
 * Reads the exact registry bytes accepted by this supervisor generation and
 * returns their scheduler cadence only when source, hash, and schema all still
 * agree. Callers fail closed on configuration drift or unreadable bytes.
 */
export function readBoundSchedulerCadenceSeconds(status: SupervisorStatus): number | null {
  if (typeof status.registryHash !== 'string' || !status.registryHash.trim()) return null;
  if (typeof status.registrySource !== 'string' || !status.registrySource.trim()) return null;
  try {
    const bytes = readFileSync(status.registrySource);
    if (sha256Bytes(bytes) !== status.registryHash) return null;
    return validateSchedulerRegistry(bytes).children[0].cadenceSeconds;
  } catch {
    return null;
  }
}

/** Concrete failed-child evidence. `lastExitMs` alone is progress/recency evidence, not failure. */
export function hasSchedulerChildFailureEvidence(status: SupervisorStatus): boolean {
  const crash = status.crashBackoff;
  if (!crash || typeof crash !== 'object') return true;
  return status.refusalReason !== null
    || !Number.isInteger(crash.rapidExits)
    || crash.rapidExits !== 0
    || !Number.isFinite(crash.backoffUntilMs)
    || crash.backoffUntilMs !== 0
    || crash.terminal !== false
    || crash.terminalReason !== null;
}

/**
 * `scheduler-operational`: a live supervisor has either a strict live scheduler
 * child or a clean, bounded post-success one-shot transition. Non-running
 * recency is anchored at the existing successful-exit `lastExitMs` and remains
 * valid through two exact hash-bound cadence intervals: the normal cadence plus
 * one fixed wake/resume/status-publication allowance.
 */
export function isSchedulerOperational(
  statusRecord: SupervisorStatusRecord | null,
  nowMs: number = Date.now(),
): statusRecord is SupervisorStatus {
  if (!isLiveSupervisorStatus(statusRecord)) return false;
  const status = statusRecord;
  if (hasSchedulerChildFailureEvidence(status)) return false;
  const cadenceSeconds = readBoundSchedulerCadenceSeconds(status);
  if (cadenceSeconds === null) return false;

  if (status.restartState === 'running') {
    return isLiveRunningSupervisorChild(status);
  }
  if (status.restartState !== 'waiting-restart') return false;
  if (status.childPid !== null || status.childStartTicks !== null) return false;
  if (!Number.isInteger(status.childGeneration) || status.childGeneration < 1) return false;
  if (!Number.isInteger(status.childRestarts) || status.childRestarts < 1) return false;

  const lastExitMs = status.crashBackoff.lastExitMs;
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastExitMs) || lastExitMs <= 0) return false;
  const ageMs = nowMs - lastExitMs;
  return ageMs >= 0 && ageMs <= 2 * cadenceSeconds * 1_000;
}

/**
 * One pure application of the existing crash-backoff policy to a completed
 * scheduler child. Production and tests share this transition so terminal fuse
 * classification cannot overwrite the concrete child failure that triggered it.
 */
export function supervisorChildExitTransition(input: {
  readonly previous: CrashBackoffState;
  readonly startedAtMs: number;
  readonly exitedAtMs: number;
  readonly result: SupervisorChildProcessResult;
  readonly policy?: CrashBackoffPolicy;
}): SupervisorChildExitTransition {
  const crash = recordChildExit({
    previous: input.previous,
    startedAtMs: input.startedAtMs,
    exitedAtMs: input.exitedAtMs,
    progressObserved: input.result.ok,
    ...(input.policy ? { policy: input.policy } : {}),
  });
  const crashBackoff: CrashBackoffState = {
    rapidExits: crash.rapidExits,
    backoffUntilMs: crash.backoffUntilMs,
    lastExitMs: crash.lastExitMs,
    terminal: crash.terminal,
    terminalReason: crash.terminalReason,
  };
  const concreteCause = input.result.ok
    ? null
    : `scheduler_child_${input.result.outcome}:${input.result.error ?? input.result.stderr ?? input.result.exitCode ?? 'unknown'}`;
  return {
    crashBackoff,
    restartState: crash.terminal ? 'refused' : 'waiting-restart',
    refusalReason: concreteCause ?? (crash.terminal ? crash.terminalReason : null),
    waitMs: crash.waitMs,
  };
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
  const lease = acquireSingleInstanceLease({
    lockDir: supervisorLockPath(options),
    metadata: { epochId: options.epochId, nonce: options.nonce },
  });
  const state: SupervisorStatus = {
    schemaVersion: 2,
    epochId: options.epochId,
    nonce: options.nonce,
    supervisorPid: process.pid,
    supervisorStartTicks: self.startTicks,
    registryHash: null,
    registrySource: path.resolve(options.targetRegistryPath),
    childId: 'pr2-scheduler',
    childPid: null,
    childStartTicks: null,
    childGeneration: 0,
    childRestarts: 0,
    restartState: 'starting',
    startedAt: new Date().toISOString(),
    lastChildStartAt: null,
    cordonReason: 'post-cas-epoch-owner',
    refusalReason: null,
    crashBackoff: EMPTY_CRASH_BACKOFF_STATE,
    consecutiveStallTerminations: 0,
    lastTerminationReason: null,
  };
  const stallTerminalLimit = crashBackoffPolicyFromEnv().terminalRapidExits;
  const verify = (): { registryHash: string; cadenceSeconds: number; stallGraceMultiplier: number } => {
    try {
      const verified = verifyEpochAndProjection(options);
      state.registryHash = verified.registryHash;
      state.refusalReason = null;
      return verified;
    } catch (error) {
      state.restartState = 'refused';
      state.childPid = null;
      state.childStartTicks = null;
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
          state.refusalReason ??= beforeRestart.terminalReason ?? 'supervisor_child_terminal_crash_loop';
          writeStatus(options, state);
          throw new Error(state.refusalReason);
        }
        state.restartState = 'waiting-restart';
        writeStatus(options, state);
        await delay(beforeRestart.waitMs);
        if (stopping) break;
      }

      const registry = validateSchedulerRegistry(readFileSync(options.projectedRegistryPath), { requireStallGraceMultiplier: true });
      const child = registry.children[0];
      const schedulerPath = path.join(options.repoRoot, 'scripts', child.script);
      currentAbort = new AbortController();
      state.childGeneration += 1;
      state.childPid = null;
      state.childStartTicks = null;
      state.restartState = 'starting';
      writeStatus(options, state);
      let childStartedAtMs = 0;
      let stallTerminationRequested = false;
      let stallDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const stallDeadlineMs = verified.cadenceSeconds * verified.stallGraceMultiplier * 1_000;
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
          stallDeadlineTimer = setTimeout(() => {
            if (stopping || currentAbort === null) return;
            stallTerminationRequested = true;
            currentAbort.abort();
          }, stallDeadlineMs);
          stallDeadlineTimer.unref();
          state.childPid = pid;
          try {
            state.childStartTicks = readProcessIdentity(pid).startTicks;
          } catch {
            state.childStartTicks = null;
          }
          state.lastChildStartAt = new Date(childStartedAtMs).toISOString();
          state.restartState = 'running';
          writeStatus(options, state);
        },
      });
      if (stallDeadlineTimer !== undefined) clearTimeout(stallDeadlineTimer);
      currentAbort = null;
      state.childPid = null;
      state.childStartTicks = null;
      if (stopping) break;
      state.childRestarts += 1;
      if (stallTerminationRequested && result.cancelled) {
        state.consecutiveStallTerminations += 1;
        state.lastTerminationReason = 'stall_terminated';
        state.restartState = 'waiting-restart';
        state.refusalReason = null;
        writeStatus(options, state);
        if (state.consecutiveStallTerminations >= stallTerminalLimit) {
          state.restartState = 'refused';
          state.refusalReason = 'scheduler_child_stall_loop';
          writeStatus(options, state);
          throw new Error(state.refusalReason);
        }
        const cadenceDelay = options.restartDelayMs ?? verified.cadenceSeconds * 1_000;
        await delay(cadenceDelay);
        continue;
      }
      state.consecutiveStallTerminations = 0;
      state.lastTerminationReason = result.ok ? 'completed' : `scheduler_child_${result.outcome}`;
      const transition = supervisorChildExitTransition({
        previous: state.crashBackoff,
        startedAtMs: childStartedAtMs,
        exitedAtMs: Date.now(),
        result,
      });
      state.crashBackoff = transition.crashBackoff;
      state.restartState = transition.restartState;
      state.refusalReason = transition.refusalReason;
      writeStatus(options, state);
      if (transition.crashBackoff.terminal) {
        throw new Error(state.refusalReason ?? transition.crashBackoff.terminalReason ?? 'supervisor_child_terminal_crash_loop');
      }
      const cadenceDelay = options.restartDelayMs ?? verified.cadenceSeconds * 1_000;
      await delay(Math.max(cadenceDelay, transition.waitMs));
    }
    state.childPid = null;
    state.childStartTicks = null;
    state.restartState = 'stopping';
    writeStatus(options, state);
  } finally {
    releaseSingleInstanceLease(lease);
  }
  process.exit(0);
  throw new Error('unreachable');
}
