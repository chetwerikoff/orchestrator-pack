import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_SEND_INTERVAL_MS,
  buildDedupeKey,
  buildReviewSendArgv,
  buildMergedPrNumberSet,
  countAmbiguousNeedsTriagePeers,
  evaluateFirstSendCandidate,
  evaluateReviewSendInterval,
  findForbiddenReviewSendReconcileCommands,
  isNeedsTriageNeverSentRun,
  planReviewSendActions,
  preSendRecheck,
  recordSuccessfulSend,
  resolveOpenFindingCount,
  resolveSentFindingCount,
  verifyRunSentStateAfterSend,
  type ReviewSendAction,
} from '../docs/review-send-reconcile.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/review-send-reconcile',
);

const HEAD = 'abc123def456';
const PR = 202;

function liveWorker(overrides: Record<string, unknown> = {}) {
  return {
    name: 'opk-11',
    role: 'worker',
    prNumber: PR,
    ownedHeadSha: HEAD,
    runtime: 'alive',
    status: 'working',
    ...overrides,
  };
}

function needsTriageRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-202',
    prNumber: PR,
    targetSha: HEAD,
    status: 'needs_triage',
    openFindingCount: 2,
    sentFindingCount: 0,
    linkedSessionId: 'opk-11',
    ...overrides,
  };
}

function openPr(head = HEAD) {
  return { number: PR, headRefOid: head };
}

function plan(input: Parameters<typeof planReviewSendActions>[0]) {
  return planReviewSendActions(input);
}

function sendActions(actions: ReviewSendAction[]) {
  return actions.filter(
    (a): a is Extract<ReviewSendAction, { type: 'send' }> => a.type === 'send',
  );
}

function loadFixture(name: string) {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as Parameters<
    typeof planReviewSendActions
  >[0];
}

describe('resolveSentFindingCount', () => {
  it('fails closed when missing', () => {
    expect(resolveSentFindingCount({})).toEqual({
      ok: false,
      reason: 'sent_finding_count_missing',
    });
  });

  it('accepts zero', () => {
    expect(resolveSentFindingCount({ sentFindingCount: 0 })).toEqual({ ok: true, count: 0 });
  });
});

describe('isNeedsTriageNeverSentRun', () => {
  it('is true for qualifying needs_triage run', () => {
    expect(isNeedsTriageNeverSentRun(needsTriageRun())).toBe(true);
  });

  it('is false for waiting_update', () => {
    expect(
      isNeedsTriageNeverSentRun(
        needsTriageRun({ status: 'waiting_update', sentFindingCount: 1 }),
      ),
    ).toBe(false);
  });
});

describe('first-send happy path (AC1)', () => {
  it('plans ao review send for qualifying needs_triage run', () => {
    const { actions } = plan({
      reviewRuns: [needsTriageRun()],
      sessions: [liveWorker()],
      openPrs: [openPr()],
      tracking: { sent: {} },
    });
    expect(sendActions(actions)).toHaveLength(1);
    expect(sendActions(actions)[0]).toMatchObject({
      runId: 'run-202',
      prNumber: PR,
      targetSha: HEAD,
      sessionId: 'opk-11',
    });
  });
});

