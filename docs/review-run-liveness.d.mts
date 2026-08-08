export function fingerprintRun(run: Record<string, unknown>): string;
export function findRunForReviewerSession(
  storeDir: string,
  reviewerSessionId: string,
): { path: string; run: Record<string, unknown> } | null;
