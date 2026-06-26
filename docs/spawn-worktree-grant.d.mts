export declare const SPAWN_WORKTREE_GRANT_SCHEMA_VERSION: number;
export declare const SPAWN_WORKTREE_GRANT_TTL_SECONDS: number;
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

export interface SpawnWorktreeGrantConsumeVerdict {
  ok: boolean;
  reason: string;
  basename?: string;
  commit?: string;
}

export interface BoundaryEscapeVerdict {
  detected: boolean;
  reason: string;
  signals: string[];
}

export declare function parseSpawnTargetFromArgv(argv: string[]): SpawnTargetParse;
export declare function gitArgvHasSourceSelectingGlobals(argv: string[]): boolean;
export declare function canonicalRepositoryRootsEqual(left: string, right: string): boolean;
export declare function parseGitSpawnWorktreeAddArgv(argv: string[]): GitSpawnWorktreeAddShape;
export declare function pathIsUnderCanonicalPrefix(candidatePath: string, prefixPath: string): boolean;
export declare function evaluateSpawnWorktreeGrantConsume(input: {
  grant?: Record<string, unknown> | null;
  argv?: string[];
  canonicalPath?: string;
  worktreesPrefix?: string;
  targetPreexists?: boolean;
  effectiveRepositoryRoot?: string;
  nowMs?: number;
}): SpawnWorktreeGrantConsumeVerdict;
export declare function buildSpawnWorktreeGrantRecord(input: {
  argv?: string[];
  grantId?: string;
  projectId?: string;
  holder?: Record<string, unknown> | null;
  extraAuthorizedWorktreeNames?: string[];
  expectedHeadRef?: string;
  expectedBranch?: string | null;
  sourceRepositoryRoot?: string;
  nowMs?: number;
}): { ok: boolean; reason: string; grant?: Record<string, unknown> };
export declare function evaluateBoundaryEscapeSignal(input: {
  env?: Record<string, string | undefined>;
  packScriptsDir?: string;
}): BoundaryEscapeVerdict;
