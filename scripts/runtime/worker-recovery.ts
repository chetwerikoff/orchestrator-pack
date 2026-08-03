import {
  runtimeUnsupported,
  type RuntimeAdapter,
  type RuntimeCallOptions,
  type RuntimeOperationFailure,
  type RuntimeWorker,
} from './contracts.ts';

export type WorkerRecoveryResult =
  | { readonly outcome: 'skipped_live'; readonly worker: RuntimeWorker; readonly reason: string }
  | { readonly outcome: 'skipped_ambiguous'; readonly worker?: RuntimeWorker; readonly reason: string }
  | { readonly outcome: 'claim_lost'; readonly reason: string }
  | { readonly outcome: 'spawn_denied'; readonly reason: string }
  | { readonly outcome: 'spawn_started'; readonly worker: RuntimeWorker; readonly workspaceRemoved: boolean }
  | { readonly outcome: 'runtime_failed'; readonly failure: RuntimeOperationFailure };

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

/**
 * Runtime-only worker recovery caller. It never derives authority from runtime
 * metadata such as linkedPR and never owns retry scheduling.
 *
 * The existing pack claim is acquired before workspace removal or spawn. After
 * claim acquisition every worker in the exact workspace is observed again. Any
 * live or unknown owner blocks cleanup. The adapter then validates exact
 * workspace path/head and performs at most one native removal before spawn.
 */
export function recoverRuntimeWorker(input: {
  readonly adapter: RuntimeAdapter;
  readonly targetId?: string;
  readonly workspace?: 'active' | string;
  readonly cleanupWorkspace?: {
    readonly workspacePath: string;
    readonly expectedHeadSha?: string;
  };
  readonly title: string;
  readonly command: string;
  readonly observationWindowMs?: number;
  readonly acquireClaim: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  readonly options?: RuntimeCallOptions;
}): WorkerRecoveryResult {
  const workspace = input.workspace ?? input.cleanupWorkspace?.workspacePath ?? 'active';
  const observationWindowMs = input.observationWindowMs ?? 50;
  let selected: RuntimeWorker | null = null;
  if (input.targetId) {
    const found = input.adapter.findWorkerById(input.targetId, input.options);
    if (found.status !== 'ok') return { outcome: 'runtime_failed', failure: found };
    selected = found.value;
  } else {
    const listed = input.adapter.listWorkers({ workspace }, input.options);
    if (listed.status !== 'ok') return { outcome: 'runtime_failed', failure: listed };
    const candidates = listed.value.filter((worker) => (
      workspace === 'active' || worker.workspacePath === workspace
    ));
    if (candidates.length > 1) {
      return { outcome: 'skipped_ambiguous', reason: 'multiple_runtime_workers' };
    }
    selected = candidates[0] ?? null;
  }

  if (selected && input.cleanupWorkspace
    && selected.workspacePath !== input.cleanupWorkspace.workspacePath) {
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

  let workspaceRemoved = false;
  if (input.cleanupWorkspace) {
    const revalidated = verifyWorkspaceHasNoLiveOwner({
      adapter: input.adapter,
      workspacePath: input.cleanupWorkspace.workspacePath,
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
    const removed = input.adapter.removeWorkspace(input.cleanupWorkspace, input.options);
    if (removed.status !== 'ok') return { outcome: 'runtime_failed', failure: removed };
    workspaceRemoved = true;
  } else if (input.targetId) {
    const current = input.adapter.findWorkerById(input.targetId, input.options);
    if (current.status !== 'ok') return { outcome: 'runtime_failed', failure: current };
    if (current.value) {
      const liveness = input.adapter.liveness({
        worker: current.value.identity,
        observationWindowMs,
      }, input.options);
      if (liveness.status !== 'gone') {
        return { outcome: 'claim_lost', reason: `post_claim_runtime_${liveness.status}` };
      }
    }
  } else {
    const current = input.adapter.listWorkers({ workspace }, input.options);
    if (current.status !== 'ok') return { outcome: 'runtime_failed', failure: current };
    if (current.value.some((worker) => workspace === 'active' || worker.workspacePath === workspace)) {
      return { outcome: 'claim_lost', reason: 'post_claim_worker_appeared' };
    }
  }

  const spawned = input.adapter.spawnWorker({
    title: input.title,
    command: input.command,
    workspace,
  }, input.options);
  if (spawned.status !== 'ok') return { outcome: 'runtime_failed', failure: spawned };
  return { outcome: 'spawn_started', worker: spawned.value, workspaceRemoved };
}
