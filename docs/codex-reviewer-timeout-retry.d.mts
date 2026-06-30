import type { ReviewRun } from './review-trigger-reconcile.d.mts';

export declare function evaluateTimeoutRetryEligibility(
  reviewRuns: ReviewRun[],
  prNumber: number,
  headSha: string,
  options?: { maxRetries?: number },
): {
  failureClass: string | null;
  retryEligible: boolean;
  escalationReason: string | null;
  timeoutFailureCount: number;
};

export declare function buildTimeoutRetryObserved(
  run: ReviewRun | null | undefined,
): Record<string, unknown>;
