export declare const POST_RUN_RETRY_LEDGER_VERSION: string;
export declare const DEFAULT_POST_RUN_RETRY_MAX: 1;
export declare const INFRA_NO_TRUSTWORTHY_VERDICT_ESCALATION: string;
export declare const RETRY_BOUND_EXHAUSTED_REASON: string;
export declare const PRE_LAUNCH_FAILURE_CLASSES: ReadonlySet<string>;

export declare function normalizePostRunLedgerHeadSha(headSha: string): string;
export declare function postRunLedgerKey(
  prNumber: number,
  headSha: string,
  failureClass: string,
): string;
export declare function isPreLaunchFailureClass(failureClass: string): boolean;
export declare function emptyPostRunRetryLedger(
  ledger?: Record<string, unknown> | null,
): Record<string, unknown>;
export declare function recordManualOperatorRetryAudit(input?: Record<string, unknown>): {
  ledger: Record<string, unknown>;
  changed: boolean;
  entry: Record<string, unknown>;
};
export declare function applyPostRunRetryAttempt(input?: Record<string, unknown>): Record<string, unknown>;
export declare function readPostRunLedgerEntry(input?: Record<string, unknown>): {
  entry: Record<string, unknown> | null;
  autonomousAttemptCount: number;
};
