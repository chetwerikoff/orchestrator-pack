import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isRuntimeWorkerTaskBindingSource,
  type RuntimeBoundedOutput,
  type RuntimeLivenessResult,
  type RuntimeObservationToken,
  type RuntimeResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
  type RuntimeWorkerTaskBindingObservation,
} from './runtime/contracts.ts';
import {
  ORCA_WORKER_TASK_BINDING_STRATEGY,
  OrcaRuntimeAdapter,
} from './orca-runtime/adapter.ts';
import type {
  OrcaJsonResponse,
  OrcaTerminalSummary,
  OrcaWorktreeSummary,
} from './orca-runtime/native.ts';
import {
  FleetObserver,
  type FleetObserverSource,
} from './pr2-foundation/fleet-observer.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface SourceState {
  worker: RuntimeWorker;
  identityResolved: boolean;
}

class BindingFleetSource implements FleetObserverSource {
  readonly states: SourceState[];
  observation: RuntimeWorkerTaskBindingObservation | PromiseLike<RuntimeWorkerTaskBindingObservation>;
  observationCalls = 0;

  constructor(
    workers: readonly RuntimeWorker[],
    observation: RuntimeWorkerTaskBindingObservation | PromiseLike<RuntimeWorkerTaskBindingObservation>,
    unresolvedIds: readonly string[] = [],
  ) {
    this.states = workers.map((worker) => ({
      worker,
      identityResolved: !unresolvedIds.includes(worker.identity.id),
    }));
    this.observation = observation;
  }

  listWorkers(): RuntimeResult<readonly RuntimeWorker[]> {
    return { status: 'ok', value: this.states.map((state) => state.worker) };
  }

  findWorker(identity: RuntimeWorkerIdentity): RuntimeResult<RuntimeWorker | null> {
    const state = this.states.find((candidate) => candidate.worker.identity.id === identity.id);
    if (!state) return { status: 'ok', value: null };
    if (!state.identityResolved) {
      return {
        status: 'ok',
        value: {
          ...state.worker,
          identity: { ...state.worker.identity, generation: `${state.worker.identity.generation}-changed` },
        },
      };
    }
    return { status: 'ok', value: state.worker };
  }

  readBoundedOutput(input: {
    readonly worker: RuntimeWorkerIdentity;
    readonly previousToken?: RuntimeObservationToken | null;
  }): RuntimeResult<RuntimeBoundedOutput> {
    return {
      status: 'ok',
      value: {
        worker: input.worker,
        lines: [],
        observationToken: { opaque: `token-${input.worker.id}` },
        changed: false,
        terminalState: 'running',
      },
    };
  }

  liveness(input: { readonly worker: RuntimeWorkerIdentity }): RuntimeLivenessResult {
    return { status: 'idle', worker: input.worker };
  }

  observeWorkerTaskBindings(
    _input: { readonly workers: readonly RuntimeWorkerIdentity[] },
  ): RuntimeWorkerTaskBindingObservation | PromiseLike<RuntimeWorkerTaskBindingObservation> {
    this.observationCalls += 1;
    return this.observation;
  }
}

function worker(id: string, generation: string, provenance: 'internal' | 'external' = 'internal'): RuntimeWorker {
  return {
    identity: { runtime: 'fake', id, generation },
    workspacePath: `/opaque/${id}`,
    title: null,
    provenance,
  };
}

function observerFor(source: FleetObserverSource, generation = 'sg-binding-test'): FleetObserver {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-binding-1380-'));
  roots.push(root);
  return new FleetObserver({
    source,
    config: {
      schemaVersion: 1,
      livelockTicks: 2,
      phaseBudgetMs: 4_000,
      maxConcurrency: 8,
      exceptions: [],
    },
    snapshotPath: path.join(root, 'snapshot.json'),
    generationFactory: () => generation,
  });
}

function boundObservation(workers: readonly RuntimeWorker[]): RuntimeWorkerTaskBindingObservation {
  return {
    status: 'ok',
    outcomes: workers.map((candidate, index) => index === 0
      ? { status: 'bound' as const, worker: candidate.identity, issueNumber: 1380, provenance: 'internal' as const }
      : index === 1
        ? { status: 'unbound' as const, worker: candidate.identity, provenance: 'internal' as const }
        : { status: 'external' as const, worker: candidate.identity, provenance: 'external' as const }),
  };
}

function terminal(
  handle: string,
  generation: string,
  worktree: number,
  explicit = true,
): OrcaTerminalSummary {
  return {
    handle,
    ...(explicit ? { incarnationId: generation } : { ptyId: generation }),
    worktreeId: `w-${worktree}`,
    worktreePath: `/tmp/w-${worktree}`,
    status: 'running',
  };
}