describe('fail-closed matrix (AC2)', () => {
  const base = {
    reviewRuns: [needsTriageRun()],
    sessions: [liveWorker()],
    openPrs: [openPr()],
    tracking: { sent: {} },
  };

  it('skips when not needs_triage', () => {
    const { actions } = plan({
      ...base,
      reviewRuns: [needsTriageRun({ status: 'waiting_update', sentFindingCount: 1 })],
    });
    expect(sendActions(actions)).toHaveLength(0);
  });

  it('skips when already sent', () => {
    const { actions } = plan({
      ...base,
      reviewRuns: [needsTriageRun({ sentFindingCount: 1 })],
    });
    expect(sendActions(actions)).toHaveLength(0);
  });

  it('skips when sentFindingCount missing', () => {
    const run = needsTriageRun();
    delete (run as { sentFindingCount?: number }).sentFindingCount;
    const { actions } = plan({ ...base, reviewRuns: [run] });
    expect(sendActions(actions)).toHaveLength(0);
  });

  it('skips when stale head', () => {
    const { actions } = plan({
      ...base,
      openPrs: [{ number: PR, headRefOid: 'newhead99' }],
    });
    expect(sendActions(actions)).toHaveLength(0);
  });

  it('skips when linked session dead', () => {
    const { actions } = plan({
      ...base,
      sessions: [liveWorker({ status: 'terminated' })],
    });
    expect(sendActions(actions)).toHaveLength(0);
  });

  it('skips when linked session not head-owning', () => {
    const { actions } = plan({
      ...base,
      sessions: [liveWorker({ ownedHeadSha: 'otherhead' })],
    });
    expect(sendActions(actions)).toHaveLength(0);
  });

  it('skips when PR merged (not in open list)', () => {
    const { actions } = plan({
      ...base,
      openPrs: [],
      mergedPrNumbers: [PR],
    });
    expect(sendActions(actions)).toHaveLength(0);
  });

  it('skips failed run', () => {
    const { actions } = plan({
      ...base,
      reviewRuns: [needsTriageRun({ status: 'failed' })],
    });
    expect(sendActions(actions)).toHaveLength(0);
  });

  it('skips outdated run', () => {
    const { actions } = plan({
      ...base,
      reviewRuns: [needsTriageRun({ status: 'outdated' })],
    });
    expect(sendActions(actions)).toHaveLength(0);
  });

  it('skips ambiguous overlapping runs', () => {
    const { actions } = plan({
      ...base,
      reviewRuns: [
        needsTriageRun({ id: 'run-a' }),
        needsTriageRun({ id: 'run-b', linkedSessionId: 'opk-11' }),
      ],
    });
    expect(sendActions(actions)).toHaveLength(0);
    expect(actions.some((a) => a.type === 'skip' && a.reason === 'ambiguous_overlapping_runs')).toBe(
      true,
    );
  });
});

describe('action surface (AC3)', () => {
  it('forbids spawn, claim-pr, kill, send, report, review run', () => {
    const violations = findForbiddenReviewSendReconcileCommands([
      'ao spawn worker',
      'ao session claim-pr 1',
      'ao session kill x',
      'ao send worker hi',
      'ao report working',
      'ao review run sess --execute',
    ]);
    expect(violations).toHaveLength(6);
  });

  it('allows ao review send', () => {
    const violations = findForbiddenReviewSendReconcileCommands([
      'ao review send run-abc',
    ]);
    expect(violations).toHaveLength(0);
    expect(buildReviewSendArgv('run-abc')).toEqual(['review', 'send', 'run-abc']);
  });
});

describe('dedupe across restart (AC4)', () => {
  it('does not plan second send when dedupe recorded', () => {
    const dedupeKey = buildDedupeKey('run-202', HEAD);
    const { actions } = plan({
      reviewRuns: [needsTriageRun()],
      sessions: [liveWorker()],
      openPrs: [openPr()],
      tracking: {
        sent: {
          [dedupeKey]: { runId: 'run-202', targetSha: HEAD, sessionId: 'opk-11', sentAtMs: 1 },
        },
      },
    });
    expect(sendActions(actions)).toHaveLength(0);
  });

  it('records dedupe only after successful send helper', () => {
    const dedupeKey = buildDedupeKey('run-202', HEAD);
    const next = recordSuccessfulSend({ sent: {} }, dedupeKey, {
      runId: 'run-202',
      targetSha: HEAD,
      sessionId: 'opk-11',
      sentAtMs: 1000,
    });
    expect(next.sent?.[dedupeKey]).toBeDefined();
  });
});

