// @vitest-ci-lane light
import { describe, expect, it } from 'vitest';
import {
  reconcileDirectPackReviewStatus,
  type DirectPackReviewStatusDependencies,
  type DirectPackReviewStatusOptions,
} from './direct-pack-review-status.ts';
import {
  projectRunnerPackReviewStatusFact,
  type PackReviewRequiredStatusRequest,
  type PackReviewSemanticSourceState,
} from './lib/pack-review-delivery.ts';
import type { GithubReviewSummary } from './lib/github-review-reconciliation.ts';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const OWNER = 'chetwerikoff';

function review(input: {
  id: number;
  head?: string;
  blocking?: boolean;
  actor?: string;
  marker?: boolean;
}): GithubReviewSummary {
  const head = input.head ?? H2;
  const blocking = input.blocking ?? false;
  return {
    id: input.id,
    state: 'COMMENTED',
    userLogin: input.actor ?? OWNER,
    submittedAt: `2026-08-27T00:00:0${input.id}.000Z`,
    body: input.marker === false
      ? 'ordinary comment'
      : `<!-- opk-pack-review:v1 head=${head} verdict=${blocking ? 'findings' : 'clean'} blocking=${String(blocking)} -->\nresult`,
    commitId: head,
    url: `fixture://review/${input.id}`,
  };
}

function options(overrides: Partial<DirectPackReviewStatusOptions> = {}): DirectPackReviewStatusOptions {
  return {
    repoRoot: process.cwd(),
    repoSlug: 'chetwerikoff/orchestrator-pack',
    prNumber: 1709,
    headSha: H2,
    reviewId: '2',
    reviewHeadSha: H2,
    dryRun: false,
    json: true,
    ...overrides,
  };
}

function deps(input: {
  reviews?: GithubReviewSummary[];
  currentHead?: string;
  runner?: PackReviewSemanticSourceState;
  ancestor?: (ancestor: string, descendant: string) => boolean;
} = {}): { deps: DirectPackReviewStatusDependencies; writes: PackReviewRequiredStatusRequest[] } {
  const writes: PackReviewRequiredStatusRequest[] = [];
  return {
    writes,
    deps: {
      currentHead: () => input.currentHead ?? H2,
      listReviews: async () => input.reviews ?? [review({ id: 2 })],
      isAncestor: input.ancestor ?? (() => false),
      runnerStatus: () => input.runner ?? { hasLegitimateReview: false, unresolvedBlockingFinding: false },
      writeStatus: async (request) => { writes.push(request); },
    },
  };
}

describe('Issue #1749 trusted direct pack-review bootstrap', () => {
  it('publishes success for a canonical exact-head clean review', async () => {
    const fixture = deps();
    const result = await reconcileDirectPackReviewStatus(options(), fixture.deps);
    expect(result).toMatchObject({ ok: true, skipped: false, projection: { state: 'success' } });
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]).toMatchObject({
      state: 'success',
      context: 'orchestrator-pack/pack-review',
    });
  });

  it('publishes failure for a same-head blocking review', async () => {
    const fixture = deps({ reviews: [review({ id: 2, blocking: true })] });
    const result = await reconcileDirectPackReviewStatus(options(), fixture.deps);
    expect(result).toMatchObject({ ok: true, skipped: false, projection: { state: 'failure' } });
    expect(fixture.writes[0]?.state).toBe('failure');
  });

  it('ignores stale, malformed, and non-owner submitted reviews', async () => {
    for (const fixture of [
      deps({ currentHead: H1 }),
      deps({ reviews: [review({ id: 2, marker: false })] }),
      deps({ reviews: [review({ id: 2, actor: 'someone-else' })] }),
    ]) {
      const result = await reconcileDirectPackReviewStatus(options(), fixture.deps);
      expect(result).toMatchObject({ ok: true, skipped: true });
      expect(fixture.writes).toHaveLength(0);
    }
  });

  it('does not carry a clean ancestor review across changed code', async () => {
    const fixture = deps({
      reviews: [review({ id: 1, head: H1 }), review({ id: 2 })],
      ancestor: (ancestor, descendant) => ancestor === H1 && descendant === H2,
    });
    const result = await reconcileDirectPackReviewStatus(options(), fixture.deps);
    expect(result).toMatchObject({ ok: true, skipped: false, projection: { state: 'success' } });
    expect(fixture.writes).toHaveLength(1);
  });

  it('defers ancestor-only blocker resolution to descendant worker/CI/smoke facts', async () => {
    const fixture = deps({
      reviews: [review({ id: 1, head: H1, blocking: true }), review({ id: 2 })],
      ancestor: (ancestor, descendant) => ancestor === H1 && descendant === H2,
    });
    const result = await reconcileDirectPackReviewStatus(options(), fixture.deps);
    expect(result).toMatchObject({ ok: true, skipped: true, reason: 'ancestor_blocker_requires_descendant_fix_facts' });
    expect(fixture.writes).toHaveLength(0);
  });

  it('never re-admits semantic status output as runner-owned evidence', () => {
    expect(projectRunnerPackReviewStatusFact(
      'success',
      'pack review evidence is complete for current facts',
    )).toEqual({ hasLegitimateReview: false, unresolvedBlockingFinding: false });
    expect(projectRunnerPackReviewStatusFact(
      'failure',
      'pack review has unresolved blocking findings',
    )).toEqual({ hasLegitimateReview: false, unresolvedBlockingFinding: false });
    expect(projectRunnerPackReviewStatusFact(
      'success',
      'Pack review completed with no findings.',
    )).toEqual({ hasLegitimateReview: true, unresolvedBlockingFinding: false });
  });
});
