import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { OrcaRuntimeAdapter } from '../orca-runtime/adapter.ts';
import {
  runOrcaJson,
  type OrcaJsonResponse,
  type OrcaTerminalSummary,
} from '../orca-runtime/native.ts';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import type {
  RuntimeCallOptions,
  RuntimeDispatchResult,
  RuntimeWorker,
  RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';

export const WORKER_SMOKE_RUN_RECEIPT_SCHEMA = 'worker-smoke-run/v1' as const;
export const WORKER_SMOKE_QUARANTINE_SCHEMA = 'worker-smoke-historical-quarantine/v1' as const;

export interface WorkerSmokeRunFailureReceipt {
  schema: typeof WORKER_SMOKE_RUN_RECEIPT_SCHEMA;
  result: 'FAIL';
  cause: {
    phase: 'bootstrap' | 'harness';
    code: string;
    detail: string;
    resolution: string;
  };
  binding?: {
    issueNumber: number;
    prNumber: number;
    headSha: string;
  };
  wrapper: {
    path: string;
    executable: boolean;
    launchFailure: 'none' | 'permission_denied';
  };
}

export type SmokeGenerationProbe = (
  terminalHandle: string,
  cwd: string,
  timeoutMs: number,
) => OrcaJsonResponse<{ terminal?: OrcaTerminalSummary }>;

export interface SmokeDeliveryBinding {
  runId: string;
  artifactDir: string;
  sealPath: string;
}

export type SmokeDeliveryProbe = (binding: SmokeDeliveryBinding) => boolean;

export type StableSpawnIdentityResult =
  | { ok: true; worker: RuntimeWorker; diagnostic?: string }
  | { ok: false; reason: string };

export interface StableWorkerSmokeSpawnPatchOptions {
  probe?: SmokeGenerationProbe;
  deliveryProbe?: SmokeDeliveryProbe;
  agentStartupProbe?: (lines: readonly string[]) => boolean;
  now?: () => number;
  sleepMs?: (milliseconds: number) => void;
  deliveryConfirmationTimeoutMs?: number;
}

export interface HistoricalSmokeQuarantine {
  runId: string;
  sourcePath: string;
  quarantinePath: string;
  cause: string;
}

interface TrackedSmokeWorkerRecord {
  readonly worker: RuntimeWorker;
  readonly originalIdentity: RuntimeWorkerIdentity;
  preserveOwnedPanelOnDeliveryFailure: boolean;
}

type TrackedSmokeWorkerRefresh =
  | { status: 'not_tracked' }
  | { status: 'ok'; worker: RuntimeWorker }
  | { status: 'failed'; reason: string };

type WorkerIdentityFailureCode =
  | 'worker_generation_mismatch'
  | 'worker_workspace_mismatch'
  | 'worker_generation_unresolved';

const patchedTaskAdapterPrototypes = new WeakSet<object>();
const spawnedSmokeWorkers = new WeakMap<object, TrackedSmokeWorkerRecord>();

const acceptedHistoricalStaleOutcomes = new Set([
  'close_failed:terminal_handle_stale',
  'close_failed:channel_stale_handle',
  'close_failed:unproven_channel_stale_handle',
]);

function safeToken(value: string): string {
  return encodeURIComponent(value.trim() || 'missing');
}

function samePath(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    const resolved = resolve(value).replaceAll('\\', '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return canonical(left) === canonical(right);
}

function generationFromTerminal(terminal: OrcaTerminalSummary): string {
  return terminal.incarnationId?.trim() || terminal.ptyId?.trim() || '';
}

function defaultGenerationProbe(
  terminalHandle: string,
  cwd: string,
  timeoutMs: number,
): OrcaJsonResponse<{ terminal?: OrcaTerminalSummary }> {
  return runOrcaJson<{ terminal?: OrcaTerminalSummary }>(
    ['terminal', 'show', '--terminal', terminalHandle],
    { cwd, timeoutMs },
  );
}

function defaultSleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function hasCursorAgentStartupBanner(lines: readonly string[]): boolean {
  return lines.some((line) => /^\s*Cursor Agent\s*$/u.test(line))
    && lines.some((line) => /^\s*v\d+\.\d+\./u.test(line));
}

/** Select the screen startup witness; OpenCode readiness is HTTP-backed. */
export function hasExecutorStartupBanner(command: string, lines: readonly string[]): boolean {
  const normalizedCommand = command.trim();
  if (/(?:^|\s)opencode(?:\s|$)/iu.test(normalizedCommand)) return false;
  if (/(?:^|\s)(?:cursor-agent|agent)(?:\s|$)/u.test(normalizedCommand)) {
    return hasCursorAgentStartupBanner(lines);
  }
  return false;
}

function defaultDeliveryProbe(binding: SmokeDeliveryBinding): boolean {
  try {
    if (!existsSync(binding.sealPath)) return false;
    const parsed = JSON.parse(readFileSync(binding.sealPath, 'utf8')) as { runId?: unknown };
    return String(parsed.runId ?? '').trim() === binding.runId;
  } catch {
    return false;
  }
}

export function smokeDeliveryBindingFromPrompt(prompt: string): SmokeDeliveryBinding | undefined {
  const runId = prompt.match(/^run-id:\s*(\S+)\s*$/mu)?.[1]?.trim() ?? '';
  const artifactDir = prompt.match(/^artifact-dir:\s*(.+?)\s*$/mu)?.[1]?.trim() ?? '';
  if (!runId || !artifactDir) return undefined;
  return {
    runId,
    artifactDir,
    sealPath: join(artifactDir, 'delivery.sealed.json'),
  };
}

function dispatchDiagnostic(result: RuntimeDispatchResult): string {
  return result.status === 'dispatched'
    ? 'dispatched'
    : `${result.status}:${safeToken(result.reason)}`;
}

function absenceProbeFailure(
  response: OrcaJsonResponse<{ terminal?: OrcaTerminalSummary }>,
): string {
  return [
    'owned_handle_absence_unproven',
    `operation=${safeToken(response.operation ?? 'terminal_show')}`,
    `outcome=${safeToken(response.outcomeCategory ?? 'unknown')}`,
    `code=${safeToken(response.error?.code ?? 'unknown')}`,
    'resolution=inspect_the_owned_terminal_handle_then_retry_cleanup',
  ].join(';');
}

export function workerIdentityFailureReason(input: {
  code: WorkerIdentityFailureCode;
  worker: RuntimeWorker;
  observedHandle?: string;
  observedGeneration?: string;
  observedWorkspace?: string;
  lookupFailure?: string;
}): string {
  return [
    input.code,
    `expected_runtime=${safeToken(input.worker.identity.runtime)}`,
    `expected_handle=${safeToken(input.worker.identity.id)}`,
    `expected_generation=${safeToken(input.worker.identity.generation)}`,
    `expected_workspace=${safeToken(input.worker.workspacePath)}`,
    `observed_handle=${safeToken(input.observedHandle ?? 'unresolved')}`,
    `observed_generation=${safeToken(input.observedGeneration ?? 'unresolved')}`,
    `observed_workspace=${safeToken(input.observedWorkspace ?? 'unresolved')}`,
    `identity_source=orca_terminal_show(${safeToken(input.worker.identity.id)})`,
    ...(input.lookupFailure ? [`lookup_failure=${safeToken(input.lookupFailure)}`] : []),
    'resolution=rerun_from_the_exact_pr_head_after_the_created_handle_identity_is_resolved',
  ].join(';');
}

function observeSmokeWorker(input: {
  worker: RuntimeWorker;
  cwd: string;
  timeoutMs: number;
  probe: SmokeGenerationProbe;
}):
  | { ok: true; observed: OrcaTerminalSummary; generation: string; diagnostic?: string }
  | { ok: false; reason: string } {
  const response = input.probe(input.worker.identity.id, input.cwd, input.timeoutMs);
  if (!response.ok) {
    return {
      ok: false,
      reason: workerIdentityFailureReason({
        code: 'worker_generation_unresolved',
        worker: input.worker,
        lookupFailure: `${response.operation ?? 'terminal_show'}:${response.error?.code ?? response.outcomeCategory ?? 'unavailable'}`,
      }),
    };
  }
  const observed = response.result?.terminal;
  if (!observed) {
    return {
      ok: false,
      reason: workerIdentityFailureReason({
        code: 'worker_generation_unresolved',
        worker: input.worker,
        lookupFailure: 'terminal_show:missing_terminal',
      }),
    };
  }
  const observedHandle = observed.handle?.trim() ?? '';
  const observedWorkspace = observed.worktreePath?.trim() ?? '';
  const observedGeneration = generationFromTerminal(observed);
  if (observedHandle !== input.worker.identity.id) {
    return {
      ok: false,
      reason: workerIdentityFailureReason({
        code: 'worker_generation_unresolved',
        worker: input.worker,
        observedHandle,
        observedGeneration,
        observedWorkspace,
        lookupFailure: 'terminal_show:handle_mismatch',
      }),
    };
  }
  if (!observedWorkspace || !samePath(observedWorkspace, input.worker.workspacePath)) {
    return {
      ok: false,
      reason: workerIdentityFailureReason({
        code: 'worker_workspace_mismatch',
        worker: input.worker,
        observedHandle,
        observedGeneration,
        observedWorkspace,
      }),
    };
  }
  if (!observedGeneration) {
    return {
      ok: false,
      reason: workerIdentityFailureReason({
        code: 'worker_generation_unresolved',
        worker: input.worker,
        observedHandle,
        observedWorkspace,
        lookupFailure: 'terminal_show:generation_missing',
      }),
    };
  }
  const observedTitle = observed.title ?? null;
  return {
    ok: true,
    observed,
    generation: observedGeneration,
    ...(observedTitle !== input.worker.title
      ? {
          diagnostic: `worker_title_drift;expected_title=${safeToken(input.worker.title ?? '')};observed_title=${safeToken(observedTitle ?? '')}`,
        }
      : {}),
  };
}

/** Establish and freeze the exact generation from one bounded exact-handle observation. */
export function stabilizeSpawnedSmokeWorkerIdentity(input: {
  worker: RuntimeWorker;
  cwd: string;
  timeoutMs: number;
  probe?: SmokeGenerationProbe;
}): StableSpawnIdentityResult {
  if (input.worker.identity.runtime !== 'orca') return { ok: true, worker: input.worker };
  const observed = observeSmokeWorker({
    worker: input.worker,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    probe: input.probe ?? defaultGenerationProbe,
  });
  if (!observed.ok) return observed;

  const identity: RuntimeWorkerIdentity = observed.generation === input.worker.identity.generation
    ? input.worker.identity
    : {
        runtime: input.worker.identity.runtime,
        id: input.worker.identity.id,
        generation: observed.generation,
      };
  const worker: RuntimeWorker = identity === input.worker.identity
    ? input.worker
    : { ...input.worker, identity };
  return {
    ok: true,
    worker,
    ...(observed.diagnostic ? { diagnostic: observed.diagnostic } : {}),
  };
}

function confirmSpawnedSmokeWorkerIdentity(input: {
  worker: RuntimeWorker;
  cwd: string;
  timeoutMs: number;
  probe: SmokeGenerationProbe;
}): StableSpawnIdentityResult {
  if (input.worker.identity.runtime !== 'orca') return { ok: true, worker: input.worker };
  const observed = observeSmokeWorker(input);
  if (!observed.ok) return observed;
  if (observed.generation !== input.worker.identity.generation) {
    return {
      ok: false,
      reason: workerIdentityFailureReason({
        code: 'worker_generation_mismatch',
        worker: input.worker,
        observedHandle: observed.observed.handle,
        observedGeneration: observed.generation,
        observedWorkspace: observed.observed.worktreePath,
      }),
    };
  }
  return {
    ok: true,
    worker: input.worker,
    ...(observed.diagnostic ? { diagnostic: observed.diagnostic } : {}),
  };
}

function refreshTrackedSmokeWorker(input: {
  identity: RuntimeWorkerIdentity;
  cwd: string;
  timeoutMs: number;
  probe: SmokeGenerationProbe;
}): TrackedSmokeWorkerRefresh {
  const tracked = spawnedSmokeWorkers.get(input.identity);
  if (!tracked) return { status: 'not_tracked' };
  const refreshed = confirmSpawnedSmokeWorkerIdentity({
    worker: tracked.worker,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    probe: input.probe,
  });
  if (!refreshed.ok) return { status: 'failed', reason: refreshed.reason };
  return { status: 'ok', worker: tracked.worker };
}

export function markTrackedSmokeWorkerDeliveryConfirmed(identity: RuntimeWorkerIdentity): void {
  const tracked = spawnedSmokeWorkers.get(identity);
  if (tracked) tracked.preserveOwnedPanelOnDeliveryFailure = false;
}

/**
 * Install the narrow worker-smoke compatibility repair on the production task
 * adapter. The first exact-handle observation establishes an immutable exact
 * identity; later observations only confirm it. Dispatch remains one actuation:
 * adapter ambiguity is preserved and child seal evidence is higher-level smoke
 * evidence only, never authority to rewrite the adapter dispatch result.
 */
export function installStableWorkerSmokeSpawnPatch(
  options: StableWorkerSmokeSpawnPatchOptions = {},
): () => void {
  const prototype = OrcaTaskRuntimeAdapter.prototype;
  const basePrototype = OrcaRuntimeAdapter.prototype;
  if (patchedTaskAdapterPrototypes.has(prototype)) return () => undefined;
  patchedTaskAdapterPrototypes.add(prototype);

  const originalBaseFind = basePrototype.findWorker;
  const originalSpawn = prototype.spawnWorker;
  const originalDispatch = prototype.dispatchInput;
  const originalReadBoundedOutput = prototype.readBoundedOutput;
  const originalLiveness = prototype.liveness;
  const originalStop = prototype.stopWorker;
  const probe = options.probe ?? defaultGenerationProbe;
  const deliveryProbe = options.deliveryProbe ?? defaultDeliveryProbe;
  const now = options.now ?? Date.now;
  const sleepMs = options.sleepMs ?? defaultSleep;

  Object.defineProperty(basePrototype, 'findWorker', {
    configurable: true,
    writable: true,
    value: function patchedFindWorker(
      this: OrcaRuntimeAdapter,
      identity: RuntimeWorkerIdentity,
      callOptions: RuntimeCallOptions = {},
    ): ReturnType<OrcaRuntimeAdapter['findWorker']> {
      const tracked = spawnedSmokeWorkers.get(identity);
      if (!tracked) return originalBaseFind.call(this, identity, callOptions);
      const refreshed = confirmSpawnedSmokeWorkerIdentity({
        worker: tracked.worker,
        cwd: callOptions.cwd ?? tracked.worker.workspacePath,
        timeoutMs: callOptions.timeoutMs ?? 30_000,
        probe,
      });
      if (!refreshed.ok) {
        if (refreshed.reason.startsWith('worker_generation_mismatch;')) {
          return { status: 'ok', value: null };
        }
        return { status: 'failed', operation: 'find_worker', reason: refreshed.reason };
      }
      return { status: 'ok', value: tracked.worker };
    },
  });

  Object.defineProperty(prototype, 'spawnWorker', {
    configurable: true,
    writable: true,
    value: function patchedSpawnWorker(
      this: OrcaTaskRuntimeAdapter,
      input: Parameters<OrcaTaskRuntimeAdapter['spawnWorker']>[0],
      callOptions: RuntimeCallOptions = {},
    ): ReturnType<OrcaTaskRuntimeAdapter['spawnWorker']> {
      const result = originalSpawn.call(this, input, callOptions);
      if (result.status !== 'ok') return result;
      const agentStartupProbe = options.agentStartupProbe
        ?? ((lines: readonly string[]) => hasExecutorStartupBanner(input.command, lines));
      const stabilized = stabilizeSpawnedSmokeWorkerIdentity({
        worker: result.value,
        cwd: callOptions.cwd ?? result.value.workspacePath,
        timeoutMs: callOptions.timeoutMs ?? 30_000,
        probe,
      });
      if (!stabilized.ok) {
        return { status: 'failed', operation: 'spawn_worker', reason: stabilized.reason };
      }
      const tracked: TrackedSmokeWorkerRecord = {
        worker: stabilized.worker,
        originalIdentity: result.value.identity,
        preserveOwnedPanelOnDeliveryFailure: false,
      };
      spawnedSmokeWorkers.set(stabilized.worker.identity, tracked);
      spawnedSmokeWorkers.set(result.value.identity, tracked);
      if (options.agentStartupProbe) return { status: 'ok', value: stabilized.worker };

      const startupTimeoutMs = Math.max(2, callOptions.timeoutMs ?? 30_000);
      if (/(?:^|\s)opencode(?:\s|$)/iu.test(input.command)) {
        const startupDeadline = now() + startupTimeoutMs;
        let healthReason = 'runtime_opencode_control_unavailable';
        while (now() < startupDeadline) {
          const remaining = startupDeadline - now();
          const health = this.openCodeHealth(stabilized.worker.identity, {
            ...callOptions,
            timeoutMs: Math.max(1, Math.min(callOptions.timeoutMs ?? startupTimeoutMs, remaining)),
          });
          if (health.status === 'ok') return { status: 'ok', value: stabilized.worker };
          healthReason = health.reason;
          if (now() >= startupDeadline) break;
          sleepMs(Math.min(250, Math.max(1, startupDeadline - now())));
        }
        tracked.preserveOwnedPanelOnDeliveryFailure = true;
        return {
          status: 'failed',
          operation: 'spawn_worker',
          reason: [
            'worker_agent_not_started',
            `agent_health=${safeToken(healthReason === 'runtime_timeout' ? 'missing' : healthReason)}`,
            'command_submit=not_applicable',
            'pane_observation=not_used',
            'resolution=inspect_the_preserved_child_panel_then_retry_from_the_exact_pr_head',
          ].join(';'),
        };
      }

      const startupDeadline = now() + startupTimeoutMs;
      const startupRead = originalReadBoundedOutput.call(this, {
        worker: stabilized.worker.identity,
        limit: 200,
      }, callOptions);
      if (startupRead.status !== 'ok') {
        tracked.preserveOwnedPanelOnDeliveryFailure = true;
        return {
          status: 'failed',
          operation: 'spawn_worker',
          reason: [
            'worker_agent_start_observation_failed',
            `observation=${safeToken(startupRead.reason)}`,
            'agent_banner=unobserved',
            'resolution=inspect_the_preserved_child_panel_then_retry_from_the_exact_pr_head',
          ].join(';'),
        };
      }

      let startupLines = startupRead.value.lines;
      let startupToken = startupRead.value.observationToken;
      let startupSubmit: RuntimeDispatchResult = { status: 'dispatched' };
      if (!agentStartupProbe(startupLines)) {
        const remainingBeforeSubmit = startupDeadline - now();
        if (remainingBeforeSubmit <= 0) {
          tracked.preserveOwnedPanelOnDeliveryFailure = true;
          return {
            status: 'failed',
            operation: 'spawn_worker',
            reason: [
              'worker_agent_not_started',
              'agent_banner=missing',
              'command_submit=not_attempted',
              'pane_observation=unchanged_before_submit',
              'resolution=inspect_the_preserved_child_panel_then_retry_from_the_exact_pr_head',
            ].join(';'),
          };
        }
        sleepMs(Math.min(50, remainingBeforeSubmit));
        startupSubmit = originalDispatch.call(this, {
          worker: stabilized.worker.identity,
          submitOnly: true,
        }, {
          ...callOptions,
          timeoutMs: Math.max(
            1,
            Math.min(callOptions.timeoutMs ?? startupTimeoutMs, startupDeadline - now()),
          ),
        });
        if (startupSubmit.status === 'send_failed') {
          tracked.preserveOwnedPanelOnDeliveryFailure = true;
          return {
            status: 'failed',
            operation: 'spawn_worker',
            reason: [
              'worker_agent_start_failed',
              `command_submit=${safeToken(dispatchDiagnostic(startupSubmit))}`,
              'agent_banner=missing',
              'resolution=inspect_the_preserved_child_panel_then_retry_from_the_exact_pr_head',
            ].join(';'),
          };
        }

        while (now() < startupDeadline) {
          sleepMs(Math.min(250, Math.max(1, startupDeadline - now())));
          const remaining = startupDeadline - now();
          if (remaining <= 0) break;
          const observed = originalReadBoundedOutput.call(this, {
            worker: stabilized.worker.identity,
            previousToken: startupToken,
            limit: 200,
          }, {
            ...callOptions,
            timeoutMs: Math.max(
              1,
              Math.min(callOptions.timeoutMs ?? startupTimeoutMs, remaining),
            ),
          });
          if (observed.status !== 'ok') {
            // A subprocess can consume the remaining budget after this iteration
            // starts. The external deadline owns expiry; report a missing banner
            // after it, rather than masking it as an observation timeout.
            if (now() >= startupDeadline) break;
            if (observed.reason === 'runtime_timeout') continue;
            tracked.preserveOwnedPanelOnDeliveryFailure = true;
            return {
              status: 'failed',
              operation: 'spawn_worker',
              reason: [
                'worker_agent_start_observation_failed',
                `observation=${safeToken(observed.reason)}`,
                `command_submit=${safeToken(dispatchDiagnostic(startupSubmit))}`,
                'agent_banner=unobserved',
                'resolution=inspect_the_preserved_child_panel_then_retry_from_the_exact_pr_head',
              ].join(';'),
            };
          }
          startupLines = observed.value.lines;
          startupToken = observed.value.observationToken;
          if (agentStartupProbe(startupLines)) break;
        }
      }

      if (!agentStartupProbe(startupLines)) {
        tracked.preserveOwnedPanelOnDeliveryFailure = true;
        return {
          status: 'failed',
          operation: 'spawn_worker',
          reason: [
            'worker_agent_not_started',
            `command_submit=${safeToken(dispatchDiagnostic(startupSubmit))}`,
            'agent_banner=missing',
            'pane_observation=changed_without_agent_banner',
            'resolution=inspect_the_preserved_child_panel_then_retry_from_the_exact_pr_head',
          ].join(';'),
        };
      }
      return { status: 'ok', value: stabilized.worker };
    },
  });

  Object.defineProperty(prototype, 'dispatchInput', {
    configurable: true,
    writable: true,
    value: function patchedDispatchInput(
      this: OrcaTaskRuntimeAdapter,
      input: Parameters<OrcaTaskRuntimeAdapter['dispatchInput']>[0],
      callOptions: RuntimeCallOptions = {},
    ): RuntimeDispatchResult {
      const tracked = spawnedSmokeWorkers.get(input.worker);
      const refreshed = refreshTrackedSmokeWorker({
        identity: input.worker,
        cwd: callOptions.cwd ?? process.cwd(),
        timeoutMs: callOptions.timeoutMs ?? 30_000,
        probe,
      });
      if (refreshed.status === 'failed') {
        return { status: 'send_failed', reason: refreshed.reason };
      }

      const result = originalDispatch.call(this, input, callOptions);
      if (tracked && result.status === 'dispatch_unknown') {
        const binding = smokeDeliveryBindingFromPrompt(input.text ?? '');
        tracked.preserveOwnedPanelOnDeliveryFailure = !(binding && deliveryProbe(binding));
      }
      return result;
    },
  });

  Object.defineProperty(prototype, 'readBoundedOutput', {
    configurable: true,
    writable: true,
    value: function patchedReadBoundedOutput(
      this: OrcaTaskRuntimeAdapter,
      input: Parameters<OrcaTaskRuntimeAdapter['readBoundedOutput']>[0],
      callOptions: RuntimeCallOptions = {},
    ): ReturnType<OrcaTaskRuntimeAdapter['readBoundedOutput']> {
      const refreshed = refreshTrackedSmokeWorker({
        identity: input.worker,
        cwd: callOptions.cwd ?? process.cwd(),
        timeoutMs: callOptions.timeoutMs ?? 30_000,
        probe,
      });
      if (refreshed.status === 'failed') {
        return {
          status: 'failed',
          operation: 'read_bounded_output',
          reason: refreshed.reason,
        };
      }
      return originalReadBoundedOutput.call(this, input, callOptions);
    },
  });

  Object.defineProperty(prototype, 'liveness', {
    configurable: true,
    writable: true,
    value: function patchedLiveness(
      this: OrcaTaskRuntimeAdapter,
      input: Parameters<OrcaTaskRuntimeAdapter['liveness']>[0],
      callOptions: RuntimeCallOptions = {},
    ): ReturnType<OrcaTaskRuntimeAdapter['liveness']> {
      const refreshed = refreshTrackedSmokeWorker({
        identity: input.worker,
        cwd: callOptions.cwd ?? process.cwd(),
        timeoutMs: callOptions.timeoutMs ?? Math.max(1, input.observationWindowMs),
        probe,
      });
      if (refreshed.status === 'failed') {
        return { status: 'unknown', worker: input.worker };
      }
      return originalLiveness.call(this, input, callOptions);
    },
  });

  Object.defineProperty(prototype, 'stopWorker', {
    configurable: true,
    writable: true,
    value: function patchedStopWorker(
      this: OrcaTaskRuntimeAdapter,
      worker: Parameters<OrcaTaskRuntimeAdapter['stopWorker']>[0],
      callOptions: RuntimeCallOptions = {},
    ): ReturnType<OrcaTaskRuntimeAdapter['stopWorker']> {
      const tracked = spawnedSmokeWorkers.get(worker);
      if (!tracked) return originalStop.call(this, worker, callOptions);
      if (tracked.preserveOwnedPanelOnDeliveryFailure) {
        return {
          status: 'failed',
          operation: 'stop_worker',
          reason: 'delivery_failure_evidence_preserved',
        };
      }
      return originalStop.call(this, tracked.originalIdentity, callOptions);
    },
  });

  return () => {
    Object.defineProperty(basePrototype, 'findWorker', {
      configurable: true,
      writable: true,
      value: originalBaseFind,
    });
    Object.defineProperty(prototype, 'spawnWorker', {
      configurable: true,
      writable: true,
      value: originalSpawn,
    });
    Object.defineProperty(prototype, 'dispatchInput', {
      configurable: true,
      writable: true,
      value: originalDispatch,
    });
    Object.defineProperty(prototype, 'readBoundedOutput', {
      configurable: true,
      writable: true,
      value: originalReadBoundedOutput,
    });
    Object.defineProperty(prototype, 'liveness', {
      configurable: true,
      writable: true,
      value: originalLiveness,
    });
    Object.defineProperty(prototype, 'stopWorker', {
      configurable: true,
      writable: true,
      value: originalStop,
    });
    patchedTaskAdapterPrototypes.delete(prototype);
  };
}

export function actionableHistoricalCleanupReason(runId: string): string {
  const normalizedRunId = runId.trim() || 'unknown';
  return [
    `unsupported_historical_cleanup:${normalizedRunId}`,
    `record=.orca-worker-smoke/runs/${normalizedRunId}/lifecycle.json`,
    `quarantine=.orca-worker-smoke/quarantine/${normalizedRunId}`,
    'resolution=inspect_the_named_record_then_repair_its_close_receipt_or_move_the_whole_run_directory_to_quarantine_before_retry',
  ].join(';');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unsupportedHistoricalCleanup(value: Record<string, unknown>): boolean {
  if (String(value.spawnState ?? '') !== 'cleanup_failed') return false;
  const cleanup = isRecord(value.cleanup) ? value.cleanup : undefined;
  const closeOutcome = String(cleanup?.closeOutcome ?? '').trim();
  return !cleanup
    || String(cleanup.reason ?? '').trim() !== 'restart_recovery'
    || !String(value.terminalHandle ?? '').trim()
    || typeof value.closeAttemptedAtMs !== 'number'
    || !Number.isFinite(value.closeAttemptedAtMs)
    || !acceptedHistoricalStaleOutcomes.has(closeOutcome);
}

/**
 * Unknown historical cleanup records are terminal audit debris, not authority
 * to actuate a worker. Move the complete run directory aside before admission,
 * preserving the exact source record plus one machine-readable cause.
 */
export function quarantineUnsupportedHistoricalSmokeRuns(
  repoRoot: string,
): HistoricalSmokeQuarantine[] {
  const runsRoot = join(repoRoot, '.orca-worker-smoke', 'runs');
  if (!existsSync(runsRoot)) return [];
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const quarantined: HistoricalSmokeQuarantine[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourcePath = join(runsRoot, entry.name);
    const lifecyclePath = join(sourcePath, 'lifecycle.json');
    let registry: unknown;
    try {
      registry = JSON.parse(readFileSync(lifecyclePath, 'utf8')) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(registry) || !unsupportedHistoricalCleanup(registry)) continue;
    const runId = String(registry.runId ?? '').trim();
    if (!runId || runId !== basename(sourcePath)) continue;

    const quarantinePath = join(repoRoot, '.orca-worker-smoke', 'quarantine', runId);
    if (existsSync(quarantinePath)) continue;
    const cause = actionableHistoricalCleanupReason(runId);
    try {
      writeFileSync(join(sourcePath, 'quarantine-reason.json'), `${JSON.stringify({
        schema: WORKER_SMOKE_QUARANTINE_SCHEMA,
        runId,
        cause,
        source: `.orca-worker-smoke/runs/${runId}`,
        quarantine: `.orca-worker-smoke/quarantine/${runId}`,
        quarantinedAt: new Date().toISOString(),
      })}\n`, 'utf8');
      mkdirSync(join(repoRoot, '.orca-worker-smoke', 'quarantine'), { recursive: true });
      renameSync(sourcePath, quarantinePath);
      quarantined.push({ runId, sourcePath, quarantinePath, cause });
    } catch {
      try { unlinkSync(join(sourcePath, 'quarantine-reason.json')); } catch { /* best effort */ }
    }
  }
  return quarantined;
}

function argValue(argv: readonly string[], name: string): string {
  const index = argv.lastIndexOf(name);
  return index >= 0 ? String(argv[index + 1] ?? '').trim() : '';
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function failureCode(input: {
  detail: string;
  wrapperLaunchFailure: 'none' | 'permission_denied';
}): string {
  if (input.wrapperLaunchFailure === 'permission_denied') return 'wrapper_not_executable';
  if (/unknown argument|usage:/iu.test(input.detail)) return 'invalid_cli';
  if (/issue-body-file/iu.test(input.detail)) return 'issue_body_unavailable';
  if (/native-entrypoint-preflight|node 22|unsupported node/iu.test(input.detail)) {
    return 'node_preflight_failed';
  }
  if (/ERR_MODULE_NOT_FOUND|cannot find module|module not found|SyntaxError/iu.test(input.detail)) {
    return 'entrypoint_import_failed';
  }
  return 'entrypoint_exception';
}

export function buildWorkerSmokeRunFailureReceipt(input: {
  detail: string;
  argv: readonly string[];
  wrapperPath: string;
  wrapperExecutable: boolean;
  wrapperLaunchFailure?: 'none' | 'permission_denied';
  phase?: 'bootstrap' | 'harness';
}): WorkerSmokeRunFailureReceipt {
  const detail = input.detail.trim() || 'worker-smoke-run terminated without a scenario report';
  const issueNumber = positiveInteger(argValue(input.argv, '--issue'));
  const prNumber = positiveInteger(argValue(input.argv, '--pr'));
  const headSha = argValue(input.argv, '--head-sha').toLowerCase();
  const binding = issueNumber > 0 && prNumber > 0 && /^[0-9a-f]{40}$/u.test(headSha)
    ? { issueNumber, prNumber, headSha }
    : undefined;
  const wrapperLaunchFailure = input.wrapperLaunchFailure ?? 'none';
  const code = failureCode({ detail, wrapperLaunchFailure });
  return {
    schema: WORKER_SMOKE_RUN_RECEIPT_SCHEMA,
    result: 'FAIL',
    cause: {
      phase: input.phase ?? 'bootstrap',
      code,
      detail,
      resolution: code === 'wrapper_not_executable'
        ? 'restore_the_executable_bit_then_retry_from_the_exact_pr_head'
        : 'fix_the_named_harness_cause_and_retry_from_the_exact_pr_head',
    },
    ...(binding ? { binding } : {}),
    wrapper: {
      path: input.wrapperPath,
      executable: input.wrapperExecutable,
      launchFailure: wrapperLaunchFailure,
    },
  };
}

export function smokeRunCwdFromArgv(argv: readonly string[]): string {
  return argValue(argv, '--cwd') || process.cwd();
}
