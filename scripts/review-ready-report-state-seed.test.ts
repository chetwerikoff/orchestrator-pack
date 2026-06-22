import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORT_STATE_POLL_TICK_CAPACITY,
  REPORT_STATE_POLL_CLASS,
  REPORT_STATE_SEED_START_REASON,
  REPORT_STATE_SEED_TO_START_MAX_MS,
  evaluatePollReportBinding,
  hasTerminalHandoffOutcome,
  planReportStatePollTick,
  pollBindingStateKey,
  isAcceptedReadyForReviewReport,
  resolveOpenPrForRepoAndNumber,
  reportStateSeedDedupeKey,
  updatePollBindingStateEntry,
  resolveInitialTipFirstObservedMs,
  isPersistedReportStateSeedBlocking,
  findLatestAcceptedReadyForReviewReport,
  findLatestAcceptedReadyForReviewAcrossSessions,
  collectStatusSessionsForPoll,
  sessionMatchesSupervisedProject,
} from '../docs/review-ready-report-state-seed.mjs';
import { isTerminalHandoffAdmissionRecord } from '../docs/review-handoff-wake-admission.mjs';
import {
  evaluateDeferredWatchEntry,
  planDeferredWatchTick,
  REPORT_STATE_SEED_START_REASON as REEVAL_REPORT_STATE_SEED_START_REASON,
  reportStateWatchEntryKey,
  resolveStartReasonForWatchEntry,
  seedWatchFromReportStatePoll,
  revertTriggeredWatchOnAbort,
} from '../docs/review-trigger-reeval.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/review-ready-report-state-seed',
);
const captureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/external-output-references/captures/ao-status-sessions',
);

type PlanResult = {
  pollClass: string;
  bindingByKey: Record<string, Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  skips: Array<Record<string, unknown>>;
  deferredScanKeys: string[];
  seededKeys: string[];
  releasedSeedKeys?: string[];
  nowMs: number;
};

type SeedFixture = {
  description?: string;
  headSha?: string;
  nowMs?: number;
  openPrs?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
  reviewRuns?: Array<Record<string, unknown>>;
  ciChecksByPr?: Record<string, unknown[]>;
  requiredCheckNamesByPr?: Record<string, string[]>;
  requiredCheckLookupFailedByPr?: Record<string, boolean>;
  bindingByKey?: Record<string, Record<string, unknown>>;
  seededKeys?: string[];
  deferredScanKeys?: string[];
  handoffRecords?: Record<string, unknown>;
  terminalClaimKeys?: string[];
  watchEntries?: Record<string, unknown>;
  tickCapacity?: number;
  expect?: Record<string, unknown>;
  ciFlipGreen?: { ciChecksByPr?: Record<string, unknown[]> };
};

function loadFixture(name: string): SeedFixture {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as SeedFixture;
}

function planFromFixture(fixture: SeedFixture, overrides: Record<string, unknown> = {}): PlanResult {
  return planReportStatePollTick({
    sessions: fixture.sessions ?? [],
    openPrs: fixture.openPrs ?? [],
    reviewRuns: fixture.reviewRuns ?? [],
    bindingByKey: fixture.bindingByKey ?? {},
    handoffRecords: fixture.handoffRecords ?? {},
    terminalClaimKeys: fixture.terminalClaimKeys ?? [],
    existingSeedKeys: fixture.seededKeys ?? [],
    watchEntries: (fixture.watchEntries ?? {}) as Record<string, object>,
    supervisedProject: 'orchestrator-pack',
    fallbackRepoSlug: 'chetwerikoff/orchestrator-pack',
    nowMs: fixture.nowMs,
    deferredScanKeys: fixture.deferredScanKeys ?? [],
    tickCapacity: fixture.tickCapacity,
    ...overrides,
  }) as PlanResult;
}

function evaluateReadyFixture(fixture: SeedFixture) {
  const plan = planFromFixture(fixture);
  const seed = seedWatchFromReportStatePoll({
    candidates: plan.candidates,
    existingWatches: fixture.watchEntries ?? {},
    nowMs: fixture.nowMs,
  });
  const tick = planDeferredWatchTick({
    watchEntries: seed.watchEntries,
    openPrs: fixture.openPrs ?? [],
    reviewRuns: fixture.reviewRuns ?? [],
    sessions: fixture.sessions ?? [],
    ciChecksByPr: fixture.ciChecksByPr ?? {},
    requiredCheckNamesByPr: fixture.requiredCheckNamesByPr ?? {},
    requiredCheckLookupFailedByPr: fixture.requiredCheckLookupFailedByPr ?? {},
    nowMs: fixture.nowMs,
  });
  const start = tick.actions.find((action) => action.type === 'start_review');
  return { plan, seed, tick, start };
}

