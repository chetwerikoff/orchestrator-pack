export declare function resolveSpawnDefaultBranchBaseRef(
  repoRoot: string,
  defaultBranch?: string,
): { ok: boolean; reason?: string; refToken?: string };

export declare function resolveGitCommitRefInRepo(
  repoRoot: string,
  refToken: string,
): { ok: boolean; reason?: string; commitOid?: string; refToken?: string };

export declare function commitOidsEqual(left: string, right: string): boolean;

export declare function evaluateSpawnWorktreeHeadRefAuthorization(input: {
  repoRoot?: string;
  expectedRefToken?: string;
  expectedCommitOid?: string;
  actualRefToken?: string;
}): {
  ok: boolean;
  reason: string;
  expectedRefToken?: string;
  expectedCommitOid?: string;
  actualRefToken?: string;
  actualCommitOid?: string;
  normalizedCommitOid?: string;
  normalizationMode?: string;
};

export declare function evaluateSpawnClaimPrPostCheckout(input: {
  workspaceRoot?: string;
  expectedPrHeadOid?: string;
  prNumber?: number;
  prRefToken?: string;
}): {
  ok: boolean;
  reason: string;
  prNumber?: number;
  prRefToken?: string;
  expectedPrHeadOid?: string;
  actualWorkspaceHeadOid?: string;
};

export declare function rewriteGitWorktreeAddCommitArgv(
  argv: string[],
  normalizedCommitOid: string,
): string[];
