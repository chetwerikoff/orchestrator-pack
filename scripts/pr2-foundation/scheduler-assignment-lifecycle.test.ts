// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WORKER_ASSIGNMENT_SCHEMA,
  WORKER_ASSIGNMENT_STORE_SCHEMA,
  attachWorkerAssignmentIssueNumber,
  currentWorkerAssignmentByDeliverable,
  publishCurrentWorkerAssignment,
  retireCurrentWorkerAssignment,
  setWorkerAssignmentDeadObservationTicks,
  workerAssignmentKey,
  type WorkerAssignmentRecord,
  type WorkerAssignmentStore,
} from '../lib/worker-assignment-store.ts';
import {
  type RuntimeAssignmentLifecycleObservation,
  type WorkerAssignmentLifecycleObservation,
} from '../lib/worker-assignment-runtime.ts';
import { runtimeFailure, type RuntimeCallOptions, type RuntimeResult } from '../runtime/contracts.ts';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import {
  observeWorkerShowTerminalMail,
  type DispatchTerminalMailDeps,
} from '../orca-runtime/dispatch-terminal-mail.ts';
import type { runOrcaJson } from '../orca-runtime/native.ts';
import {
  consumeObservedTerminalAssignment,
  reconcileWorkerAssignments,
} from '../reconcile-worker-assignments.ts';

const roots: string[] = [];
const REPOSITORY = 'chetwerikoff/orchestrator-pack';

function fixture(): { root: string; store: string; ledger: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1899-'));
  roots.push(root);
  return {
    root,
    store: path.join(root, 'worker-assignments.json'),
    ledger: path.join(root, 'dispatch-terminal-mail.json'),
  };
}

function assignment(index: number): WorkerAssignmentRecord {
  const base = {
    schema: WORKER_ASSIGNMENT_SCHEMA,
    projectId: 'orchestrator-pack',
    repository: REPOSITORY,
    taskId: `task-${index}`,
    assignmentId: `wa-${index}`,
    generation: 1,
    kind: 'local' as const,
    provider: 'orca',
    bindingKey: `dispatch-${index}`,
    createdAtUtc: '2026-09-04T00:00:00.000Z',
  };
  if (index === 7) return { ...base, role: 'worker' };
  if (index === 5) return { ...base, issueNumber: 1900 + index };
  return {
    ...base,
    issueNumber: 1900 + index,
    role: index === 6 || index === 9 || index === 10 ? 'orchestrator' : 'worker',
  };
}

function write72RowStore(file: string): WorkerAssignmentRecord[] {
  const rows = Array.from({ length: 72 }, (_, index) => assignment(index));
  const assignments = Object.fromEntries(rows.map((row) => [
    workerAssignmentKey(row.taskId, row.bindingKey),
    row,
  ]));
  const protectedRow = rows[11]!;
  const store: WorkerAssignmentStore = {
    schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
    revision: 72,
    assignments,
    operatorPrimary: {
      route: 'operator-primary',
      taskId: protectedRow.taskId,
      bindingKey: protectedRow.bindingKey,
      assignmentId: protectedRow.assignmentId,
      assignmentGeneration: protectedRow.generation,
    },
  };
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
  return rows;
}

class LifecycleAdapter extends DeterministicRuntimeAdapter {
  readonly observations: string[] = [];
  lifecycleRuntimeCalls = 0;
  nowMs = 0;
  inFlight = 0;
  peakInFlight = 0;

