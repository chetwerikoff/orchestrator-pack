import {
  sameRuntimeWorker,
  type RuntimeAdapter,
  type RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import {
  publishOperatorMessageOnce,
  validRuntimeWorkerIdentity,
  type OperatorPublicationOutcome,
} from './operator-publication.ts';

export interface WorkerDegradedCiHandoffInputV1 {
  readonly target: RuntimeWorkerIdentity;
  readonly text: string;
  readonly timeoutMs: number;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export function publishWorkerDegradedCiHandoffOnce(
  adapter: RuntimeAdapter,
  input: WorkerDegradedCiHandoffInputV1,
): OperatorPublicationOutcome {
  if (!input || !validRuntimeWorkerIdentity(input.target)
      || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
    return 'pre_dispatch_failure';
  }

  const startedAt = Date.now();
  const resolved = adapter.findWorker(input.target, { timeoutMs: input.timeoutMs });
  const remaining = input.timeoutMs - elapsedMs(startedAt);
  if (resolved.status !== 'ok' || resolved.value === null || remaining < 1) {
    return 'pre_dispatch_failure';
  }
  if (!validRuntimeWorkerIdentity(resolved.value.identity)
      || !sameRuntimeWorker(resolved.value.identity, input.target)) {
    return 'pre_dispatch_failure';
  }

  return publishOperatorMessageOnce(adapter, {
    route: 'operator-primary',
    target: input.target,
    text: input.text,
    timeoutMs: remaining,
  });
}
