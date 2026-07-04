export declare const WORKER_RECOVERY_BRANCH_CLEANUP_VERSION: string;
export declare const DEFAULT_BRANCH_OBSERVATION_TTL_SECONDS: number;

export declare function normalizeWorkerBranchRef(branch: string): Record<string, unknown>;
export declare function parseBranchDeleteForceArgv(argv: string[]): Record<string, unknown>;
export declare function evaluateBranchObservationFreshness(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateOpenPrTriState(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateBranchRemoteState(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateReflogSurvivingWork(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateConsumedGrantLineage(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateBranchWorktreeOccupancy(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateRecoveryTaskEligibility(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateDisposableWorkerBranch(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateBranchDeletionRevalidation(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateBranchPreexistsClassification(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateWorkerRecoveryBranchGitAllow(input: Record<string, unknown>): Record<string, unknown>;
export declare function buildBranchCleanupAuditRecord(input: Record<string, unknown>): Record<string, unknown>;
