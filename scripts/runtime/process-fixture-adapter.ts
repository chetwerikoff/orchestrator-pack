import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  runtimeFailure,
  runtimeUnsupported,
  sameRuntimeWorker,
  type RuntimeAdapter,
  type RuntimeBoundedOutput,
  type RuntimeCallOptions,
  type RuntimeDispatchResult,
  type RuntimeLivenessResult,
  type RuntimeObservationToken,
  type RuntimeReadiness,
  type RuntimeResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from './contracts.ts';

interface FixtureWorker {
  id: string;
  generation: string;
  bindingKey: string;
  lines: string[];
  liveness: 'busy' | 'idle' | 'gone' | 'unknown';
  provenance?: 'internal' | 'external';
}
interface FixtureState {
  workers: FixtureWorker[];
  dispatchOutcome?: 'dispatched' | 'send_failed' | 'dispatch_unknown';
  dispatches?: Array<{ workerId: string; message: string }>;
}

function fixturePath(env: NodeJS.ProcessEnv): string {
  const value = String(env.OPK_PROCESS_FIXTURE_PATH ?? '').trim();
  if (!value) throw new Error('process_fixture_path_missing');
  return path.resolve(value);
}
function readState(file: string): FixtureState {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as FixtureState;
  if (!Array.isArray(parsed.workers)) throw new Error('process_fixture_invalid');
  return parsed;
}
function writeState(file: string, state: FixtureState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
function identity(worker: FixtureWorker): RuntimeWorkerIdentity {
  return { runtime: 'process-fixture', id: worker.id, generation: worker.generation };
}
function runtimeWorker(worker: FixtureWorker): RuntimeWorker {
  return {
    identity: identity(worker),
    workspacePath: '/process-fixture/workspace',
    title: null,
    provenance: worker.provenance ?? 'internal',
  };
}
function outputToken(worker: FixtureWorker): RuntimeObservationToken {
  const digest = createHash('sha256').update(JSON.stringify(worker.lines), 'utf8').digest('hex');
  return { opaque: `process-fixture-v1.${worker.id}.${worker.generation}.${digest}` };
}

export class ProcessFixtureRuntimeAdapter implements RuntimeAdapter {
  readonly id = 'process-fixture' as const;
  readonly #env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv = process.env) { this.#env = env; }
  #read(): FixtureState { return readState(fixturePath(this.#env)); }

  readiness(_options: RuntimeCallOptions = {}): RuntimeResult<RuntimeReadiness> {
    return { status: 'ok', value: { ready: true, workspacePath: '/process-fixture/workspace' } };
  }
  listWorkers(): RuntimeResult<readonly RuntimeWorker[]> {
    try { return { status: 'ok', value: this.#read().workers.map(runtimeWorker) }; }
    catch { return runtimeFailure('list_workers', 'process_fixture_unavailable'); }
  }
  findWorkerById(id: string): RuntimeResult<RuntimeWorker | null> {
    try { const row = this.#read().workers.find((worker) => worker.id === id); return { status: 'ok', value: row ? runtimeWorker(row) : null }; }
    catch { return runtimeFailure('find_worker_by_id', 'process_fixture_unavailable'); }
  }
  findWorker(expected: RuntimeWorkerIdentity): RuntimeResult<RuntimeWorker | null> {
    const found = this.findWorkerById(expected.id);
    return found.status === 'ok'
      ? { status: 'ok', value: found.value && sameRuntimeWorker(found.value.identity, expected) ? found.value : null }
      : found;
  }
  resolveAssignmentWorker(input: { provider: string; bindingKey: string }): RuntimeResult<RuntimeWorker | null> {
    if (input.provider !== 'process-fixture') return runtimeUnsupported('resolve_assignment_worker', 'assignment_provider_unsupported');
    try {
      const row = this.#read().workers.filter((worker) => worker.bindingKey === input.bindingKey);
      return { status: 'ok', value: row.length === 1 ? runtimeWorker(row[0]!) : null };
    } catch { return runtimeFailure('resolve_assignment_worker', 'process_fixture_unavailable'); }
  }
  spawnWorker(): RuntimeResult<RuntimeWorker> { return runtimeUnsupported('spawn_worker', 'process_fixture_test_only'); }
  dispatchInput(input: { worker: RuntimeWorkerIdentity; text?: string; submitOnly?: boolean }): RuntimeDispatchResult {
    try {
      const file = fixturePath(this.#env); const state = readState(file);
      const row = state.workers.find((worker) => worker.id === input.worker.id && sameRuntimeWorker(identity(worker), input.worker));
      if (!row) return { status: 'send_failed', reason: 'worker_not_found' };
      const outcome = state.dispatchOutcome ?? 'dispatched';
      if (outcome === 'send_failed') return { status: 'send_failed', reason: 'fixture_send_failed' };
      if (outcome === 'dispatch_unknown') return { status: 'dispatch_unknown', reason: 'fixture_dispatch_unknown' };
      const message = input.submitOnly ? '<submit>' : String(input.text ?? '');
      state.dispatches = [...(state.dispatches ?? []), { workerId: row.id, message }];
      row.lines = [...row.lines, message];
      writeState(file, state);
      return { status: 'dispatched' };
    } catch { return { status: 'dispatch_unknown', reason: 'process_fixture_unavailable' }; }
  }
  readBoundedOutput(input: { worker: RuntimeWorkerIdentity; previousToken?: RuntimeObservationToken | null; limit?: number }): RuntimeResult<RuntimeBoundedOutput> {
    try {
      const row = this.#read().workers.find((worker) => worker.id === input.worker.id && sameRuntimeWorker(identity(worker), input.worker));
      if (!row) return runtimeFailure('read_bounded_output', 'worker_not_found');
      const token = outputToken(row);
      return { status: 'ok', value: {
        worker: identity(row), lines: row.lines.slice(-(input.limit ?? row.lines.length)), observationToken: token,
        changed: input.previousToken ? input.previousToken.opaque !== token.opaque : false,
        terminalState: row.liveness === 'gone' ? 'exited' : 'running',
      } };
    } catch { return runtimeFailure('read_bounded_output', 'process_fixture_unavailable'); }
  }
  liveness(input: { worker: RuntimeWorkerIdentity; observationWindowMs: number }): RuntimeLivenessResult {
    try {
      const row = this.#read().workers.find((worker) => worker.id === input.worker.id && sameRuntimeWorker(identity(worker), input.worker));
      return { status: row?.liveness ?? 'gone', worker: input.worker };
    } catch { return { status: 'unknown', worker: input.worker }; }
  }
  stopWorker(): RuntimeResult<{ stopped: true }> { return runtimeUnsupported('stop_worker', 'process_fixture_test_only'); }
}
