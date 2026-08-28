// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startPackReview } from './pack-review-runner.ts';
import { listPackReviewRuns } from './lib/pack-review-run-store.ts';
import {
  assertIndependentSmokeAdmission,
  assertPackReviewSmokeAdmission,
  commitPackReviewTriage,
  commitPackReviewTerminal,
  commitSmokeOrderingTransition,
  initializePackReviewAuthority,
  observePackReviewHead,
  readPackReviewAuthority,
  recordPackReviewPublication,
  reconcilePackReviewTier,
  smokeOrderingRequired,
  type PackReviewAuthorityDocument,
  type PackReviewAuthorityOptions,
  type PackReviewStartConsumptionRecord,
} from './pack-review-state.ts';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const REGRESSION_PR = 1799;
const REGRESSION_HEAD = '61f8745a0f5d8cdf7c9e79591ffa7e50e60bf13d';

describe('Issue #1436 smoke/review ordering', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function authorityFixture(tier: 'T1' | 'T2' | 'T3' = 'T3') {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-ordering-'));
    roots.push(root);
    const options: PackReviewAuthorityOptions = { storeRoot: root };
    const authority = initializePackReviewAuthority({
      prNumber: 1436,
      headSha: HEAD,
      tier,
      options,
    });
    return { options, authority };
  }

  it('requires the operator-only signal for independent smoke after worker-owned pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-ordering-regression-'));
    roots.push(root);
    const options: PackReviewAuthorityOptions = { storeRoot: root };
    const authority = initializePackReviewAuthority({
      prNumber: REGRESSION_PR,
      headSha: REGRESSION_HEAD,
      tier: 'T3',
      options,
    });
    const started = commitSmokeOrderingTransition({
      prNumber: REGRESSION_PR,
      expectedTransitionSeq: authority.transitionSeq,
      actor: 'worker-owned',
      headSha: REGRESSION_HEAD,
      status: 'started',
      options,
    });
    const workerPassed = commitSmokeOrderingTransition({
      prNumber: REGRESSION_PR,
      expectedTransitionSeq: started.transitionSeq,
      actor: 'worker-owned',
      headSha: REGRESSION_HEAD,
      status: 'passed',
      options,
    });

    expect(() => assertIndependentSmokeAdmission({
      authority: workerPassed,
      headSha: REGRESSION_HEAD,
      reviewRuns: [],
    })).toThrow('smoke_ordering_review_unsettled');
    expect(() => assertIndependentSmokeAdmission({
      authority: workerPassed,
      headSha: REGRESSION_HEAD,
      reviewRuns: [],
      operatorSmokeOnly: true,
    })).not.toThrow();
    expect(() => commitSmokeOrderingTransition({
      prNumber: REGRESSION_PR,
      expectedTransitionSeq: workerPassed.transitionSeq,
      actor: 'independent',
      headSha: REGRESSION_HEAD,
      status: 'started',
      reviewRuns: [],
      operatorSmokeOnly: true,
      options,
    })).not.toThrow();

    const separateRoot = mkdtempSync(join(tmpdir(), 'pack-review-ordering-regression-'));
    roots.push(separateRoot);
    const separateOptions: PackReviewAuthorityOptions = { storeRoot: separateRoot };
    const separateAuthority = initializePackReviewAuthority({
      prNumber: REGRESSION_PR,
      headSha: REGRESSION_HEAD,
      tier: 'T3',
      options: separateOptions,
    });
    expect(() => assertIndependentSmokeAdmission({
      authority: separateAuthority,
      headSha: REGRESSION_HEAD,
      reviewRuns: [],
      operatorSmokeOnly: true,
    })).toThrow('smoke_ordering_review_unsettled');
  });

  it('runs the real pack-review before any worker-owned smoke and settles independent-smoke admission', async () => {
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
      fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => undefined,
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      claimMode: 'preacquired',
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot: options.storeRoot })).toHaveLength(1);
    const finalAuthority = readPackReviewAuthority(1436, options)!;
    expect(finalAuthority.cycle?.reviewStageComplete).toBe(true);
    expect(finalAuthority.smokeOrdering?.independent).toBeUndefined();
    expect(() => assertIndependentSmokeAdmission({ authority: finalAuthority, headSha: HEAD, reviewRuns: [] })).not.toThrow();
  });

  it('settles a production non-blocking review for independent-smoke admission', async () => {
    const { options, authority } = authorityFixture();
    const started = commitSmokeOrderingTransition({
      prNumber: 1436,
      expectedTransitionSeq: authority.transitionSeq,
      actor: 'worker-owned',
      headSha: HEAD,
      status: 'started',
      options,
    });
    commitSmokeOrderingTransition({
      prNumber: 1436,
      expectedTransitionSeq: started.transitionSeq,
      actor: 'worker-owned',
      headSha: HEAD,
      status: 'passed',
      options,
    });
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
      fixtureReviewStdout: JSON.stringify({
        verdict: 'findings',
        findingCount: 1,
        findings: [{ severity: 'warning', title: 'non-blocking fixture finding' }],
      }),
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => undefined,
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      claimMode: 'preacquired',
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const finalAuthority = readPackReviewAuthority(1436, options)!;
    expect(finalAuthority.terminal?.reviewStatus).toBe('commented');
    expect(() => assertIndependentSmokeAdmission({ authority: finalAuthority, headSha: HEAD, reviewRuns: [] })).not.toThrow();
  });

  it('does not gate review admission on worker-owned smoke state', () => {
    const { options, authority } = authorityFixture();
    expect(() => assertPackReviewSmokeAdmission({ authority, headSha: HEAD })).not.toThrow();

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
    })).not.toThrow();

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
    })).not.toThrow();

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
    expect(() => assertIndependentSmokeAdmission({ authority: workerPassed, headSha: HEAD, reviewRuns: [] }))
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
    expect(() => assertIndependentSmokeAdmission({ authority: settled, headSha: HEAD, reviewRuns: [] })).not.toThrow();

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
    expect(() => assertIndependentSmokeAdmission({ authority: nextHead, headSha: NEXT_HEAD, reviewRuns: [] })).not.toThrow();
    expect(() => assertPackReviewSmokeAdmission({ authority: nextHead, headSha: NEXT_HEAD }))
      .toThrow('smoke_ordering_review_forbidden');
  });

  it('invalidates a settled review marker when the head changes before independent smoke', () => {
    const { options, authority } = authorityFixture();
    const terminal = commitPackReviewTerminal({
      prNumber: 1436,
      expectedTransitionSeq: authority.transitionSeq,
      terminal: {
        schemaVersion: 1,
        terminalContractVersion: 2,
        terminalSource: 'normal',
        runId: 'clean-before-head-shift',
        targetSha: HEAD,
        reviewVerdict: 'clean',
        findingCount: 0,
        findingsDigest: 'findings-digest',
      },
      status: 'up_to_date',
      findingCount: 0,
      options,
    });
    const settled = recordPackReviewPublication({
      prNumber: 1436,
      expectedTransitionSeq: terminal.transitionSeq,
      publication: {
        headSha: HEAD,
        terminalRunId: 'clean-before-head-shift',
        status: 'succeeded',
        publicationDigest: 'publication-digest',
        recordedAtUtc: new Date().toISOString(),
      },
      options,
    });
    expect(settled.smokeOrdering?.reviewSettledHeadSha).toBe(HEAD);
    const nextHead = observePackReviewHead({
      prNumber: 1436,
      expectedTransitionSeq: settled.transitionSeq,
      headSha: NEXT_HEAD,
      options,
    });
    expect(nextHead.smokeOrdering?.reviewSettledHeadSha).toBeUndefined();
    expect(() => assertIndependentSmokeAdmission({ authority: nextHead, headSha: NEXT_HEAD, reviewRuns: [] }))
      .toThrow('smoke_ordering_review_unsettled');
  });

  it('admits independent smoke when a consumed failed start survives only in the run store', () => {
    const { options, authority } = authorityFixture('T2');
    const openedAtUtc = authority.cycle!.openedAtUtc;
    const consumedReviewStart = [{
      prNumber: 1436,
      status: 'failed',
      automaticBudgetDisposition: 'consume',
      createdAt: openedAtUtc,
    }];

    expect(() => assertIndependentSmokeAdmission({ authority, headSha: HEAD, reviewRuns: [] }))
      .toThrow('smoke_ordering_review_unsettled');

    const sameHead = observePackReviewHead({
      prNumber: 1436,
      expectedTransitionSeq: authority.transitionSeq,
      headSha: HEAD,
      options,
      reviewRuns: consumedReviewStart,
    });
    expect(sameHead.cycle?.reviewStageComplete).toBe(true);
    expect(() => assertIndependentSmokeAdmission({
      authority: sameHead,
      headSha: HEAD,
      reviewRuns: consumedReviewStart,
    })).not.toThrow();

    const nextHead = observePackReviewHead({
      prNumber: 1436,
      expectedTransitionSeq: sameHead.transitionSeq,
      headSha: NEXT_HEAD,
      options,
      reviewRuns: consumedReviewStart,
    });
    expect(nextHead.cycle?.reviewStageComplete).toBe(true);
    expect(() => assertIndependentSmokeAdmission({
      authority: nextHead,
      headSha: NEXT_HEAD,
      reviewRuns: consumedReviewStart,
    })).not.toThrow();
  });

  it.each(['up_to_date', 'commented'] as const)(
    'settles a successful non-blocking %s review for independent smoke',
    (status) => {
      const { options, authority } = authorityFixture();
      const terminal = commitPackReviewTerminal({
        prNumber: 1436,
        expectedTransitionSeq: authority.transitionSeq,
        terminal: {
          schemaVersion: 1,
          terminalContractVersion: 2,
          terminalSource: 'normal',
          runId: `non-blocking-${status}`,
          targetSha: HEAD,
          reviewVerdict: status === 'up_to_date' ? 'clean' : 'findings',
          findingCount: status === 'up_to_date' ? 0 : 1,
          findingsDigest: 'findings-digest',
        },
        status,
        findingCount: status === 'up_to_date' ? 0 : 1,
        options,
      });
      const settled = recordPackReviewPublication({
        prNumber: 1436,
        expectedTransitionSeq: terminal.transitionSeq,
        publication: {
          headSha: HEAD,
          terminalRunId: `non-blocking-${status}`,
          status: 'succeeded',
          publicationDigest: 'publication-digest',
          recordedAtUtc: new Date().toISOString(),
        },
        options,
      });
      expect(() => assertIndependentSmokeAdmission({ authority: settled, headSha: HEAD, reviewRuns: [] })).not.toThrow();
    },
  );

  it.each(['failed', 'error', 'changes_requested'] as const)(
    'admits independent smoke after a consumed %s review across a head update',
    (status) => {
      const { options, authority } = authorityFixture();
      const terminal = commitPackReviewTerminal({
        prNumber: 1436,
        expectedTransitionSeq: authority.transitionSeq,
        terminal: {
          schemaVersion: 1,
          terminalContractVersion: 2,
          terminalSource: 'normal',
          runId: `consumed-${status}`,
          targetSha: HEAD,
          reviewVerdict: 'findings',
          findingCount: status === 'changes_requested' ? 1 : 0,
          findingsDigest: 'findings-digest',
        },
        status,
        findingCount: status === 'changes_requested' ? 1 : 0,
        options,
      });
      const settled = recordPackReviewPublication({
        prNumber: 1436,
        expectedTransitionSeq: terminal.transitionSeq,
        publication: {
          headSha: HEAD,
          terminalRunId: `consumed-${status}`,
          status: 'succeeded',
          publicationDigest: 'publication-digest',
          recordedAtUtc: new Date().toISOString(),
        },
        options,
      });
      const nextHead = observePackReviewHead({
        prNumber: 1436,
        expectedTransitionSeq: settled.transitionSeq,
        headSha: NEXT_HEAD,
        options,
      });

      expect(nextHead.cycle?.reviewStageComplete).toBeUndefined();
      expect(() => assertIndependentSmokeAdmission({
        authority: nextHead,
        headSha: NEXT_HEAD,
        reviewRuns: [],
      })).not.toThrow();
    },
  );

  it('settles an authoritative architect DEFER at cap but not BLOCK or pending', () => {
    for (const [verdict, source] of [
      ['DEFER', 'architect'],
      ['BLOCK', 'architect'],
      ['PENDING_OPERATOR', 'automatic'],
    ] as const) {
      const { options, authority } = authorityFixture('T1');
      const terminal = commitPackReviewTerminal({
        prNumber: 1436,
        expectedTransitionSeq: authority.transitionSeq,
        terminal: {
          schemaVersion: 1,
          terminalContractVersion: 2,
          terminalSource: 'normal',
          runId: `at-cap-${verdict}`,
          targetSha: HEAD,
          reviewVerdict: 'findings',
          findingCount: 1,
          findingsDigest: 'findings-digest',
        },
        status: 'changes_requested',
        findingCount: 1,
        options,
      });
      const triaged = commitPackReviewTriage({
        prNumber: 1436,
        expectedTransitionSeq: terminal.transitionSeq,
        triage: {
          verdict,
          source,
          findingSnapshotDigest: 'findings-snapshot',
          committedAtUtc: new Date().toISOString(),
        },
        options,
      });
      const published = recordPackReviewPublication({
        prNumber: 1436,
        expectedTransitionSeq: triaged.transitionSeq,
        publication: {
          headSha: HEAD,
          terminalRunId: `at-cap-${verdict}`,
          status: 'succeeded',
          publicationDigest: 'publication-digest',
          recordedAtUtc: new Date().toISOString(),
        },
        options,
      });
      if (verdict === 'DEFER') {
        expect(() => assertIndependentSmokeAdmission({ authority: published, headSha: HEAD, reviewRuns: [] })).not.toThrow();
      } else {
        expect(() => assertIndependentSmokeAdmission({ authority: published, headSha: HEAD, reviewRuns: [] }))
          .toThrow('smoke_ordering_review_unsettled');
      }
    }
  });

  it('derives smoke ordering applicability from the canonical smoke requirement', () => {
    expect(smokeOrderingRequired('')).toBe(true);
    expect(smokeOrderingRequired('```smoke-test-plan\nscenarios:\n```')).toBe(true);
    expect(smokeOrderingRequired([
      '```smoke-test-plan',
      'not-applicable: true',
      'reason: no operator-visible behavior',
      '```',
    ].join('\n'))).toBe(false);
    expect(smokeOrderingRequired('```smoke-test-plan\nnot-applicable: true\n```')).toBe(true);
  });

  it('reconciles a persisted T2 cycle before T3 review admission', () => {
    const { options, authority } = authorityFixture('T2');
    const reconciled = reconcilePackReviewTier({
      prNumber: 1436,
      tier: 'T3',
      options,
    });
    expect(reconciled.transitionSeq).toBe(authority.transitionSeq + 1);
    expect(reconciled.cycle).toMatchObject({ state: 'open', frozenTier: 'T3', frozenCap: 4 });
  });

  it('refuses a passed independent phase after a head change but permits failed continuation', () => {
    const settleWorkerAndReview = (options: PackReviewAuthorityOptions, authority: ReturnType<typeof initializePackReviewAuthority>) => {
      const started = commitSmokeOrderingTransition({
        prNumber: 1436,
        expectedTransitionSeq: authority.transitionSeq,
        actor: 'worker-owned',
        headSha: HEAD,
        status: 'started',
        options,
      });
      const passed = commitSmokeOrderingTransition({
        prNumber: 1436,
        expectedTransitionSeq: started.transitionSeq,
        actor: 'worker-owned',
        headSha: HEAD,
        status: 'passed',
        options,
      });
      const terminal = commitPackReviewTerminal({
        prNumber: 1436,
        expectedTransitionSeq: passed.transitionSeq,
        terminal: {
          schemaVersion: 1,
          terminalContractVersion: 2,
          terminalSource: 'normal',
          runId: 'settle-review',
          targetSha: HEAD,
          reviewVerdict: 'clean',
          findingCount: 0,
          findingsDigest: 'findings-digest',
        },
        status: 'up_to_date',
        findingCount: 0,
        options,
      });
      return recordPackReviewPublication({
        prNumber: 1436,
        expectedTransitionSeq: terminal.transitionSeq,
        publication: {
          headSha: HEAD,
          terminalRunId: 'settle-review',
          status: 'succeeded',
          publicationDigest: 'publication-digest',
          recordedAtUtc: new Date().toISOString(),
        },
        options,
      });
    };

    {
      const { options, authority } = authorityFixture();
      const settled = settleWorkerAndReview(options, authority);
      const independentStarted = commitSmokeOrderingTransition({
        prNumber: 1436,
        expectedTransitionSeq: settled.transitionSeq,
        actor: 'independent',
        headSha: HEAD,
        status: 'started',
        options,
      });
      const independentPassed = commitSmokeOrderingTransition({
        prNumber: 1436,
        expectedTransitionSeq: independentStarted.transitionSeq,
        actor: 'independent',
        headSha: HEAD,
        status: 'passed',
        options,
      });
      const nextHead = observePackReviewHead({
        prNumber: 1436,
        expectedTransitionSeq: independentPassed.transitionSeq,
        headSha: NEXT_HEAD,
        options,
      });
      expect(() => assertIndependentSmokeAdmission({ authority: nextHead, headSha: NEXT_HEAD, reviewRuns: [] }))
        .toThrow('smoke_ordering_independent_head_forbidden');
    }

    {
      const { options, authority } = authorityFixture();
      const settled = settleWorkerAndReview(options, authority);
      const independentStarted = commitSmokeOrderingTransition({
        prNumber: 1436,
        expectedTransitionSeq: settled.transitionSeq,
        actor: 'independent',
        headSha: HEAD,
        status: 'started',
        options,
      });
      const independentFailed = commitSmokeOrderingTransition({
        prNumber: 1436,
        expectedTransitionSeq: independentStarted.transitionSeq,
        actor: 'independent',
        headSha: HEAD,
        status: 'failed',
        failureKind: 'finding',
        options,
      });
      expect(() => assertIndependentSmokeAdmission({ authority: independentFailed, headSha: HEAD, reviewRuns: [] }))
        .toThrow('smoke_ordering_independent_same_head_forbidden');
      const nextHead = observePackReviewHead({
        prNumber: 1436,
        expectedTransitionSeq: independentFailed.transitionSeq,
        headSha: NEXT_HEAD,
        options,
      });
      expect(() => assertIndependentSmokeAdmission({ authority: nextHead, headSha: NEXT_HEAD, reviewRuns: [] })).not.toThrow();
    }
  });

  describe('Issue #1777 canonical independent-smoke admission matrix', () => {
    const OBSERVED_PR = 1740;
    const OBSERVED_HEAD = 'ce99d1e63aef156f8846483f77c426f7adeadcf0';
    const EARLIER_REVIEW_HEAD = 'c2cb38bfc7108d3887788bb3b4563fcf90ab3c1f';
    const OTHER_HEAD = 'e'.repeat(40);
    const OPENED_AT = '2026-08-27T12:00:00.000Z';
    const CURRENT_RUN_AT = '2026-08-27T12:00:01.000Z';
    const PRIOR_RUN_AT = '2026-08-27T11:59:59.000Z';
    const OBSERVED_RUN_ID = 'prr-acab5dadefd44b0da01061faa4f55ea3';

    type IndependentState =
      NonNullable<NonNullable<PackReviewAuthorityDocument['smokeOrdering']>['independent']>;

    function makeAuthority(input: {
      terminalStatus?: string;
      consumedHeadShas?: string[];
      reviewSettledHeadSha?: string;
      independent?: IndependentState;
      triageVerdict?: 'BLOCK';
      reviewStageComplete?: boolean;
      reviewStartConsumed?: boolean;
    } = {}): PackReviewAuthorityDocument {
      const terminal: PackReviewAuthorityDocument['terminal'] = input.terminalStatus
        ? {
          runId: `terminal-${input.terminalStatus}`,
          digest: 'd'.repeat(64),
          targetSha: OBSERVED_HEAD,
          reviewVerdict: ['clean', 'up_to_date', 'commented'].includes(input.terminalStatus)
            ? 'clean'
            : 'findings',
          terminalSource: 'normal',
          automaticBudgetDisposition: 'consume',
          reviewStatus: input.terminalStatus,
        }
        : undefined;
      return {
        schemaVersion: 1,
        prNumber: OBSERVED_PR,
        transitionSeq: 0,
        phase: 'head_observed',
        currentHeadSha: OBSERVED_HEAD,
        updatedAtUtc: OPENED_AT,
        cycle: {
          cycleId: 'cycle-observed-1740',
          state: 'open',
          frozenTier: 'T3',
          frozenCap: 2,
          capMapVersion: 'legacy-frozen',
          frozenMapOrigin: 'persisted-open-cycle',
          openedAtUtc: OPENED_AT,
          consumedHeadShas: input.consumedHeadShas ?? [],
          ...(input.reviewStageComplete
            ? { reviewStageComplete: true, reviewStageCompletedAtUtc: CURRENT_RUN_AT }
            : {}),
          ...(input.reviewStartConsumed ? { reviewStartConsumed: true } : {}),
        },
        ...(terminal ? { terminal } : {}),
        smokeOrdering: {
          workerOwned: {
            headSha: OBSERVED_HEAD,
            status: 'passed',
            updatedAtUtc: CURRENT_RUN_AT,
          },
          ...(input.reviewSettledHeadSha
            ? { reviewSettledHeadSha: input.reviewSettledHeadSha }
            : {}),
          ...(input.independent ? { independent: input.independent } : {}),
        },
        ...(input.triageVerdict
          ? {
            triage: {
              verdict: input.triageVerdict,
              source: 'architect',
              findingSnapshotDigest: 'finding-snapshot',
              committedAtUtc: CURRENT_RUN_AT,
            },
          }
          : {}),
      };
    }

    function observedRun(
      overrides: Partial<PackReviewStartConsumptionRecord> = {},
    ): PackReviewStartConsumptionRecord {
      return {
        id: OBSERVED_RUN_ID,
        runId: OBSERVED_RUN_ID,
        prNumber: OBSERVED_PR,
        targetSha: EARLIER_REVIEW_HEAD,
        headSha: EARLIER_REVIEW_HEAD,
        status: 'failed',
        automaticBudgetDisposition: 'consume',
        stale: false,
        createdAt: CURRENT_RUN_AT,
        ...overrides,
      };
    }

    function persistAuthority(authority: PackReviewAuthorityDocument): PackReviewAuthorityOptions {
      const root = mkdtempSync(join(tmpdir(), 'pack-review-ordering-1777-'));
      roots.push(root);
      mkdirSync(join(root, 'authority'), { recursive: true });
      writeFileSync(
        join(root, 'authority', `pr-${authority.prNumber}.json`),
        `${JSON.stringify(authority)}\n`,
        'utf8',
      );
      return { storeRoot: root };
    }

    function resultOf(action: () => unknown): string {
      try {
        action();
        return 'admit';
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error) {
          return String((error as { code?: unknown }).code);
        }
        return error instanceof Error ? error.message : String(error);
      }
    }

    type MatrixCase = {
      id: string;
      expected: string;
      authority: (derived: boolean) => PackReviewAuthorityDocument;
      runVariants: readonly (readonly PackReviewStartConsumptionRecord[])[];
      requestedHead?: string;
      derivedVariants?: readonly boolean[];
    };

    const MATRIX: readonly MatrixCase[] = [
      {
        id: 'A1 full observed #1740 run-store-only consumed start',
        expected: 'admit',
        authority: (derived) => makeAuthority({
          reviewStageComplete: derived,
          reviewStartConsumed: derived,
        }),
        runVariants: [[observedRun()]],
      },
      {
        id: 'A2 observed fixture without consuming run',
        expected: 'smoke_ordering_review_unsettled',
        authority: (derived) => makeAuthority({
          reviewStageComplete: derived,
          reviewStartConsumed: derived,
        }),
        runVariants: [[]],
      },
      {
        id: 'A3 failed terminal consumes start',
        expected: 'admit',
        authority: (derived) => makeAuthority({
          terminalStatus: 'failed',
          reviewStageComplete: derived,
          reviewStartConsumed: !derived,
        }),
        runVariants: [[]],
      },
      {
        id: 'A4 error terminal consumes start',
        expected: 'admit',
        authority: (derived) => makeAuthority({
          terminalStatus: 'error',
          reviewStageComplete: derived,
          reviewStartConsumed: !derived,
        }),
        runVariants: [[]],
      },
      {
        id: 'A5 changes_requested terminal consumes start',
        expected: 'admit',
        authority: (derived) => makeAuthority({
          terminalStatus: 'changes_requested',
          reviewStageComplete: derived,
          reviewStartConsumed: !derived,
        }),
        runVariants: [[]],
      },
      {
        id: 'A6 cap itself proves consumption',
        expected: 'admit',
        authority: (derived) => makeAuthority({
          consumedHeadShas: ['1'.repeat(40), '2'.repeat(40)],
          reviewStageComplete: derived,
          reviewStartConsumed: !derived,
        }),
        runVariants: [[]],
      },
      {
        id: 'A7 below cap without terminal or run evidence',
        expected: 'smoke_ordering_review_unsettled',
        authority: (derived) => makeAuthority({
          consumedHeadShas: ['1'.repeat(40)],
          reviewStageComplete: derived,
          reviewStartConsumed: derived,
        }),
        runVariants: [[]],
      },
      {
        id: 'A8 production failed-run failure reasons consume start',
        expected: 'admit',
        authority: (derived) => makeAuthority({
          reviewStageComplete: derived,
          reviewStartConsumed: !derived,
        }),
        runVariants: [
          [observedRun({ failureReason: 'reviewer_output_malformed:invalid_terminal_payload' })],
          [observedRun({ failureReason: 'stale_head_before_terminal' })],
        ],
      },
      {
        id: 'A9 stale or explicit non-consuming run cannot admit',
        expected: 'smoke_ordering_review_unsettled',
        authority: (derived) => makeAuthority({
          reviewStageComplete: derived,
          reviewStartConsumed: derived,
        }),
        runVariants: [
          [observedRun({ stale: true })],
          [observedRun({ automaticBudgetDisposition: 'non_consuming_explicit' })],
        ],
      },
      {
        id: 'A10 exact-head successful settlement admits',
        expected: 'admit',
        authority: () => makeAuthority({
          terminalStatus: 'up_to_date',
          reviewSettledHeadSha: OBSERVED_HEAD,
          reviewStageComplete: true,
        }),
        runVariants: [[]],
        derivedVariants: [true],
      },
      {
        id: 'A11 prior-head settlement does not settle current head',
        expected: 'smoke_ordering_review_unsettled',
        authority: (derived) => makeAuthority({
          reviewSettledHeadSha: EARLIER_REVIEW_HEAD,
          reviewStageComplete: derived,
          reviewStartConsumed: derived,
        }),
        runVariants: [[]],
      },
      {
        id: 'A12 requested head differs from authority current head',
        expected: 'smoke_ordering_head_mismatch',
        requestedHead: OTHER_HEAD,
        authority: (derived) => makeAuthority({
          reviewStageComplete: derived,
          reviewStartConsumed: derived,
        }),
        runVariants: [[observedRun()]],
      },
      {
        id: 'A13 same-head independent finding requires a new head',
        expected: 'smoke_ordering_independent_same_head_forbidden',
        authority: (derived) => makeAuthority({
          reviewStageComplete: derived,
          reviewStartConsumed: derived,
          independent: {
            startedEver: true,
            headSha: OBSERVED_HEAD,
            status: 'failed',
            failureKind: 'finding',
            failureHeadSha: OBSERVED_HEAD,
            updatedAtUtc: CURRENT_RUN_AT,
          },
        }),
        runVariants: [[observedRun()]],
      },
      {
        id: 'A14 started or passed independent smoke cannot continue on another head',
        expected: 'smoke_ordering_independent_head_forbidden',
        authority: (derived) => makeAuthority({
          reviewStageComplete: derived,
          reviewStartConsumed: derived,
          independent: {
            startedEver: true,
            headSha: EARLIER_REVIEW_HEAD,
            status: 'passed',
            updatedAtUtc: CURRENT_RUN_AT,
          },
        }),
        runVariants: [[observedRun()]],
      },
      {
        id: 'A15 unresolved blocking triage remains fail closed',
        expected: 'smoke_ordering_review_unsettled',
        authority: (derived) => makeAuthority({
          terminalStatus: 'failed',
          triageVerdict: 'BLOCK',
          reviewStageComplete: derived,
          reviewStartConsumed: true,
        }),
        runVariants: [[observedRun()]],
      },
      {
        id: 'A16 prior-cycle same-PR run cannot admit',
        expected: 'smoke_ordering_review_unsettled',
        authority: (derived) => makeAuthority({
          reviewStageComplete: derived,
          reviewStartConsumed: derived,
        }),
        runVariants: [[observedRun({ createdAt: PRIOR_RUN_AT })]],
      },
    ];

    it.each(MATRIX)('$id', ({ expected, authority: buildAuthority, runVariants, requestedHead, derivedVariants }) => {
      for (const derived of derivedVariants ?? [false, true]) {
        for (const reviewRuns of runVariants) {
          const authority = buildAuthority(derived);
          const headSha = requestedHead ?? OBSERVED_HEAD;

          expect(resultOf(() => assertIndependentSmokeAdmission({
            authority,
            headSha,
            reviewRuns,
          }))).toBe(expected);

          const options = persistAuthority(authority);
          expect(resultOf(() => commitSmokeOrderingTransition({
            prNumber: OBSERVED_PR,
            expectedTransitionSeq: authority.transitionSeq,
            actor: 'independent',
            headSha,
            status: 'started',
            reviewRuns,
            options,
          }))).toBe(expected);
        }
      }
    });

    it.each([
      { status: 'started', expected: 'smoke_ordering_independent_in_progress' },
      { status: 'passed', expected: 'smoke_ordering_independent_already_passed' },
    ] as const)('does not restart same-head independent smoke in status $status', ({ status, expected }) => {
      const authority = makeAuthority({
        independent: {
          startedEver: true,
          headSha: OBSERVED_HEAD,
          status,
          updatedAtUtc: CURRENT_RUN_AT,
        },
      });
      expect(resultOf(() => assertIndependentSmokeAdmission({
        authority,
        headSha: OBSERVED_HEAD,
        reviewRuns: [observedRun()],
      }))).toBe(expected);

      const options = persistAuthority(authority);
      expect(resultOf(() => commitSmokeOrderingTransition({
        prNumber: OBSERVED_PR,
        expectedTransitionSeq: authority.transitionSeq,
        actor: 'independent',
        headSha: OBSERVED_HEAD,
        status: 'started',
        reviewRuns: [observedRun()],
        options,
      }))).toBe(expected);
      expect(readPackReviewAuthority(OBSERVED_PR, options)?.smokeOrdering?.independent?.status).toBe(status);
    });

    it('preserves the exact observed #1740/#1754 regression identity and ordering relation', () => {
      expect(observedRun()).toMatchObject({
        id: OBSERVED_RUN_ID,
        runId: OBSERVED_RUN_ID,
        prNumber: OBSERVED_PR,
        targetSha: EARLIER_REVIEW_HEAD,
        headSha: EARLIER_REVIEW_HEAD,
        status: 'failed',
        automaticBudgetDisposition: 'consume',
        createdAt: CURRENT_RUN_AT,
      });
      expect(makeAuthority().cycle).toMatchObject({
        state: 'open',
        frozenCap: 2,
        consumedHeadShas: [],
        openedAtUtc: OPENED_AT,
      });
      expect(makeAuthority().smokeOrdering?.workerOwned).toMatchObject({
        headSha: OBSERVED_HEAD,
        status: 'passed',
      });
    });
  });

});
