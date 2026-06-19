import type { AoSession, ReviewRun, WorkerReport } from './review-trigger-reconcile.d.mts';
import type { CiCheck } from './ci-green-wake-reconcile.d.mts';

export declare const DEFAULT_DEGRADED_CI_MAX_ATTEMPTS: number;
export declare const DEGRADED_CI_MAX_ATTEMPTS_ENV: string;

export type ReviewTriggerCiLevel = 'green' | 'pending' | 'red' | 'degraded';

export declare function resolveMaxDegradedCiAttempts(config?: {
  maxDegradedCiAttempts?: number;
}): number;

export declare function classifyRequiredCiForReviewTrigger(
  checks: CiCheck[],
  options?: { requiredCheckNames?: string[]; requiredCheckLookupFailed?: boolean },
): ReviewTriggerCiLevel;

export declare function isWorkerDegradedCiHandoff(
  report: WorkerReport | Record<string, unknown> | null | undefined,
): boolean;

export declare function findLatestAcceptedReportForHead(
  session: AoSession,
  headSha: string,
  options?: { headCommittedAtMs?: number },
): Record<string, unknown> | null;

export type ReadyForReviewFreshnessBasis =
  | 'fresh-by-monotonic-order'
  | 'stale-only'
  | 'no-report'
  | 'ambiguous/incomplete-fail-closed';

export declare const FRESHNESS_BASIS_FRESH: 'fresh-by-monotonic-order';
export declare const FRESHNESS_BASIS_STALE_ONLY: 'stale-only';
export declare const FRESHNESS_BASIS_NO_REPORT: 'no-report';
export declare const FRESHNESS_BASIS_AMBIGUOUS: 'ambiguous/incomplete-fail-closed';

export declare function enumerateReportsInEmissionOrder(
  session: AoSession | null | undefined,
): Array<{ report: Record<string, unknown>; emissionIndex: number }> | null;

export declare function classifyReadyForReviewFreshness(
  session: AoSession | null | undefined,
  headSha: string,
  options?: { headCommittedAtMs?: number },
): {
  freshnessBasis: ReadyForReviewFreshnessBasis;
  freshHandoffReport: Record<string, unknown> | null;
  hasOlderStaleReadyReports?: boolean;
};

export declare function findFreshReadyForReviewHandoff(
  session: AoSession,
  headSha: string,
  options?: { headCommittedAtMs?: number },
): Record<string, unknown> | null;

export declare function hasReadyForReviewForHead(
  session: AoSession,
  headSha: string,
  options?: { headCommittedAtMs?: number },
): boolean;

export declare function degradedCiTrackingKey(prNumber: number, headSha: string): string;

export declare const QUIESCENCE_DEBOUNCE_MS: number;
export declare const ACTIVELY_WORKING_REPORT_STATES: ReadonlySet<string>;
export declare const ACTIVELY_WORKING_SESSION_STATUSES: ReadonlySet<string>;
export declare const QUIESCENT_HANDOFF_START_REASON: 'quiescent_worker_handoff_fallback';

export declare function parseLastActivityAgeMs(
  lastActivity: string | undefined | null,
): number | null;

export declare function mergeWorkerDeliveriesFromPlanInput(input?: {
  workerDeliveries?: Array<Record<string, unknown>>;
  aoEvents?: Array<Record<string, unknown>>;
  dispatchJournal?: Record<string, Record<string, unknown>>;
  reviewRuns?: ReviewRun[];
  reactionMessages?: Record<string, string>;
  nowMs?: number;
}): Array<Record<string, unknown>>;

export declare function hasPendingUnconsumedDelivery(
  session: AoSession,
  sessionId: string,
  workerDeliveries?: Array<Record<string, unknown>>,
): boolean;

export declare function isWorkerActivelyWorking(
  session: AoSession,
  headSha: string,
  nowMs: number,
  options?: {
    headCommittedAtMs?: number;
    debounceMs?: number;
    workerDeliveries?: Array<Record<string, unknown>>;
  },
): boolean;

export declare function evaluateWorkerQuiescenceBasis(
  session: AoSession,
  headSha: string,
  nowMs: number,
  options?: {
    headCommittedAtMs?: number;
    debounceMs?: number;
    workerDeliveries?: Array<Record<string, unknown>>;
  },
): Record<string, unknown>;

export interface OwnerResolution {
  sessionId?: string | null;
  reason?: string;
  failClosed?: boolean;
}

export declare function evaluateQuiescentHandoffFallback(input: {
  session: AoSession | null;
  headSha: string;
  nowMs: number;
  headCommittedAtMs?: number;
  workerDeliveries?: Array<Record<string, unknown>>;
  ownerResolution?: OwnerResolution | null;
}): {
  eligible: boolean;
  reason: string;
  failClosed?: boolean;
  basis?: Record<string, unknown>;
};

