export interface MockIssue {
  state: 'OPEN' | 'CLOSED';
  title: string;
  body: string;
  intentionallyResolved?: boolean;
}

export function checkPositiveOutcome(markdown: string): {
  ok: boolean;
  errors: string[];
  warnings: string[];
  behaviorKind: 'action-producing' | 'record-only' | null;
  skipped: boolean;
};

export function normalizeLiveIssue(parsed: {
  state?: string;
  stateReason?: string;
  title?: string;
  body?: string;
  closedByPullRequestsReferences?: unknown[];
}): MockIssue;

export function fetchLiveIssue(
  issueNumber: number,
  repo?: string,
): MockIssue | null;

export function resolveParkedRootIssueMap(
  blocks: Array<{ followUpIssue: string }>,
  mockIssues?: Record<string, MockIssue>,
  options?: { fetchLive?: boolean; repo?: string },
): Record<string, MockIssue>;

export function checkParkedRoot(
  markdown: string,
  mockIssues?: Record<string, MockIssue>,
): {
  ok: boolean;
  errors: string[];
  warnings: string[];
  deferralWithoutBlock: boolean;
};

export function checkRcaSpecDisciplineSurfaces(
  repoRoot: string,
  configPath?: string,
): {
  ok: boolean;
  errors: string[];
};
