import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  fsyncSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  mocks.fsyncSync.mockImplementation(actual.fsyncSync);
  return { ...actual, fsyncSync: mocks.fsyncSync };
});
import { runSchedulerTick } from './scheduler.ts';
import {
  FleetObserver,
  MAX_SNAPSHOT_BYTES,
  MAX_UNITS,
  calculateFleetObserverBudget,
  isAcceptedFleetSnapshot,
  serializeFleetSnapshot,
  snapshotByteLength,
  type FleetObserverSource,
} from './fleet-observer.ts';
import type {
  RuntimeBoundedOutput,
  RuntimeLivenessResult,
  RuntimeObservationToken,
  RuntimeResult,
  RuntimeWorker,
  RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';

interface FakeState {
  worker: RuntimeWorker;
  changed: boolean;
  liveness: RuntimeLivenessResult['status'];
}

class FakeFleetSource implements FleetObserverSource {
  readonly workers = new Map<string, FakeState>();

  add(id: string, generation = 'gen-1', liveness: RuntimeLivenessResult['status'] = 'idle'): RuntimeWorker {
    const worker: RuntimeWorker = {
      identity: { id, generation, runtime: 'fake' },
      workspacePath: '/opaque/workspace',
      title: 'secret display title',
      provenance: id.startsWith('external') ? 'external' : 'internal',
    };
    this.workers.set(id, { worker, changed: false, liveness });
    return worker;
  }

  remove(id: string): void {
    this.workers.delete(id);
  }

  setChanged(id: string, changed: boolean): void {
    const state = this.workers.get(id);
    if (!state) throw new Error('missing fake worker');
    state.changed = changed;
  }

  setLiveness(id: string, liveness: RuntimeLivenessResult['status']): void {
    const state = this.workers.get(id);
    if (!state) throw new Error('missing fake worker');
    state.liveness = liveness;
  }

  listWorkers(): RuntimeResult<readonly RuntimeWorker[]> {
    return { status: 'ok', value: [...this.workers.values()].map((state) => state.worker) };
  }

  findWorker(identity: RuntimeWorkerIdentity): RuntimeResult<RuntimeWorker | null> {
    const state = this.workers.get(identity.id);
    return {
      status: 'ok',
      value: state && state.worker.identity.generation === identity.generation ? state.worker : null,
    };
  }

  readBoundedOutput(input: {
    worker: RuntimeWorkerIdentity;
    previousToken?: RuntimeObservationToken | null;
  }): RuntimeResult<RuntimeBoundedOutput> {
    const state = this.workers.get(input.worker.id);
    if (!state) return { status: 'failed', operation: 'read_bounded_output', reason: 'gone' };
    const token = { opaque: `opaque-token-${input.worker.id}-${input.worker.generation}` };
    return {
      status: 'ok',
      value: {
        worker: state.worker.identity,
        lines: ['this bounded output is never persisted'],
        observationToken: token,
        changed: input.previousToken ? state.changed : false,
        terminalState: state.liveness === 'gone' ? 'exited' : 'running',
      },
    };
  }

  liveness(input: {
    worker: RuntimeWorkerIdentity;
  }): RuntimeLivenessResult {
    const state = this.workers.get(input.worker.id);
    return {
      status: state && state.worker.identity.generation === input.worker.generation
        ? state.liveness
        : 'gone',
      worker: input.worker,
    };
  }
}

class ContradictoryGenerationSource extends FakeFleetSource {
  override findWorker(identity: RuntimeWorkerIdentity): RuntimeResult<RuntimeWorker | null> {
    const found = super.findWorker(identity);
    if (found.status !== 'ok' || !found.value) return found;
    return {
      status: 'ok',
      value: {
        ...found.value,
        identity: { ...found.value.identity, generation: 'gen-contradictory' },
      },
    };
  }
}

class WrongIdentityGoneOutputSource extends FakeFleetSource {
  override readBoundedOutput(input: {
    worker: RuntimeWorkerIdentity;
    previousToken?: RuntimeObservationToken | null;
  }): RuntimeResult<RuntimeBoundedOutput> {
    const result = super.readBoundedOutput(input);
    if (result.status !== 'ok') return result;
    return {
      status: 'ok',
      value: {
        ...result.value,
        worker: { ...result.value.worker, generation: 'wrong-generation' },
      },
    };
  }
}

class ConcurrentFleetSource extends FakeFleetSource {
  active = 0;
  peak = 0;

  override async readBoundedOutput(input: {
    worker: RuntimeWorkerIdentity;
    previousToken?: RuntimeObservationToken | null;
  }): Promise<RuntimeResult<RuntimeBoundedOutput>> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    await Promise.resolve();
    const result = super.readBoundedOutput(input);
    this.active -= 1;
    return result;
  }
}

