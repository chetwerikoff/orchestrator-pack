import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyRequiredCiForReviewTrigger,
  evaluateHeadReadyForReview,
  evaluateQuiescentHandoffFallback,
  hasPendingUnconsumedDelivery,
  hasReadyForReviewForHead,
  isWorkerActivelyWorking,
  isWorkerDegradedCiHandoff,
  parseLastActivityAgeMs,
  preRunHeadReadyRecheck,
  QUIESCENCE_DEBOUNCE_MS,
} from '../docs/review-head-ready.mjs';
import { reportCoversHead } from '../docs/review-trigger-reconcile.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/review-trigger-reconcile',
);

const greenChecks = [
  { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
  { name: 'PR scope guard', state: 'SUCCESS' },
  { name: 'Run pack contract tests', state: 'SUCCESS' },
  { name: 'Self-architect lint', state: 'SUCCESS' },
];

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as T;
}

function headCommittedAtMsFromPr(pr: Record<string, unknown>) {
  const raw = pr.headCommittedAt ?? pr.headCommitCommittedAt;
  return typeof raw === 'string' && raw ? Date.parse(raw) : undefined;
}

describe('classifyRequiredCiForReviewTrigger', () => {
  it('classifies lookup failure as degraded', () => {
    expect(
      classifyRequiredCiForReviewTrigger(greenChecks, { requiredCheckLookupFailed: true }),
    ).toBe('degraded');
  });

  it('classifies absent required jobs as degraded', () => {
    expect(
      classifyRequiredCiForReviewTrigger([], {
        requiredCheckNames: ['Missing required job'],
      }),
    ).toBe('degraded');
  });

  it('classifies pending known required checks as pending', () => {
    expect(
      classifyRequiredCiForReviewTrigger(
        [{ name: 'Verify orchestrator-pack structure', state: 'PENDING' }, ...greenChecks.slice(1)],
      ),
    ).toBe('pending');
  });

  it('classifies failure as red', () => {
    expect(
      classifyRequiredCiForReviewTrigger(
        [{ name: 'Verify orchestrator-pack structure', state: 'FAILURE' }, ...greenChecks.slice(1)],
      ),
    ).toBe('red');
  });

  it('classifies partially missing required checks as degraded, not red', () => {
    expect(
      classifyRequiredCiForReviewTrigger(
        [{ name: 'Verify orchestrator-pack structure', state: 'SUCCESS' }],
        {
          requiredCheckNames: [
            'Verify orchestrator-pack structure',
            'PR scope guard',
            'Run pack contract tests',
          ],
        },
      ),
    ).toBe('degraded');
  });

  it('classifies missing fallback merge-contract checks as degraded when unrelated checks exist', () => {
    expect(
      classifyRequiredCiForReviewTrigger(
        [{ name: 'Unrelated external gate', state: 'PENDING' }],
      ),
    ).toBe('degraded');
  });
});

describe('reportCoversHead (Issue #218)', () => {
  it('binds SHA-less ready reports via head commit time vs report time', () => {
    const head = '8e35c0052127b8e156b7c1c80b2774286da16e6f';
    const report = {
      reportState: 'ready_for_review',
      reportedAt: '2026-06-06T06:10:00.000Z',
    };
    const headCommittedAtMs = Date.parse('2026-06-06T06:03:16Z');
    expect(reportCoversHead(report, head, { headCommittedAtMs })).toBe(true);
    expect(
      reportCoversHead(report, head, {
        headCommittedAtMs: Date.parse('2026-06-06T06:15:00.000Z'),
      }),
    ).toBe(false);
  });

  it('still honors explicit stored SHA when present', () => {
    const report = { reportState: 'ready_for_review', headRefOid: 'deadbeef' };
    expect(reportCoversHead(report, 'deadbeef', {})).toBe(true);
    expect(reportCoversHead(report, 'cafebabe', {})).toBe(false);
  });
});

