import { createHash } from 'node:crypto';
import type { RuntimeWorkerIdentity } from '../runtime/contracts.ts';
import type { ResolvedWorkerAssignment } from '../lib/worker-assignment-runtime.ts';

export interface FleetAssignmentBinding {
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly issueNumber: number;
  readonly taskId: string;
  readonly unitRef: string;
  /** Runtime-private identity is in-memory only. */
  readonly worker: RuntimeWorkerIdentity;
}

export function unitRefForAssignment(assignmentId: string, generation: number): string {
  const digest = createHash('sha256')
    .update(`${assignmentId}\u0000${generation}`, 'utf8')
    .digest();
  const value = (digest.readUInt32BE(0) % 999_999_999) + 1;
  return `u-${value}`;
}

export function buildFleetAssignmentBindings(
  resolved: readonly ResolvedWorkerAssignment[],
): readonly FleetAssignmentBinding[] | null {
  const bindings = resolved.map(({ assignment, worker }) => ({
    assignmentId: assignment.assignmentId,
    assignmentGeneration: assignment.generation,
    issueNumber: assignment.issueNumber,
    taskId: assignment.taskId,
    unitRef: unitRefForAssignment(assignment.assignmentId, assignment.generation),
    worker: worker.identity,
  }));
  const refs = new Set<string>();
  for (const binding of bindings) {
    if (refs.has(binding.unitRef)) return null;
    refs.add(binding.unitRef);
  }
  return bindings;
}
