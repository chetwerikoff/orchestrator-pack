export const RUNTIME_LIVENESS_RESULTS = ['busy', 'idle', 'gone', 'unknown'] as const;
export type RuntimeLiveness = (typeof RUNTIME_LIVENESS_RESULTS)[number];

export const RUNTIME_DISPATCH_RESULTS = [
  'dispatched',
  'send_failed',
  'dispatch_unknown',
] as const;
export type RuntimeDispatchStatus = (typeof RUNTIME_DISPATCH_RESULTS)[number];

/** Opaque registry key. Adding an adapter does not widen the shared contract. */
export type RuntimeAdapterId = string;
export type RuntimeWorkerProvenance = 'internal' | 'external';

/** Runtime-neutral worker identity. Id and generation are opaque to callers. */
export interface RuntimeWorkerIdentity {
  readonly id: string;
  readonly generation: string;
  readonly runtime: RuntimeAdapterId;
}

export interface RuntimeWorker {
  readonly identity: RuntimeWorkerIdentity;
  readonly workspacePath: string;
  readonly title: string | null;
  readonly provenance: RuntimeWorkerProvenance;
}

export interface RuntimeReadiness {
  readonly ready: true;
  readonly workspacePath: string;
  readonly headSha?: string;
  readonly linkedIssue?: number | null;
}

export interface RuntimeObservationToken {
  /** Equality-only opaque value. Callers must not parse or perform arithmetic on it. */
  readonly opaque: string;
}

export interface RuntimeBoundedOutput {
  readonly worker: RuntimeWorkerIdentity;
  readonly lines: readonly string[];
  readonly observationToken: RuntimeObservationToken;
  readonly changed: boolean;
  readonly terminalState: 'running' | 'exited' | 'unknown';
}

export interface RuntimeInboxMessage {
  readonly type: string;
  readonly subject?: string;
  readonly body?: string;
  readonly payload?: unknown;
}

export interface RuntimeInboxDelivery {
  readonly runId: string;
  readonly deliveryId: string;
  readonly messages: readonly RuntimeInboxMessage[];
}

export type RuntimeInboxCheckResult =
  | { readonly status: 'empty'; readonly runId: string }
  | { readonly status: 'delivery'; readonly delivery: RuntimeInboxDelivery }
  | { readonly status: 'failed' | 'unsupported' | 'unknown'; readonly reason: string };

export type RuntimeInboxDrainResult =
  | { readonly status: 'empty'; readonly runId: string }
  | {
      readonly status: 'blocked';
      readonly runId: string;
      readonly reason: string;
      readonly pendingDeliveryId?: string;
    }
  | {
      readonly status: 'boundary_busy';
      readonly runId: string;
      readonly reason: 'runtime_inbox_budget_exhausted';
      readonly pendingDeliveryId?: string;
    };

export interface RuntimeInboxDrainRequest {
  readonly runId: string;
  readonly processMessage: (
    message: RuntimeInboxMessage,
    delivery: RuntimeInboxDelivery,
  ) => void | Promise<void>;
  /** Test seam only; production callers inherit the lifecycle/turn clock. */
  readonly now?: () => number;
}

export type RuntimeOperationName =
  | 'readiness'
  | 'list_workers'
  | 'find_worker_by_id'
  | 'find_worker'
  | 'resolve_assignment_worker'
  | 'spawn_worker'
  | 'dispatch_input'
  | 'check_inbox'
  | 'read_bounded_output'
  | 'liveness'
  | 'stop_worker'
  | 'remove_workspace';

export interface RuntimeOperationFailure {
  readonly status: 'failed' | 'unsupported';
  readonly operation: RuntimeOperationName;
  readonly reason: string;
}

export type RuntimeResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | RuntimeOperationFailure;

export type RuntimeDispatchResult =
  | { readonly status: 'dispatched' }
  | { readonly status: 'send_failed'; readonly reason: string }
  | { readonly status: 'dispatch_unknown'; readonly reason: string };

/** Liveness is deliberately total and has no fifth error result. */
export interface RuntimeLivenessResult {
  readonly status: RuntimeLiveness;
  readonly worker: RuntimeWorkerIdentity;
}

export interface RuntimeCallOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface RuntimeAdapter {
  readonly id: RuntimeAdapterId;

  readiness(options?: RuntimeCallOptions): RuntimeResult<RuntimeReadiness>;

  listWorkers(
    input: { readonly workspace?: 'active' | string },
    options?: RuntimeCallOptions,
  ): RuntimeResult<readonly RuntimeWorker[]>;

  /** Resolve the current composite identity for one opaque runtime id. */
  findWorkerById(
    id: string,
    options?: RuntimeCallOptions,
  ): RuntimeResult<RuntimeWorker | null>;

  findWorker(
    identity: RuntimeWorkerIdentity,
    options?: RuntimeCallOptions,
  ): RuntimeResult<RuntimeWorker | null>;

  /**
   * Resolve a persistence-safe lifecycle binding into a current exact runtime
   * worker. The binding key is provider-owned lifecycle identity, never a raw
   * runtime id/generation. Adapters that cannot prove this mapping omit the seam.
   */
  resolveAssignmentWorker?(
    input: {
      readonly provider: string;
      readonly bindingKey: string;
    },
    options?: RuntimeCallOptions,
  ): RuntimeResult<RuntimeWorker | null>;

  spawnWorker(
    input: {
      readonly title: string;
      readonly command: string;
      readonly workspace?: 'active' | string;
    },
    options?: RuntimeCallOptions,
  ): RuntimeResult<RuntimeWorker>;

