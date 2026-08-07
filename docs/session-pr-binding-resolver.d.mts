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

export interface RuntimeWorker {
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

export declare function getSessionIssueNumber(session: RuntimeWorker | null | undefined): number;
export declare function getExplicitSessionPrNumber(session: RuntimeWorker | null | undefined): number;
export declare function sessionDetailFromSessionGetPayload(
  payload: unknown,
): { displayName?: string } | null;
export declare function shouldEnrichSessionDetailFromGet(session: RuntimeWorker | null | undefined): boolean;
export declare function buildSessionDetailsById(
  sessions: RuntimeWorker[],
  sessionGetsById?: Record<string, unknown>,
): Record<string, { displayName?: string }>;
export declare function issueLinkedWorkerBranchLiterals(issueNumber: number): string[];
export declare function headRefCorrelatesToIssue(
  headRefName: string,
  issueNumber: number,
  session?: RuntimeWorker | null,
): boolean;
export declare function listIssueCorrelatedOpenPrs(
  issueNumber: number,
  openPrs?: OpenPr[],
  session?: RuntimeWorker | null,
  options?: { headSha?: string },
): OpenPr[];
export declare function resolveSessionPrBinding(
  session: RuntimeWorker | null | undefined,
  openPrs?: OpenPr[],
  options?: { headSha?: string; sessionDetail?: { displayName?: string } | null },
): SessionPrBinding;
export declare function isEnrichedPrBinding(binding: SessionPrBinding): boolean;
export declare function sessionMatchesPrBound(
  session: RuntimeWorker | null | undefined,
  prNumber: number,
  openPrs?: OpenPr[],
  options?: { headSha?: string; sessionDetail?: { displayName?: string } | null },
): boolean;
export declare function resolvePrOwningWorkerSessionBinding(
  sessions: RuntimeWorker[],
  prNumber: number,
  openPrs?: OpenPr[],
  options?: {
    headSha?: string;
    requireLive?: boolean;
    sessionDetailsById?: Record<string, { displayName?: string }>;
    isLive?: (session: RuntimeWorker) => boolean;
    getSessionId?: (session: RuntimeWorker) => string | null;
  },
): PrSessionBindingResolution;
