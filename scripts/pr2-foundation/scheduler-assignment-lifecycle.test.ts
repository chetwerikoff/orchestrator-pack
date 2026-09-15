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
      this.nowMs += 2_000;
      const index = Number(input.bindingKey.split('-').at(-1));
      if (index <= 7) {
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

describe('Issue #1899 scheduler assignment lifecycle reconciliation', () => {
  it('drains a 72-row history in one observation per local row and only re-observes the retained set', async () => {
    const { store, ledger } = fixture();
    write72RowStore(store);
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
      unresolved: 1,
      protected: 1,
      retired: 62,
    });
    expect(first.bindings).toHaveLength(6);
    expect(first.reconciliations.every((row) => row.assignment.role !== 'orchestrator')).toBe(true);
    expect(adapter.observations).toHaveLength(72);
    expect(new Set(adapter.observations)).toHaveLength(72);
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
    expect(second.counts).toMatchObject({ observed: 10, active: 8, terminal: 1, gone: 1, retired: 0, protected: 1, unresolved: 1 });
    expect(second.reconciliations.every((row) => row.assignment.role !== 'orchestrator')).toBe(true);
    expect(adapter.observations).toHaveLength(10);
    expect(sentArgs).toHaveLength(2);
    expect(adapter.peakInFlight).toBe(1);

    const persisted = JSON.parse(readFileSync(store, 'utf8')) as WorkerAssignmentStore;
    expect(Object.keys(persisted.assignments)).toHaveLength(10);
    expect(persisted.operatorPrimary?.assignmentId).toBe('wa-11');
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
