import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyReadyForReviewFreshness,
  enumerateReportsInEmissionOrder,
  FRESHNESS_BASIS_FRESH,
  FRESHNESS_BASIS_STALE_ONLY,
  FRESHNESS_BASIS_NO_REPORT,
  FRESHNESS_BASIS_AMBIGUOUS,
  classifyRequiredCiForReviewTrigger,
  evaluateHeadReadyForReview,
  evaluateQuiescentHandoffFallback,
  hasPendingUnconsumedDelivery,
  mergeWorkerDeliveriesFromPlanInput,
  hasReadyForReviewForHead,
  isWorkerActivelyWorking,
  isWorkerDegradedCiHandoff,
  parseLastActivityAgeMs,
  preRunHeadReadyRecheck,
  QUIESCENCE_DEBOUNCE_MS,
} from '../docs/review-head-ready.mjs';
import { reportCoversHead } from '../docs/review-trigger-reconcile.mjs';
import { NUDGE_EXPIRY_MS } from '../docs/worker-iteration-cycle.mjs';

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

type TriggerFixture = {
  sessions: Array<Record<string, unknown>>;
  openPrs: Array<Record<string, unknown>>;
  ciChecksByPr?: Record<string, Array<Record<string, unknown>>>;
  expect?: Record<string, unknown>;
};

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


