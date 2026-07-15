export interface SupervisorHeavyLaneRpcBindingInspection {
  ok: boolean;
  reason: string;
  stalePaths: string[];
  bindingMode?: string;
  [key: string]: unknown;
}

export declare function listCurrentBindingScopePaths(repoRootOverride?: string): string[];

export declare function inspectSupervisorHeavyLaneRpcBinding(
  repoRootOverride?: string,
): SupervisorHeavyLaneRpcBindingInspection;

export declare function resolveExpectedCaptureSha(repoRootOverride?: string): string;

export declare function assertRpcMetadataCommitSha(
  commitSha: string,
  expectedCaptureSha: string,
  passId: string,
  repoRootOverride?: string,
): void;

export declare function validateSupervisorHeavyLaneRpcArtifacts(
  repoRootOverride?: string,
): { passCount: number; expectedCaptureSha: string; bindingMode: string };
