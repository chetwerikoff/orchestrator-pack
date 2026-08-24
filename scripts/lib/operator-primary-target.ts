import { performance } from 'node:perf_hooks';
import {
  sameRuntimeWorker,
  type RuntimeAdapter,
  type RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import {
  operatorPrimaryLockedResult,
  withCurrentOperatorPrimaryAssignment,
} from './worker-assignment-store.ts';

export const OPERATOR_PRIMARY_PRE_ACTION_FAILURES = [
  'binding_absent',
  'binding_stale',
  'assignment_untrusted',
  'remote_not_applicable',
  'runtime_unavailable',
  'target_unresolved',
  'target_not_current',
  'binding_store_busy',
  'binding_fence_failed',
  'deadline_invalid',
  'deadline_exhausted',
] as const;

export type OperatorPrimaryPreActionFailure =
  (typeof OPERATOR_PRIMARY_PRE_ACTION_FAILURES)[number];

export interface OperatorPrimarySyncActionResult<T> {
  readonly kind: 'operator-primary-sync-result';
  readonly value: T;
}

export function operatorPrimarySyncResult<T>(value: T): OperatorPrimarySyncActionResult<T> {
  return { kind: 'operator-primary-sync-result', value };
}

export type OperatorPrimaryTargetFenceResult<T> =
  | {
      readonly ok: true;
      readonly actionEntered: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly actionEntered: false;
      readonly reason: OperatorPrimaryPreActionFailure;
    }
  | {
      readonly ok: false;
      readonly actionEntered: true;
      readonly reason: 'action_failed' | 'action_result_invalid';
      readonly detail?: string;
    };

type LockedTargetResult<T> = OperatorPrimaryTargetFenceResult<T>;

function remainingBudget(deadlineMs: number): number {
  return Math.floor(deadlineMs - performance.now());
}

function preActionFailure(reason: OperatorPrimaryPreActionFailure): LockedTargetResult<never> {
  return { ok: false, actionEntered: false, reason };
}

function validRuntimeIdentity(identity: RuntimeWorkerIdentity | null | undefined): identity is RuntimeWorkerIdentity {
  return Boolean(identity
    && typeof identity.runtime === 'string' && identity.runtime.trim()
    && typeof identity.id === 'string' && identity.id.trim()
    && typeof identity.generation === 'string' && identity.generation.trim());
}

function isSyncActionResult<T>(value: unknown): value is OperatorPrimarySyncActionResult<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { readonly kind?: unknown; readonly then?: unknown };
  return candidate.kind === 'operator-primary-sync-result'
    && typeof candidate.then !== 'function';
}

/**
 * Resolve and immediately exact-revalidate the explicitly designated PACK
 * operator-primary WorkerAssignment, then run one synchronous caller action
 * while the existing assignment-store lock remains held.
 *
 * The lock fences PACK logical rebinding/replacement only. The returned target
 * is the freshly resolved/revalidated runtime snapshot; this function makes no
 * claim that a provider binding cannot remap after that snapshot is taken.
 */
export async function withCurrentOperatorPrimaryTarget<T>(
  input: {
    readonly file: string;
    readonly adapter: RuntimeAdapter;
    readonly timeoutMs: number;
  },
  action: (target: RuntimeWorkerIdentity) => OperatorPrimarySyncActionResult<T>,
): Promise<OperatorPrimaryTargetFenceResult<T>> {
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 5_000) {
    return preActionFailure('deadline_invalid');
  }

  const deadlineMs = performance.now() + input.timeoutMs;
  const fenced = await withCurrentOperatorPrimaryAssignment(input.file, (assignment) => {
    if (typeof input.adapter.resolveAssignmentWorker !== 'function') {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>(preActionFailure('runtime_unavailable'));
    }

    let remainingMs = remainingBudget(deadlineMs);
    if (remainingMs <= 0) {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>(preActionFailure('deadline_exhausted'));
    }

    let resolved: ReturnType<NonNullable<RuntimeAdapter['resolveAssignmentWorker']>>;
    try {
      resolved = input.adapter.resolveAssignmentWorker(
        { provider: assignment.provider, bindingKey: assignment.bindingKey },
        { timeoutMs: remainingMs },
      );
    } catch {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>(preActionFailure('runtime_unavailable'));
    }
    if (resolved.status !== 'ok') {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>(preActionFailure('runtime_unavailable'));
    }
    if (resolved.value.kind === 'gone') {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>(preActionFailure('target_not_current'));
    }
    if (resolved.value.kind !== 'resolved' || !validRuntimeIdentity(resolved.value.worker?.identity)) {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>(preActionFailure('target_unresolved'));
    }
    const candidate = resolved.value.worker.identity;

    remainingMs = remainingBudget(deadlineMs);
    if (remainingMs <= 0) {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>(preActionFailure('deadline_exhausted'));
    }

    let current: ReturnType<RuntimeAdapter['findWorker']>;
    try {
      current = input.adapter.findWorker(candidate, { timeoutMs: remainingMs });
    } catch {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>(preActionFailure('runtime_unavailable'));
    }
    if (current.status !== 'ok') {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>(preActionFailure('runtime_unavailable'));
    }
    if (!current.value
      || !validRuntimeIdentity(current.value.identity)
      || !sameRuntimeWorker(current.value.identity, candidate)) {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>(preActionFailure('target_not_current'));
    }

    let actionResult: OperatorPrimarySyncActionResult<T>;
    try {
      actionResult = action(candidate);
    } catch (error) {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>({
        ok: false,
        actionEntered: true,
        reason: 'action_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (!isSyncActionResult<T>(actionResult)) {
      return operatorPrimaryLockedResult<LockedTargetResult<T>>({
        ok: false,
        actionEntered: true,
        reason: 'action_result_invalid',
      });
    }
    return operatorPrimaryLockedResult<LockedTargetResult<T>>({
      ok: true,
      actionEntered: true,
      value: actionResult.value,
    });
  });

  if (!fenced.ok) {
    return preActionFailure(fenced.reason);
  }
  return fenced.value;
}
