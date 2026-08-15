import { resolve } from 'node:path';
import {
  runtimeFailure,
  runtimeUnsupported,
  sameRuntimeWorker,
  type RuntimeCallOptions,
  type RuntimeOperationFailure,
  type RuntimeResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import {
  neutralFailureReason,
  OrcaRuntimeAdapter,
  type OrcaRuntimeAdapterOptions,
} from './adapter.ts';
import {
  runOrcaJson,
  type OrcaJsonResponse,
  type OrcaWorktreeRemoveResult,
  type OrcaWorktreeShow,
} from './native.ts';

type RuntimeFailureWithNativeError = RuntimeOperationFailure & {
  readonly nativeError?: Readonly<{
    code: string;
    message: string;
  }>;
};

type UnprovenOwnedPresence = Readonly<{
  identity: RuntimeWorkerIdentity;
  reason: string;
}>;

type OrcaWorkerShowResult = Readonly<{
  worker?: Readonly<{ agent_terminal_handle?: string | null }>;
  terminal?: Readonly<{ handle?: string | null }> | null;
  observation?: Readonly<{ exactWorker?: boolean; status?: string }>;
}>;

function failureDetail(failure: RuntimeOperationFailure): string {
  return `${failure.operation}:${failure.status}:${failure.reason}`;
}

function attachNativeRuntimeError(
  failure: RuntimeOperationFailure,
  response: OrcaJsonResponse,
): RuntimeOperationFailure {
  const code = String(response.error?.code ?? '');
  const message = String(response.error?.message ?? '');
  if (!code && !message) return failure;
  Object.defineProperty(failure as RuntimeFailureWithNativeError, 'nativeError', {
    value: Object.freeze({ code, message }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return failure;
}

/**
 * Production Orca adapter for task lifecycle callers.
 *
 * Orca closes by opaque handle. The adapter permits one close attempt only for
 * an identity spawned by this adapter instance and revalidated by exact runtime
 * + id + generation immediately before the destructive call. Authority is
 * consumed before transport, so success, explicit rejection, timeout, empty
 * output, invalid JSON, and every other ambiguous result can never be replayed.
 */
export class OrcaTaskRuntimeAdapter extends OrcaRuntimeAdapter {
  readonly #options: OrcaRuntimeAdapterOptions;
  readonly #ownedForStop = new Map<string, RuntimeWorkerIdentity>();
  readonly #assignmentOwned = new Map<string, RuntimeWorkerIdentity>();
  readonly #unprovenOwnedPresence = new Map<string, UnprovenOwnedPresence>();
  readonly #runJson: typeof runOrcaJson;

  constructor(options: OrcaRuntimeAdapterOptions = {}) {
    super(options);
    this.#options = options;
    this.#runJson = options.runJson ?? runOrcaJson;
  }

  #run<T>(args: readonly string[], options: RuntimeCallOptions): OrcaJsonResponse<T> {
    return this.#runJson<T>(args, {
      cwd: options.cwd ?? this.#options.cwd,
      timeoutMs: options.timeoutMs ?? this.#options.timeoutMs,
      executable: this.#options.executable,
      runner: this.#options.runner,
      env: this.#options.env,
      killSignal: this.#options.killSignal,
    });
  }

  #recordUnprovenOwnedPresence(
    worker: RuntimeWorkerIdentity,
    reason: string,
  ): RuntimeOperationFailure {
    this.#ownedForStop.delete(worker.id);
    this.#unprovenOwnedPresence.set(worker.id, { identity: worker, reason });
    return runtimeFailure('stop_worker', reason);
  }

  override findWorker(
    worker: RuntimeWorkerIdentity,
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeWorker | null> {
    const unproven = this.#unprovenOwnedPresence.get(worker.id);
    if (unproven && sameRuntimeWorker(unproven.identity, worker)) {
      return runtimeFailure('find_worker', unproven.reason);
    }
    const current = super.findWorker(worker, options);
    if (current.status !== 'ok' || current.value === null) return current;
    const assignmentOwned = this.#assignmentOwned.get(worker.id);
    if (!assignmentOwned || !sameRuntimeWorker(assignmentOwned, worker)) return current;
    return { status: 'ok', value: { ...current.value, provenance: 'internal' } };
  }

  resolveAssignmentWorker(
    input: { readonly provider: string; readonly bindingKey: string },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeWorker | null> {
    if (input.provider.trim().toLowerCase() !== 'orca') {
      return runtimeUnsupported('resolve_assignment_worker', 'assignment_provider_unsupported');
    }
    const dispatchId = input.bindingKey.trim();
    if (!dispatchId) return runtimeFailure('resolve_assignment_worker', 'assignment_binding_missing');
    const shown = this.#run<OrcaWorkerShowResult>(
      ['orchestration', 'worker-show', '--dispatch', dispatchId],
      options,
    );
    if (!shown.ok) return runtimeFailure('resolve_assignment_worker', neutralFailureReason(shown));
    const exact = shown.result?.observation?.exactWorker === true;
    const terminalHandle = String(
      shown.result?.terminal?.handle
        ?? shown.result?.worker?.agent_terminal_handle
        ?? '',
    ).trim();
    if (!exact || !terminalHandle) return { status: 'ok', value: null };
    const current = super.findWorkerById(terminalHandle, options);
    if (current.status !== 'ok') {
      return runtimeFailure('resolve_assignment_worker', current.reason);
    }
    if (current.value === null) return { status: 'ok', value: null };
    // A current PACK WorkerAssignment plus Orca's exact Dispatch-to-terminal
    // observation is the durable ownership witness across bounded adapter
    // processes. Retain only the resolved composite identity in memory so later
    // same-tick freshness checks preserve PACK provenance; generic discovery
    // remains external and no runtime-private identity becomes durable.
    this.#assignmentOwned.set(current.value.identity.id, current.value.identity);
    return {
      status: 'ok',
      value: { ...current.value, provenance: 'internal' },
    };
  }

  override spawnWorker(
    input: {
      readonly title: string;
      readonly command: string;
      readonly workspace?: 'active' | string;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeWorker> {
    const result = super.spawnWorker(input, options);
    if (result.status === 'ok') {
      this.#unprovenOwnedPresence.delete(result.value.identity.id);
      this.#ownedForStop.set(result.value.identity.id, result.value.identity);
    }
    return result;
  }

  override stopWorker(
    worker: RuntimeWorkerIdentity,
    options: RuntimeCallOptions = {},
  ): RuntimeResult<{ readonly stopped: true }> {
    const owned = this.#ownedForStop.get(worker.id);
    if (!owned || !sameRuntimeWorker(owned, worker)) {
      return runtimeFailure('stop_worker', 'worker_not_owned_by_runtime_instance');
    }

    const current = super.findWorker(worker, options);
    if (current.status !== 'ok') {
      return this.#recordUnprovenOwnedPresence(
        worker,
        `unproven_already_absent;inventory_error=${failureDetail(current)}`,
      );
    }
    if (current.value === null) {
      this.#ownedForStop.delete(worker.id);
      return { status: 'ok', value: { stopped: true } };
    }

    // Consume authority before the destructive transport. A later caller cannot
    // infer from a failed or malformed response that the close did not happen.
    this.#ownedForStop.delete(worker.id);
    const response = this.#run(
      ['terminal', 'close', '--terminal', worker.id],
      options,
    );
    if (!response.ok) {
      const presence = super.findWorker(worker, options);
      if (presence.status === 'ok' && presence.value === null) {
        return { status: 'ok', value: { stopped: true } };
      }
      if (presence.status !== 'ok') {
        const failure = this.#recordUnprovenOwnedPresence(
          worker,
          `unproven_already_absent;close_error=${neutralFailureReason(response)};inventory_error=${failureDetail(presence)}`,
        );
        return attachNativeRuntimeError(failure, response);
      }
      return attachNativeRuntimeError(
        runtimeFailure('stop_worker', neutralFailureReason(response)),
        response,
      );
    }

    return { status: 'ok', value: { stopped: true } };
  }

  removeWorkspace(
    input: {
      readonly workspacePath: string;
      readonly expectedHeadSha: string;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<{ readonly removed: true }> {
    const rawPath = input.workspacePath.trim();
    if (!rawPath) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_path_missing');
    }
    const expectedHeadSha = input.expectedHeadSha.trim().toLowerCase();
    if (!expectedHeadSha) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_expected_head_missing');
    }
    const requestedPath = resolve(rawPath);

    const shown = this.#run<OrcaWorktreeShow>(
      ['worktree', 'show', '--worktree', `path:${requestedPath}`],
      options,
    );
    if (!shown.ok) {
      return runtimeFailure('remove_workspace', neutralFailureReason(shown));
    }
    const worktree = shown.result?.worktree;
    const observedPath = worktree?.path?.trim();
    const worktreeId = worktree?.id?.trim();
    if (!observedPath || !worktreeId) {
      return runtimeUnsupported('remove_workspace', 'runtime_workspace_identity_missing');
    }
    if (resolve(observedPath) !== requestedPath) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_path_mismatch');
    }
    const observedHeadSha = worktree?.head?.trim().toLowerCase();
    if (observedHeadSha !== expectedHeadSha) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_head_mismatch');
    }

    const removed = this.#run<OrcaWorktreeRemoveResult>(
      ['worktree', 'rm', '--worktree', `id:${worktreeId}`, '--force'],
      options,
    );
    if (!removed.ok) {
      return runtimeFailure('remove_workspace', neutralFailureReason(removed));
    }
    if (removed.result?.removed === false) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_not_removed');
    }
    return { status: 'ok', value: { removed: true } };
  }
}
