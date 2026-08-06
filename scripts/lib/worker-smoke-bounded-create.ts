import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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

type TrackedSmokeWorkerRefresh =
  | { status: 'not_tracked' }
  | { status: 'ok'; generationChanged: boolean }
  | { status: 'failed'; reason: string };

const patchedTaskAdapterPrototypes = new WeakSet<object>();
const spawnIdentityFailures = new WeakMap<object, string>();
const spawnedSmokeWorkers = new WeakMap<object, RuntimeWorker>();

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

function waitForDeliveryConfirmation(input: {
  binding: SmokeDeliveryBinding;
  deadline: number;
  deliveryProbe: SmokeDeliveryProbe;
  now: () => number;
  sleepMs: (milliseconds: number) => void;
}): boolean {
  while (true) {
    if (input.deliveryProbe(input.binding)) return true;
    const remaining = input.deadline - input.now();
    if (remaining <= 0) return false;
    input.sleepMs(Math.min(250, Math.max(1, remaining)));
  }
}

function dispatchDiagnostic(result: RuntimeDispatchResult): string {
  return result.status === 'dispatched'
    ? 'dispatched'
    : `${result.status}:${safeToken(result.reason)}`;
}

function absenceProven(response: OrcaJsonResponse<{ terminal?: OrcaTerminalSummary }>): boolean {
  if (response.ok) return !response.result?.terminal;
  const code = String(response.error?.code ?? '').trim().toLowerCase();
  const message = String(response.error?.message ?? '').trim().toLowerCase();
  return code === 'terminal_not_found'
    || code === 'not_found'
    || code === 'terminal_absent'
    || message.includes('terminal not found')
    || message.includes('terminal is no longer alive');
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

export function workerGenerationNotFoundReason(input: {
  worker: RuntimeWorker;
  observedGeneration?: string;
  lookupFailure?: string;
}): string {
  return [
    'worker_generation_not_found',
    `expected_runtime=${safeToken(input.worker.identity.runtime)}`,
    `expected_handle=${safeToken(input.worker.identity.id)}`,
    `expected_generation=${safeToken(input.worker.identity.generation)}`,
    `observed_generation=${safeToken(input.observedGeneration ?? 'not_found')}`,
    `identity_source=orca_terminal_show(${safeToken(input.worker.identity.id)})`,
    ...(input.lookupFailure ? [`lookup_failure=${safeToken(input.lookupFailure)}`] : []),
    'resolution=resolve_the_current_generation_for_the_created_handle_then_retry_from_the_exact_pr_head',
  ].join(';');
}

/**
 * Orca may return a create-time generation that differs from the immediately
 * authoritative terminal-show generation. The runtime adapters retain the
 * exact identity object for later ownership checks, so update that same object
 * only after handle, title, and worktree all prove this is the terminal just
 * created by the harness.
 */
export function stabilizeSpawnedSmokeWorkerIdentity(input: {
  worker: RuntimeWorker;
  cwd: string;
  timeoutMs: number;
  probe?: SmokeGenerationProbe;
}): StableSpawnIdentityResult {
  if (input.worker.identity.runtime !== 'orca') return { ok: true, worker: input.worker };
  const probe = input.probe ?? defaultGenerationProbe;
  const response = probe(
    input.worker.identity.id,
    input.cwd,
    input.timeoutMs,
  );
  if (!response.ok) {
    return {
      ok: false,
      reason: workerGenerationNotFoundReason({
        worker: input.worker,
        lookupFailure: `${response.operation ?? 'terminal_show'}:${response.error?.code ?? response.outcomeCategory ?? 'unavailable'}`,
      }),
    };
  }
  const observed = response.result?.terminal;
  if (!observed) {
    return {
      ok: false,
      reason: workerGenerationNotFoundReason({
        worker: input.worker,
        lookupFailure: 'terminal_show:missing_terminal',
      }),
    };
  }
  const observedHandle = observed.handle?.trim() ?? '';
  const observedTitle = observed.title ?? null;
  const observedWorkspace = observed.worktreePath?.trim() ?? '';
  const observedGeneration = generationFromTerminal(observed);
  if (observedHandle !== input.worker.identity.id) {
    return {
      ok: false,
      reason: `spawned_worker_handle_mismatch;expected_handle=${safeToken(input.worker.identity.id)};observed_handle=${safeToken(observedHandle)};resolution=inspect_orca_terminal_show_binding_and_retry`,
    };
  }
  if (observedTitle !== input.worker.title) {
    return {
      ok: false,
      reason: `spawned_worker_title_mismatch;expected_title=${safeToken(input.worker.title ?? '')};observed_title=${safeToken(observedTitle ?? '')};resolution=inspect_orca_terminal_show_binding_and_retry`,
    };
  }
  if (!observedWorkspace || !samePath(observedWorkspace, input.worker.workspacePath)) {
    return {
      ok: false,
      reason: `spawned_worker_workspace_mismatch;expected_workspace=${safeToken(input.worker.workspacePath)};observed_workspace=${safeToken(observedWorkspace)};resolution=rerun_from_the_exact_head_worktree`,
    };
  }
  if (!observedGeneration) {
    return {
      ok: false,
      reason: workerGenerationNotFoundReason({
        worker: input.worker,
        lookupFailure: 'terminal_show:generation_missing',
      }),
    };
  }
  if (observedGeneration === input.worker.identity.generation) {
    return { ok: true, worker: input.worker };
  }

  const expectedGeneration = input.worker.identity.generation;
  try {
    (input.worker.identity as { generation: string }).generation = observedGeneration;
  } catch {
    return {
      ok: false,
      reason: workerGenerationNotFoundReason({
        worker: input.worker,
        observedGeneration,
        lookupFailure: 'identity_object_not_mutable',
      }),
    };
  }
  if (input.worker.identity.generation !== observedGeneration) {
    return {
      ok: false,
      reason: workerGenerationNotFoundReason({
        worker: input.worker,
        observedGeneration,
        lookupFailure: 'identity_rebind_readback_failed',
      }),
    };
  }
  return {
    ok: true,
    worker: input.worker,
    diagnostic: [
      'worker_generation_rebound',
      `expected_generation=${safeToken(expectedGeneration)}`,
      `observed_generation=${safeToken(observedGeneration)}`,
      `identity_source=orca_terminal_show(${safeToken(input.worker.identity.id)})`,
    ].join(';'),
  };
}

function refreshTrackedSmokeWorker(input: {
  identity: RuntimeWorkerIdentity;
  cwd: string;
  timeoutMs: number;
  probe: SmokeGenerationProbe;
}): TrackedSmokeWorkerRefresh {
  const spawnedWorker = spawnedSmokeWorkers.get(input.identity);
  if (!spawnedWorker) {
    const failure = spawnIdentityFailures.get(input.identity);
    return failure ? { status: 'failed', reason: failure } : { status: 'not_tracked' };
  }

  const previousGeneration = spawnedWorker.identity.generation;
  const refreshed = stabilizeSpawnedSmokeWorkerIdentity({
    worker: spawnedWorker,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    probe: input.probe,
  });
  if (!refreshed.ok) {
    spawnIdentityFailures.set(input.identity, refreshed.reason);
    return { status: 'failed', reason: refreshed.reason };
  }
  spawnIdentityFailures.delete(input.identity);
  return {
    status: 'ok',
    generationChanged: previousGeneration !== spawnedWorker.identity.generation,
  };
}

/**
 * Install the narrow worker-smoke compatibility repair on the production task
 * adapter. Every generation-bound query re-resolves the exact created handle,
 * delivery is accepted only after the child-owned seal appears, and one
 * submit-only retry is allowed without ever sending the payload a second time.
 */
export function installStableWorkerSmokeSpawnPatch(
  options: StableWorkerSmokeSpawnPatchOptions = {},
): () => void {
  const prototype = OrcaTaskRuntimeAdapter.prototype;
  if (patchedTaskAdapterPrototypes.has(prototype)) return () => undefined;
  patchedTaskAdapterPrototypes.add(prototype);

  const originalSpawn = prototype.spawnWorker;
  const originalDispatch = prototype.dispatchInput;
  const originalReadBoundedOutput = prototype.readBoundedOutput;
  const originalLiveness = prototype.liveness;
  const originalStop = prototype.stopWorker;
  const probe = options.probe ?? defaultGenerationProbe;
  const deliveryProbe = options.deliveryProbe ?? defaultDeliveryProbe;
  const now = options.now ?? Date.now;
  const sleepMs = options.sleepMs ?? defaultSleep;

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
      spawnedSmokeWorkers.set(result.value.identity, result.value);
      const stabilized = refreshTrackedSmokeWorker({
        identity: result.value.identity,
        cwd: callOptions.cwd ?? process.cwd(),
        timeoutMs: callOptions.timeoutMs ?? 30_000,
        probe,
      });
      if (stabilized.status === 'failed') {
        spawnIdentityFailures.set(result.value.identity, stabilized.reason);
      } else {
        spawnIdentityFailures.delete(result.value.identity);
      }
      return result;
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
      if (result.status === 'send_failed' && result.reason === 'worker_generation_not_found') {
        return {
          status: 'send_failed',
          reason: workerGenerationNotFoundReason({
            worker: {
              identity: input.worker,
              workspacePath: callOptions.cwd ?? process.cwd(),
              title: null,
              provenance: 'internal',
            },
          }),
        };
      }
      if (input.submitOnly || result.status === 'send_failed') return result;

      const binding = smokeDeliveryBindingFromPrompt(input.text ?? '');
      if (!binding) return result;
      const envTimeoutMs = Number.parseInt(
        process.env.WORKER_SMOKE_SUBMIT_CONFIRMATION_TIMEOUT_MS ?? '',
        10,
      );
      const configuredTimeoutMs = options.deliveryConfirmationTimeoutMs
        ?? (Number.isSafeInteger(envTimeoutMs) && envTimeoutMs > 0 ? envTimeoutMs : 30_000);
      const timeoutMs = Math.max(
        2,
        Math.min(callOptions.timeoutMs ?? 30_000, configuredTimeoutMs),
      );
      const startedAt = now();
      const firstDeadline = startedAt + Math.max(1, Math.floor(timeoutMs / 2));
      const finalDeadline = startedAt + timeoutMs;
      if (waitForDeliveryConfirmation({
        binding,
        deadline: firstDeadline,
        deliveryProbe,
        now,
        sleepMs,
      })) return { status: 'dispatched' };

      const retried = originalDispatch.call(this, {
        worker: input.worker,
        submitOnly: true,
      }, callOptions);
      if (waitForDeliveryConfirmation({
        binding,
        deadline: finalDeadline,
        deliveryProbe,
        now,
        sleepMs,
      })) return { status: 'dispatched' };

      return {
        status: 'send_failed',
        reason: [
          'prompt_submission_unconfirmed',
          'submit_attempts=2',
          `initial_submit=${safeToken(dispatchDiagnostic(result))}`,
          `retry_submit=${safeToken(dispatchDiagnostic(retried))}`,
          `delivery_evidence=${safeToken(binding.sealPath)}:missing`,
          'resolution=inspect_the_child_delivery_seal_and_terminal_submit_transport_then_retry_from_the_exact_pr_head',
        ].join(';'),
      };
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
      const currentInput = refreshed.status === 'ok'
        && refreshed.generationChanged
        && input.previousToken
        ? { ...input, previousToken: null }
        : input;
      return originalReadBoundedOutput.call(this, currentInput, callOptions);
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
      const result = originalStop.call(this, worker, callOptions);
      if (result.status === 'ok' || result.reason !== 'worker_generation_not_found') return result;
      const response = probe(
        worker.id,
        callOptions.cwd ?? process.cwd(),
        callOptions.timeoutMs ?? 30_000,
      );
      const observed = response.result?.terminal;
      if (absenceProven(response)
        || (observed && generationFromTerminal(observed) !== worker.generation)) {
        return { status: 'ok', value: { stopped: true } };
      }
      if (observed && generationFromTerminal(observed) === worker.generation) {
        return {
          status: 'failed',
          operation: 'stop_worker',
          reason: 'owned_handle_still_present_after_close;resolution=inspect_terminal_close_transport_then_retry_cleanup',
        };
      }
      return {
        status: 'failed',
        operation: 'stop_worker',
        reason: absenceProbeFailure(response),
      };
    },
  });

  return () => {
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
