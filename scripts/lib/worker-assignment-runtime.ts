import {
  sameRuntimeWorker,
  type RuntimeAdapter,
  type RuntimeWorker,
} from '../runtime/contracts.ts';
import {
  assignmentStillCurrent,
  listCurrentWorkerAssignments,
  readWorkerAssignmentStore,
  withCurrentWorkerAssignmentFence,
  type WorkerAssignment,
} from './worker-assignment-store.ts';

export interface ResolvedWorkerAssignment {
  readonly assignment: WorkerAssignment;
  /** Exact runtime-private identity is deliberately held only in memory. */
  readonly worker: RuntimeWorker;
}

export interface WorkerAssignmentReconciliation {
  readonly assignment: WorkerAssignment;
  readonly reason: 'target_unresolved' | 'target_gone' | 'remote_not_applicable';
}

export type WorkerAssignmentTargetResolution =
  | { readonly status: 'resolved'; readonly assignment: WorkerAssignment; readonly worker: RuntimeWorker }
  | { readonly status: 'gone'; readonly assignment: WorkerAssignment }
  | { readonly status: 'remote_not_applicable'; readonly assignment: WorkerAssignment }
  | { readonly status: 'assignment_stale' | 'assignment_untrusted' | 'runtime_unavailable' | 'target_unresolved' };

export type WorkerAssignmentReplacementAdmission =
  | { readonly status: 'replaceable'; readonly expected: WorkerAssignment }
  | {
      readonly status: 'skipped_live';
      readonly expected: WorkerAssignment;
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

function sameLogicalAssignment(left: WorkerAssignment | undefined, right: WorkerAssignment): boolean {
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
 */
export function resolveCurrentWorkerAssignmentTarget(input: {
  readonly file: string;
  readonly expected: WorkerAssignment;
  readonly adapter: RuntimeAdapter;
  readonly timeoutMs?: number;
}): WorkerAssignmentTargetResolution {
  const store = readWorkerAssignmentStore(input.file);
  if (!store) return { status: 'assignment_untrusted' };
  const current = store.assignments[`issue-${input.expected.issueNumber}`];
  if (!sameLogicalAssignment(current, input.expected)) return { status: 'assignment_stale' };
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
    return { status: 'gone', assignment: current };
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
  readonly expected: WorkerAssignment;
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
  const assignments = listCurrentWorkerAssignments(input.file);
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
      reconciliations.push({ assignment, reason: 'target_gone' });
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
): ResolvedWorkerAssignment | null {
  const matches = bindings.filter((binding) => binding.assignment.issueNumber === issueNumber);
  return matches.length === 1 ? matches[0]! : null;
}