export interface HeadReadyDecision {
  eligible: boolean;
  reason: string;
  route?: string;
  ciLevel?: ReviewTriggerCiLevel;
  degradedCiAttempts?: number;
  quiescenceBasis?: Record<string, unknown>;
}

export declare function evaluateHeadReadyForReview(input: {
  reviewRuns: ReviewRun[];
  prNumber: number;
  headSha: string;
  session?: AoSession | null;
  ciChecks?: CiCheck[];
  requiredCheckNames?: string[];
  requiredCheckLookupFailed?: boolean;
  degradedCiAttempts?: number;
  maxDegradedCiAttempts?: number;
  headCommittedAtMs?: number;
  ownerResolution?: OwnerResolution | null;
  nowMs?: number;
  workerDeliveries?: Array<Record<string, unknown>>;
  allowFailedRetry?: boolean;
}): HeadReadyDecision;

export interface PreRunHeadReadyRecheckResult {
  emitReviewRun: boolean;
  reason: string;
  decision: HeadReadyDecision;
}

export declare function resolveCurrentPrHeadSha(
  openPrs: import('./review-trigger-reconcile.d.mts').OpenPr[] | import('./review-trigger-reconcile.d.mts').OpenPr | undefined,
  prNumber: number,
): string;

export declare function preRunHeadReadyRecheck(
  planned: {
    prNumber?: number;
    headSha?: string;
    sessionId?: string;
    startReason?: string;
  },
  fresh: {
    openPrs?: import('./review-trigger-reconcile.d.mts').OpenPr[];
    reviewRuns?: ReviewRun[];
    sessions?: AoSession[];
    ciChecks?: CiCheck[];
    requiredCheckNames?: string[];
    requiredCheckLookupFailed?: boolean;
    degradedCiAttempts?: number;
    maxDegradedCiAttempts?: number;
    nowMs?: number;
    workerDeliveries?: Array<Record<string, unknown>>;
    ownerResolution?: OwnerResolution | null;
    aoEvents?: Array<Record<string, unknown>>;
    dispatchJournal?: Record<string, Record<string, unknown>>;
    reactionMessages?: Record<string, string>;
    cycleState?: Record<string, unknown>;
    sharedCycleState?: Record<string, unknown>;
    legacyNudged?: Record<string, { sessionId?: string; sentAtMs?: number }>;
    repoRoot?: string;
  },
): PreRunHeadReadyRecheckResult;

export declare function hasStaleReadyForReviewOnOlderHead(
  session: AoSession,
  currentHeadSha: string,
  options?: { headCommittedAtMs?: number },
): boolean;

export declare const NOT_READY_COMPONENT_PRECEDENCE: readonly string[];

export declare function choosePrimaryNotReadyComponent(components: string[]): string;

export declare function resolveReportRoute(
  report: WorkerReport | Record<string, unknown> | null | undefined,
): string;

export declare function findLatestStaleReadyForReviewReport(
  session: AoSession,
  currentHeadSha: string,
  options?: { headCommittedAtMs?: number },
): Record<string, unknown> | null;

export declare function collectFailedNotReadyComponents(input: {
  session: AoSession | null;
  headSha: string;
  ciChecks?: CiCheck[];
  requiredCheckNames?: string[];
  requiredCheckLookupFailed?: boolean;
  reviewRuns?: ReviewRun[];
  prNumber: number;
  headCommittedAtMs?: number;
}): string[];

export declare function buildReportCiObserved(input: {
  prNumber: number;
  headSha: string;
  session?: AoSession | null;
  ciChecks?: CiCheck[];
  requiredCheckNames?: string[];
  requiredCheckLookupFailed?: boolean;
  headCommittedAtMs?: number;
}): Record<string, unknown>;

export declare function buildCoveredSkipObserved(
  run: ReviewRun | null,
  prNumber: number,
  headSha: string,
): Record<string, unknown>;

export declare function buildFailedCancelledObserved(
  run: ReviewRun | null,
  prNumber: number,
  headSha: string,
): Record<string, unknown>;

export interface NoStartDecisionRecord {
  branch: string;
  reason: string;
  primary: string;
  failedComponents: string[];
  observed: Record<string, unknown>;
}

export declare function buildNoStartDecisionRecord(input: {
  reason: string;
  prNumber: number;
  headSha: string;
  reviewRuns: ReviewRun[];
  session?: AoSession | null;
  ciChecks?: CiCheck[];
  requiredCheckNames?: string[];
  requiredCheckLookupFailed?: boolean;
  headCommittedAtMs?: number;
}): NoStartDecisionRecord;

export declare function formatDecisionRecordForLog(record: NoStartDecisionRecord): string;

export { hasFailedOrCancelledOnHead } from './review-trigger-reconcile.d.mts';
