export declare const PR_REVIEW_STATUSES: readonly string[];
export declare const BOARD_COLUMN_STATUSES: readonly string[];
export declare const COVERED_TERMINAL_PR_REVIEW_STATUSES: ReadonlySet<string>;
export declare const IN_FLIGHT_PR_REVIEW_STATUSES: ReadonlySet<string>;
export declare const IN_FLIGHT_LATEST_RUN_STATUSES: ReadonlySet<string>;
export declare const REMOVED_REPORT_RECEIPT_SURFACES: readonly string[];
export declare const REMOVED_DECISION_STATUS_SURFACES: readonly string[];

export interface NormalizedReviewRun {
  id?: string;
  runId?: string;
  prNumber?: number;
  prUrl?: string;
  targetSha?: string;
  linkedSessionId?: string;
  projectId?: string;
  prReviewStatus?: string;
  latestRunStatus?: string;
  verdict?: string;
  deliveredAt?: string | null;
  body?: string;
  findingCount?: number;
  openFindingCount?: number;
  deliveredFindingCount?: number;
  status?: string;
  githubReviewId?: string | number | null;
  batchId?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  retryEligible?: boolean;
  retryCount?: number;
}

export declare function resolveFailureDetail(latestRun: unknown): string;
export declare function resolveNormalizedRowStatus(
  prReviewStatus: string,
  latestRunStatus: string,
): string;
export declare function deriveDeliveredFindingCount(
  latestRun: unknown,
  prReviewStatus: string,
): number;
export declare function isDeliveredChangesRequested(run: NormalizedReviewRun): boolean;
export declare function isUndeliveredChangesRequested(run: NormalizedReviewRun): boolean;
export declare function isPendingWorkerDeliveryConfirmation(run: NormalizedReviewRun): boolean;
export declare function mapEngineStateToBoardStatus(input: {
  prReviewStatus?: string;
  latestRun?: unknown;
  headSha?: string;
  entryHeadSha?: string;
}): string;
export declare function normalizePrReviewStateRow(
  entry: unknown,
  linkedSessionId?: string,
): NormalizedReviewRun | null;
export declare function flattenSessionReviewsToNormalizedRuns(
  payload: unknown,
  linkedSessionId?: string,
): NormalizedReviewRun[];
export declare function attachProjectIdToNormalizedRuns(
  runs: NormalizedReviewRun[],
  projectId: string,
): NormalizedReviewRun[];
export declare function assertNoRemovedReportReceiptSurface(value: unknown): true;
export declare function assertNoDaemonStatusDecisionRead(value: unknown): true;
