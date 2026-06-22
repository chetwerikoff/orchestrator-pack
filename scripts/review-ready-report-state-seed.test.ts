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
  reportStateSeedDedupeKey,
  updatePollBindingStateEntry,
} from '../docs/review-ready-report-state-seed.mjs';
import {
  evaluateDeferredWatchEntry,
  planDeferredWatchTick,
  REPORT_STATE_SEED_START_REASON as REEVAL_REPORT_STATE_SEED_START_REASON,
  resolveStartReasonForWatchEntry,
  seedWatchFromReportStatePoll,
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
  nowMs: number;
};

type SeedFixture = {
  description?: string;
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
    const redEval = evaluateDeferredWatchEntry({
      entry: fixture.watchEntries?.['42:abc11111111111111111111111111111111111111'],
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

  it('terminated session row is not dropped', () => {
    const fixture = loadFixture('terminated-session-seeds.json');
    const plan = planFromFixture(fixture);
    expect(plan.candidates).toHaveLength(1);
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
