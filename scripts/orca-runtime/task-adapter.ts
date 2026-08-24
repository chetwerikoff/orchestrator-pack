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
  type OrcaTerminalSummary,
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
  worker?: Readonly<{
    agent_terminal_handle?: string | null;
    worktree_id?: string | null;
    state?: string | null;
    stage?: string | null;
  }>;
  terminal?: Readonly<{ handle?: string | null }> | null;
  observation?: Readonly<{ exactWorker?: boolean; status?: string }>;
  terminalResource?: Readonly<{
    terminalHandle?: string | null;
    worktreeId?: string | null;
    originDispatchId?: string | null;
    ownerDispatchId?: string | null;
  }> | null;
}>;

type OrcaTerminalListResult = Readonly<{
  terminals?: OrcaTerminalSummary[];
  totalCount?: number;
  truncated?: boolean;
}>;

type OrcaAssignmentActivity = 'active' | 'inactive' | 'unresolved';

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

function isRetryableTabNotFound(response: OrcaJsonResponse): boolean {
  return response.error?.code?.trim() === 'runtime_error'
    && response.error?.message?.trim() === 'tab_not_found';
}

function normalizedWorkerLifecycle(result: OrcaWorkerShowResult | undefined): {
  readonly observationStatus: string;
  readonly workerState: string;
  readonly workerStage: string;
} {
  return {
    observationStatus: String(result?.observation?.status ?? '').trim().toLowerCase(),
    workerState: String(result?.worker?.state ?? '').trim().toLowerCase(),
    workerStage: String(result?.worker?.stage ?? '').trim().toLowerCase(),
  };
}

function classifyWorkerLifecycle(result: OrcaWorkerShowResult | undefined): OrcaAssignmentActivity {
  const lifecycle = normalizedWorkerLifecycle(result);
  if (lifecycle.observationStatus === 'exited') return 'inactive';
  if (lifecycle.observationStatus !== 'live' && lifecycle.observationStatus !== 'running') {
    return 'unresolved';
  }
  if (!lifecycle.workerState || !lifecycle.workerStage) return 'unresolved';
  const acceptedStage = lifecycle.workerStage === 'input_accepted'
    || lifecycle.workerStage === 'remote_input_accepted';
  return lifecycle.workerState === 'ready' && acceptedStage ? 'active' : 'inactive';
}

function goneContradictsActiveLifecycle(result: OrcaWorkerShowResult | undefined): boolean {
  const lifecycle = normalizedWorkerLifecycle(result);
  return lifecycle.workerState === 'ready'
    || lifecycle.workerStage === 'input_accepted'
    || lifecycle.workerStage === 'remote_input_accepted';
}

/**
 * Production Orca adapter for task lifecycle callers.
 *
 * Orca closes by opaque handle. The adapter permits one close attempt for an
 * identity spawned by this adapter instance and revalidated by exact runtime +
 * id + generation immediately before the destructive call. The sole bounded
 * exception is native runtime_error/tab_not_found with immediate exact presence:
 * one retry of that same consumed authority is allowed. Authority is consumed
 * before transport, so no caller can replay either attempt.
 */
