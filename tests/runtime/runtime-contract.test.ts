import { describe, expect, it } from 'vitest';
import {
  asRuntimeObservationToken,
  RuntimeSelectionError,
  selectRuntimeAdapter,
  type RuntimeAdapter,
  type RuntimeBoundedOutput,
  type RuntimeLiveness,
  type RuntimeResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from '../../scripts/runtime/index.ts';

function ok<T>(value: T): RuntimeResult<T> {
  return { status: 'ok', value };
}

class DeterministicAdapter implements RuntimeAdapter {
  readonly name: string;
  private generation = 1;
  private outputVersion = 0;

  constructor(name = 'deterministic') {
    this.name = name;
  }

  isAvailable(): boolean { return true; }
  health(): RuntimeResult<'ready'> { return ok('ready'); }

  listWorkers(_input: { readonly workspacePath?: string; readonly timeoutMs?: number }): RuntimeResult<readonly RuntimeWorker[]> {
    return ok([this.worker('internal')]);
  }

  findWorker(input: { readonly identity: RuntimeWorkerIdentity }): RuntimeResult<RuntimeWorker> {
    const worker = this.worker('internal');
    return input.identity.id === worker.identity.id && input.identity.generation === worker.identity.generation
      ? ok(worker)
      : { status: 'gone', reason: 'missing' };
  }

  spawnWorker(_input: { readonly workspacePath: string; readonly title: string; readonly command: string; readonly timeoutMs?: number }): RuntimeResult<RuntimeWorker> {
    return ok(this.worker('internal'));
  }

  sendInput(_input: { readonly identity: RuntimeWorkerIdentity; readonly text: string; readonly timeoutMs?: number }): { readonly status: 'dispatched'; readonly attempts: 1 } {
    return { status: 'dispatched', attempts: 1 };
  }

  submitInput(_input: { readonly identity: RuntimeWorkerIdentity; readonly timeoutMs?: number }): { readonly status: 'dispatched'; readonly attempts: 1 } {
    return { status: 'dispatched', attempts: 1 };
  }

  readBoundedOutput(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly previousObservationToken?: ReturnType<typeof asRuntimeObservationToken>;
    readonly limit?: number;
    readonly timeoutMs?: number;
  }): RuntimeResult<RuntimeBoundedOutput> {
    const token = asRuntimeObservationToken(`v${this.outputVersion}`);
    return ok({
      lines: this.outputVersion === 0 ? [] : [`line-${this.outputVersion}`],
      observationToken: input.previousObservationToken && input.previousObservationToken === token
        ? input.previousObservationToken
        : token,
      changed: input.previousObservationToken !== undefined && input.previousObservationToken !== token,
    });
  }

  liveness(_input: { readonly identity: RuntimeWorkerIdentity; readonly boundMs: number }): RuntimeLiveness { return 'idle'; }
  stopWorker(_input: { readonly identity: RuntimeWorkerIdentity; readonly timeoutMs?: number }): RuntimeResult<{ readonly stopped: true }> { return ok({ stopped: true }); }
  removeOwnedWorkspace(_input: { readonly workspacePath: string; readonly timeoutMs?: number }): RuntimeResult<{ readonly removed: true }> { return ok({ removed: true }); }

  restart(): void { this.generation += 1; }
  appendOutput(): void { this.outputVersion += 1; }

  private worker(provenance: 'internal' | 'external'): RuntimeWorker {
    return {
      identity: { id: 'worker-1', generation: `generation-${this.generation}` },
      workspacePath: '/workspace',
      provenance,
      runtime: this.name,
    };
  }
}

function observerSnapshot(adapter: RuntimeAdapter): {
  readonly workers: readonly RuntimeWorker[];
  readonly liveness: RuntimeLiveness;
} {
  const listed = adapter.listWorkers({ workspacePath: '/workspace' });
  if (listed.status !== 'ok' || listed.value.length === 0) throw new Error('worker missing');
  return {
    workers: listed.value,
    liveness: adapter.liveness({ identity: listed.value[0]!.identity, boundMs: 50 }),
  };
}

describe('runtime-neutral contract', () => {
  it('instantiates only the explicitly selected static adapter', () => {
    const calls: string[] = [];
    const selected = selectRuntimeAdapter({
      runtimeName: 'orca',
      factories: {
        orca: () => { calls.push('orca'); return new DeterministicAdapter('orca'); },
        future: () => { calls.push('future'); return new DeterministicAdapter('future'); },
      },
    });
    expect(selected.name).toBe('orca');
    expect(calls).toEqual(['orca']);
  });

  it('fails before effects for unknown or unavailable selections', () => {
    expect(() => selectRuntimeAdapter({ runtimeName: 'missing', factories: {} }))
      .toThrowError(RuntimeSelectionError);
    const unavailable = new DeterministicAdapter('orca');
    unavailable.isAvailable = () => false;
    expect(() => selectRuntimeAdapter({ runtimeName: 'orca', factories: { orca: () => unavailable } }))
      .toThrowError(/runtime_unavailable:orca/u);
  });

  it('lets the same observer caller consume a deterministic replacement adapter', () => {
    const first = observerSnapshot(new DeterministicAdapter('orca'));
    const second = observerSnapshot(new DeterministicAdapter('test'));
    expect(first.liveness).toBe('idle');
    expect(second.liveness).toBe('idle');
    expect(first.workers[0]?.runtime).toBe('orca');
    expect(second.workers[0]?.runtime).toBe('test');
  });

  it('keeps generation and output observations distinct across restart and new output', () => {
    const adapter = new DeterministicAdapter();
    const beforeList = adapter.listWorkers({});
    const before = beforeList.status === 'ok' ? beforeList.value[0]! : null;
    expect(before).not.toBeNull();
    const baseline = adapter.readBoundedOutput({ identity: before!.identity });
    expect(baseline.status).toBe('ok');
    adapter.appendOutput();
    const changed = adapter.readBoundedOutput({
      identity: before!.identity,
      previousObservationToken: baseline.status === 'ok' ? baseline.value.observationToken : undefined,
    });
    expect(changed.status === 'ok' && changed.value.changed).toBe(true);
    adapter.restart();
    const afterList = adapter.listWorkers({});
    const after = afterList.status === 'ok' ? afterList.value[0]! : null;
    expect(after?.identity.id).toBe(before?.identity.id);
    expect(after?.identity.generation).not.toBe(before?.identity.generation);
  });
});
