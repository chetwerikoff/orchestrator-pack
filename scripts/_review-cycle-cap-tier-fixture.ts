export const REVIEW_CYCLE_CAP_T1_ISSUE_BODY = '```complexity-tier\ntier: T1\n```';
export const REVIEW_CYCLE_CAP_T2_ISSUE_BODY = '```complexity-tier\ntier: T2\n```';

export function buildReviewCycleCapPriorHeadRuns(
  prNumber: number,
  priorPrefixes: string[] = ['a1', 'a2'],
) {
  return priorPrefixes.map((prefix, idx) => ({
    prNumber,
    targetSha: prefix.padEnd(40, '1'),
    status: 'changes_requested',
    openFindingCount: 1,
    completedAt: `2026-07-0${idx + 1}T00:00:00Z`,
  }));
}

export function buildReviewCycleCapCurrentHead(prefix = 'a3') {
  return prefix.padEnd(40, '1');
}

export function buildReviewCycleCapWorkerSession(prNumber: number, sessionId: string) {
  return {
    sessionId,
    role: 'worker' as const,
    prNumber,
    status: 'working' as const,
    reports: [{ reportState: 'ready_for_review' as const, reportedAt: '2026-07-03T01:00:00Z' }],
  };
}