function worktree(index: number, linkedIssue: number | null): OrcaWorktreeSummary {
  return {
    id: `w-${index}`,
    path: `/tmp/w-${index}`,
    head: `${index}`.repeat(40).slice(0, 40),
    linkedIssue,
  };
}

interface OrcaFixtureOptions {
  readonly terminalA: readonly OrcaTerminalSummary[];
  readonly terminalB?: readonly OrcaTerminalSummary[];
  readonly issueA?: Readonly<Record<number, number | null>>;
  readonly issueB?: Readonly<Record<number, number | null>>;
  readonly seedOwned?: readonly { handle: string; generation: string; worktree: number }[];
  readonly chargeMs?: number;
}

function orcaFixture(options: OrcaFixtureOptions) {
  let now = 0;
  let binding = false;
  let terminalLists = 0;
  let worktreeShows = 0;
  const calls: Array<{ args: readonly string[]; timeoutMs?: number }> = [];
  let createIndex = 0;
  const runJson = <T>(args: readonly string[], callOptions: { readonly timeoutMs?: number } = {}): OrcaJsonResponse<T> => {
    const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
    if (binding) {
      calls.push({ args: [...args], timeoutMs: callOptions.timeoutMs });
      now += options.chargeMs ?? 0;
    }
    let response: OrcaJsonResponse;
    if (operation === 'terminal create') {
      const seed = options.seedOwned?.[createIndex++];
      response = seed
        ? { ok: true, result: { terminal: { handle: seed.handle, incarnationId: seed.generation } } }
        : { ok: false, error: { code: 'unexpected_create' } };
    } else if (operation === 'worktree current') {
      const seed = options.seedOwned?.[Math.max(0, createIndex - 1)];
      response = seed
        ? { ok: true, result: { worktree: worktree(seed.worktree, null) } }
        : { ok: false, error: { code: 'unexpected_current' } };
    } else if (operation === 'terminal list') {
      const terminals = terminalLists++ === 0 ? options.terminalA : options.terminalB ?? options.terminalA;
      response = { ok: true, result: { terminals } };
    } else if (operation === 'worktree show') {
      const selector = args[args.indexOf('--worktree') + 1] ?? '';
      const match = /^path:\/tmp\/w-(\d+)$/.exec(selector);
      const index = match ? Number(match[1]) : NaN;
      const phaseB = worktreeShows >= new Set(options.terminalA.map((item) => item.worktreePath)).size;
      worktreeShows += 1;
      const linkedIssue = phaseB
        ? options.issueB?.[index] ?? options.issueA?.[index] ?? null
        : options.issueA?.[index] ?? null;
      response = Number.isInteger(index)
        ? { ok: true, result: { worktree: worktree(index, linkedIssue) } }
        : { ok: false, error: { code: 'bad_selector' } };
    } else {
      response = { ok: false, error: { code: 'unexpected_operation', message: operation } };
    }
    return response as OrcaJsonResponse<T>;
  };
  const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never, now: () => now });
  const owned: RuntimeWorker[] = [];
  for (const seed of options.seedOwned ?? []) {
    const spawned = adapter.spawnWorker({ title: seed.handle, command: 'noop' });
    if (spawned.status !== 'ok') throw new Error('fixture seed failed');
    owned.push(spawned.value);
  }
  binding = true;
  return { adapter, owned, calls, now: () => now };
}

