import type { DeliveryRecord } from './worker-message-dispatch-observe.d.mts';
import type { AoSession } from './review-trigger-reconcile.d.mts';

export declare const DEFAULT_SUBMIT_RECONCILE_INTERVAL_MS: number;
export declare const DEFAULT_MAX_SUBMIT_ATTEMPTS: number;
export declare const DEFAULT_DELIVERY_BACKSTOP_MS: number;
export declare const DEFAULT_POST_DISPATCH_LEASE_MS: number;
export declare const DEFAULT_CLAIM_STALE_MS: number;
export declare const DEFAULT_OBSERVABILITY_SETTLE_MS: number;

export declare const SUBMIT_STATE_PENDING: string;
export declare const SUBMIT_STATE_SUBMITTED: string;
export declare const SUBMIT_STATE_ESCALATED: string;
export declare const SUBMIT_STATE_NOOP: string;

export declare const OPERATOR_ESCALATION_PREFIX: string;
export declare const FAILED_DELIVERY_UNRESOLVED: string;
export declare const FAILED_DELIVERY_RESOLVED: string;
export declare const FAILED_DELIVERY_AUDITED_CLOSED: string;

export interface BusyDispatchMarker {
  backendKey: string;
  dispatchSignature: string;
  runtimeFingerprint: string;
  tmuxFingerprint: string;
  smokedAt: string;
  runId: string;
  busy_enter_enqueued_observed: true;
  consumed_after_flush_observed: true;
  no_manual_enter: true;
}

export interface FailedDeliveryRecord {
  deliveryId: string;
  sessionId?: string;
  prNumber?: number;
  headSha?: string;
  reviewRunId?: string;
  reason: string;
  unresolvedState: string;
  firstFailedAtMs?: number;
  lastFailedAtMs?: number;
  resolvedAtMs?: number;
  resolution?: string;
  deliverySequence?: number;
  source?: string;
  lifecycleState?: string;
}

export interface DeliveryTrackingRecord {
  deliveryId?: string;
  sessionId?: string;
  firstObservedAtMs?: number;
  deliveredAtMs?: number;
  submitAttempts?: number;
  lastSubmitAtMs?: number;
  firstDispatchAtMs?: number;
  lastProgressAtMs?: number;
  terminalState?: string;
  escalatedAtMs?: number;
  escalationReason?: string;
  consumedAtMs?: number;
  escalationResolvedAtMs?: number;
  failedDeliveryResolvedAtMs?: number;
  claimed?: boolean;
  claimKey?: string;
  provisionalClaimKey?: string;
  provisionalClaimSinceMs?: number;
  draftIdentity?: string;
  busyDispatchAllowed?: boolean;
  busyDispatchReason?: string;
  prNumber?: number;
  headSha?: string;
  reviewRunId?: string;
  source?: string;
  firstFailedAtMs?: number;
  failedDelivery?: FailedDeliveryRecord;
  vanishedSuppressedAtMs?: number;
}

export interface SubmitTrackingState {
  deliveries?: Record<string, DeliveryTrackingRecord>;
  failedDeliveries?: Record<string, FailedDeliveryRecord>;
  lastTickMs?: number;
  audit?: Array<Record<string, unknown>>;
  adoptionStatus?: string;
  adoptionEpochHash?: string;
  adoptionConfigPathHash?: string;
  lastAdoptionEscalationKey?: string;
  stateRootIdentity?: string;
}

export interface SubmitDecision {
  action: string;
  reason: string;
  deliveryId?: string;
  sessionId?: string;
  terminalState?: string;
  defer?: boolean;
  attempt?: number;
  maxSubmitAttempts?: number;
  diagnosis?: string;
  draftIdentity?: string;
  busyDispatchAllowed?: boolean;
  busyDispatchReason?: string;
}

export interface DispatchObservability {
  observable: boolean;
  settled: boolean;
  reason: string;
  progressAtMs: number;
}

export type WorkerMessageSubmitAction =
  | {
      type: 'submit';
      deliveryId: string;
      sessionId: string;
      attempt?: number;
      maxSubmitAttempts?: number;
      claimKey?: string;
    }
  | {
      type: 'mark_consumed';
      deliveryId: string;
      sessionId: string;
      reason: string;
    }
  | {
      type: 'escalate';
      deliveryId: string;
      sessionId: string;
      reason: string;
      diagnosis?: string;
    }
  | {
      type: 'defer';
      deliveryId: string;
      sessionId: string;
      reason: string;
    }
  | {
      type: 'noop';
      deliveryId?: string;
      sessionId?: string;
      reason: string;
    };

export declare function resolveSubmitReconcileConfig(config?: {
  intervalMs?: number;
  maxSubmitAttempts?: number;
  deliveryBackstopMs?: number;
  deliveryBudgetMs?: number;
  postDispatchLeaseMs?: number;
  claimStaleMs?: number;
  observabilitySettleMs?: number;
  busyDispatch?: {
    markers?: BusyDispatchMarker[];
    environment?: Record<string, unknown>;
    environmentSource?: string;
  };
}): {
  intervalMs: number;
  maxSubmitAttempts: number;
  deliveryBackstopMs: number;
  postDispatchLeaseMs: number;
  claimStaleMs: number;
  observabilitySettleMs: number;
  busyDispatch: {
    markers: BusyDispatchMarker[];
    environment: Record<string, unknown>;
    environmentSource: string;
  };
};

