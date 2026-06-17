import type { CiCheck } from './ci-green-wake-reconcile.d.mts';

export declare const DEFAULT_RECONCILE_INTERVAL_MS: number;

export declare const IN_FLIGHT_REVIEW_STATUSES: ReadonlySet<string>;
export declare const COVERED_TERMINAL_REVIEW_STATUSES: ReadonlySet<string>;
export declare const NON_LIVE_WORKER_SESSION_STATUSES: ReadonlySet<string>;
export declare const FORBIDDEN_LIFECYCLE_PATTERNS: readonly RegExp[];

export declare const AMBIGUOUS_IMPLICIT_HEAD_OWNER_REASON: 'ambiguous_implicit_head_owner';

export declare function isLiveWorkerSession(session: AoSession): boolean;

export declare function getSessionIdentifier(session: AoSession): string | null;

export declare function collectSessionIdentifiers(
  session: AoSession | null | undefined,
): string[];

export declare function sessionMatchesIdentifier(
  session: AoSession,
  needle: string,
): boolean;

export declare function findSessionById(
  sessions: AoSession[],
  sessionId: string,
): AoSession | null;

export declare function findSessionByIdForReconcile(
  sessions: AoSession[],
  sessionId: string,
): AoSession | null;

export declare function sessionMatchesPr(session: AoSession, prNumber: number): boolean;

export interface OpenPr {
  number: number;
  headRefOid: string;
  headCommittedAt?: string | number;
  headCommitCommittedAt?: string | number;
  head_commit_committed_at?: string | number;
}

export interface ReviewRun {
  id?: string;
  runId?: string;
  prNumber?: number;
  targetSha?: string;
  status?: string;
  findingCount?: number;
  openFindingCount?: number;
  sentFindingCount?: number;
  terminationReason?: string;
  retryEligible?: boolean;
  retryCount?: number;
}

export interface WorkerReport {
  reportState?: string;
  report_state?: string;
  reportedAt?: string;
  timestamp?: string;
  createdAt?: string;
  headRefOid?: string;
  head_ref_oid?: string;
  forHeadSha?: string;
  for_head_sha?: string;
  prHeadSha?: string;
  pr_head_sha?: string;
  note?: string;
  message?: string;
  reason?: string;
  detail?: string;
  degradedCiEscalation?: boolean;
  handoffKind?: string;
}

export interface AoSession {
  name?: string;
  sessionId?: string;
  id?: string;
  role?: string;
  prNumber?: number | null;
  pr?: string | null;
  ownedHeadSha?: string;
  headRefOid?: string;
  status?: string;
  runtime?: string;
  reports?: WorkerReport[];
}

export interface StartReviewAction {
  type: 'start_review';
  prNumber: number;
  headSha: string;
  sessionId: string;
  startReason?: string;
  quiescenceBasis?: Record<string, unknown>;
  ownerCycle?: {
    repoId: string;
    cycle: Record<string, unknown>;
    isQuiescentFallback?: boolean;
  };
}

export interface NoStartDecisionRecord {
  branch: string;
  reason: string;
  primary: string;
  failedComponents: string[];
  observed: Record<string, unknown>;
}

export interface SkipReconcileAction {
  type: 'skip';
  prNumber: number;
  headSha: string;
  reason: string;
  record?: NoStartDecisionRecord;
}

export interface TrackDegradedCiAction {
  type: 'track_degraded_ci';
  prNumber: number;
  headSha: string;
  attempts: number;
  lastAttemptMs: number;
}

export interface EscalateDegradedCiAction {
  type: 'escalate_degraded_ci';
  prNumber: number;
  headSha: string;
  reason: string;
  message: string;
}

export type ReconcileAction =
  | StartReviewAction
  | SkipReconcileAction
  | TrackDegradedCiAction
  | EscalateDegradedCiAction;

export interface DegradedCiRecord {
  attempts?: number;
  lastAttemptMs?: number;
}

export interface DegradedCiTrackingState {
  degradedCi?: Record<string, DegradedCiRecord>;
}

