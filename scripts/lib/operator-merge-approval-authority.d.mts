export interface OperatorMergeAuthorityResult {
  allow: boolean;
  reason: string;
  approvalReason?: string;
  reviewReason?: string;
  reviewRunId?: string;
  githubReviewId?: string;
  githubReviewBodySha256?: string;
  canonicalPolicyReason?: string;
  cleanWarningReview?: boolean;
  evidenceReasons?: string[];
  pending?: Array<Record<string, unknown>>;
  classifications?: Array<Record<string, unknown>>;
  message?: string;
  approvalId?: string;
  approvedHeadSha?: string;
  approvalActor?: string;
}

export declare function resolveOperatorMergeApprovalAuthorityStoreRoot(
  input?: Record<string, unknown>,
): string;

export declare function evaluateDirectOperatorReviewSafety(
  input?: Record<string, unknown>,
): OperatorMergeAuthorityResult;

export declare function evaluateDirectOperatorMergePolicy(
  input?: Record<string, unknown>,
): OperatorMergeAuthorityResult | null;
