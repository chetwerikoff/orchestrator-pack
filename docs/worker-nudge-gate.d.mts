export declare const WORKER_NUDGE_GATE_VERSION: string;
export declare const ATOMIC_WORKER_NUDGE_CLAIM_CAPABILITY: string;
export declare const ORCHESTRATOR_TURN_SURFACE: string;
export declare const AUTONOMOUS_SURFACE_ENV: string;
export declare const JOURNALED_SEND_INTERNAL_ENV: string;
export declare const JOURNALED_SEND_INTERNAL_CAPABILITY: string;
export declare const OPERATOR_ESCALATION_PREFIX: string;
export declare const CLASSIFIER_VERSION: string;
export declare const INTENT_CLASSES: readonly string[];
export declare const TERMINAL_CLAIM_PHASES: readonly string[];
export declare const ACTIVE_CLAIM_PHASES: readonly string[];

export declare function normalizeHeadSha(sha: string | undefined | null): string;
export declare function canonicalizeStorePath(storePath: string): string;
export declare function canonicalStoreId(storePath: string): string;
export declare function isValidJournaledSendInternalCapability(value: string | undefined | null): boolean;
export declare function evaluateClaimStoreFailure(input: Record<string, unknown>): Record<string, unknown>;
export declare function syncPrOwnershipClaimRecord(input: Record<string, unknown>): Record<string, unknown>;
export declare function resolvePrOwnerSessionForNudge(input: Record<string, unknown>): Record<string, unknown>;
export declare function resolveWorkerTargetFromPrClaim(input: Record<string, unknown>): Record<string, unknown>;
export declare function buildWorkerTarget(input: Record<string, unknown>): {
  workerTarget: string;
  targetId: string;
  targetGeneration: string;
  verifiable: boolean;
};
export declare function classifyIntent(input: Record<string, unknown>): string;
export declare function deriveCycleKey(intentClass: string, input: Record<string, unknown>): string;
export declare function buildTupleKey(input: Record<string, unknown>): Record<string, unknown>;
export declare function remapLegacy332Record(record: Record<string, unknown>): Record<string, unknown>;
export declare function buildAuditRecord(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateNudgeGate(input: Record<string, unknown>): Record<string, unknown>;
export declare function acquireClaim(input: Record<string, unknown>): Record<string, unknown>;
export declare function finalizeClaim(input: Record<string, unknown>): Record<string, unknown>;
export declare function containsRawWorkerSendInvocation(commandLine: string): boolean;
export declare function isGatedWorkerNudgeParentCommandLine(commandLine: string): boolean;
export declare function evaluateBoundary(input: Record<string, unknown>): Record<string, unknown>;
export declare function findForbiddenAutonomousWorkerSendInvocations(
  commandLines: string[],
): Array<{ commandLine: string; verdict: Record<string, unknown> }>;
export declare function evaluatePreflight(input: Record<string, unknown>): Record<string, unknown>;
export declare function loadAutonomousWorkerNudgeCapabilities(
  inventoryPath?: string,
): Record<string, unknown>;
export declare function validateCapabilityInventory(input: Record<string, unknown>): {
  ok: boolean;
  violations: string[];
};
export declare function evaluateAdoptionGate(input: Record<string, unknown>): Record<string, unknown>;
