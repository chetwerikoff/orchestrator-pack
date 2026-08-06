export type FindingType =
  | 'scope-violation'
  | 'spec'
  | 'quality'
  | 'test'
  | 'ci'
  | 'security';

export type FindingSeverity = 'blocking' | 'non-blocking';

export type ReviewSource = 'codex-local' | 'codex-github-action' | 'gpt-browser';

export interface StructuredFinding {
  type: FindingType | string;
  code: string;
  severity: FindingSeverity | string;
  path: string | null;
  summary: string;
  details?: string;
  suggested_fix?: string;
  source: ReviewSource | string;
  signature?: string;
}

export interface PackReviewFinding {
  severity: 'error' | 'warning' | 'info';
  title: string;
  body: string;
  filePath?: string;
  category?: string;
  fingerprint?: string;
}
