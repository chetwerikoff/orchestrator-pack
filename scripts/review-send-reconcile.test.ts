import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_SEND_INTERVAL_MS,
  REVIEW_SEND_RECONCILE_REMOVED,
  REVIEW_SEND_RECONCILE_REMOVED_REASON,
  buildDedupeKey,
  countAmbiguousNeedsTriagePeers,
  evaluateFirstSendCandidate,
  evaluateReviewSendInterval,
  findForbiddenReviewSendReconcileCommands,
  isNeedsTriageNeverSentRun,
  planReviewSendActions,
  resolveOpenFindingCount,
  resolveSentFindingCount,
  verifyRunSentStateAfterSend,
} from '../docs/review-send-reconcile.mjs';

const HEAD = 'abc123def456';
const PR = 202;

function undeliveredRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-202',
    prNumber: PR,
    targetSha: HEAD,
    prReviewStatus: 'changes_requested',
    status: 'changes_requested',
    openFindingCount: 2,
    deliveredFindingCount: 0,
    linkedSessionId: 'opk-11',
    ...overrides,
  };
}

function liveWorker(overrides: Record<string, unknown> = {}) {
  return {
    name: 'opk-11',
    role: 'worker',
    prNumber: PR,
    ownedHeadSha: HEAD,
    status: 'working',
    activity: 'ready',
    ...overrides,
  };
}

function openPr(head = HEAD) {
  return { number: PR, headRefOid: head };
}

describe('review-send-reconcile REMOVED (#625)', () => {
  it('exports REMOVED sentinel', () => {
    expect(REVIEW_SEND_RECONCILE_REMOVED).toBe(true);
    expect(REVIEW_SEND_RECONCILE_REMOVED_REASON).toBe('ao_0_10_auto_delivery');
  });

  it('planReviewSendActions returns empty actions (auto-delivery supersedes send)', () => {
    const result = planReviewSendActions({
      reviewRuns: [undeliveredRun()],
      sessions: [liveWorker()],
      openPrs: [openPr()],
      tracking: { sent: {} },
    });
    expect(result.actions).toEqual([]);
    expect(result.removed).toBe(true);
    expect(result.reason).toBe('ao_0_10_auto_delivery');
  });
});

describe('resolveSentFindingCount (deliveredFindingCount)', () => {
  it('fails closed when missing', () => {
    expect(resolveSentFindingCount({})).toEqual({
      ok: false,
      reason: 'delivered_finding_count_missing',
    });
  });

  it('accepts zero', () => {
    expect(resolveSentFindingCount({ deliveredFindingCount: 0 })).toEqual({ ok: true, count: 0 });
  });
});

describe('isNeedsTriageNeverSentRun (undelivered changes_requested)', () => {
  it('is true for qualifying undelivered run', () => {
    expect(isNeedsTriageNeverSentRun(undeliveredRun())).toBe(true);
  });

  it('is false when delivered', () => {
    expect(
      isNeedsTriageNeverSentRun(
        undeliveredRun({
          deliveredAt: '2026-07-06T00:00:00.000Z',
          deliveredFindingCount: 2,
        }),
      ),
    ).toBe(false);
  });
});

describe('evaluateFirstSendCandidate predicates (unit only; plan is REMOVED)', () => {
  const merged = new Set<number>();

  it('eligible for undelivered changes_requested on live head owner', () => {
    const result = evaluateFirstSendCandidate(
      undeliveredRun(),
      [liveWorker()],
      [openPr()],
      merged,
    );
    expect(result.eligible).toBe(true);
  });

  it('reports open finding count missing', () => {
    const result = evaluateFirstSendCandidate(
      undeliveredRun({ openFindingCount: undefined }),
      [liveWorker()],
      [openPr()],
      merged,
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('open_finding_count_missing');
  });
});

describe('countAmbiguousNeedsTriagePeers', () => {
  it('counts peers on same pr and head', () => {
    expect(
      countAmbiguousNeedsTriagePeers(
        [undeliveredRun({ id: 'a' }), undeliveredRun({ id: 'b' })],
        undeliveredRun({ id: 'a' }),
      ),
    ).toBe(2);
  });
});

describe('verifyRunSentStateAfterSend', () => {
  it('passes when delivered with positive deliveredFindingCount', () => {
    expect(
      verifyRunSentStateAfterSend(
        {
          id: 'run-202',
          prReviewStatus: 'changes_requested',
          status: 'changes_requested',
          targetSha: HEAD,
          deliveredAt: '2026-07-06T00:00:00.000Z',
          deliveredFindingCount: 2,
        },
        'run-202',
        HEAD,
      ),
    ).toEqual({ ok: true, reason: 'ok' });
  });
});

describe('mechanical helpers', () => {
  it('buildDedupeKey normalizes sha', () => {
    expect(buildDedupeKey('run-1', HEAD)).toBe(`run-1:${HEAD.slice(0, 12).toLowerCase()}`);
  });

  it('evaluateReviewSendInterval uses default cadence', () => {
    expect(evaluateReviewSendInterval({ nowMs: 0, lastTickMs: null }).ok).toBe(true);
    expect(DEFAULT_REVIEW_SEND_INTERVAL_MS).toBe(120_000);
  });

  it('resolveOpenFindingCount fails closed when missing', () => {
    expect(resolveOpenFindingCount({})).toEqual({ ok: false, reason: 'open_finding_count_missing' });
  });

  it('forbids ao review run on mechanical path', () => {
    expect(
      findForbiddenReviewSendReconcileCommands(['ao review run op-1 --execute --command x']),
    ).not.toHaveLength(0);
  });
});