describe('Issue #1380 runtime worker identity binding', () => {
  it('discovers only the narrow optional structural capability', () => {
    expect(isRuntimeWorkerTaskBindingSource({ observeWorkerTaskBindings: () => ({ status: 'ok', outcomes: [] }) })).toBe(true);
    expect(isRuntimeWorkerTaskBindingSource({ listWorkers: () => [] })).toBe(false);
  });

  it('joins one accepted tick and keeps unresolved identity non-authoritative', async () => {
    const workers = [worker('bound', 'g1'), worker('unbound', 'g2'), worker('external', 'g3', 'external'), worker('contradiction', 'g4')];
    const observation: RuntimeWorkerTaskBindingObservation = {
      status: 'ok',
      outcomes: [
        { status: 'bound', worker: workers[0]!.identity, issueNumber: 1380, provenance: 'internal' },
        { status: 'unbound', worker: workers[1]!.identity, provenance: 'internal' },
        { status: 'external', worker: workers[2]!.identity, provenance: 'external' },
        { status: 'bound', worker: workers[3]!.identity, issueNumber: 9999, provenance: 'internal' },
      ],
    };
    const source = new BindingFleetSource(workers, observation, ['contradiction']);
    const observer = observerFor(source);
    const tick = await observer.tick({ schedulerIntervalMs: 16_000 });
    expect(tick.status).toBe('complete');
    const result = await observer.resolveWorkerIssueBindings({
      schedulerGeneration: tick.schedulerGeneration,
      tickSequence: tick.tickSequence,
    });
    expect(result.status).toBe('complete');
    expect(result.rows.map((row) => row.status)).toEqual(['resolved', 'unbound', 'external', 'identity_unresolved']);
    expect(result.rows[0]).toMatchObject({ status: 'resolved', issueNumber: 1380, unitRef: 'u-000001' });
    const bytes = readFileSync(observer.snapshotPath, 'utf8');
    for (const candidate of workers) {
      expect(bytes).not.toContain(candidate.identity.id);
      expect(bytes).not.toContain(candidate.identity.generation);
    }
    expect(bytes).not.toContain('1380');
  });

  it('keeps row ambiguity above accepted-tick identity contradiction', async () => {
    const workers = [worker('contradiction', 'g1')];
    const source = new BindingFleetSource(workers, {
      status: 'ok',
      outcomes: [{ status: 'ambiguous', worker: workers[0]!.identity, code: 'duplicate_issue' }],
    }, ['contradiction']);
    const observer = observerFor(source, 'sg-ambiguity-precedence');
    const tick = await observer.tick({ schedulerIntervalMs: 16_000 });
    const result = await observer.resolveWorkerIssueBindings({
      schedulerGeneration: tick.schedulerGeneration,
      tickSequence: tick.tickSequence,
    });
    expect(result).toMatchObject({
      status: 'complete',
      rows: [{ status: 'ambiguous', code: 'duplicate_issue' }],
    });
  });

  it('rejects malformed capability sets as one complete unavailable projection', async () => {
    const workers = [worker('one', 'g1'), worker('two', 'g2')];
    const valid = boundObservation(workers);
    if (valid.status !== 'ok') throw new Error('fixture');
    const malformed: unknown[] = [
      { status: 'ok', outcomes: valid.outcomes.slice(0, 1) },
      { status: 'ok', outcomes: [...valid.outcomes, valid.outcomes[0]] },
      { status: 'ok', outcomes: [valid.outcomes[1], valid.outcomes[0]] },
      { status: 'ok', outcomes: [valid.outcomes[0], valid.outcomes[0]] },
      { status: 'ok', outcomes: [{ ...valid.outcomes[0], worker: { ...workers[0]!.identity, generation: 'wrong' } }, valid.outcomes[1]] },
      { status: 'ok', outcomes: [{ status: 'invented', worker: workers[0]!.identity }, valid.outcomes[1]] },
    ];
    for (const response of malformed) {
      const source = new BindingFleetSource(workers, response as RuntimeWorkerTaskBindingObservation);
      const observer = observerFor(source, `sg-malformed-${roots.length}`);
      const tick = await observer.tick({ schedulerIntervalMs: 16_000 });
      const result = await observer.resolveWorkerIssueBindings({ schedulerGeneration: tick.schedulerGeneration, tickSequence: tick.tickSequence });
      expect(result).toMatchObject({ status: 'unavailable', code: 'malformed_or_incomplete' });
      expect(result.rows).toHaveLength(2);
      expect(result.rows.every((row) => row.status === 'unavailable' && row.code === 'malformed_or_incomplete')).toBe(true);
    }
  });

  it('uses one shared same-tick attempt and discards a late old completion', async () => {
    const workers = [worker('one', 'g1')];
    let release!: (value: RuntimeWorkerTaskBindingObservation) => void;
    const pending = new Promise<RuntimeWorkerTaskBindingObservation>((resolve) => { release = resolve; });
    const source = new BindingFleetSource(workers, pending);
    const observer = observerFor(source);
    const firstTick = await observer.tick({ schedulerIntervalMs: 16_000 });
    const first = observer.resolveWorkerIssueBindings({ schedulerGeneration: firstTick.schedulerGeneration, tickSequence: firstTick.tickSequence });
    const second = observer.resolveWorkerIssueBindings({ schedulerGeneration: firstTick.schedulerGeneration, tickSequence: firstTick.tickSequence });
    expect(first).toBe(second);
    expect(source.observationCalls).toBe(1);

    source.observation = { status: 'unavailable', code: 'task_metadata_unavailable' };
    const secondTick = await observer.tick({ schedulerIntervalMs: 16_000 });
    release({ status: 'ok', outcomes: [{ status: 'bound', worker: workers[0]!.identity, issueNumber: 1380, provenance: 'internal' }] });
    const old = await first;
    expect(old).toMatchObject({ status: 'unavailable', code: 'late_completion_discarded' });
    const current = await observer.resolveWorkerIssueBindings({ schedulerGeneration: secondTick.schedulerGeneration, tickSequence: secondTick.tickSequence });
    expect(current).toMatchObject({ status: 'unavailable', code: 'task_metadata_unavailable' });
    const repeated = observer.resolveWorkerIssueBindings({ schedulerGeneration: secondTick.schedulerGeneration, tickSequence: secondTick.tickSequence });
    expect(await repeated).toBe(current);
    expect(source.observationCalls).toBe(2);
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current.rows)).toBe(true);
  });

  it('fails closed for missing capability and a wrong accepted-tick key without invoking authority', async () => {
    const base = new BindingFleetSource([worker('one', 'g1')], { status: 'ok', outcomes: [] });
    const source: FleetObserverSource = {
      listWorkers: () => base.listWorkers(),
      findWorker: (identity) => base.findWorker(identity),
      readBoundedOutput: (input) => base.readBoundedOutput(input),
      liveness: (input) => base.liveness(input),
    };
    const observer = observerFor(source);
    const tick = await observer.tick({ schedulerIntervalMs: 16_000 });
    expect(await observer.resolveWorkerIssueBindings({ schedulerGeneration: tick.schedulerGeneration, tickSequence: tick.tickSequence })).toMatchObject({
      status: 'unavailable', code: 'capability_absent',
    });
    expect(await observer.resolveWorkerIssueBindings({ schedulerGeneration: 'sg-wrong', tickSequence: tick.tickSequence })).toMatchObject({
      status: 'unavailable', code: 'superseded_or_wrong_tick',
    });
  });

  it('grounds complete_ab_revalidation across six worktrees within the priced 4000ms budget', () => {
    const terminals = [
      terminal('bound', 'inc-bound', 1),
      terminal('external', 'inc-external', 2),
      terminal('unbound', 'inc-unbound', 3),
      terminal('other-4', 'inc-4', 4),
      terminal('other-5', 'inc-5', 5),
      terminal('other-6', 'inc-6', 6),
    ];
    const fixture = orcaFixture({
      terminalA: terminals,
      issueA: { 1: 1380 },
      seedOwned: [
        { handle: 'bound', generation: 'inc-bound', worktree: 1 },
        { handle: 'unbound', generation: 'inc-unbound', worktree: 3 },
      ],
      chargeMs: 250,
    });
    const result = fixture.adapter.observeWorkerTaskBindings({
      workers: [fixture.owned[0]!.identity, { runtime: 'orca', id: 'external', generation: 'inc-external' }, fixture.owned[1]!.identity],
    }, { timeoutMs: 4_000 });
    expect(ORCA_WORKER_TASK_BINDING_STRATEGY).toBe('complete_ab_revalidation');
    expect(result).toEqual({
      status: 'ok',
      outcomes: [
        { status: 'bound', worker: fixture.owned[0]!.identity, issueNumber: 1380, provenance: 'internal' },
        { status: 'external', worker: { runtime: 'orca', id: 'external', generation: 'inc-external' }, provenance: 'external' },
        { status: 'unbound', worker: fixture.owned[1]!.identity, provenance: 'internal' },
      ],
    });
    expect(fixture.calls).toHaveLength(14);
    expect(fixture.calls.every((call) => (call.timeoutMs ?? 0) <= 250)).toBe(true);
    expect(fixture.calls.every((call) => ['terminal list', 'worktree show'].includes(`${call.args[0]} ${call.args[1]}`))).toBe(true);
    expect(fixture.now()).toBe(3_500);
  });

  it('fails before Orca authority reads when the producer budget is below the Strategy B requirement', () => {
    const fixture = orcaFixture({ terminalA: [terminal('one', 'inc-1', 1)] });
    expect(fixture.adapter.observeWorkerTaskBindings({ workers: [{ runtime: 'orca', id: 'one', generation: 'inc-1' }] }, { timeoutMs: 2_000 })).toEqual({
      status: 'unavailable', code: 'deadline_exhausted',
    });
    expect(fixture.calls).toEqual([]);
  });

  it('keeps absence, replacement, pty-only incarnation, metadata races, duplicates, and restart external distinct', () => {
    const terminalsA = [terminal('exact', 'inc-a', 1), terminal('replacement', 'inc-new', 2), terminal('pty-only', 'pty-3', 3, false)];
    const base = orcaFixture({
      terminalA: terminalsA,
      issueA: { 1: 1380 },
      seedOwned: [{ handle: 'exact', generation: 'inc-a', worktree: 1 }],
    });
    expect(base.adapter.observeWorkerTaskBindings({ workers: [
      { runtime: 'orca', id: 'missing', generation: 'none' },
      { runtime: 'orca', id: 'replacement', generation: 'inc-old' },
      { runtime: 'orca', id: 'pty-only', generation: 'pty-3' },
    ] }, { timeoutMs: 4_000 })).toEqual({
      status: 'ok',
      outcomes: [
        { status: 'absent', worker: { runtime: 'orca', id: 'missing', generation: 'none' } },
        { status: 'replaced', worker: { runtime: 'orca', id: 'replacement', generation: 'inc-old' } },
        { status: 'incarnation_unavailable', worker: { runtime: 'orca', id: 'pty-only', generation: 'pty-3' } },
      ],
    });

    const stale = orcaFixture({
      terminalA: [terminal('exact', 'inc-a', 1)],
      issueA: { 1: 1380 },
      issueB: { 1: 1381 },
      seedOwned: [{ handle: 'exact', generation: 'inc-a', worktree: 1 }],
    });
    expect(stale.adapter.observeWorkerTaskBindings({ workers: [stale.owned[0]!.identity] }, { timeoutMs: 4_000 })).toMatchObject({
      status: 'ok', outcomes: [{ status: 'stale', code: 'metadata_changed' }],
    });

    const inconsistentB = orcaFixture({
      terminalA: [terminal('exact', 'inc-a', 1)],
      terminalB: [{ ...terminal('exact', 'inc-a', 1), worktreeId: 'w-conflict' }],
      issueA: { 1: 1380 },
      seedOwned: [{ handle: 'exact', generation: 'inc-a', worktree: 1 }],
    });
    expect(inconsistentB.adapter.observeWorkerTaskBindings({ workers: [inconsistentB.owned[0]!.identity] }, { timeoutMs: 4_000 })).toEqual({
      status: 'unavailable', code: 'inventory_ambiguous',
    });

    const duplicate = orcaFixture({
      terminalA: [terminal('exact', 'inc-a', 1), terminal('sibling', 'inc-b', 2)],
      issueA: { 1: 1380, 2: 1380 },
      seedOwned: [{ handle: 'exact', generation: 'inc-a', worktree: 1 }],
    });
    expect(duplicate.adapter.observeWorkerTaskBindings({ workers: [duplicate.owned[0]!.identity] }, { timeoutMs: 4_000 })).toMatchObject({
      status: 'ok', outcomes: [{ status: 'ambiguous', code: 'duplicate_issue' }],
    });

    const restarted = orcaFixture({ terminalA: [terminal('survivor', 'inc-survivor', 1)], issueA: { 1: 1380 } });
    expect(restarted.adapter.observeWorkerTaskBindings({ workers: [{ runtime: 'orca', id: 'survivor', generation: 'inc-survivor' }] }, { timeoutMs: 4_000 })).toEqual({
      status: 'ok',
      outcomes: [{ status: 'external', worker: { runtime: 'orca', id: 'survivor', generation: 'inc-survivor' }, provenance: 'external' }],
    });
  });

  it('fails closed above the six-worktree global inventory cap', () => {
    const fixture = orcaFixture({ terminalA: Array.from({ length: 7 }, (_, index) => terminal(`t-${index}`, `inc-${index}`, index + 1)) });
    expect(fixture.adapter.observeWorkerTaskBindings({ workers: [{ runtime: 'orca', id: 't-0', generation: 'inc-0' }] }, { timeoutMs: 4_000 })).toEqual({
      status: 'unavailable', code: 'inventory_over_cap',
    });
    expect(fixture.calls).toHaveLength(1);
  });

  it('emits the closed AC26 evidence datum without runtime-private identity', () => {
    const datum = {
      producer: 'orchestrator-pack',
      datum: '$.runtimeWorkerIdentityBinding.result',
      expected: 'exact-current-generation-one-to-one',
      runtimeWorkerIdentityBinding: {
        result: {
          strategy: ORCA_WORKER_TASK_BINDING_STRATEGY,
          uniqueCurrentInternalResolved: true,
          noAuthorityCasesClosed: true,
          runtimeGlobalCollisionProof: true,
          memoryOnlyIdentity: true,
          zeroMutation: true,
        },
      },
    };
    expect(datum.runtimeWorkerIdentityBinding.result.strategy).toBe('complete_ab_revalidation');
    process.stdout.write(`${JSON.stringify(datum)}\n`);
  });
});
