export type LaunchPatternId =
  | 'start-process'
  | 'pwsh-file'
  | 'pwsh-noprofile'
  | 'call-pwsh'
  | 'ps-call-op'
  | 'spawnSync'
  | 'execFileSync'
  | 'spawn'
  | 'execFile'
  | 'exec'
  | 'fork'
  | 'node-child';

export type CalleeContractSourceClass =
  | 'pack-ps1-param-block'
  | 'captured-external-help'
  | 'gh-inventory-route'
  | 'allowlist-only';

export type CoverageKind = 'validator-backed' | 'allowlist-debt';

export interface LaunchSiteHit {
  file: string;
  line: number;
  patternId: LaunchPatternId;
  lineText: string;
  classification: 'production' | 'test-excluded';
}

export interface InventoryRow {
  rowId: string;
  caller: { file: string; anchor?: string; line?: number };
  callee: { kind: string; identity: string };
  calleeContractSourceClass: CalleeContractSourceClass;
  coverageKind: CoverageKind;
  validatorId?: string;
  allowlistDebt?: { reason: string; followUpOwner: string };
  discoveryMatch?: {
    fileGlob?: string;
    file?: string;
    patternIds: LaunchPatternId[];
    line?: number;
  };
  hashPinnedSourceHash?: string;
}

export interface LaunchArgvAuditResult {
  verdict: 'PASS' | 'FAIL';
  violations: string[];
  stats: {
    totalHits: number;
    productionHits: number;
    testExcludedHits: number;
    inventoryRows: number;
  };
}

export declare const LAUNCH_IDIOM_PATTERNS: ReadonlyArray<{
  id: LaunchPatternId;
  languages: string[];
  regex: RegExp;
  lineFilter?: (line: string) => boolean;
}>;

export declare function matchesPathPattern(rel: string, patterns: string[]): boolean;
export declare function isTestExcludedFile(
  rel: string,
  testExclusions: { pathPatterns?: string[]; dedicatedTestHelperModules?: string[] },
): boolean;
export declare function isDiscoveryNoiseLine(line: string, patternId: LaunchPatternId): boolean;
export declare function listTrackedFiles(repoRoot: string): string[];
export declare function discoverLaunchSites(
  repoRoot: string,
  options?: {
    files?: string[];
    testExclusions?: { pathPatterns?: string[]; dedicatedTestHelperModules?: string[] };
  },
): LaunchSiteHit[];
export declare function loadLaunchArgvBundle(repoRoot: string): {
  inventory: {
    rows: InventoryRow[];
    hashPinnedAllowlist?: Array<{
      path: string;
      patternId: LaunchPatternId;
      sourceHash: string;
      rowId: string;
    }>;
    absorbedCoverage?: Array<{ validatorId: string; note?: string }>;
  };
  validators: { validators: Array<{ id: string; script: string }> };
  testExclusions: { pathPatterns?: string[]; dedicatedTestHelperModules?: string[] };
};
export declare function hashNormalizedBody(text: string): string;
export declare function matchDiscoveryHit(
  hit: LaunchSiteHit,
  rows: InventoryRow[],
  hashPinned?: Array<{ path: string; patternId: LaunchPatternId; sourceHash: string; rowId: string }>,
  repoRoot?: string,
): { outcome: string; rowId: string | null };
export declare function validateInventoryRows(
  bundle: ReturnType<typeof loadLaunchArgvBundle>,
  repoRoot: string,
): string[];
export declare function classifyDiscoveryHits(
  hits: LaunchSiteHit[],
  rows: InventoryRow[],
  hashPinned?: Array<{ path: string; patternId: LaunchPatternId; sourceHash: string; rowId: string }>,
  repoRoot?: string,
): { classified: Array<{ hit: LaunchSiteHit; match: ReturnType<typeof matchDiscoveryHit> }>; failures: string[] };
export declare function findOrphanInventoryRows(rows: InventoryRow[], productionHits: LaunchSiteHit[]): string[];
export declare function auditLaunchArgvInventory(
  repoRoot: string,
  options?: { repoRoot?: string },
): LaunchArgvAuditResult;
export declare function proposeCensusRows(repoRoot: string): LaunchSiteHit[];
export declare function loadTestExclusions(repoRoot: string): {
  pathPatterns?: string[];
  dedicatedTestHelperModules?: string[];
};
export declare function buildDefaultInventoryRows(repoRoot: string): InventoryRow[];
