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
import {
  runOrcaJson,
  type OrcaJsonResponse,
} from './native.ts';

function neutralStopFailure(response: OrcaJsonResponse): string {
  if (response.error?.code === 'orca_operation_timeout') return 'runtime_timeout';
  switch (response.outcomeCategory) {
    case 'process_launch_failed':
      return 'runtime_unavailable';
    case 'empty_stdout':
    case 'invalid_json':
      return 'runtime_response_invalid';
    case 'recognized_control_plane_code':
      return 'runtime_control_unavailable';
    case 'supported_operation_failure':
    default:
      return 'runtime_operation_failed';
  }
}

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

    const response = this.#runJson(
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
      return runtimeFailure('stop_worker', neutralStopFailure(response));
    }

    this.#ownedForStop.delete(worker.id);
    return { status: 'ok', value: { stopped: true } };
  }
}
