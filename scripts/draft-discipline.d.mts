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
