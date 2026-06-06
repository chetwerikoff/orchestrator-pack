import type { DeliveryRecord } from './worker-message-dispatch-observe.d.mts';
import type { AoSession } from './review-trigger-reconcile.d.mts';

export declare const DEFAULT_SUBMIT_RECONCILE_INTERVAL_MS: number;
export declare const DEFAULT_MAX_SUBMIT_ATTEMPTS: number;
export declare const DEFAULT_DELIVERY_BUDGET_MS: number;
export declare const DEFAULT_CLAIM_STALE_MS: number;

export declare const SUBMIT_STATE_PENDING: string;
export declare const SUBMIT_STATE_SUBMITTED: string;
export declare const SUBMIT_STATE_ESCALATED: string;
export declare const SUBMIT_STATE_NOOP: string;

export declare const OPERATOR_ESCALATION_PREFIX: string;

export interface DeliveryTrackingRecord {
  deliveryId?: string;
  sessionId?: string;
  firstObservedAtMs?: number;
  deliveredAtMs?: number;
  submitAttempts?: number;
  lastSubmitAtMs?: number;
  terminalState?: string;
  escalatedAtMs?: number;
  escalationReason?: string;
  consumedAtMs?: number;
  claimed?: boolean;
  claimKey?: string;
  provisionalClaimKey?: string;
  provisionalClaimSinceMs?: number;
}

export interface SubmitTrackingState {
  deliveries?: Record<string, DeliveryTrackingRecord>;
  lastTickMs?: number;
  audit?: Array<Record<string, unknown>>;
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
  deliveryBudgetMs?: number;
}): {
  intervalMs: number;
  maxSubmitAttempts: number;
  deliveryBudgetMs: number;
};

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
  floodActiveSessions?: Record<string, boolean>;
  nowMs: number;
  config?: {
    maxSubmitAttempts?: number;
    deliveryBudgetMs?: number;
    claimStaleMs?: number;
  };
}): SubmitDecision;

export declare function planWorkerMessageSubmitActions(input: {
  sessions: Array<AoSession | Record<string, unknown>>;
  dispatchJournal?: Record<string, Record<string, unknown>>;
  aoEvents?: Array<Record<string, unknown>>;
  reviewRuns?: Array<Record<string, unknown>>;
  tracking?: SubmitTrackingState;
  floodActiveSessions?: Record<string, boolean>;
  reactionMessages?: Record<string, string>;
  nowMs: number;
  config?: {
    maxSubmitAttempts?: number;
    deliveryBudgetMs?: number;
    claimStaleMs?: number;
  };
}): {
  actions: WorkerMessageSubmitAction[];
  tracking: SubmitTrackingState;
  deliveryCount: number;
};

export declare function evaluateConcurrentSubmitClaim(input: {
  existingClaim?: string;
  newClaimKey: string;
}): { ok: boolean; reason: string };
