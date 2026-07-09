export declare function resolveExpectedCaptureSha(repoRootOverride?: string): string;

export declare function assertRpcMetadataCommitSha(
  commitSha: string,
  expectedCaptureSha: string,
  passId: string,
  repoRootOverride?: string,
): void;

export declare function validateSupervisorHeavyLaneRpcArtifacts(
  repoRootOverride?: string,
): { passCount: number; head: string; expectedCaptureSha: string };