export class OrcaTaskRuntimeAdapter extends OrcaRuntimeAdapter {
  readonly #options: OrcaRuntimeAdapterOptions;
  readonly #ownedForStop = new Map<string, RuntimeWorkerIdentity>();
  readonly #stopWorkspace = new Map<string, 'active' | string>();
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
    this.#stopWorkspace.delete(worker.id);
    this.#unprovenOwnedPresence.set(worker.id, { identity: worker, reason });
    return runtimeFailure('stop_worker', reason);
  }

  #findOwnedPresence(
    worker: RuntimeWorkerIdentity,
    options: RuntimeCallOptions,
    strict = false,
  ): RuntimeResult<RuntimeWorker | null> {
    const current = super.findWorker(worker, options);
    if (!strict && current.status !== 'ok') return current;
    if (!strict && current.status === 'ok') return current;
    if (
      current.status === 'ok'
      && current.value
      && !sameRuntimeWorker(current.value.identity, worker)
    ) {
      // The worker-smoke identity stabilizer deliberately returns its
      // independently probed identity from the patched base lookup.
      return current;
    }
    const workspace = this.#stopWorkspace.get(worker.id) ?? 'active';
    const response = this.#run<OrcaTerminalListResult>(
      ['terminal', 'list', '--worktree', workspace],
      options,
    );
    if (!response.ok) {
      return runtimeFailure('find_worker', neutralFailureReason(response));
    }

    const terminals = response.result?.terminals;
    const totalCount = response.result?.totalCount;
    if (
      !Array.isArray(terminals)
      || response.result?.truncated !== false
      || !Number.isInteger(totalCount)
      || totalCount !== terminals.length
    ) {
      return runtimeFailure('find_worker', 'runtime_worker_list_incomplete');
    }

    const matches: RuntimeWorker[] = [];
    for (const terminal of terminals) {
      const id = terminal.handle?.trim();
      const generation = terminal.incarnationId?.trim();
      const workspacePath = terminal.worktreePath?.trim();
      if (!id || !generation || !workspacePath) {
        return runtimeUnsupported('find_worker', 'runtime_worker_identity_missing');
      }
      if (id !== worker.id) continue;
      matches.push({
        identity: { runtime: 'orca', id, generation },
        workspacePath,
        title: typeof terminal.title === 'string' ? terminal.title : null,
        provenance: 'external',
      });
    }
    if (matches.length > 1) {
      return runtimeFailure('find_worker', 'worker_identity_ambiguous');
    }
    const match = matches[0];
    if (match && !sameRuntimeWorker(match.identity, worker)) {
      return runtimeFailure('find_worker', 'worker_generation_mismatch');
    }
    if (match) return { status: 'ok', value: this.#assignmentProvenance(match) };
    return { status: 'ok', value: null };
  }

  #assignmentProvenance(worker: RuntimeWorker): RuntimeWorker {
    const assignmentOwned = this.#assignmentOwned.get(worker.identity.id);
    return assignmentOwned && sameRuntimeWorker(assignmentOwned, worker.identity)
      ? { ...worker, provenance: 'internal' }
      : worker;
  }

  override listWorkers(
    input: { readonly workspace?: 'active' | string },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<readonly RuntimeWorker[]> {
    const current = super.listWorkers(input, options);
    if (current.status !== 'ok') return current;
    return {
      status: 'ok',
      value: current.value.map((worker) => this.#assignmentProvenance(worker)),
    };
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
    return { status: 'ok', value: this.#assignmentProvenance(current.value) };
  }

  resolveAssignmentWorker(
    input: { readonly provider: string; readonly bindingKey: string },
    options: RuntimeCallOptions = {},
  ): ReturnType<NonNullable<import('../runtime/contracts.ts').RuntimeAdapter['resolveAssignmentWorker']>> {
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
    const { observationStatus } = normalizedWorkerLifecycle(shown.result);
    if (!exact) {
      return runtimeFailure('resolve_assignment_worker', 'assignment_target_unresolved');
    }
    if (observationStatus === 'gone') {
      if (goneContradictsActiveLifecycle(shown.result)) {
        return runtimeFailure('resolve_assignment_worker', 'assignment_target_unresolved');
      }
      const resource = shown.result?.terminalResource;
      const resourceOwner = String(resource?.ownerDispatchId ?? '').trim();
      const workerId = String(
        resourceOwner === dispatchId
          ? resource?.terminalHandle
          : '',
      ).trim();
      const value = workerId
        ? { kind: 'gone' as const, workerId }
        : { kind: 'gone' as const };
      return { status: 'ok', value };
    }
    // Exact terminal presence is deliberately weaker than active Dispatch
    // authority. Upstream Orca's worker lifecycle uses state=ready after
    // input_accepted; the installed capture may report observation.status=running
    // while newer Orca reports live. Missing/unknown lifecycle facts remain
    // unresolved, while known settled/exited lifecycle facts are explicitly inactive.
    const activity = classifyWorkerLifecycle(shown.result);
    if (activity === 'unresolved') {
      return runtimeFailure('resolve_assignment_worker', 'assignment_target_unresolved');
    }
    if (activity === 'inactive') {
      return runtimeFailure('resolve_assignment_worker', 'assignment_target_inactive');
    }
    const terminalHandle = String(
      shown.result?.terminal?.handle
        ?? shown.result?.worker?.agent_terminal_handle
        ?? '',
    ).trim();
    if (!terminalHandle) {
      return runtimeFailure('resolve_assignment_worker', 'assignment_target_unresolved');
    }
    const current = super.findWorkerById(terminalHandle, options);
    if (current.status !== 'ok') {
      return runtimeFailure('resolve_assignment_worker', current.reason);
    }
    if (current.value === null) {
      return runtimeFailure('resolve_assignment_worker', 'assignment_target_unresolved');
    }
    // A current PACK WorkerAssignment plus Orca's exact Dispatch-to-terminal
    // observation is the durable ownership witness across bounded adapter
    // processes. Retain only the resolved composite identity in memory so later
    // same-tick inventory/freshness checks preserve PACK provenance; generic
    // terminal discovery remains external and no runtime-private identity becomes durable.
    this.#assignmentOwned.set(current.value.identity.id, current.value.identity);
    return {
      status: 'ok',
      value: {
        kind: 'resolved',
        worker: this.#assignmentProvenance(current.value),
      },
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
      this.#stopWorkspace.set(result.value.identity.id, input.workspace ?? 'active');
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

    const current = this.#findOwnedPresence(worker, options);
    if (current.status !== 'ok') {
      return this.#recordUnprovenOwnedPresence(
        worker,
        `unproven_already_absent;inventory_error=${failureDetail(current)}`,
      );
    }
    if (current.value === null) {
      this.#ownedForStop.delete(worker.id);
      this.#stopWorkspace.delete(worker.id);
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
      const presence = this.#findOwnedPresence(
        worker,
        options,
        isRetryableTabNotFound(response),
      );
      if (presence.status === 'ok' && presence.value === null) {
        this.#stopWorkspace.delete(worker.id);
        return { status: 'ok', value: { stopped: true } };
      }
      if (presence.status !== 'ok') {
        const failure = this.#recordUnprovenOwnedPresence(
          worker,
          `unproven_already_absent;close_error=${neutralFailureReason(response)};inventory_error=${failureDetail(presence)}`,
        );
        return attachNativeRuntimeError(failure, response);
      }
      if (isRetryableTabNotFound(response)) {
        const retry = this.#run(
          ['terminal', 'close', '--terminal', worker.id],
          options,
        );
        if (retry.ok) {
          this.#stopWorkspace.delete(worker.id);
          return { status: 'ok', value: { stopped: true } };
        }

        const retryPresence = this.#findOwnedPresence(worker, options, true);
        if (retryPresence.status === 'ok' && retryPresence.value === null) {
          this.#stopWorkspace.delete(worker.id);
          return { status: 'ok', value: { stopped: true } };
        }
        if (retryPresence.status !== 'ok') {
          const failure = this.#recordUnprovenOwnedPresence(
            worker,
            `unproven_already_absent;close_error=${neutralFailureReason(retry)};inventory_error=${failureDetail(retryPresence)}`,
          );
          return attachNativeRuntimeError(failure, retry);
        }
        return attachNativeRuntimeError(
          runtimeFailure('stop_worker', neutralFailureReason(retry)),
          retry,
        );
      }
      return attachNativeRuntimeError(
        runtimeFailure('stop_worker', neutralFailureReason(response)),
        response,
      );
    }

    this.#stopWorkspace.delete(worker.id);
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
