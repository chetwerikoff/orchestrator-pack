import type {
  RuntimeAdapter,
  RuntimeCallOptions,
  RuntimeDispatchResult,
  RuntimeLiveness,
  RuntimeObservationToken,
  RuntimeOperationFailure,
  RuntimeWorker,
} from './contracts.ts';

export type RuntimeTaskLifecycleFailure =
  | { readonly stage: 'claim'; readonly reason: string }
  | { readonly stage: 'spawn' | 'read' | 'stop'; readonly failure: RuntimeOperationFailure }
  | {
      readonly stage: 'dispatch';
      readonly result: Exclude<RuntimeDispatchResult, { status: 'dispatched' }>;
      readonly worker: RuntimeWorker;
    };

export interface RuntimeTaskLifecycleResult {
  readonly status: 'ok';
  readonly worker: RuntimeWorker;
  readonly lines: readonly string[];
  readonly observationToken: RuntimeObservationToken;
  readonly liveness: RuntimeLiveness;
}

/**
 * Direct runtime-neutral task caller used by focused parity tests and production
 * callers that need one bounded spawn/send/read/liveness/stop lifecycle.
 *
 * The claim hook runs before adapter.spawnWorker, so a failed reservation cannot
 * produce a worktree or terminal side effect. Dispatch is attempted exactly once.
 * A non-dispatched result retains the exact spawned identity for explicit
 * recovery; this caller never retries or guesses whether transport succeeded.
 */
export function executeRuntimeTaskLifecycle(input: {
  readonly adapter: RuntimeAdapter;
  readonly title: string;
  readonly command: string;
  readonly prompt: string;
  readonly workspace?: 'active' | string;
  readonly observationWindowMs?: number;
  readonly options?: RuntimeCallOptions;
  readonly acquireClaim?: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
}): RuntimeTaskLifecycleResult | RuntimeTaskLifecycleFailure {
  const claim = input.acquireClaim?.() ?? { ok: true as const };
  if (!claim.ok) return { stage: 'claim', reason: claim.reason };

  const spawned = input.adapter.spawnWorker({
    title: input.title,
    command: input.command,
    workspace: input.workspace ?? 'active',
  }, input.options);
  if (spawned.status !== 'ok') return { stage: 'spawn', failure: spawned };

  const dispatched = input.adapter.dispatchInput({
    worker: spawned.value.identity,
    text: input.prompt,
  }, input.options);
  if (dispatched.status !== 'dispatched') {
    return { stage: 'dispatch', result: dispatched, worker: spawned.value };
  }

  const output = input.adapter.readBoundedOutput({
    worker: spawned.value.identity,
    limit: 200,
  }, input.options);
  if (output.status !== 'ok') return { stage: 'read', failure: output };

  const liveness = input.adapter.liveness({
    worker: spawned.value.identity,
    observationWindowMs: input.observationWindowMs ?? 25,
  }, input.options);

  const stopped = input.adapter.stopWorker(spawned.value.identity, input.options);
  if (stopped.status !== 'ok') return { stage: 'stop', failure: stopped };

  return {
    status: 'ok',
    worker: spawned.value,
    lines: output.value.lines,
    observationToken: output.value.observationToken,
    liveness: liveness.status,
  };
}
