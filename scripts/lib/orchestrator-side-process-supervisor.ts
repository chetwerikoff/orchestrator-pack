import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import type { OrchestrationMailReconcileResult } from '../cursor-unsent-composer-submit.ts';
import { SCHEDULER_MAIL_RECONCILE_OWNER_ENV } from '../pr2-foundation/scheduler.ts';
import { FileEpochAuthority } from './cutover/activation-epoch-authority.ts';
import { readProcessIdentity } from './cutover/activation-cordon.ts';
import { writeDurableJson } from './cutover/activation-evidence.ts';
import { projectRegistry, validateSchedulerRegistry } from './cutover/activation-registry-projection.ts';
import {
  EMPTY_CRASH_BACKOFF_STATE,
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
  orchestrationMailReconcile?: (signal: AbortSignal) => Promise<OrchestrationMailReconcileResult>;
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

export function isLiveSupervisorStatus(status: SupervisorStatusRecord | null): status is SupervisorStatus {
  return Boolean(
    status
    && status.schemaVersion === 2
    && processIdentityMatches(status.supervisorPid, status.supervisorStartTicks),
  );
}

export function isLiveRunningSupervisorChild(status: SupervisorStatus): boolean {
  return status.restartState === 'running'
    && status.childPid !== null
    && processIdentityMatches(status.childPid, status.childStartTicks);
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

async function runSupervisorMailReconcileProcess(
  options: Pick<SupervisorOptions, 'repoRoot'>,
  signal: AbortSignal,
): Promise<OrchestrationMailReconcileResult> {
  const result = await runProcess({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      path.join(options.repoRoot, 'scripts', 'cursor-unsent-composer-submit.ts'),
      '--reconcile',
      '--max-recipient-groups', '1',
      '--max-messages', '1',
    ],
    cwd: options.repoRoot,
    inheritParentEnv: true,
    signal,
    allowEmptyStdout: false,
    timeoutMs: 15_000,
  });
  if (!result.ok) throw new Error(`supervisor_mail_reconcile_${result.outcome}`);
  const line = result.stdout.trim().split(/\r?\n/u).at(-1) ?? '';
  if (!line) throw new Error("supervisor_mail_reconcile_empty_output");
  return JSON.parse(line) as OrchestrationMailReconcileResult;
}

export interface SupervisorMailReconcileLoop {
  stop(awaitPending: boolean): Promise<void>;
}

export function startSupervisorMailReconcileLoop(
  reconcile: (signal: AbortSignal) => Promise<OrchestrationMailReconcileResult>,
  intervalMs: number,
): SupervisorMailReconcileLoop {
  let stopped = false;
  let pending: Promise<void> | undefined;
  let pendingAbort: AbortController | undefined;
  const invoke = (): void => {
    if (stopped || pending) return;
    pending = Promise.resolve()
      .then(async () => {
        if (stopped) return;
        pendingAbort = new AbortController();
        await reconcile(pendingAbort.signal);
      })
      .catch(() => undefined)
      .finally(() => {
        pendingAbort = undefined;
        pending = undefined;
      });
  };
  invoke();
  const timer = setInterval(invoke, Math.max(1, intervalMs));
  timer.unref?.();
  return {
    async stop(awaitPending: boolean): Promise<void> {
      stopped = true;
      clearInterval(timer);
      pendingAbort?.abort();
      if (awaitPending && pending) await pending;
    },
  };
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
      state.childStartTicks = null;
      state.refusalReason = error instanceof Error ? error.message : String(error);
      writeStatus(options, state);
      throw error;
    }
  };

  let mailReconcileLoop: SupervisorMailReconcileLoop | undefined;
  try {
    const verified = verify();
    mailReconcileLoop = startSupervisorMailReconcileLoop(
      options.orchestrationMailReconcile
        ?? ((signal) => runSupervisorMailReconcileProcess(options, signal)),
      verified.cadenceSeconds * 1_000,
    );
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

      const registry = validateSchedulerRegistry(readFileSync(options.projectedRegistryPath));
      const child = registry.children[0];
      const schedulerPath = path.join(options.repoRoot, 'scripts', child.script);
      currentAbort = new AbortController();
      state.childGeneration += 1;
      state.childPid = null;
      state.childStartTicks = null;
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
          [SCHEDULER_MAIL_RECONCILE_OWNER_ENV]: 'supervisor',
        },
        signal: currentAbort.signal,
        allowEmptyStdout: true,
        onSpawn: (pid) => {
          childStartedAtMs = Date.now();
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
      currentAbort = null;
      state.childPid = null;
      state.childStartTicks = null;
      if (stopping) break;
      state.childRestarts += 1;
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
    await mailReconcileLoop?.stop(false);
    releaseSingleInstanceLease(lease);
  }
  process.exit(0);
  throw new Error('unreachable');
}
