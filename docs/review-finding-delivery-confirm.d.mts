export declare const DEFAULT_CONFIRMATION_WINDOW_MS: number;
export declare const DEFAULT_MAX_REDELIVERIES: number;
export declare const DEFAULT_TICK_INTERVAL_MS: number;

export declare const REVIEW_ROUND_REPORT_STATES: ReadonlySet<string>;
export declare const DELIVERY_STATE_CONFIRMED: string;
export declare const DELIVERY_STATE_ESCALATED: string;
export declare const DELIVERY_STATE_UNCONFIRMED: string;
export declare const OPERATOR_REMEDY_TEXT: string;

export interface ReviewRun {
  id?: string;
  reviewerSessionId?: string;
  prNumber?: number;
  targetSha?: string;
  status?: string;
  sentFindingCount?: number;
  linkedSessionId?: string;
  sentAt?: string;
  updatedAt?: string;
}

export type { AoSession } from './review-trigger-reconcile.d.mts';

export interface RunDeliveryRecord {
  deliveryState?: string;
  sendObservedAtMs?: number;
  redeliveryCount?: number;
  lastRedeliveryAtMs?: number;
  escalatedAtMs?: number;
}

export interface DeliveryTrackingState {
  runs?: Record<string, RunDeliveryRecord>;
  lastTickMs?: number;
}

export interface MarkConfirmedAction {
  type: 'mark_confirmed';
  runId: string;
  prNumber?: number;
}

export interface RedeliverAction {
  type: 'redeliver';
  runId: string;
  sessionId: string;
  prNumber: number;
  attempt: number;
  maxRedeliveries: number;
}

export interface EscalateAction {
  type: 'escalate';
  runId: string;
  sessionId: string;
  prNumber: number;
  reason: string;
  message: string;
}

export interface WaitAction {
  type: 'wait';
  runId: string;
  prNumber?: number;
  reason: string;
  remainingMs: number;
}

export type DeliveryConfirmAction =
  | MarkConfirmedAction
  | RedeliverAction
  | EscalateAction
  | WaitAction;

export declare function getReviewRunId(run: ReviewRun): string | null;
export declare function isPendingSentDeliveryRun(run: ReviewRun): boolean;
export declare function parseIsoMs(iso: string | undefined): number | null;
export declare function resolveSendObservedAtMs(run: ReviewRun, fallbackMs: number): number;
export declare function isDeliveryConfirmed(
  run: ReviewRun,
  sessions: AoSession[],
  sendObservedAtMs: number,
  allRuns: ReviewRun[],
  tracking: DeliveryTrackingState,
): boolean;
export declare function evaluateDeliveryTickInterval(input: {
  nowMs: number;
  lastTickMs?: number;
  intervalMs?: number;
}): { ok: true; intervalMs: number } | { ok: false; reason: string; intervalMs: number };
export declare function getConfirmationAnchorMs(
  record: RunDeliveryRecord,
  sendObservedAtMs: number,
): number;

export declare function resolveDeliveryConfig(config?: {
  confirmationWindowMs?: number;
  maxRedeliveries?: number;
}): { confirmationWindowMs: number; maxRedeliveries: number };
export declare function planDeliveryConfirmActions(input: {
  reviewRuns: ReviewRun[];
  sessions: AoSession[];
  tracking: DeliveryTrackingState;
  nowMs: number;
  config?: { confirmationWindowMs?: number; maxRedeliveries?: number };
}): { actions: DeliveryConfirmAction[]; tracking: DeliveryTrackingState };
export declare function buildEscalationMessage(input: {
  runId: string;
  sessionId: string;
  prNumber: number;
}): string;
export declare function findForbiddenDeliveryLifecycleCommands(
  commandLines: string[],
): Array<{ command: string; pattern: string }>;
export declare function buildReviewSendArgv(runId: string): string[];
