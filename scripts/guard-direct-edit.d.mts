export type GuardDecision = 'allow' | 'deny';

export type GuardRule =
  | 'fail-open'
  | 'unchanged-allowlist'
  | 'review-subtree'
  | 'draft-override'
  | 'direct-edit-override'
  | 'gated-draft'
  | 'direct-edit-deny';

export interface GuardResult {
  decision: GuardDecision;
  reason?: string;
  rule?: GuardRule;
}

export interface HookRunResult {
  exitCode: number;
  stdout: string;
  decision: GuardDecision;
  rule?: GuardRule;
  reason?: string;
}

export declare function resolveProjectRelativePath(
  filePath: string | undefined,
  projectDir: string,
): string | null;

export declare function isUnchangedAllowlisted(relativePosix: string): boolean;

export declare function isReviewSubtree(relativePosix: string): boolean;

export declare function isGatedDraftFile(relativePosix: string): boolean;

export declare function evaluateDirectEditGuard(input: {
  filePath?: string;
  projectDir?: string;
  env?: Record<string, string | undefined>;
}): GuardResult;

export declare function runHookFromStdin(
  stdin: string,
  options?: {
    projectDir?: string;
    env?: Record<string, string | undefined>;
  },
): HookRunResult;

export declare function formatDenyOutput(reason: string): string;

export declare function runCli(): Promise<number>;
