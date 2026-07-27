export const PACK_REVIEWER_ENV = 'PACK_REVIEWER';

export const PACK_REVIEWER_VALUES = ['codex', 'claude', 'gpt'] as const;
export type PackReviewer = (typeof PACK_REVIEWER_VALUES)[number];

export const PACK_REVIEWER_WRAPPER_BY_ID: Readonly<Record<PackReviewer, string>> = {
  codex: 'run-pack-review.ps1',
  claude: 'run-pack-review-claude.ps1',
  gpt: 'run-pack-review-gpt.ts',
};

export function normalizePackReviewer(value: unknown): PackReviewer | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if ((PACK_REVIEWER_VALUES as readonly string[]).includes(normalized)) {
    return normalized as PackReviewer;
  }
  return null;
}

export function resolvePackReviewerFromEnv(env: NodeJS.ProcessEnv = process.env): PackReviewer | null {
  return normalizePackReviewer(env[PACK_REVIEWER_ENV]);
}

export function packReviewerSelectorErrorMessage(selectorValue?: string): string {
  const raw = selectorValue ?? process.env[PACK_REVIEWER_ENV] ?? '';
  if (!String(raw).trim()) {
    return 'PACK_REVIEWER is not set. Set PACK_REVIEWER to gpt, claude, or codex before running pack review (see docs/reviewer-switch-runbook.md).';
  }
  return `PACK_REVIEWER has unrecognized value '${String(raw).trim()}'. Set PACK_REVIEWER to gpt, claude, or codex.`;
}

export function packReviewWrapperBasename(reviewer: PackReviewer): string {
  return PACK_REVIEWER_WRAPPER_BY_ID[reviewer];
}
