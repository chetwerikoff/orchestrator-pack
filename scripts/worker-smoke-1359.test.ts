// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectRunnerPackReviewStatusFact } from './lib/pack-review-delivery.ts';
import { projectExpectedPrTarget } from './worker-smoke-run.ts';

describe('Issue #1419 trusted readiness target', () => {
  it('fails closed when an open PR is retargeted away from the repository default branch', () => {
    expect(projectExpectedPrTarget({
      state: 'open',
      base: { ref: 'release' },
    }, {
      default_branch: 'main',
    })).toEqual({
      prOpen: true,
      baseRef: 'release',
      expectedTargetRef: 'main',
      expectedTarget: false,
    });
  });

  it('accepts only an open PR whose base is the live repository default branch', () => {
    expect(projectExpectedPrTarget({
      state: 'open',
      base: { ref: 'main' },
    }, {
      default_branch: 'main',
    }).expectedTarget).toBe(true);
  });

  it('never re-admits semantic pack-review output as runner-owned input', () => {
    expect(projectRunnerPackReviewStatusFact(
      'success',
      'pack review evidence is complete for current facts',
    )).toEqual({
      hasLegitimateReview: false,
      unresolvedBlockingFinding: false,
    });
    expect(projectRunnerPackReviewStatusFact(
      'failure',
      'pack review has unresolved blocking findings',
    )).toEqual({
      hasLegitimateReview: false,
      unresolvedBlockingFinding: false,
    });
    expect(projectRunnerPackReviewStatusFact(
      'success',
      'Pack review completed with no findings.',
    )).toEqual({
      hasLegitimateReview: true,
      unresolvedBlockingFinding: false,
    });
  });
});

describe('Issue #2319 removed nested worker-smoke harness', () => {
  it('keeps only the surviving CLI operations', () => {
    const source = readFileSync(new URL('./worker-smoke-run.ts', import.meta.url), 'utf8');
    expect(source).toContain("case 'validate-plan'");
    expect(source).toContain("case 'publish'");
    expect(source).toContain("case 'delegated-readiness'");
    expect(source).toContain("case 'reconcile-direct-review'");
    expect(source).not.toContain("case 'run'");
    expect(source).not.toContain('runSmokeAttempt');
    expect(source).not.toContain('parseLatestSmokeReport');
    expect(source).not.toContain('--smoke-actor');
    expect(source).not.toContain('adapter.spawnWorker');
  });
});
