export declare const AO_REVIEW_TRIGGER_PATH: string;
export declare const AO_REVIEW_LIST_PATH: string;
export declare const AO_PROJECT_CONFIG_PATH: string;

export declare const REMOVED_AO_REVIEW_SUBCOMMANDS: ReadonlySet<string>;
export declare const IN_FLIGHT_LATEST_RUN_STATUSES: ReadonlySet<string>;

export interface ReviewTriggerInvocation {
  method: 'POST';
  path: string;
  shimArgv: string[];
}

export interface ReviewTriggerClassification {
  ok: boolean;
  httpStatus: number;
  reused: boolean;
  created: boolean;
  reviewerHandleId: string;
  reviewCount: number;
}

export interface ReviewBeforeCleanupGateResult {
  blocked: boolean;
  proceed: boolean;
  reason: string;
  httpStatus: number;
  status?: string;
  runId?: string;
  targetSha?: string;
  prNumber?: number;
}

export interface ProjectReviewerHarnessEvaluation {
  ok: boolean;
  harness: string;
  matchesExpected: boolean;
  reviewers: Array<{ harness?: string }>;
}

export interface ReviewerHarnessAbortClassification {
  abort: boolean;
  reason: string;
  harness?: string | null;
  expectedHarness?: string;
  httpStatus?: number;
  classified?: boolean;
}

export declare function buildReviewTriggerPath(sessionId: string): string;
export declare function buildReviewListPath(sessionId: string): string;
export declare function buildLegacyReviewRunArgv(sessionId: string, reviewCommand: string): string[];
export declare function buildReviewTriggerInvocation(sessionId: string): ReviewTriggerInvocation;
export declare function normalizeSha(value: unknown): string;
export declare function flattenSessionReviewsToRuns(
  payload: unknown,
  linkedSessionId?: string,
): Array<Record<string, unknown>>;
export declare function attachProjectIdToRuns(
  runs: Array<Record<string, unknown>>,
  projectId: string,
): Array<Record<string, unknown>>;
export declare function findRunningLatestRunForHead(input: {
  reviews?: unknown;
  headSha?: string;
  prNumber?: number;
}): Record<string, unknown>;
export declare function evaluateReviewBeforeCleanupGate(input: {
  listPayload?: unknown;
  headSha?: string;
  prNumber?: number;
}): ReviewBeforeCleanupGateResult;
export declare function classifyReviewTriggerResponse(
  triggerPayload: unknown,
  httpStatus: number,
): ReviewTriggerClassification;
export declare function evaluateProjectReviewerHarness(
  configPayload: unknown,
  expectedHarness?: string,
): ProjectReviewerHarnessEvaluation;
export declare function classifyReviewerHarnessAbort(
  configPayload: unknown,
  expectedHarness?: string,
): ReviewerHarnessAbortClassification;
export declare function findForbiddenLegacyReviewRunCommands(
  commandLines: string[],
): Array<{ command: string; pattern: string }>;
