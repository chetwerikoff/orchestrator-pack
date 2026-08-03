import type {
  RuntimeAdapter,
  RuntimeCallOptions,
  RuntimeOperationFailure,
  RuntimeWorker,
} from './contracts.ts';

export type WorkerRecoveryResult =
  | { readonly outcome: 'skipped_live'; readonly worker: RuntimeWorker; readonly reason: string }
  | { readonly outcome: 'skipped_ambiguous'; readonly worker?: RuntimeWorker; readonly reason: string }
  | { readonly outcome: 'claim_lost'; readonly reason: string }
  | { readonly outcome: 'spawn_denied'; readonly reason: string }
  | { readonly outcome: 'spawn_started'; readonly worker: RuntimeWorker }
  | { readonly outcome: 'runtime_failed'; readonly failure: RuntimeOperationFailure };

/**
 * Runtime-only worker recovery caller. Branch/worktree cleanup remains a
 * separate ownership-preserving concern; this function neither removes a
 * workspace nor derives authority from runtime metadata such as linkedPR.
 *
 * Claim acquisition occurs before spawn and a second runtime observation is
 * required after claim acquisition. The caller must provide the existing pack
 * claim primitive; no new lock or retry store is introduced here.
 */
export function recoverRuntimeWorker(input: {
  readonly adapter: RuntimeAdapter;
  readonly targetId?: string;
  readonly workspace?: 'active' | string;
  readonly title: string;
  readonly command: string;
  readonly observationWindowMs?: number;
  readonly acquireClaim: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  readonly options?: RuntimeCallOptions;
}): WorkerRecoveryResult {
  const workspace = input.workspace ?? 'active';
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

  if (selected) {
    const liveness = input.adapter.liveness({
      worker: selected.identity,
      observationWindowMs: input.observationWindowMs ?? 50,
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

  if (input.targetId) {
    const current = input.adapter.findWorkerById(input.targetId, input.options);
    if (current.status !== 'ok') return { outcome: 'runtime_failed', failure: current };
    if (current.value) {
      const liveness = input.adapter.liveness({
        worker: current.value.identity,
        observationWindowMs: input.observationWindowMs ?? 50,
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
  return { outcome: 'spawn_started', worker: spawned.value };
}
