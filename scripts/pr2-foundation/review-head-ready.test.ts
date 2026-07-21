import { describe, expect, it } from 'vitest';
import { evaluateHeadReadyForReview } from './review-head-ready.ts';

const headSha = 'a'.repeat(40);
const greenChecks = [
  { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
  { name: 'PR scope guard', state: 'SUCCESS' },
  { name: 'Run pack contract tests', state: 'SUCCESS' },
  { name: 'Self-architect lint', state: 'SUCCESS' },
];
const session = {
  id: 'worker-923',
  role: 'worker',
  status: 'working',
  ownedHeadSha: headSha,
  reports: [{ reportState: 'ready_for_review', headRefOid: headSha }],
};

describe('[AC1] TypeScript head-ready liveness contract', () => {
  it('starts review for one live exact-head handoff with all required checks green', () => {
    expect(evaluateHeadReadyForReview({
      reviewRuns: [],
      prNumber: 923,
      headSha,
      session,
      ciChecks: greenChecks,
    })).toEqual({ eligible: true, route: 'start_review', reason: 'ready_for_review' });
  });

  it('fails closed for stale ownership, missing required CI, or a covering run', () => {
    expect(evaluateHeadReadyForReview({
      reviewRuns: [],
      prNumber: 923,
      headSha,
      session: { ...session, ownedHeadSha: 'b'.repeat(40) },
      ciChecks: greenChecks,
    })).toMatchObject({ eligible: false, reason: 'worker_head_mismatch' });
    expect(evaluateHeadReadyForReview({
      reviewRuns: [],
      prNumber: 923,
      headSha,
      session,
      ciChecks: greenChecks.slice(0, 3),
    })).toMatchObject({ eligible: false, reason: 'required_ci_not_green' });
    expect(evaluateHeadReadyForReview({
      reviewRuns: [{ targetSha: headSha, status: 'reviewing' }],
      prNumber: 923,
      headSha,
      session,
      ciChecks: greenChecks,
    })).toEqual({ eligible: false, route: 'already_covered', reason: 'head_already_covered' });
  });
});
