export declare const DEFAULT_CONFIRMATION_WINDOW_MS: number;
export declare const DEFAULT_MAX_REDELIVERIES: number;
export declare const DEFAULT_TICK_INTERVAL_MS: number;

export declare const PENDING_SENT_DELIVERY_STATUSES: ReadonlySet<string>;
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
  deliveredFindingCount?: number;
  deliveredAt?: string | null;
  prReviewStatus?: string;
  openFindingCount?: number;
  linkedSessionId?: string;
  updatedAt?: string;
}

import type { AoSession, OpenPr } from './review-trigger-reconcile.d.mts';

export type { AoSession, OpenPr };

export interface RunDeliveryRecord {
  deliveryState?: string;
  sendObservedAtMs?: number;
  redeliveryCount?: number;
  lastRedeliveryAtMs?: number;
  escalatedAtMs?: number;
  submitCount?: number;
  lastSubmitAtMs?: number;
  submitDecisionKey?: string;
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

export interface DeferAction {
  type: 'defer';
  runId: string;
  sessionId: string;
  prNumber: number;
  reason: string;
}

export type DeliveryConfirmAction =
  | MarkConfirmedAction
  | EscalateAction
  | WaitAction
  | DeferAction;

export declare function getReviewRunId(run: ReviewRun): string | null;
export declare function isPendingSentDeliveryRun(run: ReviewRun): boolean;
export declare function parseIsoMs(iso: string | undefined): number | null;
export declare function resolveSendObservedAtMs(run: ReviewRun, fallbackMs: number): number;
export declare function sessionOwnsRunHead(
  session: AoSession,
  prNumber: number,
  targetHeadSha: string,
  openPrs?: OpenPr[],
): boolean;
export declare function isLinkedSessionLiveOwner(
  run: ReviewRun,
  sessions: AoSession[],
  openPrs?: OpenPr[],
): boolean;
export declare function linkedRunSessionsMatch(
  sessions: AoSession[],
  linkedA: string,
  linkedB: string,
): boolean;
export declare function countAmbiguousUnconfirmedPeers(
  runs: ReviewRun[],
  tracking: DeliveryTrackingState,
  target: ReviewRun,
  sessions: AoSession[],
): number;
export declare function isDeliveryConfirmed(
  run: ReviewRun,
  sessions: AoSession[],
  sendObservedAtMs: number,
  allRuns: ReviewRun[],
  tracking: DeliveryTrackingState,
  openPrs?: OpenPr[],
): boolean;
export declare function pendingDeliveredRunsLackReportReceiptSurface(
  reviewRuns: ReviewRun[],
  sessions: AoSession[],
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
  openPrs?: OpenPr[];
  tracking: DeliveryTrackingState;
  nowMs: number;
  config?: { confirmationWindowMs?: number; maxRedeliveries?: number };
  aoEvents?: Array<Record<string, unknown>>;
  floodActiveSessions?: Record<string, boolean>;
}): { actions: DeliveryConfirmAction[]; tracking: DeliveryTrackingState };
export declare function buildEscalationMessage(input: {
  runId: string;
  sessionId: string;
  prNumber: number;
}): string;
export declare function findForbiddenDeliveryLifecycleCommands(
  commandLines: string[],
): Array<{ command: string; pattern: string }>;