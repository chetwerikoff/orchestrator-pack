export interface HostCheckResult {
  ok: boolean;
  error?: string;
}

export interface OverlapSummary {
  unownedCount: number;
  ownedCount: number;
  overrideCount: number;
}

export interface OverlapResult {
  ok: boolean;
  flagged: Array<Record<string, unknown>>;
  owned: Array<Record<string, unknown>>;
  overrides: Array<Record<string, unknown>>;
  summary: OverlapSummary;
}

export interface SendFinding {
  relPath: string;
  kind: string;
  mechanism?: string;
  line?: number;
  site?: string;
  pattern?: string;
}

export interface AuditRegistrationResult {
  verdict: 'PASS' | 'FAIL';
  violations: string[];
  overlap?: OverlapResult;
  sendFindings?: SendFinding[];
  host?: HostCheckResult;
}

export interface ProtectedRuntimeDiffResult {
  ok: boolean;
  violations: string[];
}

export interface CatalogValidationResult {
  ok: boolean;
  violations: string[];
}

export declare function assertSupportedHost(platform?: string, env?: NodeJS.ProcessEnv): HostCheckResult;
export declare function hashNormalizedBody(text: unknown): string;
export declare function loadRegistryBundle(repoRoot: string): Record<string, unknown>;
export declare function validateCatalog(bundle: Record<string, unknown>, repoRoot: string): CatalogValidationResult;
export declare function checkSemanticOverlaps(catalog: Record<string, unknown>, taxonomy: Record<string, unknown>, owners: Record<string, unknown>): OverlapResult;
export declare function detectRawSendsInSource(relPath: string, source: string, helpers: Record<string, unknown>, allowlistEntries?: unknown[]): SendFinding[];
export declare function auditRegistration(repoRoot: string, options?: Record<string, unknown>): AuditRegistrationResult;
export declare function generateMessageMap(catalog: Record<string, unknown>, overlapResult: OverlapResult): string;
export declare function checkProtectedRuntimeDiff(changedFiles: string[], protectedManifest: Record<string, unknown>, toolPaths?: string[]): ProtectedRuntimeDiffResult;
export declare function listChangedFiles(repoRoot: string, baseRef?: string): string[];
export declare function checkProtectedRuntimeForRepo(repoRoot: string, baseRef?: string): ProtectedRuntimeDiffResult;
export declare function normalizeAuditOutput(result: AuditRegistrationResult): string;
export declare function enumerateBaselineClassIds(): string[];
export declare function recipientKeysOverlap(a: string, b: string, taxonomy: Record<string, unknown>): boolean;
export declare function validateOverlapOverride(override: Record<string, unknown>): string[];