export declare function validateBusyDispatchMarker(
  marker?: Record<string, unknown>,
): { ok: boolean; reason?: string; field?: string };

export declare function validateSubmitReconcileConfig(config?: {
  maxSubmitAttempts?: number;
  deliveryBackstopMs?: number;
  deliveryBudgetMs?: number;
  postDispatchLeaseMs?: number;
  claimStaleMs?: number;
  observabilitySettleMs?: number;
  busyDispatch?: {
    markers?: BusyDispatchMarker[];
  };
}): { ok: boolean; reason?: string; field?: string };

export declare function getDeliveryTracking(
  tracking: SubmitTrackingState,
  deliveryId: string,
): DeliveryTrackingRecord;

export declare function clearSubmitClaimFields(
  record?: Record<string, unknown>,
): Record<string, unknown>;

export declare function isActiveSubmitClaim(
  record: Record<string, unknown>,
  nowMs: number,
  config?: { claimStaleMs?: number },
): boolean;

export declare function shouldClearStaleSubmitClaim(
  record: Record<string, unknown>,
  nowMs: number,
  config?: { claimStaleMs?: number },
): boolean;

export declare function resolveBusyDispatchCapability(input: {
  delivery?: Record<string, unknown>;
  session?: Record<string, unknown>;
  config?: Record<string, unknown>;
}): { allowed: boolean; backendKey?: string; reason: string; marker: BusyDispatchMarker | null };

export declare function collectSessionIdentifiers(
  session?: Record<string, unknown>,
  deliverySessionId?: string,
): string[];

export declare function getDeliveryInputAnchorMs(
  delivery: Record<string, unknown>,
  record?: Record<string, unknown>,
): number;

export declare function hasInterveningInputActivityForDelivery(
  events: Array<Record<string, unknown>>,
  session: Record<string, unknown>,
  delivery: Record<string, unknown>,
  anchorMs: number,
): boolean;

export declare function evaluateDispatchObservability(input: {
  session?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  record?: Record<string, unknown>;
  nowMs: number;
  config?: Record<string, unknown>;
}): DispatchObservability;

export declare function applySubmitOutcomes(
  tracking: SubmitTrackingState,
  outcomes: Array<{
    deliveryId?: string;
    claimKey?: string;
    outcome?: string;
    reason?: string;
  }>,
  nowMs: number,
): SubmitTrackingState;

export declare function evaluateSubmitDecision(input: {
  delivery: DeliveryRecord;
  session?: AoSession | Record<string, unknown>;
  tracking: SubmitTrackingState;
  aoEvents?: Array<Record<string, unknown>>;
  floodActiveSessions?: Record<string, boolean>;
  nowMs: number;
  config?: Record<string, unknown>;
}): SubmitDecision;

export declare function getFailedDeliveryStatus(input: {
  tracking: SubmitTrackingState;
  prNumber?: number;
  reviewRunId?: string;
  headSha?: string;
}): { ok: boolean; failClosed: boolean; unresolved: FailedDeliveryRecord[] };

export declare function evaluateWorktreeDriftVanishSuppression(input: {
  record?: Record<string, unknown>;
  reviewRuns?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
}): { suppress: boolean; reason: string };

export declare function planWorkerMessageSubmitActions(input: {
  sessions: Array<AoSession | Record<string, unknown>>;
  dispatchJournal?: Record<string, Record<string, unknown>>;
  aoEvents?: Array<Record<string, unknown>>;
  reviewRuns?: Array<Record<string, unknown>>;
  tracking?: SubmitTrackingState;
  floodActiveSessions?: Record<string, boolean>;
  reactionMessages?: Record<string, string>;
  nowMs: number;
  config?: Record<string, unknown>;
}): {
  actions: WorkerMessageSubmitAction[];
  tracking: SubmitTrackingState;
  deliveryCount: number;
  dispatchJournal?: Record<string, Record<string, unknown>>;
  overCapacity?: boolean;
};

export declare function evaluateConcurrentSubmitClaim(input: {
  existingClaim?: string;
  newClaimKey: string;
}): { ok: boolean; reason: string };

export declare const STATE_ROOT_RECOVERY_REASON: string;

export declare function evaluateStateRootReSeatEligibility(input: {
  state?: Record<string, unknown>;
  journal?: Record<string, Record<string, unknown>>;
  anchor?: Record<string, unknown> | null;
}): {
  eligible: boolean;
  reason: string;
  priorRecoveryReason?: string;
  deliveryId?: string;
  evidence?: string;
};

export declare function applyStateRootReSeat(input: {
  state?: Record<string, unknown>;
  identity?: string;
  eligibility?: Record<string, unknown>;
  nowMs: number;
}): Record<string, unknown>;

export declare function evaluateStateRootReSeat(input: {
  state?: Record<string, unknown>;
  journal?: Record<string, Record<string, unknown>>;
  anchor?: Record<string, unknown> | null;
  identity?: string;
  nowMs?: number;
}): {
  eligible: boolean;
  reason: string;
  priorRecoveryReason?: string;
  deliveryId?: string;
  evidence?: string;
  state: Record<string, unknown>;
};
