export declare const AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION: string;
export declare const TURN_VISIBLE_REAL_BINARY_ENV_VARS: readonly string[];

export interface SpawnBoundaryVerdict {
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

export declare function gitSubcommandFromArgv(argv: string[]): string;
export declare function isMutatingGitArgv(argv: string[]): boolean;
export declare function isRawSpawnInvocation(commandLine: string): boolean;
export declare function evaluateAutonomousSpawnBoundary(input: {
  commandLine?: string;
  autonomousSurface?: boolean;
}): SpawnBoundaryVerdict;
export declare function evaluateAutonomousGitBoundary(input: {
  argv?: string[];
  autonomousSurface?: boolean;
  sanctionedProvenance?: boolean;
  claimedBypass?: boolean;
  parentChain?: string[];
}): GitBoundaryVerdict;
export declare function hasSanctionedGitParentChain(
  parentChain?: string[],
  claimedBypass?: boolean,
): boolean;
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
};
export declare function validateBoundaryCapabilityInventory(input: {
  repoInventory: Array<{ id: string; classification: string }>;
  liveSurfaces?: Array<{ id: string; classification?: string }>;
}): CapabilityInventoryValidation;