describe('review-ready-report-state-seed constants', () => {
  it('uses machine-distinct start reason and poll class', () => {
    expect(REPORT_STATE_SEED_START_REASON).toBe('report_state_seed');
    expect(REEVAL_REPORT_STATE_SEED_START_REASON).toBe('report_state_seed');
    expect(REPORT_STATE_POLL_CLASS).toBe('report_state_poll');
    expect(REPORT_STATE_SEED_TO_START_MAX_MS).toBe(30_000);
    expect(DEFAULT_REPORT_STATE_POLL_TICK_CAPACITY).toBeGreaterThan(0);
  });
});

describe('Issue #391 acceptance criteria', () => {
  it('Gate B recurrence: bc012d8 capture shape seeds report_state_seed when #195-ready', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review_on_head.raw.json'), 'utf8'),
    );
    const fixture = loadFixture('gate-b-ready-green.json');
    const session = capture.data?.[0];
    expect(session?.reports?.some((report: { reportState?: string; accepted?: boolean }) =>
      report.reportState === 'ready_for_review' && report.accepted === true,
    )).toBe(true);

    const { plan, start } = evaluateReadyFixture(fixture);
    expect(plan.candidates).toHaveLength(1);
    expect(start?.startReason).toBe('report_state_seed');
    expect(start?.type).toBe('start_review');
    const processingMs = Number(start?.processingMs ?? 0);
    expect(processingMs).toBeLessThanOrEqual(REPORT_STATE_SEED_TO_START_MAX_MS);
  });

  it('CI-defer then start within bound after CI green', () => {
    const fixture = loadFixture('ci-defer-then-green.json');
    const watchKey = 'chetwerikoff/orchestrator-pack|42:abc11111111111111111111111111111111111111';
    const redEval = evaluateDeferredWatchEntry({
      entry: fixture.watchEntries?.[watchKey],
      openPrs: fixture.openPrs,
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      ciChecksByPr: fixture.ciChecksByPr,
      requiredCheckNamesByPr: fixture.requiredCheckNamesByPr,
      requiredCheckLookupFailedByPr: fixture.requiredCheckLookupFailedByPr,
      nowMs: fixture.nowMs,
    });
    expect(redEval.triggerReviewRun).toBe(false);

    const greenFixture = {
      ...fixture,
      ciChecksByPr: fixture.ciFlipGreen?.ciChecksByPr ?? fixture.ciChecksByPr,
      nowMs: Number(fixture.nowMs) + 5_000,
    };
    const { start } = evaluateReadyFixture(greenFixture);
    expect(start?.startReason).toBe('report_state_seed');
    expect(start?.type).toBe('start_review');
  });

  it('allows reseed after deferred watch expires while dedupe key remains', () => {
    const fixture = loadFixture('gate-b-ready-green.json');
    const repoSlug = 'chetwerikoff/orchestrator-pack';
    const headSha = String(fixture.headSha);
    const prNumber = 380;
    const dedupeKey = reportStateSeedDedupeKey({
      supervisedProject: 'orchestrator-pack',
      repoSlug,
      prNumber,
      headSha,
      reportState: 'ready_for_review',
    });
    const watchKey = reportStateWatchEntryKey(repoSlug, prNumber, headSha);
    const expiredFixture: SeedFixture = {
      ...fixture,
      seededKeys: [dedupeKey],
      watchEntries: {
        [watchKey]: {
          prNumber,
          headSha,
          sessionId: 'opk-165',
          seedMs: 1719018500000,
          windowExpiresMs: 1719018800000,
          seedSource: 'report_state_poll',
          status: 'expired',
          pollClass: 'scoped_deferred_head_watch',
        },
      },
      nowMs: 1719018800001,
    };
    const plan = planFromFixture(expiredFixture);
    expect(plan.releasedSeedKeys).toContain(dedupeKey);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.skips.some((skip) => skip.reason === 'seed_deduped')).toBe(false);
    expect(
      isPersistedReportStateSeedBlocking(
        dedupeKey,
        expiredFixture.watchEntries as Record<string, object>,
        Number(expiredFixture.nowMs),
      ),
    ).toBe(false);
  });

  it('replaces expired watch entry on report-state reseed', () => {
    const repoSlug = 'chetwerikoff/orchestrator-pack';
    const headSha = '2847a9ddeadbeef1234567890abcdef12345678';
    const watchKey = reportStateWatchEntryKey(repoSlug, 380, headSha);
    const priorNow = 1_700_000_000_000;
    const reseedNow = priorNow + 600_000;
    const first = seedWatchFromReportStatePoll({
      candidates: [{
        prNumber: 380,
        headSha,
        repoSlug,
        sessionId: 'opk-165',
        dedupeKey: 'prior',
      }],
      nowMs: priorNow,
    }).watchEntries[watchKey] as Record<string, unknown>;
    expect(first?.status).toBe('watching');
    const reseed = seedWatchFromReportStatePoll({
      candidates: [{
        prNumber: 380,
        headSha,
        repoSlug,
        sessionId: 'opk-165',
        dedupeKey: 'reseed',
      }],
      existingWatches: { [watchKey]: { ...first, status: 'expired' } },
      nowMs: reseedNow,
    });
    const reactivated = reseed.watchEntries[watchKey] as Record<string, unknown>;
    expect(reactivated?.status).toBe('watching');
    expect(Number(reactivated?.windowExpiresMs)).toBeGreaterThan(reseedNow);
  });

  it('isolates report-state watch keys per repository', () => {
    const headSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const shared = {
      prNumber: 1,
      headSha,
      sessionId: 's1',
      dedupeKey: 'dedupe-a',
      repoSlug: 'org/a',
    };
    const other = {
      prNumber: 1,
      headSha,
      sessionId: 's2',
      dedupeKey: 'dedupe-b',
      repoSlug: 'org/b',
    };
    const first = seedWatchFromReportStatePoll({ candidates: [shared], nowMs: 1_700_000_000_000 });
    const second = seedWatchFromReportStatePoll({
      candidates: [other],
      existingWatches: first.watchEntries,
      nowMs: 1_700_000_000_100,
    });
    expect(Object.keys(second.watchEntries)).toHaveLength(2);
    expect(second.watchEntries[reportStateWatchEntryKey('org/a', 1, headSha)]).toBeDefined();
    expect(second.watchEntries[reportStateWatchEntryKey('org/b', 1, headSha)]).toBeDefined();
  });

  it('promoted handoff admission alone does not block report-state seed', () => {
    const fixture = loadFixture('webhook-defer-then-report-seed.json');
    const plan = planFromFixture(fixture);
    expect(plan.candidates).toHaveLength(1);
    const key = 'orchestrator-pack|chetwerikoff/orchestrator-pack|380|2847a9ddeadbeef1234567890abcdef12345678';
    expect(
      isTerminalHandoffAdmissionRecord((fixture.handoffRecords ?? {})[key] as Record<string, unknown>),
    ).toBe(false);
    expect(
      hasTerminalHandoffOutcome({
        supervisedProject: 'orchestrator-pack',
        repoSlug: 'chetwerikoff/orchestrator-pack',
        prNumber: 380,
        headSha: String(fixture.headSha),
        handoffRecords: fixture.handoffRecords,
      }).terminal,
    ).toBe(false);
  });

  it('terminal handoff receipt blocks seed', () => {
    const fixture = loadFixture('terminal-handoff-blocks-seed.json');
    const plan = planFromFixture(fixture);
    expect(plan.candidates).toHaveLength(0);
    expect(
      hasTerminalHandoffOutcome({
        supervisedProject: 'orchestrator-pack',
        repoSlug: 'chetwerikoff/orchestrator-pack',
        prNumber: 77,
        headSha: 'cccccccccccccccccccccccccccccccccccccccc',
        handoffRecords: fixture.handoffRecords,
      }).terminal,
    ).toBe(true);
  });

  it('A→B race: report predates observed tip — no bind, no seed', () => {
    const fixture = loadFixture('head-race-no-bind.json');
    const plan = planFromFixture(fixture);
    expect(plan.candidates).toHaveLength(0);
    const binding = evaluatePollReportBinding({
      report: (fixture.sessions?.[0]?.reports as Array<Record<string, unknown>> | undefined)?.[0],
      currentHeadSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      tipFirstObservedMs: 1719019900000,
      reportEventId: 'opk-55|55|1719019800000|ready_for_review',
    });
    expect(binding.binds).toBe(false);
    expect(binding.reason).toBe('report_predates_observed_tip');
  });

  it('binds accepted report present before first poll observation time', () => {
    const headSha = 'dddddddddddddddddddddddddddddddddddddddd';
    const reportMs = Date.parse('2026-06-22T02:21:00.000Z');
    const nowMs = reportMs + 120_000;
    const plan = planReportStatePollTick({
      sessions: [{
        name: 'opk-88-dead',
        role: 'worker',
        status: 'terminated',
        prNumber: 88,
        reports: [{
          timestamp: new Date(reportMs).toISOString(),
          reportState: 'ready_for_review',
          accepted: true,
          prNumber: 88,
        }],
      }],
      openPrs: [{
        number: 88,
        headRefOid: headSha,
        headCommittedAt: '2026-06-22T02:20:00.000Z',
        baseRefName: 'main',
      }],
      reviewRuns: [],
      bindingByKey: {},
      handoffRecords: {},
      terminalClaimKeys: [],
      existingSeedKeys: [],
      supervisedProject: 'orchestrator-pack',
      fallbackRepoSlug: 'chetwerikoff/orchestrator-pack',
      nowMs,
      deferredScanKeys: [],
    });
    expect(plan.candidates).toHaveLength(1);
    expect(resolveInitialTipFirstObservedMs({
      nowMs,
      headCommittedAtMs: Date.parse('2026-06-22T02:20:00.000Z'),
      anchorReport: {
        timestamp: new Date(reportMs).toISOString(),
        reportState: 'ready_for_review',
        accepted: true,
      },
    })).toBeLessThanOrEqual(reportMs);
  });

  it('terminated session row is not dropped', () => {
    const fixture = loadFixture('terminated-session-seeds.json');
    const plan = planFromFixture(fixture);
    expect(plan.candidates).toHaveLength(1);
  });

  it('considers accepted reports from later session rows for the same PR', () => {
    const fixture = loadFixture('terminated-session-seeds.json');
    const plan = planFromFixture({
      ...fixture,
      sessions: [
        {
          name: 'opk-88-live',
          role: 'worker',
          status: 'working',
          prNumber: 88,
          reports: [{ timestamp: '2026-06-22T02:19:00.000Z', reportState: 'working', accepted: true }],
        },
        ...(fixture.sessions ?? []),
      ],
    });
    expect(plan.candidates).toHaveLength(1);
  });

  it('rejects ready_for_review reports that are not explicitly accepted', () => {
    expect(isAcceptedReadyForReviewReport({ reportState: 'ready_for_review' })).toBe(false);
    expect(isAcceptedReadyForReviewReport({ reportState: 'ready_for_review', accepted: null })).toBe(false);
    expect(isAcceptedReadyForReviewReport({ reportState: 'ready_for_review', accepted: false })).toBe(false);
    expect(isAcceptedReadyForReviewReport({ reportState: 'ready_for_review', accepted: true })).toBe(true);
  });

  it('eventual scan revisits deferred heads when per-tick capacity exceeded', () => {
    const fixture = loadFixture('gate-b-ready-green.json');
    const overloaded = {
      ...fixture,
      openPrs: [
        ...(fixture.openPrs ?? []),
        { number: 381, headRefOid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', headCommittedAt: '2026-06-22T01:08:00.000Z' },
        { number: 382, headRefOid: 'ffffffffffffffffffffffffffffffffffffffff', headCommittedAt: '2026-06-22T01:08:00.000Z' },
      ],
      sessions: [
        ...(fixture.sessions ?? []),
        {
          name: 'opk-381',
          role: 'worker',
          prNumber: 381,
          reports: [{ timestamp: '2026-06-22T01:09:00.000Z', reportState: 'ready_for_review', accepted: true }],
        },
        {
          name: 'opk-382',
          role: 'worker',
          prNumber: 382,
          reports: [{ timestamp: '2026-06-22T01:09:00.000Z', reportState: 'ready_for_review', accepted: true }],
        },
      ],
      tickCapacity: 1,
    };
    const first = planFromFixture(overloaded);
    expect(first.deferredScanKeys.length).toBeGreaterThan(0);
    const second = planFromFixture({
      ...overloaded,
      deferredScanKeys: first.deferredScanKeys,
      nowMs: Number(overloaded.nowMs) + 1_000,
    });
    expect(second.candidates.length + second.skips.length).toBeGreaterThan(0);
  });

  it('classifier negative: covered head defers without start', () => {
    const fixture = loadFixture('gate-b-ready-green.json');
    const covered = {
      ...fixture,
      reviewRuns: [
        {
          prNumber: 380,
          targetSha: fixture.openPrs?.[0]?.headRefOid,
          status: 'clean',
        },
      ],
    };
    const plan = planFromFixture(covered);
    expect(plan.candidates).toHaveLength(0);
  });

  it('multi-repo isolation keeps distinct dedupe keys', () => {
    const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const keyA = reportStateSeedDedupeKey({
      supervisedProject: 'orchestrator-pack',
      repoSlug: 'org/a',
      prNumber: 1,
      headSha: head,
    });
    const keyB = reportStateSeedDedupeKey({
      supervisedProject: 'orchestrator-pack',
      repoSlug: 'org/b',
      prNumber: 1,
      headSha: head,
    });
    expect(keyA).not.toBe(keyB);
  });

  it('does not assign supervised open PR head to foreign-repo session with colliding prNumber', () => {
    const supervised = 'chetwerikoff/orchestrator-pack';
    const localHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const plan = planReportStatePollTick({
      supervisedProject: 'orchestrator-pack',
      fallbackRepoSlug: supervised,
      openPrs: [
        { number: 77, headRefOid: localHead, headCommittedAt: '2026-06-22T01:08:00.000Z' },
      ],
      sessions: [
        {
          name: 'opk-foreign',
          role: 'worker',
          pr: 'https://github.com/org/other/pull/77',
          reports: [
            {
              timestamp: '2026-06-22T01:09:00.000Z',
              reportState: 'ready_for_review',
              accepted: true,
            },
          ],
        },
      ],
      reviewRuns: [],
      bindingByKey: {},
      nowMs: 1_700_000_000_000,
    });
    expect(plan.candidates).toHaveLength(0);
    expect(resolveOpenPrForRepoAndNumber(
      [{ number: 77, headRefOid: localHead }],
      'org/other',
      77,
      supervised,
    )).toBeNull();
  });

  it('filters status sessions to the supervised project before grouping', () => {
    const supervised = 'chetwerikoff/orchestrator-pack';
    const localHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const plan = planReportStatePollTick({
      supervisedProject: 'orchestrator-pack',
      fallbackRepoSlug: supervised,
      openPrs: [
        { number: 77, headRefOid: localHead, headCommittedAt: '2026-06-22T01:08:00.000Z' },
      ],
      sessions: [
        {
          name: 'opk-foreign',
          project: 'foreign-pack',
          role: 'worker',
          prNumber: 77,
          reports: [
            {
              timestamp: '2026-06-22T01:09:00.000Z',
              reportState: 'ready_for_review',
              accepted: true,
            },
          ],
        },
      ],
      reviewRuns: [],
      bindingByKey: {},
      nowMs: 1_700_000_000_000,
    });
    expect(plan.candidates).toHaveLength(0);
    expect(collectStatusSessionsForPoll([
      { name: 'opk-foreign', project: 'foreign-pack', prNumber: 77 },
      { name: 'opk-local', project: 'orchestrator-pack', prNumber: 77 },
      { name: 'opk-legacy', prNumber: 77 },
    ], 'orchestrator-pack')).toHaveLength(2);
    expect(sessionMatchesSupervisedProject({ project: 'foreign-pack' }, 'orchestrator-pack')).toBe(false);
  });

  it('selects the first accepted ready_for_review report in emission order', () => {
    const skewedReports = [
      {
        timestamp: '2026-06-22T01:00:00.000Z',
        reportState: 'ready_for_review',
        accepted: true,
        note: 'newest-first emission with skewed older timestamp',
      },
      {
        timestamp: '2026-06-22T02:00:00.000Z',
        reportState: 'ready_for_review',
        accepted: true,
        note: 'older emission with skewed newer timestamp',
      },
    ];
    const session = { name: 'opk-77', role: 'worker', prNumber: 77, reports: skewedReports };
    expect(findLatestAcceptedReadyForReviewReport(session)).toBe(skewedReports[0]);
    expect(findLatestAcceptedReadyForReviewAcrossSessions([session]).report).toBe(skewedReports[0]);
  });

  it('selects the newest accepted ready_for_review across matching sessions', () => {
    const staleSession = {
      name: 'opk-88-stale',
      role: 'worker',
      status: 'terminated',
      prNumber: 88,
      reports: [{
        timestamp: '2026-06-22T02:19:00.000Z',
        reportState: 'ready_for_review',
        accepted: true,
      }],
    };
    const freshSession = {
      name: 'opk-88-fresh',
      role: 'worker',
      status: 'working',
      prNumber: 88,
      reports: [{
        timestamp: '2026-06-22T02:21:00.000Z',
        reportState: 'ready_for_review',
        accepted: true,
      }],
    };
    const result = findLatestAcceptedReadyForReviewAcrossSessions([staleSession, freshSession]);
    expect(result.session).toBe(freshSession);
    expect(result.report).toBe(freshSession.reports[0]);
  });

  it('reverts optimistic triggered marks for unexecuted deferred-watch actions', () => {
    const deferredKey = '50:cccccccccccccccccccccccccccccccccccccccc';
    const seedKey = '99:dddddddddddddddddddddddddddddddddddddddd';
    const nowMs = 1_700_000_000_000;
    const triggered = {
      [deferredKey]: { prNumber: 50, headSha: 'cccccccccccccccccccccccccccccccccccccccc', status: 'triggered' },
      [seedKey]: { prNumber: 99, headSha: 'dddddddddddddddddddddddddddddddddddddddd', status: 'triggered' },
    } as Record<string, Record<string, unknown>>;
    const afterRevert = revertTriggeredWatchOnAbort(
      triggered as never,
      deferredKey,
      nowMs,
    );
    expect(afterRevert[deferredKey].status).toBe('watching');
    expect(afterRevert[seedKey].status).toBe('triggered');
  });

  it('concurrent seed for same dedupe key merges to one watch entry', () => {
    const candidate = {
      prNumber: 99,
      headSha: '9999999999999999999999999999999999999999',
      sessionId: 'opk-99',
      dedupeKey: 'dedupe-99',
    };
    const first = seedWatchFromReportStatePoll({ candidates: [candidate], nowMs: 1_700_000_000_000 });
    const second = seedWatchFromReportStatePoll({
      candidates: [candidate],
      existingWatches: first.watchEntries,
      nowMs: 1_700_000_000_100,
    });
    expect(Object.keys(second.watchEntries)).toHaveLength(1);
    expect(resolveStartReasonForWatchEntry(second.watchEntries['99:9999999999999999999999999999999999999999'] as Record<string, unknown>))
      .toBe('report_state_seed');
  });

  it('poll binding clears on tip change until a fresh report binds', () => {
    const key = pollBindingStateKey({ repoSlug: 'org/a', prNumber: 12 });
    const first = updatePollBindingStateEntry({
      bindingByKey: {},
      repoSlug: 'org/a',
      prNumber: 12,
      currentHeadSha: 'headaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      nowMs: 1_000,
      latestAcceptedReport: {
        timestamp: '1970-01-01T00:00:01.500Z',
        reportState: 'ready_for_review',
        accepted: true,
      },
      sessionId: 'opk-12',
    });
    expect(first.binds).toBe(true);
    const second = updatePollBindingStateEntry({
      bindingByKey: first.bindingByKey,
      repoSlug: 'org/a',
      prNumber: 12,
      currentHeadSha: 'headbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      nowMs: 2_000,
      latestAcceptedReport: {
        timestamp: '1970-01-01T00:00:01.500Z',
        reportState: 'ready_for_review',
        accepted: true,
      },
      sessionId: 'opk-12',
    });
    expect(second.binds).toBe(false);
    expect((second.bindingByKey as Record<string, Record<string, unknown>>)[key]?.boundHeadSha).not.toBe('headbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });
});
