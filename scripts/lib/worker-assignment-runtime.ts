import {
  sameRuntimeWorker,
  type RuntimeAdapter,
  type RuntimeWorker,
} from '../runtime/contracts.ts';
import {
  assignmentStillCurrent,
  listCurrentWorkerAssignments,
  type WorkerAssignment,
} from './worker-assignment-store.ts';

export interface ResolvedWorkerAssignment {
  readonly assignment: WorkerAssignment;
  /** Exact runtime-private identity is deliberately held only in memory. */
  readonly worker: RuntimeWorker;
}

export type WorkerAssignmentResolution =
  | { readonly status: 'ok'; readonly bindings: readonly ResolvedWorkerAssignment[] }
  | { readonly status: 'assignment_untrusted' | 'runtime_unavailable'; readonly bindings: readonly [] };

export function resolveCurrentWorkerAssignmentBindings(input: {
  readonly file: string;
  readonly repository: string;
  readonly adapter: RuntimeAdapter;
  readonly timeoutMs?: number;
}): WorkerAssignmentResolution {
  const assignments = listCurrentWorkerAssignments(input.file);
  if (!assignments) return { status: 'assignment_untrusted', bindings: [] };
  if (typeof input.adapter.resolveAssignmentWorker !== 'function') {
    return { status: 'runtime_unavailable', bindings: [] };
  }
  const repository = input.repository.trim().toLowerCase();
  const bindings: ResolvedWorkerAssignment[] = [];
  for (const assignment of assignments) {
    if (assignment.repository !== repository || assignment.kind !== 'local') continue;
    const resolved = input.adapter.resolveAssignmentWorker(
      { provider: assignment.provider, bindingKey: assignment.bindingKey },
      { timeoutMs: input.timeoutMs ?? 5_000 },
    );
    if (resolved.status !== 'ok' || resolved.value === null) continue;
    if (!assignmentStillCurrent(input.file, assignment)) continue;
    if (bindings.some((candidate) => sameRuntimeWorker(candidate.worker.identity, resolved.value!.identity))) {
      return { status: 'assignment_untrusted', bindings: [] };
    }
    bindings.push({ assignment, worker: resolved.value });
  }
  return { status: 'ok', bindings };
}

export function bindingForIssue(
  bindings: readonly ResolvedWorkerAssignment[],
  issueNumber: number,
): ResolvedWorkerAssignment | null {
  const matches = bindings.filter((binding) => binding.assignment.issueNumber === issueNumber);
  return matches.length === 1 ? matches[0]! : null;
}
