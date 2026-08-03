import {
  runtimeFailure,
  sameRuntimeWorker,
  type RuntimeCallOptions,
  type RuntimeResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import {
  OrcaRuntimeAdapter,
  type OrcaRuntimeAdapterOptions,
} from './adapter.ts';
import { runOrcaJson, type OrcaJsonResponse } from './native.ts';

function stopFailureReason(response: OrcaJsonResponse): string {
  if (response.error?.code === 'orca_operation_timeout'
    || response.outcomeCategory === 'empty_stdout'
    || response.outcomeCategory === 'invalid_json') {
    return 'runtime_stop_outcome_unknown';
  }
  switch (response.outcomeCategory) {
    case 'process_launch_failed':
      return 'runtime_unavailable';
    case 'recognized_control_plane_code':
      return 'runtime_control_unavailable';
    case 'supported_operation_failure':
    default:
      return response.error?.code ?? 'runtime_operation_failed';
  }
}

/**
 * Orca adapter used by ordinary task lifecycle callers after #1248.
 *
 * The upstream CLI still closes by opaque handle only. This adapter therefore
 * preserves the existing pack close behavior while adding the strongest checks
 * available at the boundary: only workers spawned by this adapter instance are
 * eligible, and the exact id+generation is revalidated immediately before the
 * one native close attempt. A stale or externally discovered handle is never
 * closed. Ambiguous close transport outcomes are returned as failure and are
 * never retried.
 */
export class OrcaTaskRuntimeAdapter extends OrcaRuntimeAdapter {
  readonly #options: OrcaRuntimeAdapterOptions;
  readonly #ownedForStop = new Map<string, RuntimeWorkerIdentity>();

  constructor(options: OrcaRuntimeAdapterOptions = {}) {
    super(options);
    this.#options = options;
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
    if (current.status !== 'ok') {
      return runtimeFailure('stop_worker', current.reason);
    }
    if (current.value === null) {
      this.#ownedForStop.delete(worker.id);
      return runtimeFailure('stop_worker', 'worker_generation_not_found');
    }

    const run = this.#options.runJson ?? runOrcaJson;
    const response = run(
      ['terminal', 'close', '--terminal', worker.id],
      {
        cwd: options.cwd ?? this.#options.cwd,
        timeoutMs: options.timeoutMs ?? this.#options.timeoutMs,
        executable: this.#options.executable,
        runner: this.#options.runner,
        env: this.#options.env,
        killSignal: this.#options.killSignal,
      },
    );
    if (!response.ok) {
      return runtimeFailure('stop_worker', stopFailureReason(response));
    }

    this.#ownedForStop.delete(worker.id);
    return { status: 'ok', value: { stopped: true } };
  }
}