export interface PlanReconcileInput {
  openPrs: OpenPr[];
  reviewRuns: ReviewRun[];
  sessions: AoSession[];
  ciChecksByPr?:
    | Record<string, CiCheck[]>
    | Array<{ prNumber: number; checks: CiCheck[] }>;
  requiredCheckNamesByPr?:
    | Record<string, string[]>
    | Array<{ prNumber: number; requiredCheckNames: string[] }>;
  requiredCheckLookupFailedByPr?:
    | Record<string, boolean>
    | Array<{ prNumber: number; failed: boolean }>;
  tracking?: DegradedCiTrackingState;
  nowMs?: number;
  workerDeliveries?: Array<Record<string, unknown>>;
  aoEvents?: Array<Record<string, unknown>>;
  dispatchJournal?: Record<string, Record<string, unknown>>;
  reactionMessages?: Record<string, string>;
  cycleState?: Record<string, unknown>;
  repoRoot?: string;
}

export interface ReconcilePlanResult {
  actions: ReconcileAction[];
  cycleState: Record<string, unknown>;
}

export interface ReconcileIntervalAccept {
  ok: true;
  intervalMs: number;
}

export interface ReconcileIntervalReject {
  ok: false;
  reason: 'interval_not_elapsed';
  intervalMs: number;
}

export type ReconcileIntervalResult = ReconcileIntervalAccept | ReconcileIntervalReject;

export interface ForbiddenLifecycleViolation {
  command: string;
  pattern: string;
}

export declare function normalizeSha(sha: string | undefined | null): string;

export declare function isRunCoveringHead(run: ReviewRun): boolean;

export declare function isHeadCovered(
  runs: ReviewRun[],
  prNumber: number,
  headSha: string,
): boolean;

export declare function hasFailedOrCancelledOnHead(
  runs: ReviewRun[],
  prNumber: number,
  headSha: string,
): boolean;

export declare function findFailedOrCancelledRunForHead(
  runs: ReviewRun[],
  prNumber: number,
  headSha: string,
): ReviewRun | null;

export declare function findCoveringRunForHead(
  runs: ReviewRun[],
  prNumber: number,
  headSha: string,
): ReviewRun | null;

export declare function formatDecisionRecordForLog(
  record: NoStartDecisionRecord,
): string;

export declare function resolveWorkerSessionId(
  sessions: AoSession[],
  prNumber: number,
  options?: { ownsHead?: (session: AoSession) => boolean },
): string | null;

export declare function getStoredReportHeadSha(report: Record<string, unknown>): string;
export declare function getReportHeadSha(report: Record<string, unknown>): string;
export declare function getReportTimestampMs(report: Record<string, unknown>): number;
export declare function reportCoversHead(
  report: Record<string, unknown>,
  headSha: string,
  options?: { headCommittedAtMs?: number },
): boolean;
export declare function resolveHeadCommittedAtMs(
  openPrs: OpenPr[] | OpenPr | undefined,
  prNumber: number,
): number | undefined;

export declare function sessionOwnsRunHead(
  session: AoSession,
  prNumber: number,
  headSha: string,
  openPrs?: OpenPr[],
): boolean;

export declare function listWorkersForPr(
  sessions: AoSession[],
  prNumber: number,
): AoSession[];

export declare function resolveStrictHeadOwningWorkerSession(
  sessions: AoSession[],
  prNumber: number,
  headSha: string,
  openPrs?: OpenPr[],
): {
  sessionId: string | null;
  reason: string;
  failClosed: boolean;
};

export declare function resolveReconcileEvaluationSession(
  sessions: AoSession[],
  prNumber: number,
  headSha: string,
  openPrs?: OpenPr[],
): {
  ownerResolution: {
    sessionId: string | null;
    reason: string;
    failClosed: boolean;
  };
  sessionId: string | null;
  session: AoSession | null;
};

export declare function resolveHeadOwningWorkerSessionId(
  sessions: AoSession[],
  prNumber: number,
  headSha: string,
  openPrs?: OpenPr[],
): string | null;

export declare function planReconcileActions(input: PlanReconcileInput): ReconcilePlanResult;

export declare function unwrapReconcilePlanResult(
  result: ReconcilePlanResult | ReconcileAction[],
): ReconcilePlanResult;

export declare function buildDegradedCiEscalationMessage(
  prNumber: number,
  headSha: string,
): string;

export declare function evaluateReconcileInterval(input: {
  nowMs: number;
  lastTickMs?: number;
  intervalMs?: number;
}): ReconcileIntervalResult;

export declare function findForbiddenLifecycleCommands(
  commandLines: string[],
): ForbiddenLifecycleViolation[];

export declare function buildReviewRunArgv(
  sessionId: string,
  reviewCommand: string,
): string[];
