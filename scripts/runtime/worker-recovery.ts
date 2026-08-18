import { resolve } from 'node:path';
import {
  runtimeUnsupported,
  type RuntimeAdapter,
  type RuntimeCallOptions,
  type RuntimeOperationFailure,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from './contracts.ts';
import {
  withCurrentWorkerAssignmentFence,
  type WorkerAssignment,
} from '../lib/worker-assignment-store.ts';
import { resolveCurrentWorkerAssignmentTarget } from '../lib/worker-assignment-runtime.ts';

export type WorkerRecoveryResult =
  | { readonly outcome: 'skipped_live'; readonly worker: RuntimeWorker; readonly reason: 'runtime_busy' | 'runtime_idle' }
  | { readonly outcome: 'skipped_ambiguous'; readonly reason: string }
  | { readonly outcome: 'assignment_stale'; readonly reason: 'assignment_stale' }
  | { readonly outcome: 'assignment_store_busy'; readonly reason: 'assignment_store_busy' }
  | { readonly outcome: 'claim_denied'; readonly reason: string }
  | { readonly outcome: 'cleanup_completed'; readonly workspaceRemoved: true; readonly reason: 'gone_target_cleanup_completed' }
  | { readonly outcome: 'runtime_failed'; readonly failure: RuntimeOperationFailure };

/**
 * Pre-existing pack-owned cleanup authority. Runtime observations may revalidate
 * this binding, but cannot create it. It is cleanup-only authority and cannot
 * mint a successor WorkerAssignment or authorize a worker start.
 */
export interface WorkerRecoveryCleanupAuthority {
  readonly source: 'pack-reservation';
  readonly worker: RuntimeWorkerIdentity;
  readonly workspacePath: string;
  readonly expectedHeadSha: string;
}

function cleanupAuthorityMatches(input: {
  readonly authority: WorkerRecoveryCleanupAuthority;
  readonly adapter: RuntimeAdapter;
  readonly cleanupPath: string;
  readonly expectedHeadSha: string;
}): boolean {
  return input.authority.source === 'pack-reservation'
    && input.authority.worker.runtime === input.adapter.id
    && resolve(input.authority.workspacePath) === resolve(input.cleanupPath)
    && input.authority.expectedHeadSha.trim().toLowerCase() === input.expectedHeadSha.toLowerCase();
}

function verifyWorkspaceHasNoLiveOwner(input: {
  readonly adapter: RuntimeAdapter;
  readonly workspacePath: string;
  readonly observationWindowMs: number;
  readonly options?: RuntimeCallOptions;
}):
  | { readonly status: 'clear' }
  | { readonly status: 'live'; readonly worker: RuntimeWorker; readonly reason: 'runtime_busy' | 'runtime_idle' }
  | { readonly status: 'ambiguous'; readonly reason: string }
  | { readonly status: 'failed'; readonly failure: RuntimeOperationFailure } {
  const listed = input.adapter.listWorkers({ workspace: input.workspacePath }, input.options);
  if (listed.status !== 'ok') return { status: 'failed', failure: listed };
  for (const worker of listed.value.filter((candidate) => resolve(candidate.workspacePath) === resolve(input.workspacePath))) {
    const liveness = input.adapter.liveness({
      worker: worker.identity,
      observationWindowMs: input.observationWindowMs,
    }, input.options);
    if (liveness.status === 'busy' || liveness.status === 'idle') {
      return { status: 'live', worker, reason: `runtime_${liveness.status}` };
    }
    if (liveness.status === 'unknown') {
      return { status: 'ambiguous', reason: 'workspace_owner_liveness_unknown' };
    }
    // A generic inventory row whose liveness says gone is not itself authority
    // for assignment-target absence; the exact assignment resolver already
    // supplied that evidence. It merely does not prove a live workspace owner.
  }
  return { status: 'clear' };
}

/**
 * Recover one exact current local assignment by bounded cleanup only.
 *
 * The exact WorkerAssignment fence is held across assignment-target resolution,
 * claim acquisition, no-live-owner revalidation, and destructive workspace
 * removal. A resolved live target returns skipped_live and stopWorker is never
 * called. Only RuntimeAdapter assignment-resolution `gone` plus the pre-existing
 * cleanup authority may enter cleanup. No successor worker is spawned here.
 *
 * Destructive cleanup additionally requires a producer-backed terminal handle
 * for the gone Dispatch and proves that it is the same handle named by the
 * pack-owned cleanup reservation. A bare `gone` with no target association is
 * sufficient for logical replacement admission, but never for workspace cleanup.
 */
export async function recoverRuntimeWorker(input: {
  readonly assignmentStorePath: string;
  readonly expectedAssignment: WorkerAssignment;
  readonly adapter: RuntimeAdapter;
  readonly cleanupWorkspace: {
    readonly workspacePath: string;
    readonly expectedHeadSha: string;
  };
  readonly cleanupAuthority: WorkerRecoveryCleanupAuthority;
  readonly observationWindowMs?: number;
  readonly acquireClaim: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  readonly options?: RuntimeCallOptions;
}): Promise<WorkerRecoveryResult> {
  const cleanupPath = input.cleanupWorkspace.workspacePath.trim();
  const expectedHeadSha = input.cleanupWorkspace.expectedHeadSha.trim().toLowerCase();
  if (!cleanupPath) return { outcome: 'skipped_ambiguous', reason: 'cleanup_workspace_missing' };
  if (!expectedHeadSha) return { outcome: 'skipped_ambiguous', reason: 'cleanup_expected_head_missing' };
  if (input.expectedAssignment.kind !== 'local') {
    return { outcome: 'skipped_ambiguous', reason: 'remote_not_applicable' };
  }
  if (!input.expectedAssignment.provider.trim() || !input.expectedAssignment.bindingKey.trim()) {
    return { outcome: 'skipped_ambiguous', reason: 'assignment_binding_untrusted' };
  }
  if (!cleanupAuthorityMatches({
    authority: input.cleanupAuthority,
    adapter: input.adapter,
    cleanupPath,
    expectedHeadSha,
  })) {
    return { outcome: 'skipped_ambiguous', reason: 'cleanup_ownership_authority_mismatch' };
  }

  const observationWindowMs = input.observationWindowMs ?? 50;
  const fenced = await withCurrentWorkerAssignmentFence(
    input.assignmentStorePath,
    input.expectedAssignment,
    async () => {
      const target = resolveCurrentWorkerAssignmentTarget({
        file: input.assignmentStorePath,
        expected: input.expectedAssignment,
        adapter: input.adapter,
        timeoutMs: input.options?.timeoutMs,
      });
      if (target.status === 'assignment_stale') {
        return { outcome: 'assignment_stale', reason: 'assignment_stale' } as const;
      }
      if (target.status === 'assignment_untrusted'
        || target.status === 'runtime_unavailable'
        || target.status === 'target_unresolved'
        || target.status === 'remote_not_applicable') {
        return { outcome: 'skipped_ambiguous', reason: target.status } as const;
      }
      if (target.status === 'resolved') {
        const liveness = input.adapter.liveness({
          worker: target.worker.identity,
          observationWindowMs,
        }, input.options);
        if (liveness.status === 'busy' || liveness.status === 'idle') {
          return {
            outcome: 'skipped_live',
            worker: target.worker,
            reason: `runtime_${liveness.status}` as 'runtime_busy' | 'runtime_idle',
          } as const;
        }
        return {
          outcome: 'skipped_ambiguous',
          reason: `resolved_target_liveness_${liveness.status}_is_not_assignment_gone_evidence`,
        } as const;
      }

      if (!target.workerId) {
        return {
          outcome: 'skipped_ambiguous',
          reason: 'cleanup_target_identity_unavailable',
        } as const;
      }
      if (target.workerId !== input.cleanupAuthority.worker.id) {
        return {
          outcome: 'skipped_ambiguous',
          reason: 'cleanup_ownership_authority_target_mismatch',
        } as const;
      }

      const claimed = input.acquireClaim();
      if (!claimed.ok) return { outcome: 'claim_denied', reason: claimed.reason } as const;

      const noLiveOwner = verifyWorkspaceHasNoLiveOwner({
        adapter: input.adapter,
        workspacePath: cleanupPath,
        observationWindowMs,
        options: input.options,
      });
      if (noLiveOwner.status === 'failed') {
        return { outcome: 'runtime_failed', failure: noLiveOwner.failure } as const;
      }
      if (noLiveOwner.status === 'live') {
        return { outcome: 'skipped_live', worker: noLiveOwner.worker, reason: noLiveOwner.reason } as const;
      }
      if (noLiveOwner.status === 'ambiguous') {
        return { outcome: 'skipped_ambiguous', reason: noLiveOwner.reason } as const;
      }
      if (!input.adapter.removeWorkspace) {
        return {
          outcome: 'runtime_failed',
          failure: runtimeUnsupported('remove_workspace', 'runtime_workspace_remove_unsupported'),
        } as const;
      }
      const removed = input.adapter.removeWorkspace({
        workspacePath: cleanupPath,
        expectedHeadSha,
      }, input.options);
      if (removed.status !== 'ok') return { outcome: 'runtime_failed', failure: removed } as const;
      return {
        outcome: 'cleanup_completed',
        workspaceRemoved: true,
        reason: 'gone_target_cleanup_completed',
      } as const;
    },
  );

  if (!fenced.ok) {
    if (fenced.reason === 'assignment_store_busy') {
      return { outcome: 'assignment_store_busy', reason: 'assignment_store_busy' };
    }
    if (fenced.reason === 'assignment_stale') {
      return { outcome: 'assignment_stale', reason: 'assignment_stale' };
    }
    return { outcome: 'skipped_ambiguous', reason: fenced.reason };
  }
  return fenced.value;
}
