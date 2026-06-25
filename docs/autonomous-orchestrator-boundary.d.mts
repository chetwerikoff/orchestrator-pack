export declare const AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION: string;
export declare const AUTONOMOUS_SPAWN_POLICY_VERSION: string;
export declare const AUTONOMOUS_SPAWN_POLICY_RELATIVE_PATH: string;
export declare const TURN_VISIBLE_REAL_BINARY_ENV_VARS: readonly string[];

export interface SpawnBoundaryVerdict {
  allowed: boolean;
  reason: string;
}

export interface SpawnPolicyDecision {
  allowed: boolean;
  denied: boolean;
  reason: string;
  action: 'spawn-new' | 'claim-pr-resume' | 'claim-pr-malformed' | 'not-spawn' | '';
  auditLine: string;
}

export interface SpawnPolicyLoadResult {
  ok: boolean;
  reason: string;
  policy?: {
    allowSpawnNew: boolean;
    allowClaimPrResume: boolean;
  };
}

export interface ClaimPrResumeSafetyVerdict {
  allowed: boolean;
  reason: string;
}

export interface GitBoundaryVerdict {
  allowed: boolean;
  reason: string;
}

export interface TurnBypassVerdict {
  bypassPresent: boolean;
  reason: string;
  name?: string;
}

export interface BoundaryPreflightResult {
  ok: boolean;
  reason: string;
  boundaryVersion: string;
}

export interface CapabilityInventoryValidation {
  ok: boolean;
  violations: string[];
}

export declare function gitArgvDefinesAlias(argv: string[]): boolean;
export declare function gitArgvSubcommandIndex(argv: string[], startIndex?: number): number;
export declare function gitSubcommandFromArgv(argv: string[]): string;
export declare function isMutatingGitArgv(argv: string[]): boolean;
export declare function isSpawnAoArgv(argv: string[]): boolean;
export declare function isRawSpawnInvocation(commandLine: string): boolean;
export declare function hasClaimPrFlagInSpawnArgv(argv: string[]): boolean;
export declare function classifySpawnAction(
  argv: string[],
): 'spawn-new' | 'claim-pr-resume' | 'claim-pr-malformed' | 'not-spawn';
export declare function parseClaimPrNumberFromSpawnArgv(argv: string[]): number | null;
export declare function validateAutonomousSpawnPolicy(policy: unknown): SpawnPolicyLoadResult;
export declare function loadAutonomousSpawnPolicy(packRoot: string): SpawnPolicyLoadResult;
export declare function evaluateAutonomousSpawnPolicyDecision(input: {
  argv?: string[];
  autonomousSurface?: boolean;
  policyLoadOk?: boolean;
  policyLoadReason?: string;
  policy?: { allowSpawnNew: boolean; allowClaimPrResume: boolean } | null;
  claimPrResumeSafe?: boolean;
  claimPrResumeReason?: string;
}): SpawnPolicyDecision;
export declare function evaluateClaimPrResumeSafety(input: {
  prNumber?: number;
  liveOwnerPresent?: boolean;
  ownerLivenessKnown?: boolean;
  staleArtifactPresent?: boolean;
  staleArtifactKnown?: boolean;
  resumeMutexHeld?: boolean;
  concurrentAttemptLost?: boolean;
}): ClaimPrResumeSafetyVerdict;
export declare function evaluateAutonomousSpawnPolicyBoundary(input: {
  argv?: string[];
  autonomousSurface?: boolean;
  policyLoadOk?: boolean;
  policyLoadReason?: string;
  policy?: { allowSpawnNew: boolean; allowClaimPrResume: boolean } | null;
  claimPrResumeSafe?: boolean;
  claimPrResumeReason?: string;
}): SpawnPolicyDecision;
export declare function evaluateAutonomousSpawnBoundary(input: {
  commandLine?: string;
  autonomousSurface?: boolean;
  argv?: string[];
  policyLoadOk?: boolean;
  policyLoadReason?: string;
  policy?: { allowSpawnNew: boolean; allowClaimPrResume: boolean } | null;
  claimPrResumeSafe?: boolean;
  claimPrResumeReason?: string;
}): SpawnBoundaryVerdict;
export declare function evaluateAutonomousGitBoundary(input: {
  argv?: string[];
  autonomousSurface?: boolean;
  sanctionedProvenance?: boolean;
  claimedBypass?: boolean;
  parentChain?: string[];
}): GitBoundaryVerdict;
export declare function isGitArgvAoOwnedWorktreeAdd(argv: string[]): boolean;
export declare function classifySanctionedGitProvenance(
  parentChain?: string[],
  maxDepth?: number,
): 'preflight' | 'claimed_review_run' | 'review_run_worktree_command' | 'none';
export declare function hasSanctionedGitParentChain(
  parentChain?: string[],
  argv?: string[],
  claimedBypass?: boolean,
  maxDepth?: number,
): boolean;
export declare function tokenizeProcessCommandLine(commandLine: string): string[];
export declare function isSanctionedGitParentCommandLine(
  commandLine: string,
  sanctionedScripts?: string[],
): boolean;
export declare function isKnownSystemGitBinaryPath(candidatePath: string): boolean;
export declare function evaluateConfiguredGitBinaryBypass(input: {
  configuredGitPath?: string;
  packRoot?: string;
}): TurnBypassVerdict;
export declare function evaluateAbsoluteSystemGitInvocationBoundary(input: {
  commandLine?: string;
  autonomousSurface?: boolean;
  claimedBypass?: boolean;
  parentChain?: string[];
}): GitBoundaryVerdict;
export declare function evaluateTurnVisibleRealBinaryBypass(input: {
  env?: Record<string, string | undefined>;
  pathValue?: string;
}): TurnBypassVerdict;
export declare function evaluateBoundaryCapabilityPreflight(input: {
  liveCapabilities?: Array<{ id: string; classification: string }>;
}): BoundaryPreflightResult;
export declare function loadAutonomousOrchestratorBoundaryInventory(
  inventoryPath?: string,
): {
  version: string;
  boundaryVersion?: string;
  capabilities: Array<{ id: string; classification: string; path?: string }>;
  sanctionedGitParents?: string[];
  sanctionedGitParentMaxDepth?: number;
};
export declare function validateBoundaryCapabilityInventory(input: {
  repoInventory: Array<{ id: string; classification: string }>;
  liveSurfaces?: Array<{ id: string; classification?: string }>;
}): CapabilityInventoryValidation;
