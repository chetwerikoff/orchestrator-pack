export declare const SPAWN_WORKTREE_GRANT_SCHEMA_VERSION: number;
export declare const SPAWN_WORKTREE_GRANT_TTL_SECONDS: number;
export declare const AO_SPAWN_WORKTREE_SESSION_BASENAME_PATTERN: RegExp;
export declare const SPAWN_ARGV_OPTIONS_WITH_VALUE: string[];
export declare const GIT_SOURCE_SELECTING_GLOBAL_FLAGS: ReadonlySet<string>;

export interface SpawnTargetParse {
  action: string;
  targetKey: string;
  prNumber: number | null;
  issueTarget: string | null;
}

export interface GitSpawnWorktreeAddShape {
  ok: boolean;
  reason?: string;
  path?: string;
  commit?: string;
  branch?: string | null;
  detach?: boolean;
}

export interface SpawnWorktreeHeadRefAudit {
  expectedRefToken?: string;
  expectedCommitOid?: string;
  actualRefToken?: string;
  actualCommitOid?: string;
  normalizationMode?: string;
  sourceRepositoryRoot?: string;
  action?: string;
  grantId?: string;
}

export interface SpawnWorktreeGrantConsumeVerdict {
  ok: boolean;
  reason: string;
  basename?: string;
  commit?: string;
  normalizedCommitOid?: string;
  normalizationMode?: string;
  headRefAudit?: SpawnWorktreeHeadRefAudit;
  expectedRefToken?: string;
  expectedCommitOid?: string;
  actualRefToken?: string;
  actualCommitOid?: string;
}

export interface BoundaryEscapeVerdict {
  detected: boolean;
  reason: string;
  signals: string[];
}

export declare function parseSpawnTargetFromArgv(argv: string[]): SpawnTargetParse;
export declare function isAoSpawnWorktreeSessionBasename(basename: string): boolean;
export declare function evaluateSpawnWorktreeBasenameBinding(
  basename: string,
  allowedNames: string[],
): { ok: boolean; reason: string };
export declare function deriveSpawnAuthorizedWorktreeNames(parsed: SpawnTargetParse, extraAuthorizedWorktreeNames?: string[]): string[];
export declare function deriveSpawnAuthorizedWorkerBranches(
  parsed: SpawnTargetParse,
  extraAuthorizedWorktreeNames?: string[],
  extraAuthorizedWorkerBranches?: string[],
): string[];
export declare function evaluateSpawnWorktreeBranchBinding(
  branch: string,
  grant: Record<string, unknown>,
): { ok: boolean; reason: string };
export declare function gitArgvHasSourceSelectingGlobals(argv: string[]): boolean;
export declare function resolveGitRepositoryIdentity(cwd: string): {
  ok: boolean;
  reason?: string;
  identity?: string;
  showToplevel?: string;
  gitCommonDirRaw?: string;
};
export declare function resolveGitWorktreeRoot(cwd: string): {
  ok: boolean;
  reason?: string;
  worktreeRoot?: string;
};
export declare function canonicalRepositoryRootsEqual(left: string, right: string): boolean;
export declare function spawnGrantRepositoryRootsEqual(
  grantRoot: string,
  effectiveRoot: string,
): { ok: boolean; reason?: string };
export declare function parseGitSpawnWorktreeAddArgv(argv: string[]): GitSpawnWorktreeAddShape;
export declare function pathIsUnderCanonicalPrefix(candidatePath: string, prefixPath: string): boolean;
export declare function evaluateSpawnWorktreeGrantConsume(input: {
  grant?: Record<string, unknown> | null;
  argv?: string[];
  canonicalPath?: string;
  worktreesPrefix?: string;
  targetPreexists?: boolean;
  effectiveRepositoryRoot?: string;
  effectiveGitWorktreeRoot?: string;
  nowMs?: number;
}): SpawnWorktreeGrantConsumeVerdict;
export declare function buildSpawnWorktreeGrantRecord(input: {
  argv?: string[];
  grantId?: string;
  projectId?: string;
  holder?: Record<string, unknown> | null;
  extraAuthorizedWorktreeNames?: string[];
  extraAuthorizedWorkerBranches?: string[];
  expectedHeadRef?: string;
  expectedCommitOid?: string;
  expectedPrHeadOid?: string;
  expectedPrRefToken?: string;
  expectedBranch?: string | null;
  sourceRepositoryRoot?: string;
  sourceGitWorktreeRoot?: string;
  nowMs?: number;
}): { ok: boolean; reason: string; grant?: Record<string, unknown> };
export declare function evaluateBoundaryEscapeSignal(input: {
  env?: Record<string, string | undefined>;
  packScriptsDir?: string;
}): BoundaryEscapeVerdict;
