import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  fsyncSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  mocks.fsyncSync.mockImplementation(actual.fsyncSync);
  mocks.readFileSync.mockImplementation(actual.readFileSync);
  mocks.renameSync.mockImplementation(actual.renameSync);
  mocks.rmSync.mockImplementation(actual.rmSync);
  mocks.writeFileSync.mockImplementation(actual.writeFileSync);
  return {
    ...actual,
    fsyncSync: mocks.fsyncSync,
    readFileSync: mocks.readFileSync,
    renameSync: mocks.renameSync,
    rmSync: mocks.rmSync,
    writeFileSync: mocks.writeFileSync,
  };
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

class AdmissionControlledFleetSource extends FakeFleetSource {
  active = 0;
  peak = 0;
  admitted = 0;
  completed = 0;
  private readonly pending: Array<() => void> = [];

  override readBoundedOutput(input: {
    worker: RuntimeWorkerIdentity;
    previousToken?: RuntimeObservationToken | null;
  }): Promise<RuntimeResult<RuntimeBoundedOutput>> {
    this.admitted += 1;
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    return new Promise((resolve) => {
      this.pending.push(() => {
        this.active -= 1;
        this.completed += 1;
        resolve(super.readBoundedOutput(input));
      });
    });
  }

  releaseAll(): void {
    while (this.pending.length > 0) this.pending.shift()!();
  }
}

class DeferredListingFleetSource extends FakeFleetSource {
  private readonly pending: Array<() => void> = [];
  private readonly queuedListings: RuntimeWorker[][] = [];

  queueListing(workers: RuntimeWorker[]): void {
    this.queuedListings.push(workers);
  }

  override listWorkers(): Promise<RuntimeResult<readonly RuntimeWorker[]>> {
    const workers = this.queuedListings.shift()
      ?? [...this.workers.values()].map((state) => state.worker);
    return new Promise((resolve) => {
      this.pending.push(() => resolve({ status: 'ok', value: workers }));
    });
  }

  async waitForPending(count: number): Promise<void> {
    while (this.pending.length < count) await Promise.resolve();
  }

