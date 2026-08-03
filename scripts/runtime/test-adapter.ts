import {
  runtimeFailure,
  runtimeUnsupported,
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

interface TestObservationBinding {
  readonly workerKey: string;
  readonly version: number;
}

const TEST_OBSERVATION_TOKEN_PREFIX = 'opk-test-output-v1.';

function identityKey(identity: RuntimeWorkerIdentity): string {
  return `${identity.runtime}\u0000${identity.id}\u0000${identity.generation}`;
}

export class DeterministicRuntimeAdapter implements RuntimeAdapter {
  readonly id = 'test' as const;
  readonly #workers = new Map<string, TestWorkerState>();
  readonly #observations = new Map<string, TestObservationBinding>();
  readonly #removedWorkspaces = new Set<string>();
  #generation = 0;
  #observationSequence = 0;

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

  findWorkerById(id: string): RuntimeResult<RuntimeWorker | null> {
    return { status: 'ok', value: this.#workers.get(id)?.worker ?? null };
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
    this.#removedWorkspaces.delete(worker.workspacePath);
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

    let changed = state.lines.length > 0;
    let observationToken = input.previousToken ?? null;
    if (input.previousToken) {
      if (!input.previousToken.opaque.startsWith(TEST_OBSERVATION_TOKEN_PREFIX)) {
        return runtimeUnsupported('read_bounded_output', 'observation_token_unsupported');
      }
      const previous = this.#observations.get(input.previousToken.opaque);
      if (!previous) {
        return runtimeUnsupported('read_bounded_output', 'observation_token_unsupported');
      }
      if (previous.workerKey !== identityKey(input.worker)) {
        return runtimeFailure('read_bounded_output', 'observation_token_scope_mismatch');
      }
      changed = previous.version !== state.version;
    }

    if (!observationToken || changed) {
      this.#observationSequence += 1;
      observationToken = {
        opaque: `${TEST_OBSERVATION_TOKEN_PREFIX}${this.#observationSequence}`,
      };
      this.#observations.set(observationToken.opaque, {
        workerKey: identityKey(input.worker),
        version: state.version,
      });
    }

    return {
      status: 'ok',
      value: {
        worker: state.worker.identity,
        lines: state.lines.slice(-(input.limit ?? state.lines.length)),
        observationToken,
        changed,
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
    const workerKey = identityKey(worker);
    for (const [token, binding] of this.#observations) {
      if (binding.workerKey === workerKey) this.#observations.delete(token);
    }
    return { status: 'ok', value: { stopped: true } };
  }

  removeWorkspace(input: {
    readonly workspacePath: string;
    readonly expectedHeadSha?: string;
  }): RuntimeResult<{ readonly removed: true }> {
    if (!input.workspacePath.trim()) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_path_missing');
    }
    if (input.expectedHeadSha && input.expectedHeadSha !== 'test-head') {
      return runtimeFailure('remove_workspace', 'runtime_workspace_head_mismatch');
    }
    if ([...this.#workers.values()].some(({ worker }) => worker.workspacePath === input.workspacePath)) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_has_live_worker');
    }
    this.#removedWorkspaces.add(input.workspacePath);
    return { status: 'ok', value: { removed: true } };
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

  workspaceWasRemoved(workspacePath: string): boolean {
    return this.#removedWorkspaces.has(workspacePath);
  }
}
