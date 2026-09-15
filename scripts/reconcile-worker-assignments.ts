import {
  listCurrentWorkerAssignmentRecords,
  retireCurrentWorkerAssignment,
  withCurrentWorkerAssignmentFence,
  type WorkerAssignment,
  type WorkerAssignmentRecord,
} from './lib/worker-assignment-store.ts';
import {
  observeCurrentWorkerAssignmentLifecycle,
  type ResolvedWorkerAssignment,
  type WorkerAssignmentLifecycleObservation,
} from './lib/worker-assignment-runtime.ts';
import {
  maybeNotifyRunOnTerminalDispatch,
  type DispatchTerminalMailDeps,
} from './orca-runtime/dispatch-terminal-mail.ts';
import { sameRuntimeWorker, type RuntimeAdapter } from './runtime/contracts.ts';

export interface WorkerAssignmentReconciliationCounts {
  readonly observed: number;
  readonly active: number;
  readonly terminal: number;
  readonly gone: number;
  readonly unresolved: number;
  readonly stale: number;
  readonly protected: number;
  readonly retired: number;
  readonly remoteRetained: number;
  readonly mailTurns: number;
}

export type WorkerAssignmentLifecycleSweepResult =
  | {
      readonly status: 'ok';
      readonly bindings: readonly ResolvedWorkerAssignment[];
      readonly counts: WorkerAssignmentReconciliationCounts;
    }
  | {
      readonly status: 'assignment_untrusted';
      readonly bindings: readonly [];
      readonly counts: WorkerAssignmentReconciliationCounts;
    };

export interface ReconcileWorkerAssignmentsInput {
  readonly file: string;
  readonly repository: string;
  readonly adapter: RuntimeAdapter;
  readonly timeoutMs?: number;
  readonly batchSize?: number;
  readonly terminalMailDeps?: DispatchTerminalMailDeps;
  /**
   * One serialized latency-sensitive turn between lifecycle batches. Production
   * uses this for orchestration mail; it must not launch overlapping runtime work.
   */
  readonly betweenBatches?: () => void | Promise<void>;
}

function emptyCounts(): WorkerAssignmentReconciliationCounts {
  return {
    observed: 0,
    active: 0,
    terminal: 0,
    gone: 0,
    unresolved: 0,
    stale: 0,
    protected: 0,
    retired: 0,
    remoteRetained: 0,
    mailTurns: 0,
  };
}

function isNumberedWorkerPartition(assignment: WorkerAssignmentRecord): assignment is WorkerAssignment {
  return Number.isInteger(assignment.issueNumber)
    && Number(assignment.issueNumber) > 0
    && assignment.role !== 'orchestrator';
}

function mutableCounts(seed: WorkerAssignmentReconciliationCounts): Record<keyof WorkerAssignmentReconciliationCounts, number> {
  return { ...seed };
}

function classifyRetirement(
  result: Awaited<ReturnType<typeof retireCurrentWorkerAssignment>>,
  counts: Record<keyof WorkerAssignmentReconciliationCounts, number>,
): void {
  if (result.ok) {
    counts.retired += 1;
    return;
  }
  if (result.reason === 'assignment_protected') {
    counts.protected += 1;
    return;
  }
  if (result.reason === 'assignment_stale') {
    counts.stale += 1;
    return;
  }
  counts.unresolved += 1;
}

/**
 * Consume a previously observed exact terminal assignment. The mail action is
 * revalidated while holding the assignment fence. Retirement then performs its
 * own exact-current CAS; if replacement wins after mail, the successor is kept.
 */
export async function consumeObservedTerminalAssignment(input: {
  readonly file: string;
  readonly observation: Extract<WorkerAssignmentLifecycleObservation, { readonly status: 'terminal' }>;
  readonly terminalMailDeps?: DispatchTerminalMailDeps;
}): Promise<
  | { readonly status: 'retired' | 'protected' | 'stale' | 'retained_unresolved' }
  | { readonly status: 'notified_retirement_failed'; readonly reason: string }
> {
  const { observation } = input;
  const snapshot = observation.snapshot;
  if (!snapshot || snapshot.dispatchId.trim() !== observation.assignment.bindingKey.trim()) {
    return { status: 'retained_unresolved' };
  }
  const fenced = await withCurrentWorkerAssignmentFence(input.file, observation.assignment, () =>
    maybeNotifyRunOnTerminalDispatch(snapshot, input.terminalMailDeps));
  if (!fenced.ok) {
    return fenced.reason === 'assignment_stale'
      ? { status: 'stale' }
      : { status: 'retained_unresolved' };
  }
  if (fenced.value.outcome !== 'sent' && fenced.value.outcome !== 'duplicate') {
    return { status: 'retained_unresolved' };
  }
  const retired = await retireCurrentWorkerAssignment({
    file: input.file,
    expected: observation.assignment,
  });
  if (retired.ok) return { status: 'retired' };
  if (retired.reason === 'assignment_protected') return { status: 'protected' };
  if (retired.reason === 'assignment_stale') return { status: 'stale' };
  return { status: 'notified_retirement_failed', reason: retired.reason };
}

export async function reconcileWorkerAssignments(
  input: ReconcileWorkerAssignmentsInput,
): Promise<WorkerAssignmentLifecycleSweepResult> {
  const records = listCurrentWorkerAssignmentRecords(input.file);
  const baseCounts = emptyCounts();
  if (!records) return { status: 'assignment_untrusted', bindings: [], counts: baseCounts };

  const counts = mutableCounts(baseCounts);
  const repository = input.repository.trim().toLowerCase();
  const batchSize = Math.max(1, Math.min(16, Math.floor(input.batchSize ?? 4)));
  const bindings: ResolvedWorkerAssignment[] = [];
  const workers = [] as ResolvedWorkerAssignment['worker'][];

  for (const assignment of records) {
    if (assignment.repository !== repository) continue;
    if (assignment.kind !== 'local') {
      counts.remoteRetained += 1;
      continue;
    }

    const observation = observeCurrentWorkerAssignmentLifecycle({
      file: input.file,
      expected: assignment,
      adapter: input.adapter,
      timeoutMs: input.timeoutMs,
    });
    counts.observed += 1;

    if (observation.status === 'active') {
      counts.active += 1;
      if (isNumberedWorkerPartition(observation.assignment)) {
        if (workers.some((candidate) => sameRuntimeWorker(candidate.identity, observation.worker.identity))) {
          counts.unresolved += 1;
        } else {
          workers.push(observation.worker);
          bindings.push({ assignment: observation.assignment, worker: observation.worker });
        }
      }
    } else if (observation.status === 'terminal') {
      counts.terminal += 1;
      const consumed = await consumeObservedTerminalAssignment({
        file: input.file,
        observation,
        terminalMailDeps: input.terminalMailDeps,
      });
      if (consumed.status === 'retired') counts.retired += 1;
      else if (consumed.status === 'protected') counts.protected += 1;
      else if (consumed.status === 'stale') counts.stale += 1;
      else counts.unresolved += 1;
    } else if (observation.status === 'gone') {
      counts.gone += 1;
      const retired = await retireCurrentWorkerAssignment({
        file: input.file,
        expected: observation.assignment,
      });
      classifyRetirement(retired, counts);
    } else if (observation.status === 'assignment_stale') {
      counts.stale += 1;
    } else {
      counts.unresolved += 1;
    }

    if (counts.observed % batchSize === 0 && input.betweenBatches) {
      await input.betweenBatches();
      counts.mailTurns += 1;
    }
  }

  return {
    status: 'ok',
    bindings,
    counts: counts as unknown as WorkerAssignmentReconciliationCounts,
  };
}
