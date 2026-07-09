export declare function assertRpcMetadataCommitSha(
  commitSha: string,
  head: string,
  passId: string,
  repoRootOverride?: string,
): void;

export declare function validateSupervisorHeavyLaneRpcArtifacts(
  repoRootOverride?: string,
): { passCount: number; head: string };