class SupersedingFleetSource extends FakeFleetSource {
  private releaseGate: (() => void) | undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  release(): void {
    this.releaseGate?.();
  }

  override async readBoundedOutput(input: {
    worker: RuntimeWorkerIdentity;
    previousToken?: RuntimeObservationToken | null;
  }): Promise<RuntimeResult<RuntimeBoundedOutput>> {
    await this.gate;
    return super.readBoundedOutput(input);
  }
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function observerFor(source: FakeFleetSource, config: unknown = undefined, generation = 'sg-test-1'): FleetObserver {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fleet-observer-1258-'));
  roots.push(root);
  const configPath = path.join(root, 'config.json');
  if (config !== undefined) writeFileSync(configPath, JSON.stringify(config));
  return new FleetObserver({
    source,
    configPath,
    snapshotPath: path.join(root, 'state', 'snapshot.json'),
    generationFactory: () => generation,
  });
}

describe('S1 fleet observer', () => {
  it('uses the exact budget formula and fixed ceilings', () => {
    expect(calculateFleetObserverBudget({}, 20_000)).toEqual({
      configuredBudgetMs: null,
      effectiveBudgetMs: 5_000,
      settlementReserveMs: 250,
    });
    expect(calculateFleetObserverBudget({ phaseBudgetMs: 17 }, 100)).toEqual({
      configuredBudgetMs: 17,
      effectiveBudgetMs: 17,
      settlementReserveMs: 3,
    });
    expect(MAX_UNITS).toBe(256);
    expect(MAX_SNAPSHOT_BYTES).toBe(1_048_576);
  });

  it('classifies positive idle, busy, livelock, unknown, and exact exemptions', async () => {
    const source = new FakeFleetSource();
    source.add('idle');
    source.add('busy', 'gen-1', 'busy');
    source.add('unknown', 'gen-1', 'unknown');
    const observer = observerFor(source, { schemaVersion: 1, livelockTicks: 2 });

    const first = await observer.tick({ schedulerIntervalMs: 1_000 });
    expect(first.snapshot?.census.map((row) => row.class)).toEqual(['idle', 'unknown', 'unknown']);
    source.setChanged('busy', true);
    const second = await observer.tick({ schedulerIntervalMs: 1_000 });
    expect(second.snapshot?.census.find((row) => row.unitRef === 'u-000002')?.class).toBe('busy');
    source.setChanged('busy', false);
    const third = await observer.tick({ schedulerIntervalMs: 1_000 });
    expect(third.snapshot?.census.find((row) => row.unitRef === 'u-000002')?.class).toBe('unknown');
    const fourth = await observer.tick({ schedulerIntervalMs: 1_000 });
    expect(fourth.snapshot?.census.find((row) => row.unitRef === 'u-000002')?.class).toBe('livelock');

    const configPath = path.join(path.dirname(observer.snapshotPath), '..', 'config.json');
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1,
      livelockTicks: 2,
      exceptions: [{ kind: 'HELD', schedulerGeneration: observer.schedulerGeneration, unitRef: 'u-000001' }],
    }));
    source.setChanged('idle', true);
    const exempt = await observer.tick({ schedulerIntervalMs: 1_000 });
    expect(exempt.snapshot?.census.find((row) => row.unitRef === 'u-000001')?.class).toBe('exempt');
  });

  it('closes positive gone and gives a reappearance a fresh reference', async () => {
    const source = new FakeFleetSource();
    source.add('worker', 'gen-1', 'gone');
    const observer = observerFor(source);
    const gone = await observer.tick({ schedulerIntervalMs: 1_000 });
    expect(gone.snapshot?.census).toEqual([]);
    expect(gone.snapshot?.transitions.some((transition) => transition.reason === 'positive-gone')).toBe(true);

    source.setLiveness('worker', 'idle');
    const reappeared = await observer.tick({ schedulerIntervalMs: 1_000 });
    expect(reappeared.snapshot?.census).toHaveLength(1);
    expect(reappeared.snapshot?.census[0]?.unitRef).toBe('u-000002');
    expect(reappeared.snapshot?.transitions.some((transition) => transition.reason === 'unit-present')).toBe(true);
  });

  it('retains the prior census and fails closed on a fleet cap', async () => {
    const source = new FakeFleetSource();
    source.add('one');
    const observer = observerFor(source);
    const accepted = await observer.tick({ schedulerIntervalMs: 1_000 });
    expect(accepted.snapshotCommitted).toBe(true);
    source.remove('one');
    for (let index = 0; index < MAX_UNITS; index += 1) source.add(`at-limit-${index}`);
    const atLimit = await observer.tick({ schedulerIntervalMs: 1_000 });
    expect(atLimit.status).toBe('complete');
    expect(atLimit.snapshotCommitted).toBe(true);
    expect(atLimit.snapshot?.census).toHaveLength(MAX_UNITS);

    for (let index = 0; index < MAX_UNITS; index += 1) source.remove(`at-limit-${index}`);
    for (let index = 0; index < MAX_UNITS + 1; index += 1) source.add(`worker-${index}`);
    const capped = await observer.tick({ schedulerIntervalMs: 1_000 });
    expect(capped.status).toBe('failed');
    expect(capped.reason).toBe('fleet-cap-exceeded');
    expect(capped.snapshot?.census).toEqual(atLimit.snapshot?.census);
    expect(capped.snapshot?.transitions).toEqual(atLimit.snapshot?.transitions);
  });

  it('rejects stale and private snapshot content, and accepts the atomic result', async () => {
    const source = new FakeFleetSource();
    source.add('opaque-runtime-id');
    const observer = observerFor(source);
    const result = await observer.tick({ schedulerIntervalMs: 1_000 });
    const bytes = readFileSync(observer.snapshotPath, 'utf8');
    expect(isAcceptedFleetSnapshot(bytes)).toBe(true);
    expect(bytes).not.toContain('opaque-runtime-id');
    expect(bytes).not.toContain('opaque-token');
    expect(bytes).not.toContain('secret display title');
    expect(isAcceptedFleetSnapshot(bytes.slice(0, -1))).toBe(false);
    expect(result.zeroActuation).toBe(true);
  });

  it('calls the observer exactly once without changing scheduler actions', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fleet-observer-epoch-'));
    roots.push(root);
    const authorityPath = path.join(root, 'epoch.json');
    const epochId = 'epoch-1258';
    const nonce = 'nonce-1258';
    const core = {
      epochId,
      nonce,
      hostId: 'host-1258',
      repoRoot: process.cwd(),
      installedCommitSha: 'a'.repeat(40),
      snapshotDigests: { reconcile: 'a', reevaluation: 'b', reportStateSeed: 'c' },
      importDigests: { reconcile: 'd', reevaluation: 'e', reportStateSeed: 'f' },
      registryHash: 'g',
      preCommitLogDigest: 'h',
      commitAt: '2026-08-03T13:00:00.000Z',
    };
    writeFileSync(authorityPath, JSON.stringify({
      schemaVersion: 1,
      currentEpochId: epochId,
      records: [core],
    }));
    const source = new FakeFleetSource();
    source.add('scheduler-unit');
    const observer = observerFor(source);
    const boundary = {
      listCandidates: () => [],
      readCurrentPr: vi.fn(),
      readChecks: vi.fn(),
      listReviewRuns: () => [],
      start: vi.fn(async () => ({ ok: true })),
      schedulerIntervalMs: 1_000,
      fleetObserver: observer,
    };
    const result = await runSchedulerTick(boundary, {
      ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath,
      ORCHESTRATOR_CUTOVER_EPOCH_ID: epochId,
      ORCHESTRATOR_CUTOVER_NONCE: nonce,
    });
    expect(result).toMatchObject({ attempted: 0, started: 0, skipped: 0 });
    expect(result.observer?.snapshotCommitted).toBe(true);
    expect(boundary.start).not.toHaveBeenCalled();

    const observerFailureBoundary = {
      ...boundary,
      listCandidates: vi.fn(() => []),
      fleetObserver: { tick: vi.fn(async () => { throw new Error('adapter unavailable'); }) },
    };
    const afterObserverFailure = await runSchedulerTick(observerFailureBoundary, {
      ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath,
      ORCHESTRATOR_CUTOVER_EPOCH_ID: epochId,
      ORCHESTRATOR_CUTOVER_NONCE: nonce,
    });
    expect(observerFailureBoundary.listCandidates).toHaveBeenCalled();
    expect(afterObserverFailure).toMatchObject({ attempted: 0, started: 0, skipped: 0 });
  });

  it('covers smoke scenario 3 at the exact UTF-8 snapshot byte boundary', async () => {
    const source = new FakeFleetSource();
    source.add('byte-boundary');
    const observer = observerFor(source);
    const result = await observer.tick({ schedulerIntervalMs: 1_000 });
    const base = serializeFleetSnapshot(result.snapshot!);
    const exact = `${base}${' '.repeat(MAX_SNAPSHOT_BYTES - snapshotByteLength(result.snapshot!))}`;
    const over = `${exact} `;

    expect(Buffer.byteLength(exact, 'utf8')).toBe(1_048_576);
    expect(Buffer.byteLength(over, 'utf8')).toBe(1_048_577);
    expect(isAcceptedFleetSnapshot(exact)).toBe(true);
    expect(isAcceptedFleetSnapshot(over)).toBe(false);
    expect(readFileSync(observer.snapshotPath, 'utf8')).toBe(base);
  });

  it('covers smoke scenario 4 by invalidating a near-deadline publication', async () => {
    let expired = false;
    const source = new FakeFleetSource();
    source.add('near-deadline');
    const configRoot = mkdtempSync(path.join(os.tmpdir(), 'fleet-observer-deadline-'));
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'fleet-observer-deadline-state-'));
    roots.push(configRoot, stateRoot);
    const observer = new FleetObserver({
      source,
      configPath: path.join(configRoot, 'config.json'),
      snapshotPath: path.join(stateRoot, 'snapshot.json'),
      generationFactory: () => 'sg-deadline',
      now: () => (expired ? 26 : 0),
    });
    const original = source.readBoundedOutput.bind(source);
    source.readBoundedOutput = (input) => {
      const output = original(input);
      expired = true;
      return output;
    };

    const result = await observer.tick({ schedulerIntervalMs: 100, phaseStartMs: 0 });
    expect(result.snapshotCommitted).toBe(false);
    expect(result.schedulerReturnedWithinBudget).toBe(false);
  });

  it('covers smoke scenario 6 without emitting disappearance for contradictory generation evidence', async () => {
    const source = new ContradictoryGenerationSource();
    source.add('contradictory', 'gen-1', 'gone');
    const observer = observerFor(source);
    const result = await observer.tick({ schedulerIntervalMs: 1_000 });

    expect(result.snapshot?.census[0]?.class).toBe('unknown');
    expect(result.snapshot?.census[0]?.reason).toBe('identity-contradiction');
    expect(result.snapshot?.transitions.some((transition) => transition.reason === 'positive-gone')).toBe(false);
  });

  it('does not settle gone when output identity differs', async () => {
    const source = new WrongIdentityGoneOutputSource();
    source.add('worker', 'gen-1', 'gone');
    const observer = observerFor(source);
    const result = await observer.tick({ schedulerIntervalMs: 1_000 });

    expect(result.snapshot?.census[0]?.class).toBe('unknown');
    expect(result.snapshot?.transitions.some((transition) => transition.reason === 'positive-gone')).toBe(false);
  });

  it('covers smoke scenario 7 with bounded deterministic fleet concurrency', async () => {
    const source = new ConcurrentFleetSource();
    for (let index = 0; index < 12; index += 1) source.add(`delayed-${index}`);
    const observer = observerFor(source, { schemaVersion: 1, maxConcurrency: 3 });
    const result = await observer.tick({ schedulerIntervalMs: 1_000 });

    expect(source.peak).toBeLessThanOrEqual(3);
    expect(result.snapshotCommitted).toBe(true);
    expect(result.snapshot?.census).toHaveLength(12);
    expect(result.schedulerReturnedWithinBudget).toBe(true);
  });

  it('covers smoke scenario 9 with a restart-safe unit reference collision', async () => {
    const source = new FakeFleetSource();
    source.add('restart-worker');
    const root = mkdtempSync(path.join(os.tmpdir(), 'fleet-observer-restart-'));
    roots.push(root);
    const configPath = path.join(root, 'config.json');
    const snapshotPath = path.join(root, 'snapshot.json');
    const first = new FleetObserver({
      source,
      configPath,
      snapshotPath,
      generationFactory: () => 'sg-before-restart',
    });
    const firstResult = await first.tick({ schedulerIntervalMs: 1_000 });
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1,
      exceptions: [{ kind: 'HELD', schedulerGeneration: 'sg-before-restart', unitRef: 'u-000001' }],
    }));
    const restarted = new FleetObserver({
      source,
      configPath,
      snapshotPath,
      generationFactory: () => 'sg-after-restart',
    });
    const restartedResult = await restarted.tick({ schedulerIntervalMs: 1_000 });

    expect(firstResult.snapshot?.census[0]?.unitRef).toBe('u-000001');
    expect(restarted.schedulerGeneration).toBe('sg-after-restart');
    expect(restartedResult.snapshot?.census[0]?.unitRef).toBe('u-000001');
    expect(restartedResult.snapshot?.census[0]?.class).toBe('idle');
    expect(restartedResult.exceptionCollisionRejected).toBe(true);
  });

  it('covers smoke scenario 11 by retaining the prior result on publication failure', async () => {
    const source = new FakeFleetSource();
    source.add('publication-fault');
    const observer = observerFor(source);
    const accepted = await observer.tick({ schedulerIntervalMs: 1_000 });
    rmSync(observer.snapshotPath);
    mkdirSync(observer.snapshotPath);
    const failed = await observer.tick({ schedulerIntervalMs: 1_000 });

    expect(accepted.snapshotCommitted).toBe(true);
    expect(failed.snapshotCommitted).toBe(false);
    expect(failed.status).toBe('failed');
    expect(failed.reason).toBe('snapshot-publication-failed');
    expect(failed.snapshot?.census).toEqual(accepted.snapshot?.census);
  });

  it('invalidates an unvalidated replacement when directory sync and rollback both fail', async () => {
    const source = new FakeFleetSource();
    source.add('rollback-fault');
    const observer = observerFor(source);
    await observer.tick({ schedulerIntervalMs: 1_000 });

    let fsyncCalls = 0;
    const fsync = vi.mocked(fs.fsyncSync);
    const originalFsync = fsync.getMockImplementation();
    fsync.mockImplementation((fd) => {
      fsyncCalls += 1;
      if (fsyncCalls >= 2) throw new Error('injected fsync failure');
      return originalFsync!(fd);
    });

    let failed;
    try {
      failed = await observer.tick({ schedulerIntervalMs: 1_000 });
    } finally {
      fsync.mockImplementation(originalFsync!);
    }

    expect(fsyncCalls).toBeGreaterThanOrEqual(3);
    expect(failed.snapshotCommitted).toBe(false);
    expect(failed.status).toBe('failed');
    const snapshotBytes = existsSync(observer.snapshotPath)
      ? readFileSync(observer.snapshotPath, 'utf8')
      : null;
    expect(snapshotBytes === null || !isAcceptedFleetSnapshot(snapshotBytes)).toBe(true);
  });

  it('covers smoke scenario 12 by rejecting stale completion after supersession', async () => {
    const source = new SupersedingFleetSource();
    source.add('stale-completion');
    const observer = observerFor(source, undefined, 'sg-stale');
    const firstPromise = observer.tick({ schedulerIntervalMs: 1_000, tickSequence: 1 });
    await Promise.resolve();
    const secondPromise = observer.tick({ schedulerIntervalMs: 1_000, tickSequence: 2 });
    source.release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.staleCompletionRejected).toBe(true);
    expect(first.snapshotCommitted).toBe(false);
    expect(second.snapshotCommitted).toBe(true);
    expect(second.snapshot?.tickSequence).toBe(2);
  });
});
