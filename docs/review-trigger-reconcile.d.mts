import type { CiCheck } from './ci-green-wake-reconcile.d.mts';

export declare const DEFAULT_RECONCILE_INTERVAL_MS: number;

export declare const IN_FLIGHT_REVIEW_STATUSES: ReadonlySet<string>;
export declare const COVERED_TERMINAL_REVIEW_STATUSES: ReadonlySet<string>;
export declare const NON_LIVE_WORKER_SESSION_STATUSES: ReadonlySet<string>;
export declare const FORBIDDEN_LIFECYCLE_PATTERNS: readonly RegExp[];

export declare function isLiveWorkerSession(session: AoSession): boolean;

export declare function getSessionIdentifier(session: AoSession): string | null;

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
}

export interface ReviewRun {
  prNumber?: number;
  targetSha?: string;
  status?: string;
  findingCount?: number;
  openFindingCount?: number;
  sentFindingCount?: number;
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
}

export interface SkipReconcileAction {
  type: 'skip';
  prNumber: number;
  headSha: string;
  reason: string;
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

export declare function resolveWorkerSessionId(
  sessions: AoSession[],
  prNumber: number,
  options?: { ownsHead?: (session: AoSession) => boolean },
): string | null;

export declare function sessionOwnsPrHead(
  session: AoSession,
  prNumber: number,
  headSha: string,
  openPrs?: OpenPr[],
): boolean;

export declare function resolveHeadOwningWorkerSessionId(
  sessions: AoSession[],
  prNumber: number,
  headSha: string,
  openPrs?: OpenPr[],
): string | null;

export declare function planReconcileActions(input: PlanReconcileInput): ReconcileAction[];

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
