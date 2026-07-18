export declare const DEFER_NO_ISSUE_BINDING: 'no_issue_binding';
export declare const DEFER_AMBIGUOUS_ISSUE_PR_BINDING: 'ambiguous_issue_pr_binding';
export declare const DEFER_AMBIGUOUS_PR_SESSION_BINDING: 'ambiguous_pr_session_binding';
export declare const DEFER_AMBIGUOUS_SESSION_PRS: 'ambiguous_session_prs';

export type SessionPrBindingSource = 'issue_correlation' | 'none';
export type RuntimeBindingSource = 'live_prs' | 'issue_correlation';
export type LiveSessionPrBindingSource = 'prs' | 'branch' | 'issue_correlation' | 'none';

export interface OpenPr {
  number?: number;
  headRefOid?: string;
  headRefName?: string;
  head?: string;
  state?: string;
  repoSlug?: string;
  repository?: string;
  merged?: boolean;
  closed?: boolean;
}

/** AO 0.10.2 bulk session-list row used for live PR binding. */
export interface AoSession {
  name?: string;
  sessionId?: string;
  id?: string;
  role?: string;
  kind?: string;
  issue?: string | number | null;
  issueId?: string | number | null;
  issueNumber?: number | null;
  branch?: string;
  headBranch?: string;
  headRefName?: string;
  ownedHeadSha?: string;
  headRefOid?: string;
  status?: string;
  repoSlug?: string;
  prs?: unknown[];
  /** AO transport rows may contain unrelated fields; binding reads only the fields above. */
  [field: string]: unknown;
}

export interface SessionPrReference {
  repoSlug: string;
  prNumber: number;
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
  candidates?: Array<number | SessionPrReference | OpenPr>;
}

export interface PrSessionBindingResolution {
  sessionId: string | null;
  conflictingSessionIds?: string[];
  reason: string;
  failClosed: boolean;
  source?: RuntimeBindingSource | LiveSessionPrBindingSource | SessionPrBindingSource;
  deferReason?: string;
}

export interface SessionPrBindingOptions {
  headSha?: string;
  repoSlug?: string;
  openListAuthoritative?: boolean;
  /** Retired compatibility input; ignored by the implementation. */
  sessionDetail?: unknown;
}

export declare function parseSessionPrReference(value: unknown): SessionPrReference | null;
export declare function listSessionPrReferences(
  session: AoSession | null | undefined,
  options?: { repoSlug?: string },
): SessionPrReference[];
export declare function getSessionIssueNumber(session: AoSession | null | undefined): number;
/** Compatibility export; any argument is ignored and retired daemon-row aliases are never read. */
export declare function getExplicitSessionPrNumber(ignoredSession?: unknown): 0;
/** Per-session detail enrichment is retired; compatibility arguments are ignored. */
export declare function sessionDetailFromSessionGetPayload(ignoredPayload?: unknown): null;
export declare function shouldEnrichSessionDetailFromGet(ignoredSession?: unknown): false;
export declare function buildSessionDetailsById(
  ignoredSessions?: unknown,
  ignoredSessionGetsById?: unknown,
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
  options?: SessionPrBindingOptions,
): SessionPrBinding;
export declare function isEnrichedPrBinding(binding: SessionPrBinding): boolean;
export declare function sessionMatchesPrBound(
  session: AoSession | null | undefined,
  prNumber: number,
  openPrs?: OpenPr[],
  options?: SessionPrBindingOptions,
): boolean;
export declare function resolvePrOwningWorkerSessionBinding(
  sessions: AoSession[] | null | undefined,
  prNumber: number,
  openPrs?: OpenPr[],
  options?: SessionPrBindingOptions & {
    requireLive?: boolean;
    /** Retired compatibility input; ignored by the implementation. */
    sessionDetailsById?: Record<string, unknown>;
    isLive?: (session: AoSession) => boolean;
    getSessionId?: (session: AoSession) => string | null;
  },
): PrSessionBindingResolution;
