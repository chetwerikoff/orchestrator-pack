export declare const topologyArtifactRelPath: string;

export declare const FALLBACK_CLASSIFICATION: {
  DERIVED: string;
  FIXED_FALLBACK: string;
};

export interface HeavyTopologyPolicy {
  targetShardSeconds: number;
  minShardCount: number;
  maxShardCount: number;
  fallbackHeavyShardCount: number;
}

export type PrScopeMode = 'full' | 'shadow' | 'enforce';

export interface ChangedPathManifestEntry {
  status: string;
  path: string;
  previousPath?: string;
  oldMode?: string | null;
  newMode?: string | null;
  oldSha?: string | null;
  newSha?: string | null;
}

export interface ChangedPathManifest {
  version: number;
  baseSha: string;
  headSha: string;
  diffOk: boolean;
  failureReason?: string | null;
  entryCount: number;
  entries: ChangedPathManifestEntry[];
  oversized?: boolean;
}

export interface VitestPrScopeSelection {
  applicable: boolean;
  mode: PrScopeMode;
  killSwitchState: PrScopeMode;
  effectiveRunMode: 'full' | 'scoped';
  wouldRunMode: 'full' | 'scoped';
  className:
    | 'not-applicable'
    | 'test-only'
    | 'source-only'
    | 'source+test'
    | 'workflow/config'
    | 'mixed/cross-cutting'
    | 'rename/delete-only'
    | 'diff-computation-failure';
  reason: string;
  baseSha: string | null;
  headSha: string | null;
  changedEntries: ChangedPathManifestEntry[];
  changedEntryCount?: number;
  selectedHeavyFiles: string[];
  wouldSelectHeavyFiles: string[];
}

export declare const FRESH_GUARD_PROVENANCE: Set<string>;

export declare function artifactRequiresFreshnessProvenance(artifact: RuntimeHistoryArtifact | null | undefined): boolean;

export interface RuntimeHistoryArtifact {
  source?: string;
  files: Record<string, number>;
  provenance?: Record<string, string>;
  contentSha?: Record<string, string>;
  dataChangedAt?: string;
}

export interface HeavyTopologyArtifact {
  issue: number;
  heavyShardCount: number;
  heavyShardIndices: number[];
  heavyShardMatrix: number[];
  lightShardCount?: number;
  lightShardMatrix?: number[];
  fallbackClassification: string;
  targetShardSeconds: number;
  heavyLaneTotalWeightSeconds: number;
  underProvisioned: boolean;
  rawDerivedCount: number | null;
  weightInputReason: string | null;
  policy: HeavyTopologyPolicy;
  parity: { count: number; matrixLength: number };
  fullDiscoveryCount: number;
  prScope: VitestPrScopeSelection;
  oversizedOffenders: Array<{ file: string; weightSeconds: number; targetShardSeconds: number }>;
  unresolvedGuardWeights: Array<{ file: string; reason: string }>;
}

export interface HeavyTopologySuccess {
  ok: true;
  topology: HeavyTopologyArtifact;
  discovered: string[];
  fullDiscovered: string[];
  light: string[];
  heavy: string[];
  parked: string[];
  runtimeHistory: Record<string, number>;
  lanesConfig: import('./vitest-ci-lanes.mjs').LanesConfig;
  historyLoad: { state: string; path?: string; reason?: string; artifact?: RuntimeHistoryArtifact | null };
  policy: HeavyTopologyPolicy;
}

export interface HeavyTopologyFailure {
  ok: false;
  errors: string[];
  discovered?: string[];
}

export type HeavyTopologyResult = HeavyTopologySuccess | HeavyTopologyFailure;

export declare function loadRuntimeHistoryArtifact(repoRoot?: string): {
  state: 'absent' | 'present_but_unusable' | 'valid';
  path?: string;
  reason?: string;
  artifact?: RuntimeHistoryArtifact | null;
};

export declare function parseTopologyPolicy(rawConfig: Record<string, unknown>): HeavyTopologyPolicy;
export declare function validateTopologyPolicy(policy: HeavyTopologyPolicy): string[];
export declare function msToSeconds(ms: number): number;
export declare function computeFileContentSha(repoRoot: string, filePath: string): string | null;
export declare function resolveGuardWeightSeconds(
  file: string,
  artifact: RuntimeHistoryArtifact | null,
  repoRoot: string,
  options?: {
    changedFiles?: string[];
    preTopologyMeasurements?: Record<string, number>;
    parkedFiles?: string[];
  },
): { ok: true; weightSeconds: number; source: string } | { ok: false; reason: string; file: string };
export declare function findOversizedFiles(
  discovered: string[],
  artifact: RuntimeHistoryArtifact | null,
  policy: HeavyTopologyPolicy,
  repoRoot: string,
  options?: {
    changedFiles?: string[];
    preTopologyMeasurements?: Record<string, number>;
    parkedFiles?: string[];
  },
): {
  offenders: Array<{ file: string; weightSeconds: number; targetShardSeconds: number }>;
  unresolved: Array<{ file: string; reason: string }>;
};
export declare function sumHeavyLaneWeightSeconds(
  heavyFiles: string[],
  runtimeHistory: Record<string, number>,
  defaultRuntimeMs: number,
): number;
export declare function clampHeavyShardCount(
  count: number,
  policy: HeavyTopologyPolicy,
): number;
export declare function deriveHeavyShardCountFromTotal(
  heavyLaneTotalSeconds: number,
  policy: HeavyTopologyPolicy,
): { heavyShardCount: number; rawDerivedCount: number; underProvisioned: boolean };
export declare function buildHeavyShardIndices(heavyShardCount: number): number[];
export declare function buildHeavyTopology(
  repoRoot?: string,
  options?: {
    changedFiles?: string[];
    changedPathManifest?: ChangedPathManifest | null;
    preTopologyMeasurements?: Record<string, number>;
    prScopeMode?: PrScopeMode;
  },
): HeavyTopologyResult;
export declare function topologyArtifactPath(repoRoot?: string): string;
export declare function formatOversizedGuardFailures(result: HeavyTopologyResult): string[];
export declare function relativeRepoPath(repoRoot: string, absolutePath: string): string;