  dispatchInput(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly text?: string;
      readonly submitOnly?: boolean;
    },
    options?: RuntimeCallOptions,
  ): RuntimeDispatchResult;

  /**
   * Read the bound Run's oldest unacknowledged Delivery. When ackDeliveryId is
   * supplied, the provider must acknowledge that exact prior whole Delivery
   * before performing the next non-blocking check. Implementations must never
   * synthesize delivery ids or surface/ack a sibling Run.
   */
  checkInbox?(
    input: {
      readonly runId: string;
      readonly ackDeliveryId?: string;
    },
    options?: RuntimeCallOptions,
  ): RuntimeInboxCheckResult;

  readBoundedOutput(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly previousToken?: RuntimeObservationToken | null;
      readonly limit?: number;
    },
    options?: RuntimeCallOptions,
  ): RuntimeResult<RuntimeBoundedOutput>;

  liveness(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly observationWindowMs: number;
    },
    options?: RuntimeCallOptions,
  ): RuntimeLivenessResult;

  stopWorker(
    worker: RuntimeWorkerIdentity,
    options?: RuntimeCallOptions,
  ): RuntimeResult<{ readonly stopped: true }>;

  /**
   * Remove one exact runtime workspace after caller-owned policy and claims have
   * admitted cleanup. The expected head is mandatory; path-only cleanup is not
   * a destructive authority.
   */
  removeWorkspace?(
    input: {
      readonly workspacePath: string;
      readonly expectedHeadSha: string;
    },
    options?: RuntimeCallOptions,
  ): RuntimeResult<{ readonly removed: true }>;
}

/**
 * Drain one exact Run inbox inside the caller-owned lifecycle/turn budget.
 * Every Delivery is processed completely before one ack is attempted. Any
 * malformed/foreign/runtime/processing/ack uncertainty fails closed; an ack is
 * never retried because its outcome would be ambiguous.
 */
export async function drainRuntimeInbox(
  adapter: Pick<RuntimeAdapter, 'checkInbox'>,
  request: RuntimeInboxDrainRequest,
  options: RuntimeCallOptions,
): Promise<RuntimeInboxDrainResult> {
  const runId = request.runId.trim();
  if (!runId) {
    return { status: 'blocked', runId, reason: 'runtime_inbox_run_id_missing' };
  }
  if (!adapter.checkInbox) {
    return { status: 'blocked', runId, reason: 'runtime_inbox_unsupported' };
  }
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || Number(timeoutMs) <= 0) {
    return { status: 'boundary_busy', runId, reason: 'runtime_inbox_budget_exhausted' };
  }

  const now = request.now ?? Date.now;
  const deadlineMs = now() + Number(timeoutMs);
  let pendingAckDeliveryId: string | undefined;

  while (true) {
    const remainingMs = Math.floor(deadlineMs - now());
    if (remainingMs <= 0) {
      return {
        status: 'boundary_busy',
        runId,
        reason: 'runtime_inbox_budget_exhausted',
        ...(pendingAckDeliveryId ? { pendingDeliveryId: pendingAckDeliveryId } : {}),
      };
    }

    const ackDeliveryId = pendingAckDeliveryId;
    pendingAckDeliveryId = undefined;
    let checked: RuntimeInboxCheckResult;
    try {
      checked = adapter.checkInbox(
        {
          runId,
          ...(ackDeliveryId ? { ackDeliveryId } : {}),
        },
        { ...options, timeoutMs: remainingMs },
      );
    } catch (error) {
      return {
        status: 'blocked',
        runId,
        reason: `runtime_inbox_check_threw:${error instanceof Error ? error.message : String(error)}`,
        ...(ackDeliveryId ? { pendingDeliveryId: ackDeliveryId } : {}),
      };
    }

    if (checked.status === 'empty') {
      if (checked.runId !== runId) {
        return { status: 'blocked', runId, reason: 'runtime_inbox_foreign_empty_run' };
      }
      return { status: 'empty', runId };
    }
    if (checked.status !== 'delivery') {
      return {
        status: 'blocked',
        runId,
        reason: `runtime_inbox_${checked.status}:${checked.reason}`,
        ...(ackDeliveryId ? { pendingDeliveryId: ackDeliveryId } : {}),
      };
    }

    const delivery = checked.delivery;
    if (!delivery
      || delivery.runId !== runId
      || typeof delivery.deliveryId !== 'string'
      || !delivery.deliveryId.trim()
      || !Array.isArray(delivery.messages)) {
      return { status: 'blocked', runId, reason: 'runtime_inbox_delivery_malformed' };
    }

    for (const message of delivery.messages) {
      try {
        await request.processMessage(message, delivery);
      } catch (error) {
        return {
          status: 'blocked',
          runId,
          reason: `runtime_inbox_message_processing_failed:${error instanceof Error ? error.message : String(error)}`,
          pendingDeliveryId: delivery.deliveryId,
        };
      }
    }

    pendingAckDeliveryId = delivery.deliveryId;
  }
}

export function runtimeFailure(
  operation: RuntimeOperationName,
  reason: string,
): RuntimeOperationFailure {
  return { status: 'failed', operation, reason };
}

export function runtimeUnsupported(
  operation: RuntimeOperationName,
  reason: string,
): RuntimeOperationFailure {
  return { status: 'unsupported', operation, reason };
}

export function sameRuntimeWorker(
  left: RuntimeWorkerIdentity,
  right: RuntimeWorkerIdentity,
): boolean {
  return left.runtime === right.runtime
    && left.id === right.id
    && left.generation === right.generation;
}
