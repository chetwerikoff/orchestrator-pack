import type {
  AoSession as ReconcileAoSession,
  OpenPr,
  ReviewRun as ReconcileReviewRun,
} from './review-trigger-reconcile.d.mts';

export declare const DEFAULT_GRACE_MINUTES: number;
export declare const DEFAULT_GRACE_MS: number;
export declare const GRACE_MINUTES_ENV_VAR: string;
export declare const PACK_MERGE_CONTRACT_CHECK_NAMES: readonly string[];
export declare const FALSE_STUCK_SESSION_STATUSES: ReadonlySet<string>;
export declare const BLIND_RECOVERY_FORBIDDEN: readonly RegExp[];
export declare const DELIVERY_STATE_ESCALATED: string;
export declare const DELIVERY_STATE_UNCONFIRMED: string;

export type { OpenPr };

export interface CiCheck {
  name?: string;
  state?: string;
  conclusion?: string;
  status?: string;
}

export interface ReviewRun extends ReconcileReviewRun {
  id?: string;
  linkedSessionId?: string;
}

export interface AoSession extends ReconcileAoSession {
  runtime?: string;
  reports?: Array<Record<string, unknown>>;
}

export interface GraceRecord {
  firstFalseStuckAtMs?: number;
}

export interface GraceTrackingState {
  snapshots?: Record<string, GraceRecord>;
}

export interface UnreachabilityEvidence {
  reachabilityFailed?: boolean;
  deliveryEscalated?: boolean;
  floodNotCleared?: boolean;
}

export interface ReviewReadyClassification {
  reviewReady: boolean;
  reasons: string[];
  prNumber: number;
  headSha: string;
  sessionId: string;
  readyReport: Record<string, unknown> | null;
  cleanRun: ReviewRun | null;
}

export type StuckGuardAction =
  | {
      type: 'allow_normal';
      reason: string;
      forbidImmediateLifecycle?: never;
      forbidBlindRecovery?: never;
      evidence?: never;
    }
  | {
      type: 'hold_grace';
      reason: string;
      forbidImmediateLifecycle: true;
      forbidBlindRecovery?: never;
      evidence?: never;
    }
  | {
      type: 'recycle_escalate';
      reason: string;
      forbidBlindRecovery: true;
      evidence: UnreachabilityEvidence;
      forbidImmediateLifecycle?: never;
    };

export interface StuckGuardPlanResult {
  classification: ReviewReadyClassification;
  action: StuckGuardAction;
  graceAnchorMs: number | null;
  graceDeadlineMs: number | null;
}

export declare function isRuntimeAlive(session: AoSession): boolean;
export declare function resolveGraceMs(config?: { graceMs?: number }): number;
export declare function normalizeCiState(raw: string | undefined): string;
export declare function isCiCheckSuccess(check: CiCheck): boolean;
export declare function isCiCheckPending(check: CiCheck): boolean;
export declare function isCiCheckFailure(check: CiCheck): boolean;
export declare function isMergeContractCiGreen(
  checks: CiCheck[],
  options?: { requiredCheckNames?: string[] },
): boolean;
export declare function getReportHeadSha(report: Record<string, unknown>): string;
export declare function getStoredReportHeadSha(report: Record<string, unknown>): string;
export declare function reportCoversHead(
  report: Record<string, unknown>,
  headSha: string,
  options?: { headCommittedAtMs?: number },
): boolean;
export declare function findLatestReportForHead(
  session: AoSession,
  headSha: string,
  options?: { matchStates?: ReadonlySet<string>; headCommittedAtMs?: number },
): Record<string, unknown> | null;
export declare function findLastReadyForReviewReport(
  session: AoSession,
  headSha: string,
  options?: { headCommittedAtMs?: number },
): Record<string, unknown> | null;
export declare function isCoveringCleanRun(
  run: ReviewRun,
  prNumber: number,
  headSha: string,
  sessionId: string,
): boolean;
export declare function findCoveringCleanRun(
  runs: ReviewRun[],
  prNumber: number,
  headSha: string,
  sessionId: string,
  sessions: AoSession[],
): ReviewRun | null;
export declare function graceTrackingKey(sessionId: string, headSha: string): string;
export declare function getGraceAnchorMs(
  tracking: GraceTrackingState,
  sessionId: string,
  headSha: string,
  nowMs: number,
): number;
export declare function isWithinGrace(
  anchorMs: number,
  nowMs: number,
  graceMs: number,
): boolean;
export declare function hasAffirmativeUnreachability(
  evidence: UnreachabilityEvidence,
): boolean;
export declare function classifyReviewReadySnapshot(input: {
  session: AoSession;
  openPr: OpenPr;
  reviewRuns: ReviewRun[];
  ciChecks: CiCheck[];
  sessions?: AoSession[];
}): ReviewReadyClassification;
export declare function isDeliveryEscalatedForUnreachability(input: {
  deliveryTracking?: { runs?: Record<string, { deliveryState?: string }> };
  runId: string;
}): boolean;
export declare function findBlindRecoveryViolations(
  commandLines: string[],
): Array<{ command: string; pattern: string }>;
export declare function planStuckGuardReaction(input: {
  session: AoSession;
  openPr: OpenPr;
  reviewRuns: ReviewRun[];
  ciChecks: CiCheck[];
  sessions?: AoSession[];
  tracking?: GraceTrackingState;
  unreachability?: UnreachabilityEvidence;
  nowMs: number;
  graceMs?: number;
  deliveryTracking?: { runs?: Record<string, { deliveryState?: string }> };
}): StuckGuardPlanResult;
