import {
  sameRuntimeWorker,
  type RuntimeAdapter,
  type RuntimeWorker,
} from '../runtime/contracts.ts';
import {
  assignmentStillCurrent,
  listCurrentWorkerAssignmentRecords,
  readWorkerAssignmentStore,
  withCurrentWorkerAssignmentFence,
  workerAssignmentKey,
  type WorkerAssignment,
  type WorkerAssignmentRecord,
} from './worker-assignment-store.ts';

export interface ResolvedWorkerAssignment {
  readonly assignment: WorkerAssignmentRecord;
  /** Exact runtime-private identity is deliberately held only in memory. */
  readonly worker: RuntimeWorker;
}

export interface ResolvedIssueWorkerAssignment extends ResolvedWorkerAssignment {
  readonly assignment: WorkerAssignment;
}

export interface WorkerAssignmentReconciliation {
  readonly assignment: WorkerAssignmentRecord;
  readonly reason: 'target_unresolved' | 'remote_not_applicable';
}

export type WorkerAssignmentTargetResolution =
  | { readonly status: 'resolved'; readonly assignment: WorkerAssignmentRecord; readonly worker: RuntimeWorker }
  | { readonly status: 'gone'; readonly assignment: WorkerAssignmentRecord; readonly workerId?: string }
  | { readonly status: 'remote_not_applicable'; readonly assignment: WorkerAssignmentRecord }
  | { readonly status: 'assignment_stale' | 'assignment_untrusted' | 'runtime_unavailable' | 'target_unresolved' };

export type WorkerAssignmentReplacementAdmission =
  | { readonly status: 'replaceable'; readonly expected: WorkerAssignmentRecord }
  | {
      readonly status: 'skipped_live';
      readonly expected: WorkerAssignmentRecord;
      readonly worker: RuntimeWorker;
      readonly reason: 'runtime_busy' | 'runtime_idle';
    }
  | {
      readonly status:
        | 'assignment_stale'
        | 'assignment_store_busy'
        | 'assignment_fence_failed'
        | 'assignment_untrusted'
        | 'runtime_unavailable'
        | 'target_unresolved';
      readonly reason?: string;
    };

export type WorkerAssignmentResolution =
  | {
      readonly status: 'ok';
      readonly bindings: readonly ResolvedWorkerAssignment[];
      readonly reconciliations: readonly WorkerAssignmentReconciliation[];
    }
  | {
      readonly status: 'assignment_untrusted' | 'runtime_unavailable';
      readonly bindings: readonly [];
      readonly reconciliations: readonly [];
    };

function sameLogicalAssignment(left: WorkerAssignmentRecord | undefined, right: WorkerAssignmentRecord): boolean {
  return Boolean(left
    && left.assignmentId === right.assignmentId
    && left.generation === right.generation
    && left.issueNumber === right.issueNumber
    && left.taskId === right.taskId
    && left.kind === right.kind
    && left.provider === right.provider
    && left.bindingKey === right.bindingKey);
}

/**
 * Resolve one exact expected current assignment without collapsing affirmative
 * gone evidence into generic unresolved state. This function observes only;
 * callers that authorize an effect must still hold withCurrentWorkerAssignmentFence.
 *
 * Orca may attach a producer-backed historical terminal handle to affirmative
 * gone evidence. That handle is optional, in-memory-only evidence used by
 * destructive cleanup to bind an existing pack reservation to this Dispatch;
 * it is never persisted as WorkerAssignment authority.
 */
export function resolveCurrentWorkerAssignmentTarget(input: {
  readonly file: string;
  readonly expected: WorkerAssignmentRecord;
  readonly adapter: RuntimeAdapter;
  readonly timeoutMs?: number;
}): WorkerAssignmentTargetResolution {
  const store = readWorkerAssignmentStore(input.file);
  if (!store) return { status: 'assignment_untrusted' };
  const key = workerAssignmentKey(input.expected.taskId, input.expected.bindingKey);
  const current = key ? store.assignments[key] : undefined;
  if (!current || !sameLogicalAssignment(current, input.expected)) {
    return { status: 'assignment_stale' };
  }
  if (current.kind !== 'local') {
    return { status: 'remote_not_applicable', assignment: current };
  }
  if (typeof input.adapter.resolveAssignmentWorker !== 'function') {
    return { status: 'runtime_unavailable' };
  }
  const resolved = input.adapter.resolveAssignmentWorker(
    { provider: current.provider, bindingKey: current.bindingKey },
    { timeoutMs: input.timeoutMs ?? 5_000 },
  );
  if (resolved.status !== 'ok') return { status: 'target_unresolved' };
  if (!assignmentStillCurrent(input.file, current)) return { status: 'assignment_stale' };
  if (resolved.value.kind === 'gone') {
    const workerId = String(
      (resolved.value as { readonly workerId?: unknown }).workerId ?? '',
    ).trim();
    return {
      status: 'gone',
      assignment: current,
      ...(workerId ? { workerId } : {}),
    };
  }
  return { status: 'resolved', assignment: current, worker: resolved.value.worker };
}

