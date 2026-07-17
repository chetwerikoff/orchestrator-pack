export declare const DEFER_NO_ISSUE_BINDING: 'no_issue_binding';
export declare const DEFER_AMBIGUOUS_ISSUE_PR_BINDING: 'ambiguous_issue_pr_binding';
export declare const DEFER_AMBIGUOUS_PR_SESSION_BINDING: 'ambiguous_pr_session_binding';
export declare const DEFER_AMBIGUOUS_SESSION_PRS: 'ambiguous_session_prs';

export type SessionPrBindingSource = 'issue_correlation' | 'none';
export type LiveSessionPrBindingSource = 'prs' | 'branch' | 'issue_correlation' | 'none';
export type RuntimeBindingSource = 'live_prs' | 'issue_correlation';

export interface OpenPr {
  number?: number;
  headRefOid?: string;
  headRefName?: string;
  head?: string;
  state?: string;
  repoSlug?: string;
  repository?: string;
}

export interface AoSession {
  name?: string;
  sessionId?: string;
  id?: string;
  role?: string;
  kind?: string;
  /** @deprecated AO bulk rows do not produce this binding field. */
  prNumber?: number | null;
  /** @deprecated AO bulk rows do not produce this binding field. */
  pr?: string | null;
  issue?: string | number | null;
  issueId?: string | number | null;
  issueNumber?: number | null;
  /** @deprecated Not a PR binding signal. */
  displayName?: string;
  branch?: string;
  headBranch?: string;
  headRefName?: string;
  ownedHeadSha?: string;
  headRefOid?: string;
  status?: string;
  repoSlug?: string;
  prs?: unknown[];
}

export interface SessionPrReference {
  prNumber: number;
  repoSlug?: string;
  url?: string;
}

export interface SessionPrBinding {
  bound: boolean;
  prNumber: number | null;
  source: SessionPrBindingSource;
  bindingSource?: RuntimeBindingSource;
  enriched: boolean;
  liveSource?: LiveSessionPrBindingSource;
  trustRank?: number;
  repoSlug?: string;
  deferReason?: string;
  diagnostic?: string;
  candidates?: Array<number | SessionPrReference>;
}

export interface PrSessionBindingResolution {
  sessionId: string | null;
  conflictingSessionIds?: string[];
  reason: string;
  failClosed: boolean;
  source?: RuntimeBindingSource | LiveSessionPrBindingSource;
  deferReason?: string;
}

export declare function getSessionIssueNumber(session: AoSession | null | undefined): number;
export declare function getExplicitSessionPrNumber(session: AoSession | null | undefined): number;
export declare function sessionDetailFromSessionGetPayload(payload: unknown): null;
export declare function shouldEnrichSessionDetailFromGet(session: AoSession | null | undefined): false;
export declare function buildSessionDetailsById(
  sessions?: AoSession[],
  sessionGetsById?: Record<string, unknown>,
): Record<string, never>;
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
  options?: { headSha?: string; repoSlug?: string },
): OpenPr[];
export declare function resolveSessionPrBinding(
  session: AoSession | null | undefined,
  openPrs?: OpenPr[],
  options?: { headSha?: string; repoSlug?: string; openListAuthoritative?: boolean },
): SessionPrBinding;
export declare function isEnrichedPrBinding(binding: SessionPrBinding): boolean;
export declare function sessionMatchesPrBound(
  session: AoSession | null | undefined,
  prNumber: number,
  openPrs?: OpenPr[],
  options?: { headSha?: string; repoSlug?: string; openListAuthoritative?: boolean },
): boolean;
export declare function resolvePrOwningWorkerSessionBinding(
  sessions: AoSession[],
  prNumber: number,
  openPrs?: OpenPr[],
  options?: {
    headSha?: string;
    repoSlug?: string;
    openListAuthoritative?: boolean;
    requireLive?: boolean;
    sessionDetailsById?: Record<string, unknown>;
    isLive?: (session: AoSession) => boolean;
    getSessionId?: (session: AoSession) => string | null;
  },
): PrSessionBindingResolution;
