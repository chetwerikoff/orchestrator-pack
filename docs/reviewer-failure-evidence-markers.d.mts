import type { ReviewRun } from './review-trigger-reconcile.d.mts';

export declare const TIMEOUT_NO_VERDICT_FAILURE_CLASS: 'timeout_no_verdict';
export declare const REPEATED_TIMEOUT_ESCALATION_REASON: 'repeated_timeout_no_verdict';
export declare const REVIEWER_EVIDENCE_PREFIX: 'reviewer-evidence:';
export declare const DEFAULT_TIMEOUT_RETRY_MAX: 1;

export declare function resolveTimeoutRetryMax(env?: NodeJS.ProcessEnv): number;
export declare function extractReviewerEvidenceFromText(
  text: string,
): { reviewer: Record<string, unknown> } | null;
export declare function extractReviewerFailureClass(
  run: ReviewRun | null | undefined,
): string | null;
export declare function countSameHeadFailuresByClass(
  runs: ReviewRun[],
  prNumber: number,
  headSha: string,
  failureClass: string,
): number;
