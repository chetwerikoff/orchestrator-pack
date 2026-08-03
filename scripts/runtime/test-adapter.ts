import {
  runtimeFailure,
  sameRuntimeWorker,
  type RuntimeAdapter,
  type RuntimeBoundedOutput,
  type RuntimeCallOptions,
  type RuntimeDispatchResult,
  type RuntimeLiveness,
  type RuntimeLivenessResult,
  type RuntimeObservationToken,
  type RuntimeReadiness,
  type RuntimeResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from './contracts.ts';

interface TestWorkerState {
  worker: RuntimeWorker;
  lines: string[];
  version: number;
  liveness: RuntimeLiveness;
}

export class DeterministicRuntimeAdapter implements RuntimeAdapter {
  readonly id = 'test' as const;
  readonly #workers = new Map<string, TestWorkerState>();
  #generation = 0;

  readiness(_options: RuntimeCallOptions = {}): RuntimeResult<RuntimeReadiness> {
    return {
      status: 'ok',
      value: { ready: true, workspacePath: '/test/workspace', headSha: 'test-head' },
    };
  }

  listWorkers(): RuntimeResult<readonly RuntimeWorker[]> {
    return {
      status: 'ok',
      value: [...this.#workers.values()].map(({ worker }) => worker),
    };
  }

  findWorker(identity: RuntimeWorkerIdentity): RuntimeResult<RuntimeWorker | null> {
    const state = this.#workers.get(identity.id);
    return {
      status: 'ok',
      value: state && sameRuntimeWorker(state.worker.identity, identity) ? state.worker : null,
    };
  }

  spawnWorker(input: {
    readonly title: string;
    readonly command: string;
    readonly workspace?: 'active' | string;
  }): RuntimeResult<RuntimeWorker> {
    this.#generation += 1;
    const identity: RuntimeWorkerIdentity = {
      runtime: 'test',
      id: `worker-${this.#generation}`,
      generation: `generation-${this.#generation}`,
    };
    const worker: RuntimeWorker = {
      identity,
      workspacePath: input.workspace && input.workspace !== 'active'
        ? input.workspace
        : '/test/workspace',
      title: input.title,
      provenance: 'internal',
    };
    this.#workers.set(identity.id, {
      worker,
      lines: [`started:${input.command}`],
      version: 1,
      liveness: 'busy',
    });
    return { status: 'ok', value: worker };
  }

  dispatchInput(input: {
    readonly worker: RuntimeWorkerIdentity;
    readonly text?: string;
    readonly submitOnly?: boolean;
  }): RuntimeDispatchResult {
    const state = this.#workers.get(input.worker.id);
    if (!state || !sameRuntimeWorker(state.worker.identity, input.worker)) {
      return { status: 'send_failed', reason: 'worker_not_found' };
    }
    state.lines.push(input.submitOnly ? '<submit>' : input.text ?? '');
    state.version += 1;
    state.liveness = 'busy';
    return { status: 'dispatched' };
  }

  readBoundedOutput(input: {
    readonly worker: RuntimeWorkerIdentity;
    readonly previousToken?: RuntimeObservationToken | null;
    readonly limit?: number;
  }): RuntimeResult<RuntimeBoundedOutput> {
    const state = this.#workers.get(input.worker.id);
    if (!state || !sameRuntimeWorker(state.worker.identity, input.worker)) {
      return runtimeFailure('read_bounded_output', 'worker_not_found');
    }
    const token: RuntimeObservationToken = { opaque: `v${state.version}` };
    return {
      status: 'ok',
      value: {
        worker: state.worker.identity,
        lines: state.lines.slice(-(input.limit ?? state.lines.length)),
        observationToken: token,
        changed: input.previousToken?.opaque !== token.opaque,
        terminalState: state.liveness === 'gone' ? 'exited' : 'running',
      },
    };
  }

  liveness(input: {
    readonly worker: RuntimeWorkerIdentity;
    readonly observationWindowMs: number;
  }): RuntimeLivenessResult {
    if (input.observationWindowMs <= 0) {
      return { status: 'unknown', worker: input.worker };
    }
    const state = this.#workers.get(input.worker.id);
    if (!state || !sameRuntimeWorker(state.worker.identity, input.worker)) {
      return { status: 'gone', worker: input.worker };
    }
    return { status: state.liveness, worker: state.worker.identity };
  }

  stopWorker(worker: RuntimeWorkerIdentity): RuntimeResult<{ readonly stopped: true }> {
    const state = this.#workers.get(worker.id);
    if (!state || !sameRuntimeWorker(state.worker.identity, worker)) {
      return runtimeFailure('stop_worker', 'worker_not_found');
    }
    this.#workers.delete(worker.id);
    return { status: 'ok', value: { stopped: true } };
  }

  setLiveness(worker: RuntimeWorkerIdentity, liveness: RuntimeLiveness): void {
    const state = this.#workers.get(worker.id);
    if (!state || !sameRuntimeWorker(state.worker.identity, worker)) {
      throw new Error('worker_not_found');
    }
    state.liveness = liveness;
  }

  /** Test-only same-id recreation used to prove generation invalidation. */
  recreateWorker(worker: RuntimeWorkerIdentity): RuntimeWorker {
    const state = this.#workers.get(worker.id);
    if (!state || !sameRuntimeWorker(state.worker.identity, worker)) {
      throw new Error('worker_not_found');
    }
    this.#generation += 1;
    const recreated: RuntimeWorker = {
      ...state.worker,
      identity: {
        ...state.worker.identity,
        generation: `generation-${this.#generation}`,
      },
    };
    this.#workers.set(worker.id, {
      worker: recreated,
      lines: ['recreated'],
      version: 1,
      liveness: 'busy',
    });
    return recreated;
  }
}
