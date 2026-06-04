export declare const DEFAULT_RECONCILE_INTERVAL_MS: number;

export declare const IN_FLIGHT_REVIEW_STATUSES: ReadonlySet<string>;
export declare const COVERED_TERMINAL_REVIEW_STATUSES: ReadonlySet<string>;
export declare const FORBIDDEN_LIFECYCLE_PATTERNS: readonly RegExp[];

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

export interface AoSession {
  name?: string;
  role?: string;
  prNumber?: number | null;
  pr?: string | null;
  status?: string;
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

export type ReconcileAction = StartReviewAction | SkipReconcileAction;

export interface PlanReconcileInput {
  openPrs: OpenPr[];
  reviewRuns: ReviewRun[];
  sessions: AoSession[];
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

export declare function resolveWorkerSessionId(
  sessions: AoSession[],
  prNumber: number,
): string | null;

export declare function planReconcileActions(input: PlanReconcileInput): ReconcileAction[];

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
