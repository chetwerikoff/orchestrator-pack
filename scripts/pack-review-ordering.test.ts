// @vitest-ci-lane light

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startPackReview } from './pack-review-runner.ts';
import { listPackReviewRuns } from './lib/pack-review-run-store.ts';
import {
  assertIndependentSmokeAdmission,
  assertPackReviewSmokeAdmission,
  commitPackReviewTerminal,
  commitSmokeOrderingTransition,
  initializePackReviewAuthority,
  observePackReviewHead,
  readPackReviewAuthority,
  recordPackReviewPublication,
  type PackReviewAuthorityOptions,
} from './pack-review-state.ts';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

describe('Issue #1436 smoke/review ordering', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function authorityFixture() {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-ordering-'));
    roots.push(root);
    const options: PackReviewAuthorityOptions = { storeRoot: root };
    const authority = initializePackReviewAuthority({
      prNumber: 1436,
      headSha: HEAD,
      tier: 'T3',
      options,
    });
    return { options, authority };
  }

  it('refuses the real pack-review start before creating a run', async () => {
    const { options } = authorityFixture();
    const issueBody = [
      '```complexity-tier',
      'tier: T3',
      'advisory-prior: T3',
      '```',
      '',
      '```smoke-test-plan',
      'scenarios:',
      '  - action: exact head smoke | expected: PASS',
      '```',
    ].join('\n');
    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot: options.storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber: 1436,
      headSha: HEAD,
      fixtureCurrentPrHeadSha: HEAD,
      fixturePrState: 'OPEN',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: 1436,
      fixtureIssueBody: issueBody,
      claimMode: 'preacquired',
    });
    expect(result).toMatchObject({ ok: false, created: false, httpStatus: 409 });
    expect(String(result.reason)).toContain('smoke_ordering_worker_smoke_required');
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot: options.storeRoot })).toEqual([]);
  });

  it('refuses review until the exact-head worker-owned smoke passes', () => {
    const { options, authority } = authorityFixture();
    expect(() => assertPackReviewSmokeAdmission({ authority, headSha: HEAD }))
      .toThrow('smoke_ordering_worker_smoke_required');

    const started = commitSmokeOrderingTransition({
      prNumber: 1436,
      expectedTransitionSeq: authority.transitionSeq,
      actor: 'worker-owned',
      headSha: HEAD,
      status: 'started',
      options,
    });
    expect(() => assertPackReviewSmokeAdmission({
      authority: readPackReviewAuthority(1436, options)!,
      headSha: HEAD,
    })).toThrow('smoke_ordering_worker_smoke_required');

    const failed = commitSmokeOrderingTransition({
      prNumber: 1436,
      expectedTransitionSeq: started.transitionSeq,
      actor: 'worker-owned',
      headSha: HEAD,
      status: 'failed',
      options,
    });
    expect(() => assertPackReviewSmokeAdmission({
      authority: readPackReviewAuthority(1436, options)!,
      headSha: HEAD,
    })).toThrow('smoke_ordering_worker_smoke_required');

    commitSmokeOrderingTransition({
      prNumber: 1436,
      expectedTransitionSeq: failed.transitionSeq,
      actor: 'worker-owned',
      headSha: HEAD,
      status: 'started',
      options,
    });
    const passed = commitSmokeOrderingTransition({
      prNumber: 1436,
      expectedTransitionSeq: failed.transitionSeq + 1,
      actor: 'worker-owned',
      headSha: HEAD,
      status: 'passed',
      options,
    });
    expect(() => assertPackReviewSmokeAdmission({ authority: passed, headSha: HEAD })).not.toThrow();
  });

  it('refuses independent smoke before settled review and forbids later review', () => {
    const { options, authority } = authorityFixture();
    const started = commitSmokeOrderingTransition({
      prNumber: 1436,
      expectedTransitionSeq: authority.transitionSeq,
      actor: 'worker-owned',
      headSha: HEAD,
      status: 'started',
      options,
    });
    const workerPassed = commitSmokeOrderingTransition({
      prNumber: 1436,
      expectedTransitionSeq: started.transitionSeq,
      actor: 'worker-owned',
      headSha: HEAD,
      status: 'passed',
      options,
    });
    expect(() => assertIndependentSmokeAdmission({ authority: workerPassed, headSha: HEAD }))
      .toThrow('smoke_ordering_review_unsettled');

    const terminal = commitPackReviewTerminal({
      prNumber: 1436,
      expectedTransitionSeq: workerPassed.transitionSeq,
      terminal: {
        schemaVersion: 1,
        terminalContractVersion: 2,
        terminalSource: 'normal',
        runId: 'review-run',
        targetSha: HEAD,
        reviewVerdict: 'clean',
        findingCount: 0,
        findingsDigest: 'findings-digest',
      },
      status: 'clean',
      findingCount: 0,
      options,
    });
    const settled = recordPackReviewPublication({
      prNumber: 1436,
      expectedTransitionSeq: terminal.transitionSeq,
      publication: {
        headSha: HEAD,
        terminalRunId: 'review-run',
        status: 'succeeded',
        publicationDigest: 'publication-digest',
        recordedAtUtc: new Date().toISOString(),
      },
      options,
    });
    expect(() => assertIndependentSmokeAdmission({ authority: settled, headSha: HEAD })).not.toThrow();

    const independentStarted = commitSmokeOrderingTransition({
      prNumber: 1436,
      expectedTransitionSeq: settled.transitionSeq,
      actor: 'independent',
      headSha: HEAD,
      status: 'started',
      options,
    });
    expect(() => assertPackReviewSmokeAdmission({
      authority: independentStarted,
      headSha: HEAD,
    })).toThrow('smoke_ordering_review_forbidden');

    const independentFailed = commitSmokeOrderingTransition({
      prNumber: 1436,
      expectedTransitionSeq: independentStarted.transitionSeq,
      actor: 'independent',
      headSha: HEAD,
      status: 'failed',
      options,
    });
    const nextHead = observePackReviewHead({
      prNumber: 1436,
      expectedTransitionSeq: independentFailed.transitionSeq,
      headSha: NEXT_HEAD,
      options,
    });
    expect(() => assertIndependentSmokeAdmission({ authority: nextHead, headSha: NEXT_HEAD })).not.toThrow();
    expect(() => assertPackReviewSmokeAdmission({ authority: nextHead, headSha: NEXT_HEAD }))
      .toThrow('smoke_ordering_review_forbidden');
  });
});
