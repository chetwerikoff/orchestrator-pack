export declare const DEFER_NO_ISSUE_BINDING: 'no_issue_binding';
export declare const DEFER_AMBIGUOUS_ISSUE_PR_BINDING: 'ambiguous_issue_pr_binding';
export declare const DEFER_AMBIGUOUS_PR_SESSION_BINDING: 'ambiguous_pr_session_binding';

export type SessionPrBindingSource = 'explicit_pr' | 'display_name' | 'issue_correlation' | 'none';

export interface OpenPr {
  number?: number;
  headRefOid?: string;
  headRefName?: string;
  head?: string;
  state?: string;
}

export interface AoSession {
  name?: string;
  sessionId?: string;
  id?: string;
  role?: string;
  prNumber?: number | null;
  pr?: string | null;
  issue?: string | number | null;
  issueId?: string | number | null;
  issueNumber?: number | null;
  displayName?: string;
  branch?: string;
  headBranch?: string;
  headRefName?: string;
  ownedHeadSha?: string;
  headRefOid?: string;
  status?: string;
}

export interface SessionPrBinding {
  bound: boolean;
  prNumber: number | null;
  source: SessionPrBindingSource;
  enriched: boolean;
  deferReason?: string;
}

export interface PrSessionBindingResolution {
  sessionId: string | null;
  reason: string;
  failClosed: boolean;
  deferReason?: string;
}

export declare function getSessionIssueNumber(session: AoSession | null | undefined): number;
export declare function getExplicitSessionPrNumber(session: AoSession | null | undefined): number;
export declare function issueLinkedWorkerBranchLiterals(issueNumber: number): string[];
export declare function headRefCorrelatesToIssue(
  headRefName: string,
  issueNumber: number,
  session?: AoSession | null,
): boolean;
export declare function listIssueCorrelatedOpenPrs(
  issueNumber: number,
  openPrs?: OpenPr[],
  session?: AoSession | null,
  options?: { headSha?: string },
): OpenPr[];
export declare function resolveSessionPrBinding(
  session: AoSession | null | undefined,
  openPrs?: OpenPr[],
  options?: { headSha?: string; sessionDetail?: { displayName?: string } | null },
): SessionPrBinding;
export declare function isEnrichedPrBinding(binding: SessionPrBinding): boolean;
export declare function sessionMatchesPrBound(
  session: AoSession | null | undefined,
  prNumber: number,
  openPrs?: OpenPr[],
  options?: { headSha?: string; sessionDetail?: { displayName?: string } | null },
): boolean;
export declare function resolvePrOwningWorkerSessionBinding(
  sessions: AoSession[],
  prNumber: number,
  openPrs?: OpenPr[],
  options?: {
    headSha?: string;
    requireLive?: boolean;
    sessionDetailsById?: Record<string, { displayName?: string }>;
    isLive?: (session: AoSession) => boolean;
    getSessionId?: (session: AoSession) => string | null;
  },
): PrSessionBindingResolution;
