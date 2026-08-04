import { resolve } from 'node:path';
import {
  runtimeFailure,
  runtimeUnsupported,
  sameRuntimeWorker,
  type RuntimeCallOptions,
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

/**
 * Production Orca adapter for task lifecycle callers.
 *
 * Orca closes by opaque handle. The adapter therefore permits one close attempt
 * only for an identity spawned by this adapter instance and revalidated by exact
 * runtime + id + generation immediately before the destructive call. It never
 * retries an ambiguous close result and never adopts an externally discovered
 * worker for cleanup.
 */
export class OrcaTaskRuntimeAdapter extends OrcaRuntimeAdapter {
  readonly #options: OrcaRuntimeAdapterOptions;
  readonly #ownedForStop = new Map<string, RuntimeWorkerIdentity>();
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
    if (current.status !== 'ok') return current;
    if (current.value === null) {
      this.#ownedForStop.delete(worker.id);
      return runtimeFailure('stop_worker', 'worker_generation_not_found');
    }

    // Consume authority before transport. Timeout, empty output, invalid JSON,
    // or another ambiguous result may mean Orca already closed the terminal.
    this.#ownedForStop.delete(worker.id);
    const response = this.#run(
      ['terminal', 'close', '--terminal', worker.id],
      options,
    );
    if (!response.ok) {
      return runtimeFailure('stop_worker', neutralFailureReason(response));
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
