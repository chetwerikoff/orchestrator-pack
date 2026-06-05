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
): Record<string, unknown> | null;

export declare function hasReadyForReviewForHead(session: AoSession, headSha: string): boolean;

export declare function degradedCiTrackingKey(prNumber: number, headSha: string): string;

export interface HeadReadyDecision {
  eligible: boolean;
  reason: string;
  route?: string;
  ciLevel?: ReviewTriggerCiLevel;
  degradedCiAttempts?: number;
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
  planned: { prNumber?: number; headSha?: string; sessionId?: string },
  fresh: {
    openPrs?: import('./review-trigger-reconcile.d.mts').OpenPr[];
    reviewRuns?: ReviewRun[];
    sessions?: AoSession[];
    ciChecks?: CiCheck[];
    requiredCheckNames?: string[];
    requiredCheckLookupFailed?: boolean;
    degradedCiAttempts?: number;
    maxDegradedCiAttempts?: number;
  },
): PreRunHeadReadyRecheckResult;

export declare function hasStaleReadyForReviewOnOlderHead(
  session: AoSession,
  currentHeadSha: string,
): boolean;

export { hasFailedOrCancelledOnHead } from './review-trigger-reconcile.d.mts';
