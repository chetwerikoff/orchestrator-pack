import type { AoSession, OpenPr } from './review-trigger-reconcile.d.mts';

export declare const DEFAULT_POLL_WINDOW_MS: number;
export declare const DEFAULT_POLL_INTERVAL_MS: number;
export declare const MAX_POLL_WINDOW_MS: number;
export declare const ENV_POLL_WINDOW_SECONDS: string;
export declare const ENV_POLL_INTERVAL_SECONDS: string;

export declare const GATE_ACTION_SEND: 'send';
export declare const GATE_ACTION_SUPPRESS: 'suppress';
export declare const GATE_ACTION_ESCALATE: 'escalate';

export declare const LIVENESS_LIVE_HEAD_OWNING: 'live_head_owning';
export declare const LIVENESS_DRIFTED_HEAD: 'drifted_head';
export declare const LIVENESS_DEAD_TERMINATED: 'dead_terminated';

export declare const POLL_DELIVERED: 'delivered';
export declare const POLL_NOT_DELIVERED: 'not_delivered';
export declare const POLL_AMBIGUOUS: 'ambiguous';

export declare const OPERATOR_REMEDY_TEXT: string;

export type { AoSession, OpenPr };

export interface GateConfig {
  pollWindowMs: number;
  pollIntervalMs: number;
}

export interface SubmitCorrelation {
  runId?: string;
  batchId?: string;
  prNumber?: number;
  targetSha?: string;
}

export interface LatestRunRow {
  id?: string;
  batchId?: string;
  status?: string;
  verdict?: string;
  targetSha?: string;
  prUrl?: string;
}

export interface ReviewEntry {
  latestRun?: LatestRunRow;
}

export interface FindReviewEntryResult {
  ok: boolean;
  entry?: ReviewEntry;
  reason?: string;
}

export interface PollOutcome {
  outcome: string;
  reason?: string;
}

export interface LivenessClassification {
  liveness: string;
  reason?: string;
}

export interface TerminalAction {
  action: string | null;
  reason?: string;
}

export interface GatePollStepResult {
  config: GateConfig;
  elapsedMs: number;
  windowExpired: boolean;
  pollOutcome: PollOutcome;
  liveness: LivenessClassification;
  terminal: TerminalAction;
  shouldContinuePolling: boolean;
  latestRunStatus?: string;
}

export interface PostSendCompositionResult {
  terminal: string;
  reason: string;
}

export declare function resolveGateConfig(config?: Record<string, unknown>): GateConfig;
export declare function isDaemonDeliveryConfirmed(status: unknown): boolean;
export declare function isTerminalNotDelivered(status: unknown): boolean;
export declare function findReviewEntryForSubmit(
  reviews: unknown,
  submit: SubmitCorrelation,
): FindReviewEntryResult;
export declare function attributeSubmittedRun(input: {
  entry?: ReviewEntry;
  submittedRunId?: string;
  submittedBatchId?: string;
  initialObservedRunId?: string;
}): { ok: boolean; latestRun?: LatestRunRow; reason?: string };
export declare function classifyPollDatum(input: {
  latestRun?: LatestRunRow;
  attributionOk?: boolean;
  attributionReason?: string;
}): PollOutcome;
export declare function classifyWorkerLiveness(input: {
  session?: AoSession;
  openPrs?: OpenPr[];
  prNumber?: number;
  targetSha?: string;
}): LivenessClassification;
export declare function evaluateGateTerminalAction(input: {
  verdict?: string;
  pollOutcome?: PollOutcome;
  liveness?: LivenessClassification;
  windowExpired?: boolean;
}): TerminalAction;
export declare function evaluateGatePollStep(input: Record<string, unknown>): GatePollStepResult;
export declare function evaluatePostSendComposition(input: {
  explicitSendOutcome?: string;
  lateAutoDeliveryConfirmed?: boolean;
  dedupApplied?: boolean;
  dedupFailed?: boolean;
}): PostSendCompositionResult;
export declare function classifyPostSendCompositionInput(input: {
  reviews?: unknown;
  runId?: string;
  batchId?: string;
  prNumber?: number;
  targetSha?: string;
  sendSucceeded?: boolean;
}): {
  explicitSendOutcome: string;
  lateAutoDeliveryConfirmed: boolean;
};
export declare function buildGateEscalationMessage(input: {
  runId?: string;
  sessionId?: string;
  prNumber?: number;
  reason?: string;
}): string;
export declare function resolveGateConfigFromEnv(
  env?: Record<string, string | undefined>,
): GateConfig;

export declare const SUPERVISOR_PARENT_WAIT_GRACE_MS: number;
export declare function resolveSupervisorParentWaitMs(config?: Record<string, unknown>): number;
export declare function inferSupervisorChildExitFromLogs(logText: unknown): number;
