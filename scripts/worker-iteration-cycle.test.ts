import { describe, expect, it } from 'vitest';
import {
  BLOCKER_PRECEDENCE,
  NUDGE_EXPIRY_MS,
  OPEN_REVISION_STUCK_BOUND_MS,
  QUIESCENCE_DEBOUNCE_MS,
  STALE_PENDING_DELIVERY_BOUND_MS,
  bootstrapLegacyNudgedCycle,
  buildOwnerCycleKey,
  buildPrScopedKey,
  buildSurfaceStateKey,
  choosePrimaryBlocker,
  evaluateNudgeCycleGate,
  evaluateOpenReviewRevision,
  evaluateReviewCycleGate,
  evaluateSettleActionPrecedence,
  normalizeCanonicalRepoIdentity,
  resolveOrAdvanceOwnerCycle,
} from '../docs/worker-iteration-cycle.mjs';
import { planCiGreenWakeActions } from '../docs/ci-green-wake-reconcile.mjs';

const greenChecks = [
  { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
  { name: 'PR scope guard', state: 'SUCCESS' },
  { name: 'Run pack contract tests', state: 'SUCCESS' },
  { name: 'Self-architect lint', state: 'SUCCESS' },
];

function liveWorker(overrides: Record<string, unknown> = {}) {
  return {
    name: 'op-worker',
    role: 'worker',
    prNumber: 42,
    ownedHeadSha: 'abc123',
    status: 'fixing_ci',
    activity: 'idle',
    runtime: 'alive',
    reports: [],
    ...overrides,
  };
}

describe('named timer bounds', () => {
  it('nudge expiry is at least quiescence debounce', () => {
    expect(NUDGE_EXPIRY_MS).toBeGreaterThanOrEqual(QUIESCENCE_DEBOUNCE_MS);
  });

  it('exports stuck and stale delivery bounds', () => {
    expect(OPEN_REVISION_STUCK_BOUND_MS).toBeGreaterThan(0);
    expect(STALE_PENDING_DELIVERY_BOUND_MS).toBeGreaterThan(0);
  });
});

describe('canonical key helpers', () => {
  it('normalizes WSL and Windows repo paths to the same identity', () => {
    const linux = normalizeCanonicalRepoIdentity('/mnt/c/Users/op/orchestrator-pack');
    const windows = normalizeCanonicalRepoIdentity('C:\\Users\\op\\orchestrator-pack');
    expect(linux).toBe(windows);
  });

  it('builds discriminated surface keys', () => {
    const repoId = normalizeCanonicalRepoIdentity('/repo');
    expect(buildSurfaceStateKey('ci_green_nudge', repoId, 42, 'op-1')).toContain('surface:ci_green_nudge');
    expect(buildPrScopedKey(repoId, 42)).toBe(`${repoId}:pr:42`);
    expect(buildOwnerCycleKey(repoId, 42, 'op-1')).toContain(':owner:op-1');
  });
});

describe('multi-blocker precedence', () => {
  it('chooses the most durable blocker', () => {
    expect(
      choosePrimaryBlocker(['quiescence_debounce_pending', 'prior_revision_open', 'worker_actively_working']),
    ).toBe('prior_revision_open');
    expect(BLOCKER_PRECEDENCE.indexOf('prior_revision_open')).toBeLessThan(
      BLOCKER_PRECEDENCE.indexOf('quiescence_debounce_pending'),
    );
  });
});

describe('open review revision', () => {
  it('defers while findings are dispatched but not drained', () => {
    const open = evaluateOpenReviewRevision({
      reviewRuns: [
        {
          id: 'run-1',
          prNumber: 42,
          targetSha: 'abc123',
          status: 'waiting_update',
          sentFindingCount: 2,
          sentAt: '2026-06-01T00:00:00.000Z',
        },
      ],
      prNumber: 42,
      session: liveWorker({ reports: [{ reportState: 'addressing_reviews', reportedAt: '2026-06-01T00:01:00.000Z' }] }),
      currentHeadSha: 'def456',
      nowMs: Date.parse('2026-06-01T00:02:00.000Z'),
    });
    expect(open.open).toBe(true);
    expect(open.runId).toBe('run-1');
  });

  it('releases immediately on clean no-findings review', () => {
    const open = evaluateOpenReviewRevision({
      reviewRuns: [
        {
          id: 'run-clean',
          prNumber: 42,
          targetSha: 'abc123',
          status: 'clean',
          findingCount: 0,
          sentFindingCount: 0,
        },
      ],
      prNumber: 42,
      session: liveWorker(),
      currentHeadSha: 'abc123',
    });
    expect(open.open).toBe(false);
  });
});

describe('per-cycle head burst', () => {
  const baseNow = Date.parse('2026-06-01T01:00:00.000Z');
  const settledAt = baseNow - QUIESCENCE_DEBOUNCE_MS - 1000;

  it('allows at most one CI-green nudge across H1→H2→H3 within one cycle', () => {
    let cycleState = {};
    const heads = ['h1', 'h2', 'h3'];
    let nudgeCount = 0;

    for (const headSha of heads) {
      const result = planCiGreenWakeActions({
        openPrs: [{ number: 42, headRefOid: headSha, headCommittedAt: settledAt }],
        sessions: [
          liveWorker({
            ownedHeadSha: headSha,
            reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
          }),
        ],
        ciChecksByPr: { 42: greenChecks },
        tracking: { cycleState, heads: {}, nudged: {} },
        reviewRuns: [],
        nowMs: baseNow,
      });
      cycleState = result.cycleState ?? {};
      nudgeCount += result.actions.filter((a) => a.type === 'nudge').length;
    }

    expect(nudgeCount).toBeLessThanOrEqual(1);
  });

  it('suppresses nudge for actively working worker even when CI is green', () => {
    const result = planCiGreenWakeActions({
      openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: baseNow }],
      sessions: [
        liveWorker({
          activity: 'active',
          status: 'working',
          reports: [{ reportState: 'working', reportedAt: '2026-06-01T01:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {},
      nowMs: baseNow,
    });
    expect(result.actions.some((a) => a.type === 'nudge')).toBe(false);
    expect(result.actions.some((a) => a.type === 'skip' && a.reason === 'worker_actively_working')).toBe(true);
  });
});

describe('settle action precedence', () => {
  it('prefers nudge before fallback and never co-fires both', () => {
    const first = evaluateSettleActionPrecedence({
      cycle: { cycleId: 'c1', nudgeArmed: false, fallbackArmed: false },
      quiescentFallbackEligible: true,
      nudgeEligible: true,
      nowMs: 1000,
    });
    expect(first.action).toBe('nudge');

    const outstanding = evaluateSettleActionPrecedence({
      cycle: {
        cycleId: 'c1',
        nudgeArmed: true,
        nudgeExpiresAtMs: 5000,
        fallbackArmed: false,
      },
      quiescentFallbackEligible: true,
      nudgeEligible: false,
      nowMs: 2000,
    });
    expect(outstanding.action).not.toBe('nudge');
    expect(outstanding.action).not.toBe('fallback');

    const afterExpiry = evaluateSettleActionPrecedence({
      cycle: {
        cycleId: 'c1',
        nudgeArmed: true,
        nudgeExpiresAtMs: 5000,
        fallbackArmed: false,
      },
      quiescentFallbackEligible: true,
      nudgeEligible: false,
      nowMs: 6000,
    });
    expect(afterExpiry.action).toBe('fallback');
  });
});

describe('legacy nudge migration', () => {
  it('bootstraps already-nudged state from per-head transition journal', () => {
    const state = bootstrapLegacyNudgedCycle(
      {},
      { '42:abc123:1': { sessionId: 'op-worker', sentAtMs: 1000 } },
      42,
      'op-worker',
    );
    const repoId = normalizeCanonicalRepoIdentity('orchestrator-pack');
    const cycle = state.ownerCycles?.[buildOwnerCycleKey(repoId, 42, 'op-worker')];
    expect(cycle?.nudgeArmed).toBe(true);
  });
});

describe('review cycle gate matrix cells', () => {
  it('C2/C4: prior revision open defers new review', () => {
    const gate = evaluateReviewCycleGate({
      cycle: { reviewArmed: false },
      openRevision: { open: true, runId: 'run-9', reason: 'revision_findings_open' },
      reviewRuns: [],
      prNumber: 42,
      headSha: 'abc123',
      handoffAccepted: true,
      readyDebounce: { settled: true, waiting: false, reason: 'settled' },
    });
    expect(gate.allow).toBe(false);
    expect(gate.primary).toBe('prior_revision_open');
  });

  it('C8: nudge gate blocks while prior revision open even if idle', () => {
    const gate = evaluateNudgeCycleGate({
      cycle: { nudgeArmed: false },
      openRevision: { open: true, runId: 'run-9' },
      activelyWorking: false,
      debouncePending: false,
      handedOff: false,
    });
    expect(gate.allow).toBe(false);
    expect(gate.primary).toBe('prior_revision_open');
  });
});

describe('owner cycle advance', () => {
  it('advances head without opening a new cycle', () => {
    const repoId = 'repo';
    const first = resolveOrAdvanceOwnerCycle({
      state: {},
      repoId,
      prNumber: 42,
      ownerSessionId: 'op-worker',
      headSha: 'h1',
      nowMs: 1000,
    });
    const second = resolveOrAdvanceOwnerCycle({
      state: first.state,
      repoId,
      prNumber: 42,
      ownerSessionId: 'op-worker',
      headSha: 'h2',
      nowMs: 2000,
    });
    expect(second.advanced).toBe(true);
    expect(second.opened).toBe(false);
    expect(second.cycle?.cycleId).toBe(first.cycle?.cycleId);
    expect(second.cycle?.headAdvanceCount).toBe(1);
  });
});