/**
 * Admit a logical replacement while the exact expected assignment is fenced.
 * Remote current ownership needs only exact-current serialization. Current local
 * ownership additionally requires affirmative assignment-resolution `gone`.
 * A resolved busy/idle worker is live; unknown or contradictory liveness is not
 * absence evidence and fails closed.
 */
export async function admitCurrentWorkerAssignmentReplacement(input: {
  readonly file: string;
  readonly expected: WorkerAssignmentRecord;
  readonly adapter: RuntimeAdapter;
  readonly timeoutMs?: number;
  readonly observationWindowMs?: number;
}): Promise<WorkerAssignmentReplacementAdmission> {
  const fenced = await withCurrentWorkerAssignmentFence(input.file, input.expected, () => {
    if (input.expected.kind !== 'local') {
      return { status: 'replaceable', expected: input.expected } as const;
    }
    const target = resolveCurrentWorkerAssignmentTarget({
      file: input.file,
      expected: input.expected,
      adapter: input.adapter,
      timeoutMs: input.timeoutMs,
    });
    if (target.status === 'gone') {
      return { status: 'replaceable', expected: input.expected } as const;
    }
    if (target.status === 'resolved') {
      const liveness = input.adapter.liveness({
        worker: target.worker.identity,
        observationWindowMs: input.observationWindowMs ?? 50,
      }, { timeoutMs: input.timeoutMs ?? 5_000 });
      if (liveness.status === 'busy' || liveness.status === 'idle') {
        return {
          status: 'skipped_live',
          expected: input.expected,
          worker: target.worker,
          reason: `runtime_${liveness.status}` as 'runtime_busy' | 'runtime_idle',
        } as const;
      }
      return {
        status: 'target_unresolved',
        reason: `resolved_target_liveness_${liveness.status}_is_not_assignment_gone_evidence`,
      } as const;
    }
    if (target.status === 'remote_not_applicable') {
      return { status: 'assignment_stale' } as const;
    }
    return { status: target.status } as const;
  });
  if (!fenced.ok) return { status: fenced.reason };
  return fenced.value;
}

export function resolveCurrentWorkerAssignmentBindings(input: {
  readonly file: string;
  readonly repository: string;
  readonly adapter: RuntimeAdapter;
  readonly timeoutMs?: number;
}): WorkerAssignmentResolution {
  const assignments = listCurrentWorkerAssignmentRecords(input.file);
  if (!assignments) return { status: 'assignment_untrusted', bindings: [], reconciliations: [] };
  if (typeof input.adapter.resolveAssignmentWorker !== 'function') {
    return { status: 'runtime_unavailable', bindings: [], reconciliations: [] };
  }
  const repository = input.repository.trim().toLowerCase();
  const bindings: ResolvedWorkerAssignment[] = [];
  const reconciliations: WorkerAssignmentReconciliation[] = [];
  for (const assignment of assignments) {
    if (assignment.repository !== repository) continue;
    if (assignment.kind !== 'local') {
      if (assignmentStillCurrent(input.file, assignment)) {
        reconciliations.push({ assignment, reason: 'remote_not_applicable' });
      }
      continue;
    }
    const resolved = input.adapter.resolveAssignmentWorker(
      { provider: assignment.provider, bindingKey: assignment.bindingKey },
      { timeoutMs: input.timeoutMs ?? 5_000 },
    );
    if (resolved.status !== 'ok') {
      if (assignmentStillCurrent(input.file, assignment)) {
        reconciliations.push({ assignment, reason: 'target_unresolved' });
      }
      continue;
    }
    if (!assignmentStillCurrent(input.file, assignment)) continue;
    if (resolved.value.kind === 'gone') {
      // Fleet reconciliation has no authority to act on gone evidence. Preserve
      // the exact gone distinction only on the target-resolution seam used by
      // replacement/recovery; the existing scheduler handoff remains generic.
      reconciliations.push({ assignment, reason: 'target_unresolved' });
      continue;
    }
    const worker = resolved.value.worker;
    if (bindings.some((candidate) => sameRuntimeWorker(candidate.worker.identity, worker.identity))) {
      return { status: 'assignment_untrusted', bindings: [], reconciliations: [] };
    }
    bindings.push({ assignment, worker });
  }
  return { status: 'ok', bindings, reconciliations };
}

export function bindingForIssue(
  bindings: readonly ResolvedWorkerAssignment[],
  issueNumber: number,
): ResolvedIssueWorkerAssignment | null {
  const matches = bindings.filter((binding): binding is ResolvedIssueWorkerAssignment =>
    binding.assignment.issueNumber === issueNumber);
  return matches.length === 1 ? matches[0]! : null;
}