describe('evaluateHeadReadyForReview', () => {
  it('Issue #218: SHA-less latest ready_for_review is eligible on green CI', () => {
    const fixture = loadFixture<{
      openPrs: { number: number; headRefOid: string; headCommittedAt: string }[];
      reviewRuns: [];
      sessions: Array<Record<string, unknown>>;
      ciChecksByPr: Record<string, typeof greenChecks>;
    }>('ready-sha-less-pr217.json');
    const pr = fixture.openPrs[0]!;
    const decision = evaluateHeadReadyForReview({
      reviewRuns: fixture.reviewRuns,
      prNumber: pr.number,
      headSha: pr.headRefOid,
      session: fixture.sessions[0] as never,
      ciChecks: fixture.ciChecksByPr[String(pr.number)],
      headCommittedAtMs: Date.parse(pr.headCommittedAt),
    });
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toBe('head_ready_for_review');
  });

  it('(a) ready head with green CI is eligible', () => {
    const fixture = loadFixture<{
      openPrs: { number: number; headRefOid: string; headCommittedAt?: string }[];
      reviewRuns: [];
      sessions: Array<Record<string, unknown>>;
      ciChecksByPr: Record<string, typeof greenChecks>;
    }>('ready-head-triggers.json');
    const pr = fixture.openPrs[0]!;
    const decision = evaluateHeadReadyForReview({
      reviewRuns: fixture.reviewRuns,
      prNumber: pr.number,
      headSha: pr.headRefOid,
      session: fixture.sessions[0] as never,
      ciChecks: fixture.ciChecksByPr[String(pr.number)],
      headCommittedAtMs: headCommittedAtMsFromPr(pr),
    });
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toBe('head_ready_for_review');
  });

  it('(b) intermediate commit without ready_for_review is not eligible', () => {
    const fixture = loadFixture<{
      openPrs: { number: number; headRefOid: string }[];
      reviewRuns: [];
      sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
      ciChecksByPr: Record<string, typeof greenChecks>;
    }>('intermediate-commit.json');
    const pr = fixture.openPrs[0]!;
    const decision = evaluateHeadReadyForReview({
      reviewRuns: fixture.reviewRuns,
      prNumber: pr.number,
      headSha: pr.headRefOid,
      session: fixture.sessions[0] as never,
      ciChecks: fixture.ciChecksByPr[String(pr.number)],
      headCommittedAtMs: headCommittedAtMsFromPr(pr),
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('uncovered_not_ready');
  });

  it('(c) stale ready_for_review on older head does not authorize current head', () => {
    const fixture = loadFixture<{
      openPrs: { number: number; headRefOid: string; headCommittedAt?: string }[];
      sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
    }>('intermediate-commit.json');
    const session = fixture.sessions[0]!;
    const pr = fixture.openPrs[0]!;
    expect(
      hasReadyForReviewForHead(session, pr.headRefOid, {
        headCommittedAtMs: headCommittedAtMsFromPr(pr),
      }),
    ).toBe(false);
  });

  it('requires the latest accepted report to be ready_for_review', () => {
    const head = 'superseded01';
    const headCommittedAtMs = Date.parse('2026-06-05T12:00:00.000Z');
    const session = {
      name: 'op-worker-superseded',
      role: 'worker',
      prNumber: 60,
      reports: [
        {
          reportState: 'ready_for_review',
          reportedAt: '2026-06-05T11:00:00.000Z',
        },
        {
          reportState: 'addressing_reviews',
          reportedAt: '2026-06-05T12:00:00.000Z',
        },
      ],
    };
    expect(hasReadyForReviewForHead(session, head, { headCommittedAtMs })).toBe(false);
    const decision = evaluateHeadReadyForReview({
      reviewRuns: [],
      prNumber: 60,
      headSha: head,
      session: session as never,
      ciChecks: greenChecks,
      headCommittedAtMs,
      nowMs: headCommittedAtMs + 5 * 60 * 1000,
      ownerResolution: { sessionId: 'op-worker-superseded', reason: 'resolved', failClosed: false },
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('uncovered_not_ready');
  });

  it('(d) red CI defers an otherwise-ready head', () => {
    const fixture = loadFixture<{
      openPrs: { number: number; headRefOid: string; headCommittedAt?: string }[];
      reviewRuns: [];
      sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
      ciChecksByPr: Record<string, { name: string; state: string }[]>;
    }>('red-ci-defer.json');
    const pr = fixture.openPrs[0]!;
    const decision = evaluateHeadReadyForReview({
      reviewRuns: fixture.reviewRuns,
      prNumber: pr.number,
      headSha: pr.headRefOid,
      session: fixture.sessions[0] as never,
      ciChecks: fixture.ciChecksByPr[String(pr.number)],
      headCommittedAtMs: headCommittedAtMsFromPr(pr),
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('ci_red_defer');
  });

  it('(e) pending CI on ready head is eligible', () => {
    const fixture = loadFixture<{
      openPrs: { number: number; headRefOid: string }[];
      reviewRuns: [];
      sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
      ciChecksByPr: Record<string, { name: string; state: string }[]>;
    }>('pending-ci-triggers.json');
    const pr = fixture.openPrs[0]!;
    const decision = evaluateHeadReadyForReview({
      reviewRuns: fixture.reviewRuns,
      prNumber: pr.number,
      headSha: pr.headRefOid,
      session: fixture.sessions[0] as never,
      ciChecks: fixture.ciChecksByPr[String(pr.number)],
      headCommittedAtMs: headCommittedAtMsFromPr(pr),
    });
    expect(decision.eligible).toBe(true);
  });

  it('(e3) worker degraded-CI handoff is not uncovered-not-ready', () => {
    const fixture = loadFixture<{
      openPrs: { number: number; headRefOid: string }[];
      reviewRuns: [];
      sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
      requiredCheckLookupFailedByPr: Record<string, boolean>;
    }>('degraded-ci-worker-handoff.json');
    const pr = fixture.openPrs[0]!;
    const report = fixture.sessions[0]!.reports?.[0];
    expect(isWorkerDegradedCiHandoff(report)).toBe(true);
    const decision = evaluateHeadReadyForReview({
      reviewRuns: fixture.reviewRuns,
      prNumber: pr.number,
      headSha: pr.headRefOid,
      session: fixture.sessions[0] as never,
      ciChecks: [],
      requiredCheckLookupFailed: true,
      headCommittedAtMs: headCommittedAtMsFromPr(pr),
    });
    expect(decision.reason).not.toBe('uncovered_not_ready');
    expect(decision.route).toBe('degraded_ci_retry');
  });
});

describe('Issue #261 quiescence helpers', () => {
  it('parseLastActivityAgeMs reads ao status shapes', () => {
    expect(parseLastActivityAgeMs('20m ago')).toBe(20 * 60 * 1000);
    expect(parseLastActivityAgeMs('just now')).toBe(0);
  });

  it('treats streaming and recent activity as actively working', () => {
    const nowMs = 1781096400000;
    expect(
      isWorkerActivelyWorking(
        { status: 'working', activity: 'active', reports: [] } as never,
        'head',
        nowMs,
      ),
    ).toBe(true);
    expect(
      isWorkerActivelyWorking(
        {
          status: 'working',
          activity: 'ready',
          lastActivity: '2m ago',
          reports: [],
        } as never,
        'head',
        nowMs,
        { debounceMs: QUIESCENCE_DEBOUNCE_MS },
      ),
    ).toBe(true);
  });

  it('hasPendingUnconsumedDelivery matches deliveries keyed by any session identifier', () => {
    const session = {
      name: 'opk-37',
      sessionId: 'opk-37-stable',
      reports: [],
    } as never;
    const deliveries = [
      {
        deliveryId: 'opk-37-stable:1:pack-send:ci-green',
        sessionId: 'opk-37-stable',
        deliveredAtMs: 1,
        deliveryPath: 'pending-draft',
      },
    ];
    expect(hasPendingUnconsumedDelivery(session, 'opk-37', deliveries)).toBe(true);
  });

  it('evaluateQuiescentHandoffFallback matches PR #260 idle owner', () => {
    const fixture = loadFixture<{
      nowMs: number;
      openPrs: { number: number; headRefOid: string; headCommittedAt: string }[];
      sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
    }>('quiescent-pr260-opk-37.json');
    const pr = fixture.openPrs[0]!;
    const session = fixture.sessions[0]!;
    const result = evaluateQuiescentHandoffFallback({
      session,
      headSha: pr.headRefOid,
      nowMs: fixture.nowMs,
      headCommittedAtMs: Date.parse(pr.headCommittedAt),
      ownerResolution: { sessionId: 'opk-37', reason: 'resolved', failClosed: false },
    });
    expect(result.eligible).toBe(true);
    expect(result.basis?.pendingUnconsumedDelivery).toBe(false);
  });
});

describe('preRunHeadReadyRecheck', () => {
  it('(g) aborts when head becomes covered before run', () => {
    const fixture = loadFixture<{
      planned: { prNumber: number; headSha: string; sessionId: string };
      fresh: {
        openPrs: { number: number; headRefOid: string }[];
        reviewRuns: { prNumber: number; targetSha: string; status: string }[];
        sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
        ciChecks: typeof greenChecks;
      };
      expect: { emitReviewRun: boolean; reasonPrefix: string };
    }>('pre-run-abort.json');
    const result = preRunHeadReadyRecheck(fixture.planned, fixture.fresh);
    expect(result.emitReviewRun).toBe(fixture.expect.emitReviewRun);
    expect(result.reason).toMatch(new RegExp(`^${fixture.expect.reasonPrefix}`));
  });

  it('Issue #261 AC11b: aborts quiescence start when strict ownership becomes ambiguous', () => {
    const fixture = loadFixture<{
      planned: { prNumber: number; headSha: string; sessionId: string; startReason: string };
      fresh: {
        nowMs: number;
        openPrs: { number: number; headRefOid: string; headCommittedAt: string }[];
        reviewRuns: [];
        sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
        ciChecks: typeof greenChecks;
      };
      expect: { emitReviewRun: boolean; reasonPrefix: string };
    }>('pre-run-owner-ambiguous.json');
    const result = preRunHeadReadyRecheck(fixture.planned, fixture.fresh);
    expect(result.emitReviewRun).toBe(fixture.expect.emitReviewRun);
    expect(result.reason).toMatch(new RegExp(`^${fixture.expect.reasonPrefix}`));
  });

  it('Issue #261 AC11: aborts quiescence start when worker resumes activity', () => {
    const fixture = loadFixture<{
      planned: { prNumber: number; headSha: string; sessionId: string; startReason: string };
      fresh: {
        nowMs: number;
        openPrs: { number: number; headRefOid: string; headCommittedAt: string }[];
        reviewRuns: [];
        sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
        ciChecks: typeof greenChecks;
      };
      expect: { emitReviewRun: boolean; reasonPrefix: string };
    }>('pre-run-quiescence-abort.json');
    const result = preRunHeadReadyRecheck(fixture.planned, fixture.fresh);
    expect(result.emitReviewRun).toBe(fixture.expect.emitReviewRun);
    expect(result.reason).toMatch(new RegExp(`^${fixture.expect.reasonPrefix}`));
  });

  it('aborts when PR head advanced since plan', () => {
    const fixture = loadFixture<{
      planned: { prNumber: number; headSha: string; sessionId: string };
      fresh: {
        openPrs: { number: number; headRefOid: string }[];
        reviewRuns: [];
        sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
        ciChecks: typeof greenChecks;
      };
      expect: { emitReviewRun: boolean; reason: string };
    }>('pre-run-head-advanced.json');
    const result = preRunHeadReadyRecheck(fixture.planned, fixture.fresh);
    expect(result.emitReviewRun).toBe(fixture.expect.emitReviewRun);
    expect(result.reason).toBe(fixture.expect.reason);
  });
});