  releaseNext(): void {
    const release = this.pending.shift();
    if (!release) throw new Error('missing deferred list result');
    release();
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

  it('keeps delimiter-bearing opaque identities independent', async () => {
    const source = new FakeFleetSource();
    source.add('a\u0000b', 'c');
    source.add('a', 'b\u0000c');
    const observer = observerFor(source);
    const result = await observer.tick({ schedulerIntervalMs: 1_000 });
    expect(result.snapshot?.census).toHaveLength(2);
    expect(new Set(result.snapshot?.census.map((row) => row.unitRef)).size).toBe(2);
  });

  it('rejects malformed output instead of granting class authority', async () => {
    const source = new FakeFleetSource();
    const worker = source.add('malformed-output');
    source.readBoundedOutput = () => ({
      status: 'ok',
      value: {
        worker: worker.identity,
        lines: ['bounded'],
        observationToken: { opaque: 'token', unexpected: true },
        changed: false,
        terminalState: 'running',
      },
    } as unknown as RuntimeResult<RuntimeBoundedOutput>);
    const result = await observerFor(source).tick({ schedulerIntervalMs: 1_000 });
    expect(result.snapshot?.census[0]).toMatchObject({ class: 'unknown', reason: 'observation-failed' });
  });

  it('accepts known disappearance output failure with positive same-generation gone', async () => {
    const source = new FakeFleetSource();
    const worker = source.add('vanishing', 'gen-1', 'gone');
    source.readBoundedOutput = () => ({
      status: 'failed',
      operation: 'read_bounded_output',
      reason: 'worker_generation_not_found',
    });
    const result = await observerFor(source).tick({ schedulerIntervalMs: 1_000 });
    expect(result.snapshot?.census).toEqual([]);
    expect(result.snapshot?.transitions.filter((entry) => entry.unitRef === 'u-000001')).toHaveLength(1);
    expect(worker.identity.id).toBe('vanishing');
  });

  it('keeps the prior-generation snapshot authoritative after restart failure', async () => {
    const source = new FakeFleetSource();
    source.add('restart-failure');
    const root = mkdtempSync(path.join(os.tmpdir(), 'fleet-observer-restart-failure-'));
    roots.push(root);
    const configPath = path.join(root, 'config.json');
    const snapshotPath = path.join(root, 'snapshot.json');
    const first = new FleetObserver({ source, configPath, snapshotPath, generationFactory: () => 'sg-before-failure' });
    const accepted = await first.tick({ schedulerIntervalMs: 1_000 });
    const priorBytes = readFileSync(snapshotPath, 'utf8');
    source.listWorkers = () => ({ status: 'failed', operation: 'list_workers', reason: 'transport-down' });
    const restarted = new FleetObserver({ source, configPath, snapshotPath, generationFactory: () => 'sg-after-failure' });
    const failed = await restarted.tick({ schedulerIntervalMs: 1_000 });
    expect(accepted.snapshotCommitted).toBe(true);
    expect(failed.snapshotCommitted).toBe(false);
    expect(failed.snapshot).toBeUndefined();
    expect(readFileSync(snapshotPath, 'utf8')).toBe(priorBytes);
  });

  it('rejects contradictory snapshot class and probe records', async () => {
    const source = new FakeFleetSource();
    source.add('snapshot-validation');
    const observer = observerFor(source);
    const result = await observer.tick({ schedulerIntervalMs: 1_000 });
    const invalid = JSON.parse(serializeFleetSnapshot(result.snapshot!)) as Record<string, unknown>;
    const census = invalid.census as Array<Record<string, unknown>>;
    const row = census[0]!;
    row.class = 'idle';
    row.reason = 'positive-idle';
    row.probes = { output: 'failed', liveness: 'idle' };
    expect(isAcceptedFleetSnapshot(JSON.stringify(invalid))).toBe(false);
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

    const phaseStartedAt = { value: 0 };
    const cancel = vi.fn();
    const delayedObserver = {
      tick: vi.fn(() => new Promise<FleetObserverResult>((resolve) => {
        setTimeout(() => resolve({} as FleetObserverResult), 100);
      })),
      getEffectiveBudgetMs: () => 10,
      cancel,
    };
    const deadlineBoundary = {
      ...boundary,
      listCandidates: vi.fn(() => {
        phaseStartedAt.value = Date.now();
        return [];
      }),
      fleetObserver: delayedObserver,
    };
    const startedAt = Date.now();
    await runSchedulerTick(deadlineBoundary, {
      ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath,
      ORCHESTRATOR_CUTOVER_EPOCH_ID: epochId,
      ORCHESTRATOR_CUTOVER_NONCE: nonce,
    });
    expect(delayedObserver.tick).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(phaseStartedAt.value - startedAt).toBeLessThan(80);
  });

  it('covers smoke scenario 3 through production serialization and commit boundaries', async () => {
    const source = new FakeFleetSource();
    source.add('byte-boundary');
    const observer = observerFor(source);
    const accepted = await observer.tick({ schedulerIntervalMs: 1_000 });
    const originalStringify = JSON.stringify;
    let boundary: 'exact' | 'over' = 'exact';
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      const serialized = originalStringify(value, replacer, space);
      if (typeof value === 'object' && value !== null && 'commitStatus' in value
        && 'tickSequence' in value && [2, 3].includes((value as { tickSequence?: number }).tickSequence ?? 0)) {
        return (value as { tickSequence?: number }).tickSequence === 2
          ? `${serialized}${' '.repeat(MAX_SNAPSHOT_BYTES - Buffer.byteLength(serialized, 'utf8'))}`
          : `${serialized}${' '.repeat(MAX_SNAPSHOT_BYTES - Buffer.byteLength(serialized, 'utf8') + 1)}`;
      }
      return serialized;
    });
    try {
      const exact = await observer.tick({ schedulerIntervalMs: 1_000 });
      const exactBytes = readFileSync(observer.snapshotPath, 'utf8');
      expect(Buffer.byteLength(exactBytes, 'utf8')).toBe(MAX_SNAPSHOT_BYTES);
      expect(isAcceptedFleetSnapshot(exactBytes)).toBe(true);
      expect(exact.snapshotCommitted).toBe(true);
      expect(exact.snapshot?.tickSequence).toBe(2);

      boundary = 'over';
      const writes = vi.mocked(fs.writeFileSync);
      writes.mockClear();
      const over = await observer.tick({ schedulerIntervalMs: 1_000 });
      expect(over.snapshotCommitted).toBe(false);
      expect(over.status).toBe('failed');
      expect(over.snapshot?.census).toEqual(exact.snapshot?.census);
      expect(writes.mock.calls
        .filter(([target]) => String(target).includes('.tmp-'))
        .every(([, data]) => Buffer.byteLength(String(data), 'utf8') <= MAX_SNAPSHOT_BYTES)).toBe(true);
      expect(stringify).toHaveBeenCalled();
      expect(accepted.snapshotCommitted).toBe(true);
    } finally {
      stringify.mockRestore();
    }
  });

  it('covers smoke scenario 4 through scheduler deadline return and rollback', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const root = mkdtempSync(path.join(os.tmpdir(), 'fleet-observer-deadline-scheduler-'));
      roots.push(root);
      const authorityPath = path.join(root, 'epoch.json');
      writeFileSync(authorityPath, JSON.stringify({
        schemaVersion: 1,
        currentEpochId: 'epoch-1306',
        records: [{
          epochId: 'epoch-1306', nonce: 'nonce-1306', hostId: 'host-1306', repoRoot: process.cwd(),
          installedCommitSha: 'a'.repeat(40), snapshotDigests: {}, importDigests: {}, registryHash: 'a',
          preCommitLogDigest: 'b', commitAt: '2026-08-05T00:00:00.000Z',
        }],
      }));
      let expired = false;
      let injectExpired = false;
      const source = new FakeFleetSource();
      source.add('near-deadline');
      let clock = 0;
      const observer = new FleetObserver({
        source,
        configPath: path.join(root, 'config.json'),
        snapshotPath: path.join(root, 'snapshot.json'),
        generationFactory: () => 'sg-deadline',
        now: () => clock,
      });
      const accepted = await observer.tick({ schedulerIntervalMs: 100, phaseStartMs: 0 });
      const prior = readFileSync(observer.snapshotPath, 'utf8');
      const originalOutput = source.readBoundedOutput.bind(source);
      source.readBoundedOutput = (input) => {
        const output = originalOutput(input);
        if (injectExpired) {
          expired = true;
          clock = 26;
        }
        return output;
      };
      injectExpired = true;
      const boundary = {
        listCandidates: vi.fn(() => []),
        readCurrentPr: vi.fn(),
        readChecks: vi.fn(),
        listReviewRuns: () => [],
        start: vi.fn(async () => ({ ok: true })),
        schedulerIntervalMs: 100,
        fleetObserver: observer,
      };
      const result = await runSchedulerTick(boundary, {
        ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath,
        ORCHESTRATOR_CUTOVER_EPOCH_ID: 'epoch-1306',
        ORCHESTRATOR_CUTOVER_NONCE: 'nonce-1306',
      });
      expect(accepted.snapshotCommitted).toBe(true);
      expect(expired).toBe(true);
      expect(boundary.listCandidates).toHaveBeenCalled();
      expect(boundary.start).not.toHaveBeenCalled();
      expect(result.observer?.snapshotCommitted).toBe(false);
      expect(result.observer?.schedulerReturnedWithinBudget).toBe(false);
      expect(result.observer?.snapshot?.progress.at(-1)?.type).not.toBe('tick-complete');
      expect(readFileSync(observer.snapshotPath, 'utf8')).toBe(prior);
    } finally {
      vi.useRealTimers();
    }
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

  it('rejects a stale list result before mutating shared state', async () => {
    const source = new DeferredListingFleetSource();
    const existing = source.add('existing-listing');
    source.queueListing([existing]);
    const observer = observerFor(source);
    const initialPromise = observer.tick({ schedulerIntervalMs: 1_000, tickSequence: 1 });
    await source.waitForPending(1);
    source.releaseNext();
    const initial = await initialPromise;
    const initialUnitRef = initial.snapshot?.census[0]?.unitRef;
    expect(initialUnitRef).toBe('u-000001');

    source.remove('existing-listing');
    const stale = source.add('stale-listing');
    source.remove('stale-listing');
    source.add('existing-listing');
    source.queueListing([stale]);
    source.queueListing([existing]);

    const stalePromise = observer.tick({ schedulerIntervalMs: 1_000, tickSequence: 2 });
    const currentPromise = observer.tick({ schedulerIntervalMs: 1_000, tickSequence: 3 });
    await source.waitForPending(2);
    source.releaseNext();
    const staleResult = await stalePromise;
    expect(staleResult.staleCompletionRejected).toBe(true);
    expect(staleResult.snapshotCommitted).toBe(false);

    source.releaseNext();
    const currentResult = await currentPromise;
    expect(currentResult.snapshotCommitted).toBe(true);
    expect(currentResult.snapshot?.census[0]?.unitRef).toBe(initialUnitRef);
  });

  it('does not settle gone when output identity differs', async () => {
    const source = new WrongIdentityGoneOutputSource();
    source.add('worker', 'gen-1', 'gone');
    const observer = observerFor(source);
    const result = await observer.tick({ schedulerIntervalMs: 1_000 });

    expect(result.snapshot?.census[0]?.class).toBe('unknown');
    expect(result.snapshot?.transitions.some((transition) => transition.reason === 'positive-gone')).toBe(false);
  });

  it('covers smoke scenario 7 with bounded admission and hard-deadline settlement', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const source = new AdmissionControlledFleetSource();
      for (let index = 0; index < 12; index += 1) source.add(`delayed-${index}`);
      const observer = observerFor(source, { schemaVersion: 1, maxConcurrency: 3 });
      const tick = observer.tick({ schedulerIntervalMs: 1_000, phaseStartMs: 0 });
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
      expect(source.peak).toBe(3);
      vi.advanceTimersByTime(4_000);
      source.releaseAll();
      const result = await tick;
      await Promise.resolve();

      expect(source.peak).toBeLessThanOrEqual(3);
      expect(source.admitted).toBe(3);
      expect(source.completed).toBe(3);
      expect(result.snapshotCommitted).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.snapshot?.census ?? []).toHaveLength(0);
      expect(result.schedulerReturnedWithinBudget).toBe(false);

      const authorityPath = path.join(path.dirname(observer.snapshotPath), 'epoch.json');
      mkdirSync(path.dirname(authorityPath), { recursive: true });
      writeFileSync(authorityPath, JSON.stringify({
        schemaVersion: 1,
        currentEpochId: 'epoch-1306-s7',
        records: [{
          epochId: 'epoch-1306-s7', nonce: 'nonce-1306-s7', hostId: 'host-1306', repoRoot: process.cwd(),
          installedCommitSha: 'a'.repeat(40), snapshotDigests: {}, importDigests: {}, registryHash: 'a',
          preCommitLogDigest: 'b', commitAt: '2026-08-05T00:00:00.000Z',
        }],
      }));
      const boundary = {
        listCandidates: vi.fn(() => []),
        readCurrentPr: vi.fn(),
        readChecks: vi.fn(),
        listReviewRuns: () => [],
        start: vi.fn(async () => ({ ok: true })),
        schedulerIntervalMs: 1_000,
        fleetObserver: { tick: vi.fn(async () => result), getEffectiveBudgetMs: () => 1 },
      };
      await runSchedulerTick(boundary, {
        ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath,
        ORCHESTRATOR_CUTOVER_EPOCH_ID: 'epoch-1306-s7',
        ORCHESTRATOR_CUTOVER_NONCE: 'nonce-1306-s7',
      });
      expect(boundary.listCandidates).toHaveBeenCalled();
      expect(boundary.start).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('covers smoke scenario 9 with restart-discarded continuity and unit-ref collision', async () => {
    const source = new FakeFleetSource();
    source.add('restart-worker', 'gen-1', 'busy');
    const root = mkdtempSync(path.join(os.tmpdir(), 'fleet-observer-restart-'));
    roots.push(root);
    const configPath = path.join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    const snapshotPath = path.join(root, 'snapshot.json');
    const first = new FleetObserver({ source, configPath, snapshotPath, generationFactory: () => 'sg-before-restart' });
    const firstResult = await first.tick({ schedulerIntervalMs: 1_000 });
    source.setChanged('restart-worker', false);
    const secondResult = await first.tick({ schedulerIntervalMs: 1_000 });
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 2, exceptions: [{ kind: 'HELD', schedulerGeneration: 'sg-before-restart', unitRef: 'u-000001' }] }));
    const restarted = new FleetObserver({ source, configPath, snapshotPath, generationFactory: () => 'sg-after-restart' });
    const restartedResult = await restarted.tick({ schedulerIntervalMs: 1_000 });
    expect(firstResult.snapshot?.census[0]?.unitRef).toBe('u-000001');
    expect(secondResult.snapshot?.census[0]?.class).toBe('livelock');
    expect(restarted.schedulerGeneration).toBe('sg-after-restart');
    expect(restartedResult.snapshot?.census[0]?.unitRef).toBe('u-000001');
    expect(restartedResult.snapshot?.census[0]?.class).toBe('unknown');
    expect(restartedResult.snapshot?.census[0]?.reason).toBe('missing-output-baseline');
    expect(restartedResult.exceptionCollisionRejected).toBe(true);
  });

  it('covers smoke scenario 11 with separate replacement and read-back faults', async () => {
    const exercise = async (fault: 'replacement' | 'read-back'): Promise<void> => {
      const source = new FakeFleetSource();
      source.add(`publication-fault-${fault}`);
      const observer = observerFor(source);
      const accepted = await observer.tick({ schedulerIntervalMs: 1_000 });
      const priorBytes = readFileSync(observer.snapshotPath, 'utf8');
      const rename = vi.mocked(fs.renameSync);
      const read = vi.mocked(fs.readFileSync);
      const originalRename = rename.getMockImplementation()!;
      const originalRead = read.getMockImplementation()!;
      let faulted = false;
      try {
        rename.mockImplementation((from, to) => {
          if (fault === 'replacement' && String(from).includes('.tmp-')) { faulted = true; throw new Error('replacement'); }
          return originalRename(from, to);
        });
        read.mockImplementation((target, ...args) => {
          if (fault === 'read-back' && !faulted && String(target) === observer.snapshotPath) { faulted = true; throw new Error('read-back'); }
          return originalRead(target, ...args);
        });
        const failed = await observer.tick({ schedulerIntervalMs: 1_000 });
        expect(faulted).toBe(true);
        expect(accepted.snapshotCommitted).toBe(true);
        expect(failed.status).toBe('failed');
        expect(failed.result).toBe('observer-failed');
        expect(failed.snapshot?.census).toEqual(accepted.snapshot?.census);
        const disk = JSON.parse(readFileSync(observer.snapshotPath, 'utf8')) as { result: string; census: unknown[]; progress: Array<{ type: string }> };
        expect(isAcceptedFleetSnapshot(priorBytes)).toBe(true);
        expect(['complete', 'failed']).toContain(disk.result);
        expect(disk.census).toEqual(accepted.snapshot?.census);
      } finally {
        rename.mockImplementation(originalRename);
        read.mockImplementation(originalRead);
      }
    };
    await exercise('replacement');
    await exercise('read-back');
  });

  it('covers smoke scenario 12 at synchronous serializer and temp-write supersession boundaries', async () => {
    const exercise = async (boundary: 'serializer' | 'temp-write'): Promise<void> => {
      const source = new FakeFleetSource();
      source.add(`superseded-${boundary}`);
      const observer = observerFor(source, undefined, `sg-${boundary}`);
      let newer: Promise<Awaited<ReturnType<FleetObserver['tick']>>> | undefined;
      const originalStringify = JSON.stringify;
      const stringifySpy = boundary === 'serializer' ? vi.spyOn(JSON, 'stringify') : undefined;
      const write = vi.mocked(fs.writeFileSync);
      const originalWrite = write.getMockImplementation()!;
      if (stringifySpy) {
        stringifySpy.mockImplementation((value, replacer, space) => {
          const serialized = originalStringify(value, replacer, space);
          if (!newer && typeof value === 'object' && value !== null && 'tickSequence' in value && (value as { tickSequence?: number }).tickSequence === 1) { observer.cancel(); newer = observer.tick({ schedulerIntervalMs: 1_000, tickSequence: 2 }); }
          return serialized;
        });
      } else {
        write.mockImplementation((target, data, options) => {
          if (!newer && String(target).includes('.tmp-')) { observer.cancel(); newer = observer.tick({ schedulerIntervalMs: 1_000, tickSequence: 2 }); }
          return originalWrite(target, data, options);
        });
      }
      try {
        const first = await observer.tick({ schedulerIntervalMs: 1_000, tickSequence: 1 });
        const second = await newer;
        expect(second).toBeDefined();
        expect(first.staleCompletionRejected).toBe(false);
        expect(first.snapshotCommitted).toBe(false);
        expect(second?.snapshotCommitted).toBe(true);
        expect(second?.snapshot?.tickSequence).toBe(2);
        expect(readFileSync(observer.snapshotPath, 'utf8')).toContain('"tickSequence":2');
      } finally {
        stringifySpy?.mockRestore();
        write.mockImplementation(originalWrite);
      }
    };
    await exercise('serializer');
    await exercise('temp-write');
  });
});