describe('classifyReadyForReviewFreshness (Issue #352)', () => {
  it('classifies coexistence as fresh-by-monotonic-order', () => {
    const fixture = loadFixture<TriggerFixture>('coexistence-fresh-handoff-pr344.json');
    const session = fixture.sessions[0]!;
    const pr = fixture.openPrs[0]!;
    const headSha = String(pr.headRefOid ?? '');
    const classification = classifyReadyForReviewFreshness(session as never, headSha, {
      headCommittedAtMs: headCommittedAtMsFromPr(pr),
    });
    expect(classification.freshnessBasis).toBe(FRESHNESS_BASIS_FRESH);
    expect(classification.hasOlderStaleReadyReports).toBe(true);
  });

  it('distinguishes stale-only from no-report', () => {
    const staleOnly = loadFixture<TriggerFixture>('defer-stale-only-binding.json');
    const staleSession = staleOnly.sessions[0]!;
    const stalePr = staleOnly.openPrs[0]!;
    const staleHead = String(stalePr.headRefOid ?? '');
    expect(
      classifyReadyForReviewFreshness(staleSession as never, staleHead, {
        headCommittedAtMs: headCommittedAtMsFromPr(stalePr),
      }).freshnessBasis,
    ).toBe(FRESHNESS_BASIS_STALE_ONLY);

    const noReport = loadFixture<TriggerFixture>('uncovered-no-report.json');
    const noSession = noReport.sessions[0]!;
    const noPr = noReport.openPrs[0]!;
    const noHead = String(noPr.headRefOid ?? '');
    expect(
      classifyReadyForReviewFreshness(noSession as never, noHead, {
        headCommittedAtMs: headCommittedAtMsFromPr(noPr),
      }).freshnessBasis,
    ).toBe(FRESHNESS_BASIS_NO_REPORT);
  });

  it('fails closed for false-fresh and replayed stale rows', () => {
    for (const name of [
      'false-fresh-rewritten-commit.json',
      'replayed-stale-after-head-observation.json',
    ]) {
      const fixture = loadFixture<TriggerFixture>(name);
      const pr = fixture.openPrs[0]!;
      const classification = classifyReadyForReviewFreshness(
        fixture.sessions[0] as never,
        String(pr.headRefOid ?? ''),
        { headCommittedAtMs: headCommittedAtMsFromPr(pr) },
      );
      expect(classification.freshnessBasis).toBe(FRESHNESS_BASIS_AMBIGUOUS);
    }
  });

  it('preserves AO array order when deriving emission order', () => {
    const reports = [
      {
        reportState: 'ready_for_review',
        reportedAt: '2026-06-17T08:00:00.000Z',
      },
      {
        reportState: 'addressing_reviews',
        reportedAt: '2026-06-19T05:00:00.000Z',
      },
      {
        reportState: 'fixing_ci',
        reportedAt: '2026-06-19T04:30:00.000Z',
      },
    ];
    const emission = enumerateReportsInEmissionOrder({ reports } as never);
    expect(emission.map(({ report }) => String(report.reportState ?? ''))).toEqual([
      'fixing_ci',
      'addressing_reviews',
      'ready_for_review',
    ]);
  });

  it('counts the iteration boundary as a handoff precursor across non-precursor reports', () => {
    const headSha = '2ad9eb91e7a152cee0f14fa810fe8dfcd7c82d0e';
    const classification = classifyReadyForReviewFreshness(
      {
        ownedHeadSha: headSha,
        reports: [
          {
            reportState: 'ready_for_review',
            reportedAt: '2026-06-19T06:00:00.000Z',
            accepted: true,
            headRefOid: headSha,
          },
          {
            reportState: 'completed',
            reportedAt: '2026-06-19T05:30:00.000Z',
            accepted: true,
          },
          {
            reportState: 'working',
            reportedAt: '2026-06-19T05:00:00.000Z',
            accepted: true,
          },
        ],
      } as never,
      headSha,
      { headCommittedAtMs: Date.parse('2026-06-19T04:00:00.000Z') },
    );
    expect(classification.freshnessBasis).toBe(FRESHNESS_BASIS_FRESH);
    expect(classification.freshHandoffReport).not.toBeNull();
  });

    it('accepts direct addressing_reviews and started handoff precursors', () => {
    const headSha = '699499c41d22d6172126fb436dfc81b635d4e30e';
    const headCommittedAtMs = Date.parse('2026-06-19T04:00:00.000Z');
    for (const precursor of ['addressing_reviews', 'started'] as const) {
      const classification = classifyReadyForReviewFreshness(
        {
          ownedHeadSha: headSha,
          reports: [
            {
              reportState: 'ready_for_review',
              reportedAt: '2026-06-19T05:00:00.000Z',
              accepted: true,
              headRefOid: headSha,
            },
            {
              reportState: precursor,
              reportedAt: '2026-06-19T04:30:00.000Z',
              accepted: true,
            },
          ],
        } as never,
        headSha,
        { headCommittedAtMs },
      );
      expect(classification.freshnessBasis).toBe(FRESHNESS_BASIS_FRESH);
      expect(classification.freshHandoffReport).not.toBeNull();
    }
  });

    it('excludes explicitly rejected reports from freshness classification', () => {
    const headSha = '5525b365db230c69b7a5f1676442085eb5e0d01b';
    const classification = classifyReadyForReviewFreshness(
      {
        ownedHeadSha: headSha,
        reports: [
          {
            reportState: 'ready_for_review',
            reportedAt: '2026-06-19T03:00:00.000Z',
            accepted: false,
            headRefOid: headSha,
          },
          {
            reportState: 'working',
            reportedAt: '2026-06-19T02:00:00.000Z',
            accepted: false,
          },
        ],
      } as never,
      headSha,
    );
    expect(classification.freshnessBasis).toBe(FRESHNESS_BASIS_NO_REPORT);
    expect(classification.freshHandoffReport).toBeNull();
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

  it('active worker with degraded CI visibility stays uncovered_not_ready', () => {
    const decision = evaluateHeadReadyForReview({
      reviewRuns: [],
      prNumber: 99,
      headSha: 'active99',
      session: {
        name: 'op-live',
        role: 'worker',
        status: 'working',
        reports: [{ reportState: 'working', reportedAt: '2026-06-05T12:00:00.000Z' }],
      } as never,
      ciChecks: [],
      requiredCheckNames: ['Missing required job'],
      requiredCheckLookupFailed: false,
    });
    expect(decision.reason).toBe('uncovered_not_ready');
    expect(decision.route).toBe('defer');
    expect(decision.route).not.toBe('degraded_ci_retry');
  });

  it('orphaned PR with degraded CI returns no_worker_session before degraded retry', () => {
    const decision = evaluateHeadReadyForReview({
      reviewRuns: [],
      prNumber: 99,
      headSha: 'orphan99',
      session: null,
      ciChecks: [],
      requiredCheckNames: ['Missing required job'],
      requiredCheckLookupFailed: false,
    });
    expect(decision.reason).toBe('no_worker_session');
    expect(decision.route).not.toBe('degraded_ci_retry');
  });

  it('fail-closed owner without session returns defer before degraded retry', () => {
    const decision = evaluateHeadReadyForReview({
      reviewRuns: [],
      prNumber: 99,
      headSha: 'orphan99',
      session: null,
      ciChecks: [],
      requiredCheckLookupFailed: true,
      ownerResolution: {
        sessionId: null,
        reason: 'no_live_review_target',
        failClosed: true,
      },
    });
    expect(decision.reason).toBe('no_live_review_target');
    expect(decision.route).toBe('defer');
    expect(decision.route).not.toBe('degraded_ci_retry');
  });

  it('degraded-CI handoff pending escalates at max attempts', () => {
    const fixture = loadFixture<{
      openPrs: { number: number; headRefOid: string }[];
      reviewRuns: [];
      sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
      requiredCheckLookupFailedByPr: Record<string, boolean>;
    }>('degraded-ci-worker-handoff.json');
    const pr = fixture.openPrs[0]!;
    const decision = evaluateHeadReadyForReview({
      reviewRuns: fixture.reviewRuns,
      prNumber: pr.number,
      headSha: pr.headRefOid,
      session: fixture.sessions[0] as never,
      ciChecks: [],
      requiredCheckLookupFailed: true,
      headCommittedAtMs: headCommittedAtMsFromPr(pr),
      degradedCiAttempts: 3,
      maxDegradedCiAttempts: 3,
    });
    expect(decision.reason).toBe('degraded_ci_escalate_operator');
    expect(decision.route).toBe('escalate_operator');
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

describe('mergeWorkerDeliveriesFromPlanInput', () => {
  it('merges explicit deliveries with synthesized reaction deliveries', () => {
    const deliveries = mergeWorkerDeliveriesFromPlanInput({
      workerDeliveries: [
        {
          deliveryId: 'journal:opk-37:pack-send',
          sessionId: 'opk-37',
          deliveredAtMs: 1781095000000,
          deliveryPath: 'journal',
        },
      ],
      aoEvents: [
        {
          kind: 'reaction.action_succeeded',
          sessionId: 'opk-37',
          tsEpoch: 1781095200000,
          data: { action: 'send-to-agent', reactionKey: 'report-stale' },
        },
      ],
      dispatchJournal: {},
      reviewRuns: [],
      reactionMessages: {
        'report-stale':
          'Agent report is stale (30 minutes since last report). Continue your task and push fixes when ready. This nudge is long enough to use the pending-draft delivery path so reconcile can observe unconsumed worker input before starting review.',
      },
      nowMs: 1781096400000,
    });
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((row) => row.deliveryId)).toEqual(
      expect.arrayContaining(['journal:opk-37:pack-send', expect.stringContaining('opk-37')]),
    );
  });

  it('ignores null explicit delivery placeholders and merges aoEvents', () => {
    const deliveries = mergeWorkerDeliveriesFromPlanInput({
      workerDeliveries: [null as unknown as Record<string, unknown>],
      aoEvents: [
        {
          kind: 'reaction.action_succeeded',
          sessionId: 'opk-37',
          tsEpoch: 1781095200000,
          data: { action: 'send-to-agent', reactionKey: 'report-stale' },
        },
      ],
      dispatchJournal: {},
      reviewRuns: [],
      reactionMessages: {
        'report-stale':
          'Agent report is stale (30 minutes since last report). Continue your task and push fixes when ready. This nudge is long enough to use the pending-draft delivery path so reconcile can observe unconsumed worker input before starting review.',
      },
      nowMs: 1781096400000,
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.sessionId).toBe('opk-37');
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

  it('Issue #261 AC11c: pre-run recheck resolves single implicit owner for quiescence', () => {
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
    }>('pre-run-single-implicit-owner.json');
    const nowMs = Number(fixture.fresh.nowMs ?? Date.now());
    const result = preRunHeadReadyRecheck(fixture.planned, {
      ...fixture.fresh,
      sharedCycleState: {
        repoId: 'orchestrator-pack',
        ownerCycles: {
          'orchestrator-pack:pr:260:owner:opk-37': {
            cycleId: 'orchestrator-pack:260:opk-37:seed',
            ownerSessionId: 'opk-37',
            prNumber: 260,
            openedAtMs: nowMs - NUDGE_EXPIRY_MS - 1000,
            nudgeArmed: true,
            nudgeSentAtMs: nowMs - NUDGE_EXPIRY_MS - 1000,
            nudgeExpiresAtMs: nowMs - 1000,
            nudgeExpiredFallbackPending: true,
          },
        },
      },
      legacyNudged: {
        '260:42bf1490dbe8829667d2835b937a33e7af9d82f1:1:nudge': {
          sessionId: 'opk-37',
          sentAtMs: nowMs - NUDGE_EXPIRY_MS - 1000,
        },
      },
    });
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

  it('aborts quiescent fallback when fresh shared nudge is still outstanding', () => {
    const fixture = loadFixture<{
      nowMs: number;
      openPrs: { number: number; headRefOid: string; headCommittedAt: string }[];
      sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
      ciChecksByPr: Record<string, typeof greenChecks>;
    }>('quiescent-pr260-opk-37.json');
    const nowMs = Number(fixture.nowMs ?? Date.now());
    const sessionId = 'opk-37';
    const prNumber = 260;
    const headSha = '42bf1490dbe8829667d2835b937a33e7af9d82f1';
    const repoId = 'orchestrator-pack';
    const ownerKey = `${repoId}:pr:${prNumber}:owner:${sessionId}`;
    const sentAtMs = nowMs - 60_000;

    const result = preRunHeadReadyRecheck(
      {
        prNumber,
        headSha,
        sessionId,
        startReason: 'quiescent_worker_handoff_fallback',
      },
      {
        nowMs,
        openPrs: fixture.openPrs,
        reviewRuns: [],
        sessions: fixture.sessions,
        ciChecks: fixture.ciChecksByPr?.[String(prNumber)] ?? greenChecks,
        aoEvents: [],
        dispatchJournal: {},
        workerDeliveries: [],
        sharedCycleState: {
          repoId,
          ownerCycles: {
            [ownerKey]: {
              cycleId: 'cg-cycle',
              ownerSessionId: sessionId,
              prNumber,
              nudgeArmed: true,
              nudgeSentAtMs: sentAtMs,
              nudgeExpiresAtMs: sentAtMs + NUDGE_EXPIRY_MS,
            },
          },
        },
        legacyNudged: {
          [`${prNumber}:${headSha}:1:nudge`]: { sessionId, sentAtMs },
        },
      },
    );
    expect(result.emitReviewRun).toBe(false);
    expect(result.reason).toContain('nudge_outstanding');
  });

  it('aborts when fail-closed ownership would reuse a ready planned session', () => {
    const fixture = loadFixture<{
      planned: { prNumber: number; headSha: string; sessionId: string };
      fresh: {
        openPrs: { number: number; headRefOid: string; headCommittedAt: string }[];
        reviewRuns: [];
        sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
        ciChecks: typeof greenChecks;
      };
      expect: { emitReviewRun: boolean; reason: string };
    }>('pre-run-fail-closed-ready-report.json');
    const result = preRunHeadReadyRecheck(fixture.planned, fixture.fresh);
    expect(result.emitReviewRun).toBe(fixture.expect.emitReviewRun);
    expect(result.reason).toBe(fixture.expect.reason);
  });

  it('aborts non-quiescent start when strict head owner drifts before run', () => {
    const fixture = loadFixture<{
      planned: { prNumber: number; headSha: string; sessionId: string };
      fresh: {
        openPrs: { number: number; headRefOid: string; headCommittedAt: string }[];
        reviewRuns: [];
        sessions: NonNullable<Parameters<typeof evaluateHeadReadyForReview>[0]['session']>[];
        ciChecks: typeof greenChecks;
      };
      expect: { emitReviewRun: boolean; reason: string };
    }>('pre-run-owner-drift.json');
    const result = preRunHeadReadyRecheck(fixture.planned, fixture.fresh);
    expect(result.emitReviewRun).toBe(fixture.expect.emitReviewRun);
    expect(result.reason).toBe(fixture.expect.reason);
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

  it('allows retry-eligible failed run through pre-run recheck', () => {
    const headSha = 'abc3180000000000000000000000000000000000';
    const result = preRunHeadReadyRecheck(
      { prNumber: 318, headSha, sessionId: 'opk-75' },
      {
        openPrs: [{ number: 318, headRefOid: headSha, headCommittedAt: '2026-06-16T00:00:00.000Z' }],
        reviewRuns: [{
        id: 'failed-empty',
        prNumber: 318,
        targetSha: 'abc3180000000000000000000000000000000000',
        status: 'failed',
        findingCount: 0,
        body:
          'reviewer-evidence:{"reviewer":{"effectiveBudgetMs":600000,"failureClass":"timeout_no_verdict"}}\nreviewer timeout before verdict',
      }],
        sessions: [
          {
            sessionId: 'opk-75',
            name: 'opk-75',
            prNumber: 318,
            reports: [{ reportState: 'ready_for_review', reportedAt: '2026-06-16T00:00:00.000Z' }],
          },
        ],
        ciChecks: greenChecks,
        requiredCheckNames: [
          'Verify orchestrator-pack structure',
          'PR scope guard',
          'Run pack contract tests',
          'Self-architect lint',
        ],
      },
    );
    expect(result.emitReviewRun).toBe(true);
    expect(result.reason).toBe('failed_retry_after_recheck');
  });

  it('blocks retry-eligible failed run when required CI is red at pre-run recheck', () => {
    const headSha = 'abc3180000000000000000000000000000000000';
    const result = preRunHeadReadyRecheck(
      { prNumber: 318, headSha, sessionId: 'opk-75' },
      {
        openPrs: [{ number: 318, headRefOid: headSha, headCommittedAt: '2026-06-16T00:00:00.000Z' }],
        reviewRuns: [{
        id: 'failed-empty',
        prNumber: 318,
        targetSha: 'abc3180000000000000000000000000000000000',
        status: 'failed',
        findingCount: 0,
        body:
          'reviewer-evidence:{"reviewer":{"effectiveBudgetMs":600000,"failureClass":"timeout_no_verdict"}}\nreviewer timeout before verdict',
      }],
        sessions: [
          {
            sessionId: 'opk-75',
            name: 'opk-75',
            prNumber: 318,
            reports: [{ reportState: 'ready_for_review', reportedAt: '2026-06-16T00:00:00.000Z' }],
          },
        ],
        ciChecks: [{ name: 'Verify orchestrator-pack structure', state: 'FAILURE' }],
        requiredCheckNames: ['Verify orchestrator-pack structure'],
      },
    );
    expect(result.emitReviewRun).toBe(false);
    expect(result.reason).toBe('pre_run_recheck_ci_red_defer');
  });
});
