import type { CiCheck } from './ci-green-wake-reconcile.d.mts';
import type {
  RuntimeWorker as ReconcileRuntimeWorker,
  ReviewRun as ReconcileReviewRun,
} from './review-trigger-reconcile.d.mts';

export interface ReviewRun extends ReconcileReviewRun {
  id?: string;
  linkedSessionId?: string;
  reviewerSessionId?: string;
  body?: string;
  deliveredAt?: string | null;
  deliveredFindingCount?: number;
  prReviewStatus?: string;
}

export type RuntimeWorker = ReconcileRuntimeWorker;

export {
  evaluateHeadReadyForReview,
  hasReadyForReviewForHead,
  preRunHeadReadyRecheck,
} from './review-head-ready.d.mts';

export {
  COVERED_TERMINAL_REVIEW_STATUSES,
  IN_FLIGHT_REVIEW_STATUSES,
  hasFailedOrCancelledOnHead,
  isHeadCovered,
  isRunCoveringHead,
  normalizeSha,
} from './review-trigger-reconcile.d.mts';

export interface StartReviewDecision {
  start: boolean;
  reason: string;
  route?: string;
}

export declare function shouldStartReviewRunOnUncoveredPath(
  runs: ReviewRun[],
  prNumber: number,
  headSha: string,
): StartReviewDecision;

export declare function shouldStartReviewRun(input: {
  reviewRuns: ReviewRun[];
  prNumber: number;
  headSha: string;
  session?: RuntimeWorker | null;
  ciChecks?: CiCheck[];
  requiredCheckNames?: string[];
  requiredCheckLookupFailed?: boolean;
  degradedCiAttempts?: number;
}): StartReviewDecision;

export interface ReviewRunRecheckDecision {
  emitReviewRun: boolean;
  reason: string;
}

export declare function evaluateReviewRunWithRecheck(input: {
  runsAtTurnStart: ReviewRun[];
  runsImmediatelyBeforeRun: ReviewRun[];
  prNumber: number;
  headSha: string;
  session?: RuntimeWorker | null;
  ciChecksAtStart?: CiCheck[];
  ciChecksBeforeRun?: CiCheck[];
  requiredCheckNamesAtStart?: string[];
  requiredCheckNamesBeforeRun?: string[];
  requiredCheckLookupFailedAtStart?: boolean;
  requiredCheckLookupFailedBeforeRun?: boolean;
}): ReviewRunRecheckDecision;

export declare function getRunLinkedSessionId(run: ReviewRun): string;

export declare function resolveSessionPrNumber(
  session: RuntimeWorker,
): { resolved: true; prNumber: number } | { resolved: false; reason: string };

export declare function resolveRunPrViaLinkedSession(
  run: ReviewRun,
  sessions: RuntimeWorker[],
):
  | { resolved: true; prNumber: number; session: RuntimeWorker; linkedId: string }
  | { resolved: false; reason: string };

export declare function hasRestoredSessionIdMismatch(
  run: ReviewRun,
  sessions: RuntimeWorker[],
): boolean;

export declare function isPrMergedOnGitHub(
  prNumber: number,
  mergedPrNumbers: Set<number> | number[] | Record<string, boolean>,
): boolean;

export interface PrNumberLessMergedDecision {
  action: string;
  terminal: boolean;
  prNumber?: number;
  reason?: string;
}

export declare function evaluatePrNumberLessMergedRun(
  run: ReviewRun,
  sessions: RuntimeWorker[],
  mergedPrNumbers: Set<number> | number[] | Record<string, boolean>,
): PrNumberLessMergedDecision;

export declare function shouldOrchestratorActOnRun(
  run: ReviewRun,
  sessions: RuntimeWorker[],
  mergedPrNumbers: Set<number> | number[] | Record<string, boolean>,
): { act: boolean; terminal?: boolean; action: string; prNumber?: number; reason?: string };
