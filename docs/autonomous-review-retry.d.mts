import type { ReviewRun } from './review-trigger-reconcile.d.mts';

export declare const TIMEOUT_NO_VERDICT_FAILURE_CLASS: 'timeout_no_verdict';
export declare const REPEATED_TIMEOUT_ESCALATION_REASON: 'repeated_timeout_no_verdict';
export declare const REVIEWER_EVIDENCE_PREFIX: 'reviewer-evidence:';
export declare const DEFAULT_POST_RUN_RETRY_MAX: 1;
export declare const DEFAULT_TIMEOUT_RETRY_MAX: 1;
export declare const FAILURE_CLASS_UNKNOWN: 'unknown';
export declare const FAILURE_CLASS_EMPTY_OUTPUT: 'empty_output';
export declare const FAILURE_CLASS_MALFORMED_OUTPUT: 'malformed_output';
export declare const FAILURE_CLASS_AUTH_FAILURE: 'auth_failure';
export declare const FAILURE_CLASS_QUOTA_EXCEEDED: 'quota_exceeded';
export declare const FAILURE_CLASS_USAGE_LIMIT: 'usage_limit';
export declare const FAILURE_CLASS_CONFIG_ERROR: 'config_error';
export declare const FAILURE_CLASS_DEPENDENCY_MISSING: 'dependency_missing';
export declare const FAILURE_CLASS_REVIEWER_PROCESS_CRASH: 'reviewer_process_crash';
export declare const FAILURE_CLASS_WORKSPACE_PREFLIGHT_TRANSIENT: 'workspace_preflight_transient';

export declare const RECOVERABLE_POST_RUN_FAILURE_CLASSES: ReadonlySet<string>;
export declare const NON_RETRYABLE_POST_RUN_FAILURE_CLASSES: ReadonlySet<string>;

export declare function resolveTimeoutRetryMax(env?: NodeJS.ProcessEnv): number;
export declare function extractReviewerEvidenceFromText(
  text: string,
): { reviewer: Record<string, unknown> } | null;
export declare function extractTerminationFailureClass(
  run: ReviewRun | null | undefined,
): string | null;
export declare function extractFailureClassFromArtifact(
  artifact: Record<string, unknown> | null | undefined,
): string | null;
export declare function validateSidecarJoin(
  run: ReviewRun,
  artifact: Record<string, unknown> | null | undefined,
  pointer?: Record<string, unknown> | null,
  allRuns?: ReviewRun[],
): { ok: boolean; reason?: string };
export declare function classifyPostRunFailure(
  run: ReviewRun,
  evidence?: Record<string, unknown>,
): { failureClass: string; source: string };
export declare function enrichReviewRun(
  run: ReviewRun,
  options?: Record<string, unknown>,
): ReviewRun & Record<string, unknown>;
export declare function enrichReviewRuns(
  runs: ReviewRun[],
  options?: Record<string, unknown>,
): Array<ReviewRun & Record<string, unknown>>;
export declare function buildEvidenceByRunIdFromStore(
  storeDir: string,
  runs: ReviewRun[],
): Record<string, { artifact?: Record<string, unknown>; pointer?: Record<string, unknown> }>;
export declare function countSameHeadFailuresByClass(
  runs: ReviewRun[],
  prNumber: number,
  headSha: string,
  failureClass: string,
): number;
export declare function evaluatePostRunRetryDecision(
  run: ReviewRun | null | undefined,
  reviewRuns: ReviewRun[],
  prNumber: number,
  headSha: string,
  options?: Record<string, unknown>,
): {
  failureClass: string | null;
  retryEligible: boolean;
  escalationReason: string | null;
  failureCount: number;
  maxRetries?: number;
  preLaunchOwnedBy516?: boolean;
};
export declare function resolveFailedRunRetryEligibility(
  run: ReviewRun | null | undefined,
  reviewRuns: ReviewRun[],
  prNumber: number,
  headSha: string,
  options?: Record<string, unknown>,
): {
  failureClass: string | null;
  retryEligible: boolean;
  escalationReason: string | null;
  timeoutFailureCount: number;
  failureCount: number;
};
export declare function shouldRouteNeedsTriageToSend(
  reviewRuns: ReviewRun[],
  prNumber: number,
  headSha: string,
): boolean;

export {
  INFRA_NO_TRUSTWORTHY_VERDICT_ESCALATION,
  isPreLaunchFailureClass,
  POST_RUN_RETRY_LEDGER_VERSION,
} from './post-run-retry-ledger.d.mts';
