export declare const WORKER_RECOVERY_VERSION: string;
export declare const WORKER_RECOVERY_DEFAULT_RETRY_BUDGET: number;
export declare const WORKER_RECOVERY_DEFAULT_BACKOFF_MS: number;

export declare function canonicalizeRecoveryPath(pathValue: string): {
  ok: boolean;
  reason?: string;
  canonical?: string;
  resolved?: string;
};

export declare function deriveRecoveryClaimKey(sessionId: string, canonicalPath: string): string;

export declare function classifyWorkerSessionLiveness(session: Record<string, unknown>): {
  verdict: string;
  reason: string;
  runtimeClass?: string;
};

export declare function evaluateOwnershipEvidence(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateArtifactPreservation(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateCleanupEligibility(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluatePostClaimRevalidation(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateTriggerAdmission(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateSpawnFreshness(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateBoundedRetry(input: Record<string, unknown>): Record<string, unknown>;
export declare function parseWorktreeListPorcelain(porcelain: string): Array<Record<string, unknown>>;
export declare function parseWorktreeRemoveForceArgv(argv: string[]): Record<string, unknown>;
export declare function evaluateWorkerRecoveryGitAllow(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateRecoverySpawnRoute(input: Record<string, unknown>): Record<string, unknown>;
export declare function buildRecoveryAuditRecord(input: Record<string, unknown>): Record<string, unknown>;