describe('handoff to #171 (AC7)', () => {
  it('never sends waiting_update runs', () => {
    const { actions } = plan({
      reviewRuns: [
        needsTriageRun({
          status: 'waiting_update',
          sentFindingCount: 1,
          openFindingCount: 0,
        }),
      ],
      sessions: [liveWorker()],
      openPrs: [openPr()],
      tracking: { sent: {} },
    });
    expect(sendActions(actions)).toHaveLength(0);
  });
});

describe('race safety (AC8)', () => {
  it('pre-send recheck fails when other sender already sent', () => {
    const planned = {
      runId: 'run-202',
      prNumber: PR,
      targetSha: HEAD,
      sessionId: 'opk-11',
    };
    const fresh = {
      reviewRuns: [
        needsTriageRun({
          status: 'waiting_update',
          sentFindingCount: 1,
          openFindingCount: 0,
        }),
      ],
      sessions: [liveWorker()],
      openPrs: [openPr()],
    };
    expect(preSendRecheck(planned, fresh).ok).toBe(false);
  });

  it('pre-send recheck fails when head advanced', () => {
    const planned = {
      runId: 'run-202',
      prNumber: PR,
      targetSha: HEAD,
      sessionId: 'opk-11',
    };
    const fresh = {
      reviewRuns: [needsTriageRun()],
      sessions: [liveWorker({ ownedHeadSha: 'newhead99' })],
      openPrs: [{ number: PR, headRefOid: 'newhead99' }],
    };
    expect(preSendRecheck(planned, fresh).ok).toBe(false);
    expect(preSendRecheck(planned, fresh).reason).toContain('recheck_failed');
  });
});

describe('AO sent-state probe (AC10)', () => {
  it('verify fails when sentFindingCount still missing after send', () => {
    expect(
      verifyRunSentStateAfterSend(needsTriageRun(), 'run-202', HEAD).ok,
    ).toBe(false);
  });

  it('verify passes when run left needs_triage with sent findings', () => {
    expect(
      verifyRunSentStateAfterSend(
        needsTriageRun({
          status: 'waiting_update',
          sentFindingCount: 2,
          openFindingCount: 0,
        }),
        'run-202',
        HEAD,
      ).ok,
    ).toBe(true);
  });
});

describe('fixture ticks', () => {
  it('happy-path fixture plans one send', () => {
    const fixture = loadFixture('happy-needs-triage.json');
    const { actions } = plan(fixture);
    expect(sendActions(actions)).toHaveLength(1);
  });

  it('merged-pr fixture plans no send', () => {
    const fixture = loadFixture('merged-pr.json');
    const { actions } = plan(fixture);
    expect(sendActions(actions)).toHaveLength(0);
  });
});

describe('interval gate (AC5)', () => {
  it('defaults to 2-minute cadence', () => {
    expect(DEFAULT_REVIEW_SEND_INTERVAL_MS).toBe(120_000);
    expect(
      evaluateReviewSendInterval({
        nowMs: 200_000,
        lastTickMs: 50_000,
      }).ok,
    ).toBe(true);
    expect(
      evaluateReviewSendInterval({
        nowMs: 100_000,
        lastTickMs: 50_000,
      }).ok,
    ).toBe(false);
  });
});

describe('buildMergedPrNumberSet', () => {
  it('marks PR absent from open list as merged', () => {
    const merged = buildMergedPrNumberSet([needsTriageRun()], [], []);
    expect(merged.has(PR)).toBe(true);
  });
});

describe('countAmbiguousNeedsTriagePeers', () => {
  it('counts peers on same pr and head', () => {
    expect(
      countAmbiguousNeedsTriagePeers(
        [needsTriageRun({ id: 'a' }), needsTriageRun({ id: 'b' })],
        needsTriageRun(),
      ),
    ).toBe(2);
  });
});

describe('evaluateFirstSendCandidate', () => {
  it('reports open finding count missing', () => {
    const run = needsTriageRun();
    delete (run as { openFindingCount?: number }).openFindingCount;
    const result = evaluateFirstSendCandidate(
      run,
      [liveWorker()],
      [openPr()],
      new Set(),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('open_finding_count_missing');
  });
});
