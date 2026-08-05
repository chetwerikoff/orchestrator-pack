import { resolve } from 'node:path';
import {
  runtimeUnsupported,
  sameRuntimeWorker,
  type RuntimeAdapter,
  type RuntimeCallOptions,
  type RuntimeOperationFailure,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from './contracts.ts';

export type WorkerRecoveryResult =
  | { readonly outcome: 'skipped_live'; readonly worker: RuntimeWorker; readonly reason: string }
  | { readonly outcome: 'skipped_ambiguous'; readonly worker?: RuntimeWorker; readonly reason: string }
  | { readonly outcome: 'claim_lost'; readonly reason: string }
  | { readonly outcome: 'spawn_denied'; readonly reason: string }
  | { readonly outcome: 'spawn_started'; readonly worker: RuntimeWorker; readonly workspaceRemoved: boolean }
  | { readonly outcome: 'runtime_failed'; readonly failure: RuntimeOperationFailure };

/**
 * Pre-existing pack-owned cleanup authority. Runtime observations may revalidate
 * this binding, but cannot create it. Callers must load it from the durable claim
 * or reservation that owned the worker before recovery began.
 */
export interface WorkerRecoveryCleanupAuthority {
  readonly source: 'pack-reservation';
  readonly worker: RuntimeWorkerIdentity;
  readonly workspacePath: string;
  readonly expectedHeadSha: string;
}

function workersForWorkspace(
  adapter: RuntimeAdapter,
  workspacePath: string,
  options: RuntimeCallOptions | undefined,
): { readonly status: 'ok'; readonly workers: readonly RuntimeWorker[] }
  | { readonly status: 'failed'; readonly failure: RuntimeOperationFailure } {
  const listed = adapter.listWorkers({ workspace: workspacePath }, options);
  if (listed.status !== 'ok') return { status: 'failed', failure: listed };
  return {
    status: 'ok',
    workers: listed.value.filter((worker) => worker.workspacePath === workspacePath),
  };
}

function verifyWorkspaceHasNoLiveOwner(input: {
  readonly adapter: RuntimeAdapter;
  readonly workspacePath: string;
  readonly observationWindowMs: number;
  readonly options?: RuntimeCallOptions;
}): { readonly ok: true }
  | { readonly ok: false; readonly outcome: 'claim_lost' | 'skipped_ambiguous'; readonly reason: string }
  | { readonly ok: false; readonly failure: RuntimeOperationFailure } {
  const current = workersForWorkspace(input.adapter, input.workspacePath, input.options);
  if (current.status !== 'ok') return { ok: false, failure: current.failure };
  for (const worker of current.workers) {
    const liveness = input.adapter.liveness({
      worker: worker.identity,
      observationWindowMs: input.observationWindowMs,
    }, input.options);
    if (liveness.status === 'busy' || liveness.status === 'idle') {
      return { ok: false, outcome: 'claim_lost', reason: `post_claim_runtime_${liveness.status}` };
    }
    if (liveness.status === 'unknown') {
      return { ok: false, outcome: 'skipped_ambiguous', reason: 'post_claim_runtime_unknown' };
    }
  }
  return { ok: true };
}

function expectedIdentity(
  adapter: RuntimeAdapter,
  targetId: string,
  targetGeneration: string,
): RuntimeWorkerIdentity {
  return {
    runtime: adapter.id,
    id: targetId,
    generation: targetGeneration,
  };
}

function cleanupAuthorityMatches(input: {
  readonly authority: WorkerRecoveryCleanupAuthority;
  readonly expected: RuntimeWorkerIdentity;
  readonly cleanupPath: string;
  readonly expectedHeadSha: string;
}): boolean {
  return input.authority.source === 'pack-reservation'
    && sameRuntimeWorker(input.authority.worker, input.expected)
    && resolve(input.authority.workspacePath) === resolve(input.cleanupPath)
    && input.authority.expectedHeadSha.trim().toLowerCase() === input.expectedHeadSha.toLowerCase();
}

/**
 * Runtime-only worker recovery caller. It never derives authority from runtime
 * metadata such as linkedPR and never owns retry scheduling.
 *
 * Destructive cleanup requires a complete expected worker identity, expected
 * workspace head, and pre-existing pack-owned authority binding all three.
 * Cleanup/spawn selectors are validated before any runtime call or claim
 * acquisition, and the exact identity is re-read after the claim. A disappeared
 * worker is removable only when that durable authority is present; absence,
 * mismatch, unknown liveness, or a different live owner fails closed.
 */
export function recoverRuntimeWorker(input: {
  readonly adapter: RuntimeAdapter;
  readonly targetId?: string;
  readonly targetGeneration?: string;
  /** Selector for the new worker. Defaults to the current active workspace. */
  readonly workspace?: 'active' | string;
  readonly cleanupWorkspace?: {
    readonly workspacePath: string;
    readonly expectedHeadSha: string;
  };
  readonly cleanupAuthority?: WorkerRecoveryCleanupAuthority;
  readonly title: string;
  readonly command: string;
  readonly observationWindowMs?: number;
  readonly acquireClaim: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  readonly options?: RuntimeCallOptions;
}): WorkerRecoveryResult {
  const targetId = input.targetId?.trim() ?? '';
  const targetGeneration = input.targetGeneration?.trim() ?? '';
  if (targetId && !targetGeneration) {
    return { outcome: 'skipped_ambiguous', reason: 'target_generation_missing' };
  }
  if (!targetId && targetGeneration) {
    return { outcome: 'skipped_ambiguous', reason: 'target_id_missing' };
  }

  const cleanupPath = input.cleanupWorkspace?.workspacePath.trim() ?? '';
  const expectedHeadSha = input.cleanupWorkspace?.expectedHeadSha.trim().toLowerCase() ?? '';
  if (input.cleanupWorkspace && !cleanupPath) {
    return { outcome: 'skipped_ambiguous', reason: 'cleanup_workspace_missing' };
  }
  if (input.cleanupWorkspace && !expectedHeadSha) {
    return { outcome: 'skipped_ambiguous', reason: 'cleanup_expected_head_missing' };
  }
  if (input.cleanupWorkspace && (!targetId || !targetGeneration)) {
    return { outcome: 'skipped_ambiguous', reason: 'cleanup_target_identity_required' };
  }

  const spawnWorkspace = input.workspace ?? 'active';
  if (input.cleanupWorkspace && spawnWorkspace !== 'active'
    && resolve(spawnWorkspace) === resolve(cleanupPath)) {
    return { outcome: 'skipped_ambiguous', reason: 'cleanup_spawn_workspace_reuse' };
  }

  const observationWorkspace = cleanupPath || spawnWorkspace;
  const observationWindowMs = input.observationWindowMs ?? 50;
  const expected = targetId
    ? expectedIdentity(input.adapter, targetId, targetGeneration)
    : null;
  const cleanupAuthority = input.cleanupAuthority;
  if (input.cleanupWorkspace) {
    if (!expected || !cleanupAuthority) {
      return { outcome: 'skipped_ambiguous', reason: 'cleanup_ownership_authority_missing' };
    }
    if (!cleanupAuthorityMatches({
      authority: cleanupAuthority,
      expected,
      cleanupPath,
      expectedHeadSha,
    })) {
      return { outcome: 'skipped_ambiguous', reason: 'cleanup_ownership_authority_mismatch' };
    }
  }

  let selected: RuntimeWorker | null = null;
  if (expected) {
    const found = input.adapter.findWorkerById(expected.id, input.options);
    if (found.status !== 'ok') return { outcome: 'runtime_failed', failure: found };
    selected = found.value;
    if (selected && !sameRuntimeWorker(selected.identity, expected)) {
      return { outcome: 'skipped_ambiguous', worker: selected, reason: 'worker_identity_mismatch' };
    }
    if (selected && !input.cleanupWorkspace && selected.provenance !== 'internal') {
      return { outcome: 'skipped_ambiguous', worker: selected, reason: 'external_worker_not_authority' };
    }
  } else {
    const listed = input.adapter.listWorkers({ workspace: observationWorkspace }, input.options);
    if (listed.status !== 'ok') return { outcome: 'runtime_failed', failure: listed };
    const candidates = listed.value.filter((worker) => (
      observationWorkspace === 'active' || worker.workspacePath === observationWorkspace
    ));
    if (candidates.length > 1) {
      return { outcome: 'skipped_ambiguous', reason: 'multiple_runtime_workers' };
    }
    selected = candidates[0] ?? null;
    if (selected?.provenance === 'external') {
      return { outcome: 'skipped_ambiguous', worker: selected, reason: 'external_worker_not_authority' };
    }
  }

  if (selected && input.cleanupWorkspace
    && resolve(selected.workspacePath) !== resolve(cleanupPath)) {
    return { outcome: 'skipped_ambiguous', worker: selected, reason: 'workspace_identity_mismatch' };
  }

  if (selected) {
    const liveness = input.adapter.liveness({
      worker: selected.identity,
      observationWindowMs,
    }, input.options);
    if (liveness.status === 'busy' || liveness.status === 'idle') {
      return { outcome: 'skipped_live', worker: selected, reason: `runtime_${liveness.status}` };
    }
    if (liveness.status === 'unknown') {
      return { outcome: 'skipped_ambiguous', worker: selected, reason: 'runtime_liveness_unknown' };
    }
  }

  const claim = input.acquireClaim();
  if (!claim.ok) return { outcome: 'spawn_denied', reason: claim.reason };

  if (expected) {
    const current = input.adapter.findWorkerById(expected.id, input.options);
    if (current.status !== 'ok') return { outcome: 'runtime_failed', failure: current };
    if (current.value && !sameRuntimeWorker(current.value.identity, expected)) {
      return { outcome: 'claim_lost', reason: 'post_claim_worker_identity_mismatch' };
    }
    if (current.value && !input.cleanupWorkspace && current.value.provenance !== 'internal') {
      return { outcome: 'claim_lost', reason: 'post_claim_worker_identity_mismatch' };
    }
  }

  let workspaceRemoved = false;
  if (input.cleanupWorkspace) {
    const revalidated = verifyWorkspaceHasNoLiveOwner({
      adapter: input.adapter,
      workspacePath: cleanupPath,
      observationWindowMs,
      options: input.options,
    });
    if (!revalidated.ok) {
      if ('failure' in revalidated) return { outcome: 'runtime_failed', failure: revalidated.failure };
      return { outcome: revalidated.outcome, reason: revalidated.reason };
    }
    if (!input.adapter.removeWorkspace) {
      return {
        outcome: 'runtime_failed',
        failure: runtimeUnsupported('remove_workspace', 'runtime_workspace_remove_unsupported'),
      };
    }
    const removed = input.adapter.removeWorkspace({
      workspacePath: cleanupPath,
      expectedHeadSha,
    }, input.options);
    if (removed.status !== 'ok') return { outcome: 'runtime_failed', failure: removed };
    workspaceRemoved = true;
  } else if (expected) {
    const current = input.adapter.findWorkerById(expected.id, input.options);
    if (current.status !== 'ok') return { outcome: 'runtime_failed', failure: current };
    if (current.value) {
      if (!sameRuntimeWorker(current.value.identity, expected)
        || current.value.provenance !== 'internal') {
        return { outcome: 'claim_lost', reason: 'post_claim_worker_identity_mismatch' };
      }
      const liveness = input.adapter.liveness({
        worker: current.value.identity,
        observationWindowMs,
      }, input.options);
      if (liveness.status !== 'gone') {
        return { outcome: 'claim_lost', reason: `post_claim_runtime_${liveness.status}` };
      }
    }
  } else {
    const current = input.adapter.listWorkers({ workspace: observationWorkspace }, input.options);
    if (current.status !== 'ok') return { outcome: 'runtime_failed', failure: current };
    if (current.value.some((worker) => (
      observationWorkspace === 'active' || worker.workspacePath === observationWorkspace
    ))) {
      return { outcome: 'claim_lost', reason: 'post_claim_worker_appeared' };
    }
  }

  const spawned = input.adapter.spawnWorker({
    title: input.title,
    command: input.command,
    workspace: spawnWorkspace,
  }, input.options);
  if (spawned.status !== 'ok') return { outcome: 'runtime_failed', failure: spawned };
  return { outcome: 'spawn_started', worker: spawned.value, workspaceRemoved };
}
