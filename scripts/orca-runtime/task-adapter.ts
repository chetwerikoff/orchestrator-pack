import {
  runtimeFailure,
  sameRuntimeWorker,
  type RuntimeBoundedOutput,
  type RuntimeCallOptions,
  type RuntimeDispatchResult,
  type RuntimeReadiness,
  type RuntimeResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import { encodeRuntimeCompatibilityDiagnostic } from '../runtime/compat-diagnostic.ts';
import {
  OrcaRuntimeAdapter,
  type OrcaRuntimeAdapterOptions,
} from './adapter.ts';
import {
  runOrcaJson,
  type OrcaJsonResponse,
  type OrcaRunOptions,
} from './native.ts';

interface DiagnosticState {
  lastFailure: OrcaJsonResponse | null;
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
  readonly #diagnosticState: DiagnosticState;
  readonly #runJson: typeof runOrcaJson;

  constructor(options: OrcaRuntimeAdapterOptions = {}) {
    const diagnosticState: DiagnosticState = { lastFailure: null };
    const nativeRun = options.runJson ?? runOrcaJson;
    const diagnosticRun = (<T>(
      args: readonly string[],
      runOptions: OrcaRunOptions = {},
    ): OrcaJsonResponse<T> => {
      const response = nativeRun<T>(args, runOptions);
      diagnosticState.lastFailure = response.ok ? null : response;
      return response;
    }) as typeof runOrcaJson;
    super({ ...options, runJson: diagnosticRun });
    this.#options = options;
    this.#diagnosticState = diagnosticState;
    this.#runJson = diagnosticRun;
  }

  #beginOperation(): void {
    this.#diagnosticState.lastFailure = null;
  }

  #failureReason(fallback: string): string {
    const response = this.#diagnosticState.lastFailure;
    this.#diagnosticState.lastFailure = null;
    return response
      ? encodeRuntimeCompatibilityDiagnostic(response) ?? fallback
      : fallback;
  }

  override readiness(
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeReadiness> {
    this.#beginOperation();
    const result = super.readiness(options);
    if (result.status === 'ok') {
      this.#diagnosticState.lastFailure = null;
      return result;
    }
    return { ...result, reason: this.#failureReason(result.reason) };
  }

  override spawnWorker(
    input: {
      readonly title: string;
      readonly command: string;
      readonly workspace?: 'active' | string;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeWorker> {
    this.#beginOperation();
    const result = super.spawnWorker(input, options);
    if (result.status === 'ok') {
      this.#diagnosticState.lastFailure = null;
      this.#ownedForStop.set(result.value.identity.id, result.value.identity);
      return result;
    }
    return { ...result, reason: this.#failureReason(result.reason) };
  }

  override dispatchInput(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly text?: string;
      readonly submitOnly?: boolean;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeDispatchResult {
    this.#beginOperation();
    const result = super.dispatchInput(input, options);
    if (result.status === 'dispatched') {
      this.#diagnosticState.lastFailure = null;
      return result;
    }
    return { ...result, reason: this.#failureReason(result.reason) };
  }

  override readBoundedOutput(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly previousToken?: { readonly opaque: string } | null;
      readonly limit?: number;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeBoundedOutput> {
    this.#beginOperation();
    const result = super.readBoundedOutput(input, options);
    if (result.status === 'ok') {
      this.#diagnosticState.lastFailure = null;
      return result;
    }
    return { ...result, reason: this.#failureReason(result.reason) };
  }

  override stopWorker(
    worker: RuntimeWorkerIdentity,
    options: RuntimeCallOptions = {},
  ): RuntimeResult<{ readonly stopped: true }> {
    this.#beginOperation();
    const owned = this.#ownedForStop.get(worker.id);
    if (!owned || !sameRuntimeWorker(owned, worker)) {
      return runtimeFailure('stop_worker', 'worker_not_owned_by_runtime_instance');
    }

    const current = super.findWorker(worker, options);
    if (current.status !== 'ok') {
      return runtimeFailure('stop_worker', this.#failureReason(current.reason));
    }
    if (current.value === null) {
      this.#ownedForStop.delete(worker.id);
      return runtimeFailure('stop_worker', 'worker_generation_not_found');
    }

    this.#diagnosticState.lastFailure = null;
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
      return runtimeFailure(
        'stop_worker',
        this.#failureReason(response.error?.code ?? 'runtime_operation_failed'),
      );
    }

    this.#diagnosticState.lastFailure = null;
    this.#ownedForStop.delete(worker.id);
    return { status: 'ok', value: { stopped: true } };
  }
}
