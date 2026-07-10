export declare const manifestRelPath: string;
export declare const preMoveManifestRelPath: string;

export interface SplitManifest {
  issue: number;
  charterIssue: number;
  approvalIssue: number;
  approvalMarker: string;
  immutableApprovalCommentRef?: { issueNumber: number; commentId: number };
  preMoveBaselineSha: string;
  preMoveEnumeratedFiles: string[];
  preMoveToPostMergeMap: Record<string, string[]>;
}

export interface ApprovalValidationResult {
  ok: boolean;
  errors?: string[];
}

export interface ImmutableApprovalResult {
  ok: boolean;
  source?: string;
  reference?: string;
  marker?: string;
  enumerated?: string;
  url?: string;
  author?: string;
  permission?: string;
  reason?: string;
  mode?: 'steady-state';
}

export declare function loadSplitManifest(repoRoot?: string): SplitManifest;
export declare function loadPreMoveManifest(repoRoot?: string): { prRequiredUnion: string[] };
export declare function listPostMergeExecutionFiles(manifest?: SplitManifest): string[];
export declare function buildCoverageDeltaReport(repoRoot?: string): {
  ok: boolean;
  errors: string[];
  report?: Record<string, unknown>;
};
export declare function isAuthorizedCollaboratorPermission(permission: string | null | undefined): boolean;
export declare function isApprovedReviewState(state: string): boolean;
export declare function validateApprovalBody(body: string, manifest?: SplitManifest): ApprovalValidationResult;
export declare function parsePullRequestNumberFromEnv(env?: NodeJS.ProcessEnv): string | null;
export declare function listWriteCollaboratorLogins(
  owner: string,
  name: string,
  token: string,
): Promise<{ ok: true; logins: string[] } | { ok: false; reason: string }>;

export declare function hasEligibleNonAuthorReviewer(
  owner: string,
  name: string,
  token: string,
  prAuthor: string | null,
): Promise<{ ok: true; eligible: string[] } | { ok: false; reason: string }>;

export declare function fetchCollaboratorPermission(
  owner: string,
  name: string,
  login: string,
  token: string,
): Promise<string | null>;
export declare function resolveImmutableApproval(
  repoRoot?: string,
  options?: { fixture?: string | null },
): Promise<ImmutableApprovalResult>;
export declare function validateRollbackDocumentation(repoRoot?: string): { ok: boolean; errors: string[] };
export declare function validateRollbackOrderViolationFixture(): { ok: boolean; detected: string[] };
export declare function verifyLatestMainWallClockEvidence(
  repoRoot?: string,
  options?: { fixture?: string | null },
): Promise<{
  ok: boolean;
  mode?: string;
  reason?: string;
  mainHeadSha?: string;
  runId?: number;
  url?: string;
  ageHours?: number;
}>;

export declare function resolvePinnedImmutableApproval(manifest: WallclockSplitManifest, owner: string, name: string, token: string, options?: { prNumber?: string | null; prAuthor?: string | null }): Promise<ImmutableApprovalResult>;