  #enter(): void {
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
  }

  #leave(): void {
    this.inFlight -= 1;
  }

  enterExternalRuntimeCall(): void { this.#enter(); }
  leaveExternalRuntimeCall(): void { this.#leave(); }

  observeAssignmentLifecycle(
    input: { readonly provider: string; readonly bindingKey: string },
    _options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeAssignmentLifecycleObservation> {
    this.#enter();
    try {
      this.observations.push(input.bindingKey);
      this.lifecycleRuntimeCalls += 1;
      this.nowMs += 2_000;
      const index = Number(input.bindingKey.split('-').at(-1));
      if (index <= 7) {
        // Production Orca resolves an active assignment with worker-show and
        // then terminal-show. Model both independently bounded runtime calls.
        this.lifecycleRuntimeCalls += 1;
        this.nowMs += 2_000;
        return {
          status: 'ok',
          value: {
            kind: 'active',
            worker: {
              identity: { runtime: 'test', id: `worker-${index}`, generation: 'g1' },
              workspacePath: `/tmp/worker-${index}`,
              title: `worker-${index}`,
              provenance: 'internal',
            },
          },
        };
      }
      if (index >= 8 && index <= 10) {
        return {
          status: 'ok',
          value: {
            kind: 'terminal',
            released: true,
            ...(index === 10 ? {} : {
              snapshot: {
                dispatchId: input.bindingKey,
                runId: `run-${index}`,
                state: 'succeeded',
                stage: 'terminal',
                lastError: null,
                dispatchStatus: 'completed',
                observationStatus: 'exited',
              },
            }),
          },
        };
      }
      return {
        status: 'ok',
        value: { kind: 'gone', evidence: 'producer_exact_absence' },
      };
    } finally {
      this.#leave();
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #2106 bounded scheduler assignment lifecycle reconciliation', () => {
  it('drains a 72-row history in one observation per local row and only re-observes the retained set', async () => {
    const { store, ledger } = fixture();
    const rows = write72RowStore(store);
    const agedActive = await setWorkerAssignmentDeadObservationTicks({ file: store, expected: rows[0]!, ticks: 2 });
    expect(agedActive.ok).toBe(true);
    writeFileSync(ledger, `${JSON.stringify({
      notified: Object.fromEntries(Array.from({ length: 59 }, (_, offset) => {
        const index = 12 + offset;
        return [`dispatch-${index}`, `sent:history-${index}`];
      })),
    }, null, 2)}\n`);
    const adapter = new LifecycleAdapter();
    const mailTurnTimes: number[] = [];
    const runtimeSendArgs: readonly string[][] = [];
    const sentArgs = runtimeSendArgs as string[][];
    const runJson = ((args: readonly string[]) => {
      adapter.enterExternalRuntimeCall();
      try {
        sentArgs.push([...args]);
        return { ok: true, result: { message_id: `msg-${sentArgs.length}` } };
      } finally {
        adapter.leaveExternalRuntimeCall();
      }
    }) as unknown as typeof runOrcaJson;
    const terminalMailDeps: DispatchTerminalMailDeps = {
      ledgerPath: ledger,
      runJson,
      deliverMessage: null,
    };

    const first = await reconcileWorkerAssignments({
      file: store,
      repository: REPOSITORY,
      adapter,
      timeoutMs: 250,
      // Deliberately request four: reconciliation must cap the effective batch
      // at two because active Orca observations can consume two runtime calls.
      batchSize: 4,
      terminalMailDeps,
      betweenBatches: () => {
        adapter.enterExternalRuntimeCall();
        try { mailTurnTimes.push(adapter.nowMs); } finally { adapter.leaveExternalRuntimeCall(); }
      },
    });

    expect(first.status).toBe('ok');
    expect(first.counts).toMatchObject({
      observed: 72,
      active: 8,
      terminal: 3,
      gone: 61,
      unresolved: 3,
      protected: 0,
      retired: 61,
    });
    expect(first.bindings).toHaveLength(6);
    const activeBinding = first.bindings.find((binding) => binding.assignment.taskId === 'task-0');
    expect(activeBinding).toBeDefined();
    expect(activeBinding?.assignment).not.toHaveProperty('deadObservationTicks');
    expect(first.reconciliations.every((row) => row.assignment.role !== 'orchestrator')).toBe(true);
    expect(adapter.observations).toHaveLength(72);
    expect(new Set(adapter.observations)).toHaveLength(72);
    expect(adapter.lifecycleRuntimeCalls).toBe(80);
    expect(sentArgs).toHaveLength(2);
    expect(sentArgs.every((args) => args[0] === 'orchestration' && args[1] === 'send')).toBe(true);
    expect(mailTurnTimes[0]).toBe(8_000);
    expect(mailTurnTimes[0]).toBeLessThanOrEqual(10_000);
    expect(adapter.peakInFlight).toBe(1);

    adapter.observations.splice(0);
    mailTurnTimes.splice(0);
    const second = await reconcileWorkerAssignments({
      file: store,
      repository: REPOSITORY,
      adapter,
      timeoutMs: 250,
      batchSize: 4,
      terminalMailDeps,
      betweenBatches: () => {
        adapter.enterExternalRuntimeCall();
        try { mailTurnTimes.push(adapter.nowMs); } finally { adapter.leaveExternalRuntimeCall(); }
      },
    });
    expect(second.status).toBe('ok');
    expect(second.counts).toMatchObject({ observed: 11, active: 8, terminal: 1, gone: 2, retired: 0, protected: 0, unresolved: 3 });
    expect(second.reconciliations.every((row) => row.assignment.role !== 'orchestrator')).toBe(true);
    expect(adapter.observations).toHaveLength(11);
    expect(sentArgs).toHaveLength(2);
    expect(adapter.peakInFlight).toBe(1);

    adapter.observations.splice(0);
    const third = await reconcileWorkerAssignments({
      file: store,
      repository: REPOSITORY,
      adapter,
      timeoutMs: 250,
      terminalMailDeps,
    });
    expect(third.status).toBe('ok');
    expect(third.counts).toMatchObject({ observed: 11, active: 8, terminal: 1, gone: 2, retired: 2, protected: 1, unresolved: 0, boundedGiveUps: 2 });
    expect(adapter.observations).toHaveLength(11);
    expect(adapter.observations).toContain('dispatch-10');
    expect(adapter.observations).toContain('dispatch-71');
    expect(sentArgs).toHaveLength(2);
    expect(currentWorkerAssignmentByDeliverable(store, 'task-10', 'dispatch-10')).toBeNull();
    expect(currentWorkerAssignmentByDeliverable(store, 'task-71', 'dispatch-71')).toBeNull();

    adapter.observations.splice(0);
    const fourth = await reconcileWorkerAssignments({
      file: store,
      repository: REPOSITORY,
      adapter,
      timeoutMs: 250,
      terminalMailDeps,
    });
    expect(fourth.status).toBe('ok');
    expect(fourth.counts).toMatchObject({ observed: 9, active: 8, gone: 1, retired: 0, protected: 1, boundedGiveUps: 0 });
    expect(adapter.observations).not.toContain('dispatch-10');
    expect(adapter.observations).not.toContain('dispatch-71');
    expect(adapter.observations).toHaveLength(9);

    const converged = JSON.parse(readFileSync(store, 'utf8')) as WorkerAssignmentStore;
    expect(Object.keys(converged.assignments)).toHaveLength(9);
    expect(converged.operatorPrimary?.assignmentId).toBe('wa-11');
  });

  it('gives up after three persisted exact terminal observations without forging mail settlement', async () => {
    const { store, ledger } = fixture();
    const published = await publishCurrentWorkerAssignment({
      file: store,
      repository: REPOSITORY,
      issueNumber: 1899,
      taskId: 'failed-terminal-task',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-8',
      role: 'worker',
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(published.reason);

    let sends = 0;
    const persistedTicksAtSend: number[] = [];
    const terminalMailDeps: DispatchTerminalMailDeps = {
      ledgerPath: ledger,
      deliverMessage: null,
      runJson: (() => {
        sends += 1;
        persistedTicksAtSend.push(currentWorkerAssignmentByDeliverable(
          store,
          'failed-terminal-task',
          'dispatch-8',
        )?.deadObservationTicks ?? -1);
        return { ok: false, error: { code: 'injected_failure' } };
      }) as unknown as typeof runOrcaJson,
    };
    const adapter = new LifecycleAdapter();
    for (let tick = 1; tick <= 3; tick += 1) {
      const result = await reconcileWorkerAssignments({
        file: store,
        repository: REPOSITORY,
        adapter,
        terminalMailDeps,
      });
      expect(result.status).toBe('ok');
      expect(result.counts.terminalMailUnsettled).toBe(1);
      expect(result.counts.boundedGiveUps).toBe(tick === 3 ? 1 : 0);
    }

    expect(sends).toBe(3);
    expect(persistedTicksAtSend).toEqual([1, 2, 3]);
    expect(currentWorkerAssignmentByDeliverable(store, 'failed-terminal-task', 'dispatch-8')).toBeNull();
    expect(JSON.parse(readFileSync(ledger, 'utf8'))).toEqual({ notified: {} });
  });

  it('stops unsettled terminal-mail retries at the bound while retaining operator-primary protection', async () => {
    const { store, ledger } = fixture();
    const published = await publishCurrentWorkerAssignment({
      file: store,
      repository: REPOSITORY,
      issueNumber: 1899,
      taskId: 'protected-terminal-task',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-8',
      role: 'worker',
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(published.reason);

    const current = JSON.parse(readFileSync(store, 'utf8')) as WorkerAssignmentStore;
    writeFileSync(store, `${JSON.stringify({
      ...current,
      operatorPrimary: {
        route: 'operator-primary',
        taskId: published.assignment.taskId,
        bindingKey: published.assignment.bindingKey,
        assignmentId: published.assignment.assignmentId,
        assignmentGeneration: published.assignment.generation,
      },
    }, null, 2)}\n`);

    let sends = 0;
    const terminalMailDeps: DispatchTerminalMailDeps = {
      ledgerPath: ledger,
      deliverMessage: null,
      runJson: (() => {
        sends += 1;
        return { ok: false, error: { code: 'injected_failure' } };
      }) as unknown as typeof runOrcaJson,
    };
    const adapter = new LifecycleAdapter();
    for (let tick = 1; tick <= 4; tick += 1) {
      const result = await reconcileWorkerAssignments({
        file: store,
        repository: REPOSITORY,
        adapter,
        terminalMailDeps,
      });
      expect(result.status).toBe('ok');
      expect(result.counts.terminalMailUnsettled).toBe(1);
      expect(result.counts.protected).toBe(tick >= 3 ? 1 : 0);
    }

    expect(sends).toBe(3);
    expect(currentWorkerAssignmentByDeliverable(
      store,
      published.assignment.taskId,
      published.assignment.bindingKey,
    )).toMatchObject({ ...published.assignment, deadObservationTicks: 3 });
    expect(JSON.parse(readFileSync(store, 'utf8'))).toMatchObject({
      operatorPrimary: { assignmentId: published.assignment.assignmentId },
    });
  });

  it('resets active dead progress after Issue attachment changes mutable assignment fields', async () => {
    const { store } = fixture();
    const published = await publishCurrentWorkerAssignment({
      file: store,
      repository: REPOSITORY,
      taskId: 'active-reset-task',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-active-reset',
      role: 'worker',
    });
    if (!published.ok) throw new Error(published.reason);
    const aged = await setWorkerAssignmentDeadObservationTicks({
      file: store,
      expected: published.assignment,
      ticks: 2,
    });
    if (!aged.ok) throw new Error(aged.reason);
    const attached = await attachWorkerAssignmentIssueNumber({
      file: store,
      expected: aged.assignment,
      issueNumber: 1899,
    });
    if (!attached.ok) throw new Error(attached.reason);

    const reset = await setWorkerAssignmentDeadObservationTicks({
      file: store,
      expected: aged.assignment,
      ticks: 0,
    });
    expect(reset).toMatchObject({ ok: true, assignment: { issueNumber: 1899 } });
    if (!reset.ok) throw new Error(reset.reason);
    expect(reset.assignment).not.toHaveProperty('deadObservationTicks');
    expect(currentWorkerAssignmentByDeliverable(
      store,
      published.assignment.taskId,
      published.assignment.bindingKey,
    )).not.toHaveProperty('deadObservationTicks');
  });

  it('does zero mail and zero retirement from stale terminal evidence after Issue attachment', async () => {
    const { store, ledger } = fixture();
    const published = await publishCurrentWorkerAssignment({
      file: store,
      repository: REPOSITORY,
      taskId: 'brief-task',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-stale',
      role: 'worker',
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(published.reason);
    const staleExpected = published.assignment;
    const attached = await attachWorkerAssignmentIssueNumber({ file: store, expected: staleExpected, issueNumber: 1899 });
    expect(attached.ok).toBe(true);

    let sends = 0;
    const observation: Extract<WorkerAssignmentLifecycleObservation, { readonly status: 'terminal' }> = {
      status: 'terminal',
      assignment: staleExpected,
      released: true,
      snapshot: {
        dispatchId: staleExpected.bindingKey,
        runId: 'run-stale',
        state: 'succeeded',
        stage: 'terminal',
        lastError: null,
        dispatchStatus: 'completed',
        observationStatus: 'exited',
      },
    };
    const consumed = await consumeObservedTerminalAssignment({
      file: store,
      observation,
      terminalMailDeps: {
        ledgerPath: ledger,
        deliverMessage: null,
        runJson: (() => {
          sends += 1;
          return { ok: true, result: { message_id: 'msg-unexpected' } };
        }) as unknown as typeof runOrcaJson,
      },
    });
    expect(consumed).toEqual({ status: 'stale' });
    expect(sends).toBe(0);
    expect(currentWorkerAssignmentByDeliverable(store, staleExpected.taskId, staleExpected.bindingKey)).toEqual(attached.ok ? attached.assignment : null);
  });

  it('retains terminal evidence until exact release is observed', async () => {
    const { store, ledger } = fixture();
    const published = await publishCurrentWorkerAssignment({
      file: store,
      repository: REPOSITORY,
      issueNumber: 1899,
      taskId: 'unreleased-task',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-unreleased',
      role: 'worker',
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(published.reason);

    let sends = 0;
    const observation: Extract<WorkerAssignmentLifecycleObservation, { readonly status: 'terminal' }> = {
      status: 'terminal',
      assignment: published.assignment,
      released: false,
      snapshot: {
        dispatchId: published.assignment.bindingKey,
        runId: 'run-unreleased',
        state: 'succeeded',
        stage: 'terminal',
        lastError: null,
        dispatchStatus: 'completed',
        observationStatus: 'exited',
      },
    };
    const consumed = await consumeObservedTerminalAssignment({
      file: store,
      observation,
      terminalMailDeps: {
        ledgerPath: ledger,
        deliverMessage: null,
        runJson: (() => {
          sends += 1;
          return { ok: true, result: { message_id: 'msg-unexpected' } };
        }) as unknown as typeof runOrcaJson,
      },
    });
    expect(consumed).toEqual({ status: 'retained_unresolved' });
    expect(sends).toBe(0);
    expect(currentWorkerAssignmentByDeliverable(store, published.assignment.taskId, published.assignment.bindingKey)).toEqual(published.assignment);
  });

  it('retains exact gone without terminal-mail proof and retires it after the ledger proves settlement', async () => {
    const { store, ledger } = fixture();
    const published = await publishCurrentWorkerAssignment({
      file: store,
      repository: REPOSITORY,
      issueNumber: 1899,
      taskId: 'gone-gate-task',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-gone-gate',
      role: 'worker',
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(published.reason);

    const adapter = new LifecycleAdapter();
    const withoutProof = await reconcileWorkerAssignments({
      file: store,
      repository: REPOSITORY,
      adapter,
      terminalMailDeps: { ledgerPath: ledger, deliverMessage: null },
    });
    expect(withoutProof.status).toBe('ok');
    expect(withoutProof.counts).toMatchObject({ observed: 1, gone: 1, unresolved: 1, retired: 0 });
    expect(currentWorkerAssignmentByDeliverable(
      store,
      published.assignment.taskId,
      published.assignment.bindingKey,
    )).toMatchObject({ ...published.assignment, deadObservationTicks: 1 });

    writeFileSync(ledger, `${JSON.stringify({
      notified: { [published.assignment.bindingKey]: 'sent:msg-gone' },
    }, null, 2)}\n`);
    const withProof = await reconcileWorkerAssignments({
      file: store,
      repository: REPOSITORY,
      adapter,
      terminalMailDeps: { ledgerPath: ledger, deliverMessage: null },
    });
    expect(withProof.status).toBe('ok');
    expect(withProof.counts).toMatchObject({ observed: 1, gone: 1, unresolved: 0, retired: 1 });
    expect(currentWorkerAssignmentByDeliverable(
      store,
      published.assignment.taskId,
      published.assignment.bindingKey,
    )).toBeNull();
  });

  it('does not age out generic unknown lifecycle evidence', async () => {
    const { store } = fixture();
    const published = await publishCurrentWorkerAssignment({
      file: store,
      repository: REPOSITORY,
      issueNumber: 1899,
      taskId: 'unknown-lifecycle-task',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-unknown',
      role: 'worker',
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(published.reason);
    const aged = await setWorkerAssignmentDeadObservationTicks({
      file: store,
      expected: published.assignment,
      ticks: 2,
    });
    expect(aged.ok).toBe(true);
    if (!aged.ok) throw new Error(aged.reason);

    const adapter = new class extends DeterministicRuntimeAdapter {
      observeAssignmentLifecycle(
        _input: { readonly provider: string; readonly bindingKey: string },
        _options: RuntimeCallOptions = {},
      ): RuntimeResult<RuntimeAssignmentLifecycleObservation> {
        return runtimeFailure('find_worker', 'injected_unavailable');
      }
    }();
    const result = await reconcileWorkerAssignments({ file: store, repository: REPOSITORY, adapter });
    expect(result.status).toBe('ok');
    expect(result.counts).toMatchObject({ observed: 1, unresolved: 1, retired: 0, boundedGiveUps: 0 });
    expect(currentWorkerAssignmentByDeliverable(
      store,
      published.assignment.taskId,
      published.assignment.bindingKey,
    )).toMatchObject({ ...aged.assignment, deadObservationTicks: 2 });
  });

  it('exact retirement cannot delete a concurrent replacement', async () => {
    const { store } = fixture();
    const first = await publishCurrentWorkerAssignment({
      file: store,
      repository: REPOSITORY,
      issueNumber: 1899,
      taskId: 'replace-task',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-old',
      role: 'worker',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    const replacement = await publishCurrentWorkerAssignment({
      file: store,
      repository: REPOSITORY,
      issueNumber: 1899,
      taskId: 'replace-task',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-new',
      role: 'worker',
      expectedCurrent: { assignmentId: first.assignment.assignmentId, generation: first.assignment.generation },
    });
    expect(replacement.ok).toBe(true);
    const retired = await retireCurrentWorkerAssignment({ file: store, expected: first.assignment });
    expect(retired).toEqual({ ok: false, reason: 'assignment_stale' });
    if (!replacement.ok) throw new Error(replacement.reason);
    expect(currentWorkerAssignmentByDeliverable(store, replacement.assignment.taskId, replacement.assignment.bindingKey)).toEqual(replacement.assignment);
  });

  it('direct terminal-mail fallback skips worker-show when the ledger already proves notification', () => {
    const { ledger } = fixture();
    writeFileSync(ledger, `${JSON.stringify({ notified: { 'dispatch-ledger': 'sent:msg-1' } })}\n`);
    let runtimeCalls = 0;
    const result = observeWorkerShowTerminalMail('dispatch-ledger', {
      ledgerPath: ledger,
      runJson: (() => {
        runtimeCalls += 1;
        return runtimeFailure('find_worker', 'should_not_run');
      }) as unknown as typeof runOrcaJson,
    });
    expect(result).toEqual({ dispatchId: 'dispatch-ledger', outcome: 'duplicate', reason: 'terminal_already_notified' });
    expect(runtimeCalls).toBe(0);
  });

  it('Orca scheduler observation returns terminal evidence without sending mail', () => {
    const calls: string[][] = [];
    const adapter = new OrcaTaskRuntimeAdapter({
      runJson: ((args: readonly string[]) => {
        calls.push([...args]);
        return {
          ok: true,
          result: {
            dispatch: { id: 'dispatch-terminal', run_id: 'run-terminal', status: 'completed', last_heartbeat_at: null },
            worker: { state: 'succeeded', stage: 'terminal', agent_terminal_handle: 'term-1', worktree_id: 'wt-1' },
            terminal: { handle: 'term-1' },
            observation: { exactWorker: true, status: 'exited' },
            terminalResource: {
              terminalHandle: 'term-1',
              worktreeId: 'wt-1',
              originDispatchId: 'dispatch-terminal',
              ownerDispatchId: 'dispatch-terminal',
              releaseState: 'released',
            },
          },
        };
      }) as unknown as typeof runOrcaJson,
    });

    const observed = adapter.observeAssignmentLifecycle({ provider: 'orca', bindingKey: 'dispatch-terminal' });
    expect(observed.status).toBe('ok');
    if (observed.status !== 'ok') throw new Error(observed.reason);
    expect(observed.value.kind).toBe('terminal');
    expect(calls).toEqual([['orchestration', 'worker-show', '--dispatch', 'dispatch-terminal']]);
    expect(calls.some((args) => args[0] === 'orchestration' && args[1] === 'send')).toBe(false);
  });
});
