import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NOT_READY_COMPONENT_PRECEDENCE,
  choosePrimaryNotReadyComponent,
} from '../docs/review-head-ready.mjs';
import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  buildReviewRunArgv,
  evaluateReconcileInterval,
  findForbiddenLifecycleCommands,
  findFailedOrCancelledRunForHead,
  isHeadCovered,
  isRunCoveringHead,
  collectSessionIdentifiers,
  findSessionById,
  getSessionIdentifier,
  isLiveWorkerSession,
  sessionMatchesIdentifier,
  planReconcileActions,
  resolveHeadOwningWorkerSessionId,
  resolveStrictHeadOwningWorkerSession,
  resolveWorkerSessionId,
  unwrapReconcilePlanResult,
  type PlanReconcileInput,
  type ReconcileAction,
} from '../docs/review-trigger-reconcile.mjs';
import { NUDGE_EXPIRY_MS, QUIESCENCE_DEBOUNCE_MS, CYCLE_SURFACE_READY_FOR_REVIEW, commitReviewStartedCycleState, buildOwnerCycleKey, normalizeCanonicalRepoIdentity } from '../docs/worker-iteration-cycle.mjs';
import { mergeLegacyNudgedWithPendingJournal } from '../docs/ci-green-wake-reconcile.mjs';

const greenChecks = [
  { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
  { name: 'PR scope guard', state: 'SUCCESS' },
  { name: 'Run pack contract tests', state: 'SUCCESS' },
  { name: 'Self-architect lint', state: 'SUCCESS' },
];

function startReviewActions(actions: ReconcileAction[]) {
  return actions.filter((a): a is Extract<ReconcileAction, { type: 'start_review' }> => a.type === 'start_review');
}

function skipActions(actions: ReconcileAction[]) {
  return actions.filter((a): a is Extract<ReconcileAction, { type: 'skip' }> => a.type === 'skip');
}

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/review-trigger-reconcile',
);

type FixturePayload = PlanReconcileInput & {
  expect?: {
    startReviewCount?: number;
    sessionId?: string;
    skipReason?: string;
    trackDegradedCi?: boolean;
    escalateDegradedCi?: boolean;
    notSkipReason?: string;
    record?: {
      branch?: string;
      primary?: string;
      failedComponents?: string[];
      observed?: Record<string, unknown>;
    };
  };
};

function loadFixture(name: string): FixturePayload {
  const raw = readFileSync(path.join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as FixturePayload;
}

type FailedRetryExhaustedFixture = {
  runs: Array<{
    id: string;
    prNumber: number;
    targetSha: string;
    status: string;
    retryEligible?: boolean;
    retryCount?: number;
    createdAt: string;
  }>;
  prNumber: number;
  headSha: string;
  expect: { retryEligible: boolean; runId: string };
};

function loadFailedRetryExhaustedFixture(name: string): FailedRetryExhaustedFixture {
  const raw = readFileSync(path.join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as FailedRetryExhaustedFixture;
}

describe('isRunCoveringHead', () => {
  it.each([
    ['queued', true],
    ['preparing', true],
    ['running', true],
    ['reviewing', true],
    ['clean', true],
    ['needs_triage', true],
    ['waiting_update', true],
    ['outdated', false],
    ['failed', false],
    ['cancelled', false],
  ])('status %s covered=%s', (status, covered) => {
    expect(isRunCoveringHead({ status })).toBe(covered);
  });
});

describe('isHeadCovered', () => {
  const head = 'abc123';
  const pr = 42;

  it('is false when no runs exist for the head', () => {
    expect(isHeadCovered([], pr, head)).toBe(false);
  });

  it('is true when only outdated runs exist', () => {
    expect(
      isHeadCovered(
        [{ prNumber: pr, targetSha: head, status: 'outdated' }],
        pr,
        head,
      ),
    ).toBe(false);
  });
});

describe('findFailedOrCancelledRunForHead', () => {
  it('selects the latest failed/cancelled row for retry exhaustion', () => {
    const fixture = loadFailedRetryExhaustedFixture('failed-retry-exhausted-latest.json');
    const latest = findFailedOrCancelledRunForHead(
      fixture.runs,
      fixture.prNumber,
      fixture.headSha,
    );
    expect(latest?.id).toBe(fixture.expect.runId);
    const retryEligible = latest?.retryEligible ?? latest?.retryCount == null;
    expect(retryEligible).toBe(fixture.expect.retryEligible);
  });
});

function planReconcile(input: PlanReconcileInput) {
  return unwrapReconcilePlanResult(planReconcileActions(input)).actions;
}

function withExpiredNudgeCycle(fixture: FixturePayload): FixturePayload {
  const nowMs = Number(fixture.nowMs ?? Date.now());
  const pr = fixture.openPrs?.[0];
  const prNumber = Number(pr?.number ?? 0);
  const headSha = String(pr?.headRefOid ?? '');
  const expectSessionId = (fixture as PlanReconcileInput & { expect?: { sessionId?: string } }).expect
    ?.sessionId;
  const sessionId =
    expectSessionId ??
    resolveStrictHeadOwningWorkerSession(
      fixture.sessions ?? [],
      prNumber,
      headSha,
      fixture.openPrs ?? [],
    ).sessionId ??
    resolveHeadOwningWorkerSessionId(
      fixture.sessions ?? [],
      prNumber,
      headSha,
      fixture.openPrs ?? [],
    ) ??
    '';
  if (!prNumber || !sessionId) {
    return fixture;
  }
  const repoId = 'orchestrator-pack';
  const ownerKey = `${repoId}:pr:${prNumber}:owner:${String(sessionId).toLowerCase()}`;
  return {
    ...fixture,
    cycleState: {
      repoId,
      ownerCycles: {
        [ownerKey]: {
          cycleId: `${repoId}:${prNumber}:${sessionId}:seed`,
          ownerSessionId: sessionId,
          prNumber,
          openedAtMs: nowMs - NUDGE_EXPIRY_MS - 1000,
          nudgeArmed: true,
          nudgeSentAtMs: nowMs - NUDGE_EXPIRY_MS - 1000,
          nudgeExpiresAtMs: nowMs - 1000,
          nudgeExpiredFallbackPending: true,
        },
      },
    },
  };
}

describe('planReconcileActions', () => {
  it('persists ready_for_review debounce when reviewGate blocks on debounce pending', () => {
    const headSha = 'deadbeef';
    const headCommittedAtMs = Date.parse('2026-06-01T00:00:00.000Z');
    const handoffAtMs = headCommittedAtMs + 14 * 60 * 1000;
    const prNumber = 99;
    const sessionId = 'op-live-worker';
    const repoId = normalizeCanonicalRepoIdentity('orchestrator-pack');
    const ownerKey = buildOwnerCycleKey(repoId, prNumber, sessionId);
    const baseInput = {
      openPrs: [
        {
          number: prNumber,
          headRefOid: headSha,
          headCommittedAt: new Date(headCommittedAtMs).toISOString(),
        },
      ],
      reviewRuns: [],
      sessions: [
        {
          name: sessionId,
          role: 'worker',
          prNumber,
          status: 'working',
          reports: [
            {
              reportState: 'ready_for_review',
              reportedAt: new Date(handoffAtMs).toISOString(),
            },
          ],
        },
      ],
      ciChecksByPr: { [String(prNumber)]: greenChecks },
      repoRoot: 'orchestrator-pack',
    };

    const first = unwrapReconcilePlanResult(
      planReconcileActions({ ...baseInput, nowMs: handoffAtMs }),
    );
    expect(startReviewActions(first.actions)).toHaveLength(0);
    expect(
      skipActions(first.actions).some((a) => a.reason === 'ready_for_review_debounce_pending'),
    ).toBe(true);
    const debounce = (
      first.cycleState?.ownerCycles as Record<
        string,
        { debounce?: Record<string, { startedAtMs?: number }> }
      >
    )?.[ownerKey]?.debounce?.[CYCLE_SURFACE_READY_FOR_REVIEW];
    expect(debounce?.startedAtMs).toBe(handoffAtMs);

    const tooEarly = unwrapReconcilePlanResult(
      planReconcileActions({
        ...baseInput,
        cycleState: first.cycleState,
        nowMs: headCommittedAtMs + 15 * 60 * 1000,
      }),
    );
    expect(startReviewActions(tooEarly.actions)).toHaveLength(0);

    const settled = unwrapReconcilePlanResult(
      planReconcileActions({
        ...baseInput,
        cycleState: first.cycleState,
        nowMs: handoffAtMs + QUIESCENCE_DEBOUNCE_MS,
      }),
    );
    expect(startReviewActions(settled.actions)).toHaveLength(1);
  });

  it('does not mark reviewArmed in cycleState during planning', () => {
    const fixture = withExpiredNudgeCycle(loadFixture('quiescent-pr260-opk-37.json'));
    const result = unwrapReconcilePlanResult(planReconcileActions(fixture));
    const start = startReviewActions(result.actions)[0];
    expect(start?.ownerCycle).toBeDefined();
    const ownerCycles = (result.cycleState?.ownerCycles ?? {}) as Record<
      string,
      { reviewArmed?: boolean; fallbackArmed?: boolean }
    >;
    expect(Object.values(ownerCycles).every((cycle) => !cycle?.reviewArmed)).toBe(true);
    const committed = commitReviewStartedCycleState(result.cycleState ?? {}, {
      repoId: start.ownerCycle!.repoId,
      prNumber: start.prNumber,
      ownerSessionId: start.sessionId,
      cycle: start.ownerCycle!.cycle,
      isQuiescentFallback: Boolean(start.ownerCycle!.isQuiescentFallback),
    }) as { ownerCycles?: Record<string, { reviewArmed?: boolean }> };
    expect(
      Object.values(committed.ownerCycles ?? {}).some((cycle) => cycle?.reviewArmed),
    ).toBe(true);
  });

  it('shares ci-green nudge evidence before allowing quiescent fallback', () => {
    const fixture = loadFixture('quiescent-pr260-opk-37.json');
    const nowMs = Number(fixture.nowMs ?? Date.now());
    const sessionId = 'opk-37';
    const prNumber = 260;
    const repoId = 'orchestrator-pack';
    const ownerKey = `${repoId}:pr:${prNumber}:owner:${sessionId}`;

    const blocked = unwrapReconcilePlanResult(
      planReconcileActions({ ...fixture, cycleState: {} }),
    );
    expect(startReviewActions(blocked.actions)).toHaveLength(0);
    expect(
      skipActions(blocked.actions).some((a) => a.reason === 'nudge_precedence_over_fallback'),
    ).toBe(true);

    const allowed = unwrapReconcilePlanResult(
      planReconcileActions({
        ...fixture,
        cycleState: {},
        legacyNudged: {
          [`${prNumber}:42bf1490dbe8829667d2835b937a33e7af9d82f1:1:nudge`]: {
            sessionId,
            sentAtMs: nowMs - NUDGE_EXPIRY_MS - 1000,
          },
        },
        sharedCycleState: {
          repoId,
          ownerCycles: {
            [ownerKey]: {
              cycleId: 'cg-cycle',
              ownerSessionId: sessionId,
              prNumber,
              nudgeArmed: true,
              nudgeSentAtMs: nowMs - NUDGE_EXPIRY_MS - 1000,
              nudgeExpiresAtMs: nowMs - 1000,
            },
          },
        },
      }),
    );
    expect(startReviewActions(allowed.actions)).toHaveLength(1);
    expect(startReviewActions(allowed.actions)[0]?.startReason).toBe(
      'quiescent_worker_handoff_fallback',
    );
  });

  it('allows quiescent fallback when nudge evidence exists only in pendingJournal', () => {
    const fixture = loadFixture('quiescent-pr260-opk-37.json');
    const nowMs = Number(fixture.nowMs ?? Date.now());
    const sessionId = 'opk-37';
    const prNumber = 260;
    const transitionId = `${prNumber}:42bf1490dbe8829667d2835b937a33e7af9d82f1:1:nudge`;
    const legacyNudged = mergeLegacyNudgedWithPendingJournal(
      {},
      {
        [transitionId]: {
          sessionId,
          sentAtMs: nowMs - NUDGE_EXPIRY_MS - 1000,
          message: 'hand off',
        },
      },
    );

    const allowed = unwrapReconcilePlanResult(
      planReconcileActions({
        ...fixture,
        cycleState: {},
        legacyNudged,
      }),
    );
    expect(startReviewActions(allowed.actions)).toHaveLength(1);
    expect(startReviewActions(allowed.actions)[0]?.startReason).toBe(
      'quiescent_worker_handoff_fallback',
    );
  });

  it('Issue #218 (AC1/AC2): SHA-less ready_for_review on PR #217 shape triggers review', () => {
    const fixture = loadFixture('ready-sha-less-pr217.json');
    const actions = planReconcile(fixture);
    const starts = startReviewActions(actions);
    expect(starts).toHaveLength(fixture.expect?.startReviewCount ?? 1);
    expect(starts[0]).toMatchObject({
      prNumber: 217,
      sessionId: fixture.expect?.sessionId ?? 'opk-19',
      headSha: '8e35c0052127b8e156b7c1c80b2774286da16e6f',
    });
  });

  it('Issue #218 (AC3): SHA-less ready_for_review superseded when head commit is newer', () => {
    const fixture = loadFixture('supersede-sha-less-ready.json');
    const actions = planReconcile(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    const skip = skipActions(actions)[0];
    expect(skip?.reason).toBe(fixture.expect?.skipReason);
    expect(skip?.record?.primary).toBe(fixture.expect?.record?.primary);
    expect(skip?.record?.failedComponents).toEqual(fixture.expect?.record?.failedComponents);
  });

  it('Issue #195 (a): starts review for ready head with green CI', () => {
    const fixture = loadFixture('ready-head-triggers.json');
    const actions = planReconcile(fixture);
    const starts = startReviewActions(actions);
    expect(starts).toHaveLength(fixture.expect?.startReviewCount ?? 1);
    expect(starts[0]).toMatchObject({
      prNumber: 99,
      sessionId: fixture.expect?.sessionId ?? 'op-live-worker',
      headSha: 'deadbeef',
    });
  });

  it('Issue #195 (b): does not start without ready_for_review (uncovered-but-not-ready)', () => {
    const fixture = loadFixture('uncovered-no-report.json');
    const actions = planReconcile(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(skipActions(actions).some((a) => a.reason === fixture.expect?.skipReason)).toBe(
      true,
    );
  });

  it('accepts PowerShell single-object openPrs (not a JSON array)', () => {
    const fixture = loadFixture('ready-head-triggers.json');
    const actions = planReconcile({
      openPrs: fixture.openPrs[0] as unknown as typeof fixture.openPrs,
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      ciChecksByPr: fixture.ciChecksByPr,
    });
    expect(startReviewActions(actions)).toHaveLength(1);
  });

  it('Issue #195 (c): intermediate commit without ready_for_review does not trigger', () => {
    const fixture = loadFixture('intermediate-commit.json');
    const actions = planReconcile(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(skipActions(actions).some((a) => a.reason === 'uncovered_not_ready')).toBe(true);
  });

  it('AC3: does not start when head is covered by each blocking status', () => {
    for (const name of [
      'covered-in-flight.json',
      'covered-clean.json',
      'covered-needs-triage.json',
      'covered-waiting-update.json',
    ]) {
      const fixture = loadFixture(name);
      const actions = planReconcile(fixture);
      expect(startReviewActions(actions), name).toHaveLength(0);
    }
  });

  it('AC3: starts when only outdated runs cover the PR and head is ready', () => {
    const fixture = loadFixture('uncovered-only-outdated.json');
    const actions = planReconcile(fixture);
    expect(startReviewActions(actions)).toHaveLength(1);
  });

  it('Issue #195 (d): red CI defers review on ready head', () => {
    const fixture = loadFixture('red-ci-defer.json');
    const actions = planReconcile(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(skipActions(actions).some((a) => a.reason === 'ci_red_defer')).toBe(true);
  });

  it('Issue #195 (e): pending CI on ready head still triggers', () => {
    const fixture = loadFixture('pending-ci-triggers.json');
    const actions = planReconcile(fixture);
    expect(startReviewActions(actions)).toHaveLength(1);
  });

  it('Issue #195 (e2): missing required checks track degraded-ci retry', () => {
    const fixture = loadFixture('degraded-ci-visibility.json');
    const actions = planReconcile(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(actions.some((a) => a.type === 'track_degraded_ci')).toBe(true);
  });

  it('Issue #195 (e2): bounded attempts escalate operator', () => {
    const fixture = loadFixture('degraded-ci-escalate.json');
    const actions = planReconcile(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(actions.some((a) => a.type === 'escalate_degraded_ci')).toBe(true);
  });

  it('Issue #195 (e3): degraded-CI worker handoff avoids uncovered-not-ready', () => {
    const fixture = loadFixture('degraded-ci-worker-handoff.json');
    const actions = planReconcile(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(skipActions(actions).some((a) => a.reason === 'uncovered_not_ready')).toBe(false);
    expect(actions.some((a) => a.type === 'track_degraded_ci')).toBe(true);
  });

  describe('Issue #261 quiescent handoff fallback', () => {
    it('AC1: PR #260 / opk-37 idle green head starts via quiescence fallback', () => {
      const fixture = withExpiredNudgeCycle(loadFixture('quiescent-pr260-opk-37.json'));
      const actions = planReconcile(fixture);
      const starts = startReviewActions(actions);
      expect(starts).toHaveLength(fixture.expect?.startReviewCount ?? 1);
      expect(starts[0]).toMatchObject({
        prNumber: 260,
        sessionId: fixture.expect?.sessionId ?? 'opk-37',
        headSha: '42bf1490dbe8829667d2835b937a33e7af9d82f1',
        startReason: 'quiescent_worker_handoff_fallback',
      });
      expect(starts[0]?.quiescenceBasis?.pendingUnconsumedDelivery).toBe(false);
    });

    it('AC2: actively working owner without ready_for_review still defers', () => {
      const fixture = loadFixture('uncovered-no-report.json');
      expect(startReviewActions(planReconcile(fixture))).toHaveLength(0);
      expect(skipActions(planReconcile(fixture)).some((a) => a.reason === 'uncovered_not_ready')).toBe(true);
    });

    it('AC3: idle owner within debounce window defers', () => {
      const fixture = loadFixture('quiescent-within-debounce.json');
      expect(startReviewActions(planReconcile(fixture))).toHaveLength(0);
      expect(skipActions(planReconcile(fixture)).some((a) => a.reason === 'uncovered_not_ready')).toBe(true);
    });

    it('AC3a: pending unconsumed delivery defers despite idle stable head', () => {
      const fixture = loadFixture('quiescent-pending-delivery.json');
      expect(startReviewActions(planReconcile(fixture))).toHaveLength(0);
      expect(skipActions(planReconcile(fixture)).some((a) => a.reason === 'uncovered_not_ready')).toBe(true);
    });

    it('AC3a-alt: pending delivery keyed by sessionId matches display name owner', () => {
      const fixture = loadFixture('quiescent-pending-delivery-dual-id.json');
      expect(startReviewActions(planReconcile(fixture))).toHaveLength(0);
      expect(skipActions(planReconcile(fixture)).some((a) => a.reason === 'uncovered_not_ready')).toBe(true);
    });

    it('AC3b: reaction pending delivery defers when reactionMessages supplied', () => {
      const fixture = loadFixture('quiescent-reaction-pending.json');
      expect(startReviewActions(planReconcile(fixture))).toHaveLength(0);
      const withoutMessages = planReconcile(
        withExpiredNudgeCycle({
          ...fixture,
          reactionMessages: {},
        }),
      );
      expect(startReviewActions(withoutMessages)).toHaveLength(1);
    });

    it('AC5: stale ready on older head with quiescent owner starts', () => {
      const fixture = withExpiredNudgeCycle(loadFixture('stale-ready-quiescent-starts.json'));
      const starts = startReviewActions(planReconcile(fixture));
      expect(starts).toHaveLength(1);
      expect(starts[0]?.startReason).toBe('quiescent_worker_handoff_fallback');
    });

    it('defers quiescent fallback while prior review revision is open', () => {
      const oldHead = '42bf1490dbe8829667d2835b937a33e7af9d82f1';
      const newHead = 'deadbeef00000000000000000000000000000001';
      const base = withExpiredNudgeCycle(loadFixture('quiescent-pr260-opk-37.json'));
      const fixture: FixturePayload = {
        ...base,
        openPrs: [
          {
            number: 260,
            headRefOid: newHead,
            headCommittedAt: '2026-06-10T12:40:00.000Z',
          },
        ],
        sessions: (base.sessions ?? []).map((session) => ({
          ...session,
          ownedHeadSha: newHead,
        })),
        reviewRuns: [
          {
            id: 'opk-rev-open',
            prNumber: 260,
            targetSha: oldHead,
            status: 'needs_triage',
            findingCount: 1,
            openFindingCount: 1,
            sentFindingCount: 1,
          },
        ],
      };
      const actions = planReconcile(fixture);
      expect(startReviewActions(actions)).toHaveLength(0);
      const skip = skipActions(actions).find((a) => a.prNumber === 260);
      expect(skip?.reason).toMatch(/^prior_revision_open:/);
    });

    it('AC8: not-live owner fails closed with no_live_review_target', () => {
      const fixture = loadFixture('quiescent-not-live-owner.json');
      const skip = skipActions(planReconcile(fixture))[0];
      expect(skip?.reason).toBe('no_live_review_target');
      expect(startReviewActions(planReconcile(fixture))).toHaveLength(0);
    });

    it('AC9: live replacement quiescent owner starts; active replacement defers', () => {
      const starts = startReviewActions(
        planReconcile(withExpiredNudgeCycle(loadFixture('live-replacement-quiescent.json'))),
      );
      expect(starts).toHaveLength(1);
      expect(starts[0]?.sessionId).toBe('opk-live-replacement');
      expect(startReviewActions(planReconcile(loadFixture('live-replacement-active.json')))).toHaveLength(0);
    });

    it('AC10b: strict explicit owner wins over legacy report-history pick for quiescence', () => {
      const fixture = withExpiredNudgeCycle(loadFixture('quiescent-strict-owner-over-legacy-report.json'));
      const legacyId = resolveHeadOwningWorkerSessionId(
        fixture.sessions,
        92,
        'newhead92abcd',
        fixture.openPrs,
      );
      expect(legacyId).toBe('opk-stale-report');
      const starts = startReviewActions(planReconcile(fixture));
      expect(starts).toHaveLength(1);
      expect(starts[0]?.sessionId).toBe('opk-strict-owner');
      expect(starts[0]?.startReason).toBe('quiescent_worker_handoff_fallback');
    });

    it('resolves a single live implicit owner for strict pre-run validation', () => {
      expect(
        resolveStrictHeadOwningWorkerSession(
          [
            {
              name: 'op-implicit',
              role: 'worker',
              prNumber: 95,
              status: 'working',
            },
          ],
          95,
          'head95ab',
          [{ number: 95, headRefOid: 'head95ab' }],
        ),
      ).toEqual({
        sessionId: 'op-implicit',
        reason: 'resolved',
        failClosed: false,
      });
    });

    it('AC10d: implicit owner ambiguity still honors ready_for_review report binding', () => {
      const fixture = loadFixture('implicit-ready-report-handoff.json');
      const starts = startReviewActions(planReconcile(fixture));
      expect(starts).toHaveLength(1);
      expect(starts[0]?.sessionId).toBe('op-ready');
      expect(starts[0]?.startReason).toBeUndefined();
    });

    it('AC10c: ambiguous implicit live owners fail closed without legacy pick', () => {
      const fixture = loadFixture('ambiguous-implicit-owners.json');
      expect(startReviewActions(planReconcile(fixture))).toHaveLength(0);
      expect(skipActions(planReconcile(fixture))[0]?.reason).toBe('ambiguous_head_owner');
    });

    it('AC10: ambiguous live owners fail closed', () => {
      const skip = skipActions(planReconcile(loadFixture('ambiguous-head-owner.json')))[0];
      expect(skip?.reason).toBe('ambiguous_head_owner');
      expect(
        resolveStrictHeadOwningWorkerSession(
          loadFixture('ambiguous-head-owner.json').sessions,
          90,
          'sharedhead90aa',
          loadFixture('ambiguous-head-owner.json').openPrs,
        ).failClosed,
      ).toBe(true);
    });

    it('AC12: covered head on second tick does not start again', () => {
      const fixture = loadFixture('quiescent-idempotent-second-tick.json');
      expect(startReviewActions(planReconcile(fixture))).toHaveLength(0);
      expect(skipActions(planReconcile(fixture)).some((a) => a.reason === 'head_covered')).toBe(true);
    });
  });

  it('AC4: split-brain uses live worker session only (no lifecycle in review argv)', () => {
    const fixture = loadFixture('split-brain-live-worker.json');
    const actions = planReconcile(fixture);
    const starts = startReviewActions(actions);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.sessionId).toBe('op-worker-pr97');

    const reviewCommand =
      'powershell.exe -NoProfile -File scripts/invoke-pack-review.ps1 --repo-root . --base origin/main';
    const argv = buildReviewRunArgv(starts[0]!.sessionId, reviewCommand);
    const commandLine = `ao ${argv.join(' ')}`;
    expect(findForbiddenLifecycleCommands([commandLine])).toEqual([]);
  });
});

describe('isLiveWorkerSession', () => {
  it.each([
    ['working', true],
    ['stuck', true],
    ['terminated', false],
    ['killed', false],
    ['detecting', false],
    ['done', false],
  ])('status %s live=%s', (status, live) => {
    expect(isLiveWorkerSession({ status })).toBe(live);
  });
});

describe('getSessionIdentifier', () => {
  it('prefers name, then sessionId, then id', () => {
    expect(getSessionIdentifier({ name: 'op-a' })).toBe('op-a');
    expect(getSessionIdentifier({ sessionId: 'op-b' })).toBe('op-b');
    expect(getSessionIdentifier({ id: 'op-c' })).toBe('op-c');
    expect(getSessionIdentifier({})).toBeNull();
  });
});

describe('collectSessionIdentifiers', () => {
  it('returns every non-empty identifier field', () => {
    expect(
      collectSessionIdentifiers({
        name: 'opk-display',
        sessionId: 'opk-stable',
        id: 'legacy-id',
      }),
    ).toEqual(['opk-display', 'opk-stable', 'legacy-id']);
  });
});

describe('sessionMatchesIdentifier', () => {
  it('matches name, sessionId, or id independently', () => {
    const session = {
      name: 'opk-worker-display',
      sessionId: 'opk-worker-stable-id',
      id: 'legacy-id',
    };
    expect(sessionMatchesIdentifier(session, 'opk-worker-display')).toBe(true);
    expect(sessionMatchesIdentifier(session, 'opk-worker-stable-id')).toBe(true);
    expect(sessionMatchesIdentifier(session, 'legacy-id')).toBe(true);
    expect(sessionMatchesIdentifier(session, 'unknown')).toBe(false);
  });
});

describe('findSessionById', () => {
  it('finds session when linkedSessionId is sessionId but row also has name', () => {
    const sessions = [
      {
        name: 'opk-15',
        sessionId: 'opk-15-stable',
        role: 'worker',
        prNumber: 180,
        status: 'working',
      },
    ];
    expect(findSessionById(sessions, 'opk-15-stable')).toBe(sessions[0]);
    expect(findSessionById(sessions, 'opk-15')).toBe(sessions[0]);
  });
});

describe('resolveWorkerSessionId', () => {
  it('resolves workers identified by sessionId only', () => {
    expect(
      resolveWorkerSessionId(
        [
          {
            sessionId: 'opk-worker-9',
            role: 'worker',
            prNumber: 66,
            status: 'working',
          },
        ],
        66,
      ),
    ).toBe('opk-worker-9');
  });

  it('starts review when status payload uses sessionId and head is ready', () => {
    const actions = planReconcile({
      openPrs: [{ number: 66, headRefOid: 'sha66', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      reviewRuns: [],
      sessions: [
        {
          sessionId: 'opk-worker-9',
          role: 'worker',
          prNumber: 66,
          status: 'working',
          reports: [
            {
              reportState: 'ready_for_review',

              reportedAt: '2026-06-05T12:00:00.000Z',
            },
          ],
        },
      ],
      ciChecksByPr: {
        '66': [
          { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
          { name: 'PR scope guard', state: 'SUCCESS' },
          { name: 'Run pack contract tests', state: 'SUCCESS' },
          { name: 'Self-architect lint', state: 'SUCCESS' },
        ],
      },
    });
    expect(startReviewActions(actions)).toEqual([
      expect.objectContaining({
        type: 'start_review',
        sessionId: 'opk-worker-9',
        prNumber: 66,
      }),
    ]);
  });

  it('ignores dead worker sessions linked to the PR', () => {
    expect(
      resolveWorkerSessionId(
        [
          {
            name: 'op-dead',
            role: 'worker',
            prNumber: 55,
            status: 'terminated',
          },
        ],
        55,
      ),
    ).toBeNull();
  });

  it('prefers a live worker when dead and live sessions share the PR', () => {
    expect(
      resolveWorkerSessionId(
        [
          {
            name: 'op-dead',
            role: 'worker',
            prNumber: 55,
            status: 'killed',
          },
          {
            name: 'op-live',
            role: 'worker',
            prNumber: 55,
            status: 'working',
          },
        ],
        55,
      ),
    ).toBe('op-live');
  });

  it('skips reconcile when only dead workers hold the PR', () => {
    const fixture = {
      openPrs: [{ number: 55, headRefOid: 'cafe55', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      reviewRuns: [],
      sessions: [
        {
          name: 'op-dead',
          role: 'worker',
          prNumber: 55,
          status: 'detecting',
        },
      ],
      ciChecksByPr: {
        '55': greenChecks,
      },
    };
    const actions = planReconcile(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    const skip = actions.find(
      (a): a is Extract<ReconcileAction, { type: 'skip' }> =>
        a.type === 'skip' && a.reason === 'no_live_review_target',
    );
    expect(skip).toBeDefined();
    expect(skip?.record?.reason).toBe('no_live_review_target');
  });

  it('ignores orchestrator sessions', () => {
    const id = resolveWorkerSessionId(
      [
        { name: 'op-orchestrator', role: 'orchestrator', prNumber: 99 },
        { name: 'op-worker', role: 'worker', prNumber: 99 },
      ],
      99,
    );
    expect(id).toBe('op-worker');
  });

  it('prefers head-owning worker over stale live worker on the same PR', () => {
    const headSha = 'currenthead57';
    expect(
      resolveHeadOwningWorkerSessionId(
        [
          {
            name: 'op-stale',
            role: 'worker',
            prNumber: 57,
            ownedHeadSha: 'oldhead57',
            status: 'working',
          },
          {
            name: 'op-ready',
            role: 'worker',
            prNumber: 57,
            ownedHeadSha: headSha,
            status: 'idle',
          },
        ],
        57,
        headSha,
        [{ number: 57, headRefOid: headSha }],
      ),
    ).toBe('op-ready');
  });

  it('prefers worker with ready_for_review report when multiple live workers match PR', () => {
    const headSha = 'currenthead58';
    const actions = planReconcile({
      openPrs: [{ number: 58, headRefOid: headSha, headCommittedAt: '2026-06-05T11:00:00.000Z' }],
      reviewRuns: [],
      sessions: [
        {
          name: 'op-earlier',
          role: 'worker',
          prNumber: 58,
          status: 'working',
          reports: [],
        },
        {
          name: 'op-ready',
          role: 'worker',
          prNumber: 58,
          status: 'idle',
          reports: [
            {
              reportState: 'ready_for_review',
              reportedAt: '2026-06-05T12:00:00.000Z',
            },
          ],
        },
      ],
      ciChecksByPr: { '58': greenChecks },
    });
    expect(startReviewActions(actions)).toEqual([
      expect.objectContaining({
        type: 'start_review',
        sessionId: 'op-ready',
        prNumber: 58,
      }),
    ]);
  });
});

describe('evaluateReconcileInterval', () => {
  it('AC5: default interval is ten minutes', () => {
    expect(DEFAULT_RECONCILE_INTERVAL_MS).toBe(10 * 60 * 1000);
  });

  it('AC5: skips tick inside configured interval', () => {
    const now = 10_000_000;
    const result = evaluateReconcileInterval({
      nowMs: now + 5 * 60 * 1000,
      lastTickMs: now,
      intervalMs: 10 * 60 * 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('interval_not_elapsed');
    }
  });

  it('accepts tick after interval elapsed', () => {
    const now = 20_000_000;
    const result = evaluateReconcileInterval({
      nowMs: now + DEFAULT_RECONCILE_INTERVAL_MS,
      lastTickMs: now,
      intervalMs: DEFAULT_RECONCILE_INTERVAL_MS,
    });
    expect(result.ok).toBe(true);
  });
});

describe('findForbiddenLifecycleCommands', () => {
  it('flags spawn, claim-pr, kill, and send', () => {
    const violations = findForbiddenLifecycleCommands([
      'ao spawn --claim-pr 12',
      'ao session kill op-1',
      'ao send op-2 hello',
      'ao review run op-3 --execute --command foo',
    ]);
    expect(violations.length).toBeGreaterThanOrEqual(4);
  });
});

describe('Issue #212 defer subreason records', () => {
  it('AC1: documents stable primary precedence order', () => {
    expect(NOT_READY_COMPONENT_PRECEDENCE.indexOf('degraded_ci_handoff')).toBeLessThan(
      NOT_READY_COMPONENT_PRECEDENCE.indexOf('no_ready_for_review'),
    );
    expect(NOT_READY_COMPONENT_PRECEDENCE.indexOf('no_ready_for_review')).toBeLessThan(
      NOT_READY_COMPONENT_PRECEDENCE.indexOf('ci_red'),
    );
    expect(
      choosePrimaryNotReadyComponent(['degraded_ci_handoff', 'no_ready_for_review']),
    ).toBe('degraded_ci_handoff');
    expect(choosePrimaryNotReadyComponent(['ci_red', 'no_ready_for_review'])).toBe(
      'no_ready_for_review',
    );
  });

  it('AC1: no ready_for_review records no_ready_for_review primary', () => {
    const fixture = loadFixture('uncovered-no-report.json');
    const skip = skipActions(planReconcile(fixture)).find((a) => a.prNumber === 99);
    expect(skip?.reason).toBe('uncovered_not_ready');
    expect(skip?.record?.primary).toBe('no_ready_for_review');
    expect(skip?.record?.failedComponents).toContain('no_ready_for_review');
    expect(skip?.record?.observed?.reportRoute).toBe('none');
  });

  it('AC1: stale report binding records stale_report_binding', () => {
    const skip = skipActions(planReconcile(loadFixture('intermediate-commit.json')))[0];
    expect(skip?.record?.primary).toBe('no_ready_for_review');
    expect(skip?.record?.failedComponents).toContain('stale_report_binding');
    expect(skip?.record?.observed?.reportBoundHeadSha).toBe('stale_sha_less_handoff');
    expect(skip?.record?.observed?.reportRoute).toBe('ready_for_review');
    expect(skip?.record?.observed?.staleReadyForReviewHeadSha).toBe('stale_sha_less_handoff');
    expect(skip?.record?.observed?.staleReadyForReviewRoute).toBe('ready_for_review');
  });

  it('AC3: only stale ready_for_review preserves binding in observed', () => {
    const fixture = loadFixture('defer-stale-only-binding.json');
    const skip = skipActions(planReconcile(fixture))[0];
    expect(skip?.record?.failedComponents).toContain('stale_report_binding');
    expect(skip?.record?.observed).toMatchObject(fixture.expect?.record?.observed ?? {});
  });

  it('AC1: ci_red_defer records ci_red subreason', () => {
    const skip = skipActions(planReconcile(loadFixture('defer-ci-red.json')))[0];
    expect(skip?.reason).toBe('ci_red_defer');
    expect(skip?.record?.primary).toBe('ci_red');
    expect(skip?.record?.failedComponents).toEqual(['ci_red']);
  });

  it('AC1: failed/cancelled records failed_or_cancelled branch', () => {
    const skip = skipActions(planReconcile(loadFixture('defer-failed-cancelled.json')))[0];
    expect(skip?.reason).toBe('failed_or_cancelled_on_head');
    expect(skip?.record?.branch).toBe('failed_or_cancelled');
    expect(skip?.record?.observed).toMatchObject({
      runId: 'run-fail-71',
      status: 'failed',
      terminationReason: 'codex exec review exited 1',
    });
  });

  it('failed/cancelled record wins over head_covered when both runs exist on head', () => {
    const fixture = loadFixture('failed-and-covered-same-head.json');
    const skip = skipActions(planReconcile(fixture))[0];
    expect(skip?.reason).toBe(fixture.expect?.skipReason);
    expect(skip?.record?.branch).toBe(fixture.expect?.record?.branch);
    expect(skip?.record?.primary).toBe(fixture.expect?.record?.primary);
    expect(skip?.record?.observed).toMatchObject({
      runId: 'run-fail-73',
      status: 'failed',
      terminationReason: 'codex exec review exited 1',
    });
    expect(skip?.record?.branch).not.toBe('head_covered');
  });

  it('AC1: head_covered is distinct from uncovered-not-ready subreasons', () => {
    const skip = skipActions(planReconcile(loadFixture('covered-clean.json')))[0];
    expect(skip?.reason).toBe('head_covered');
    expect(skip?.record?.branch).toBe('head_covered');
    expect(skip?.record?.primary).toBe('head_covered');
    expect(skip?.record?.observed).toMatchObject({
      coveringRunStatus: 'clean',
      headMatch: true,
      prMatch: true,
    });
  });

  it('AC2: mixed failure records every failed component and deterministic primary', () => {
    const fixture = loadFixture('defer-mixed-failure.json');
    const skip = skipActions(planReconcile(fixture))[0];
    expect(skip?.record?.primary).toBe(fixture.expect?.record?.primary);
    expect(skip?.record?.failedComponents).toEqual(fixture.expect?.record?.failedComponents);
  });

  it('AC3: report/CI defer carries branch-complete reproducing fields', () => {
    const skip = skipActions(planReconcile(loadFixture('uncovered-no-report.json')))[0];
    expect(skip?.record?.observed).toMatchObject({
      prNumber: 99,
      currentHeadSha: 'deadbeef',
      reportBoundHeadSha: 'none',
      reportRoute: 'none',
      ciLevel: 'green',
      requiredCheckSource: 'pack_merge_contract_fallback',
    });
  });

  it('AC4: degraded-CI handoff is distinct from no hand-off yet', () => {
    const degradedSkip = skipActions(
      planReconcile(loadFixture('degraded-ci-worker-handoff.json')),
    ).find((a) => a.record);
    expect(degradedSkip?.reason).not.toBe('uncovered_not_ready');
    expect(degradedSkip?.record?.primary).toBe('degraded_ci_handoff');
    expect(degradedSkip?.record?.failedComponents).toContain('degraded_ci_handoff');
    expect(degradedSkip?.record?.observed?.reportRoute).toBe('degraded_ci');

    const noHandoffSkip = skipActions(
      planReconcile(loadFixture('uncovered-no-report.json')),
    )[0];
    expect(noHandoffSkip?.record?.observed?.reportRoute).toBe('none');
    expect(noHandoffSkip?.record?.failedComponents).not.toContain('degraded_ci_handoff');
  });

  it('AC5: ready uncovered head starts review on reconciler tick alone', () => {
    expect(startReviewActions(planReconcile(loadFixture('ready-head-triggers.json')))).toHaveLength(1);
  });

  it('AC6: PR #211 shape — prior defer does not block next tick when head becomes ready', () => {
    const prNumber = 211;
    const headSha = '1607071';
    const base = {
      openPrs: [{ number: prNumber, headRefOid: headSha, headCommittedAt: '2026-06-06T01:00:00.000Z' }],
      reviewRuns: [] as [],
      ciChecksByPr: { [String(prNumber)]: greenChecks },
    };

    const tick1 = planReconcile({
      ...base,
      sessions: [{ name: 'opk-16', role: 'worker', prNumber, status: 'working', reports: [] }],
    });
    const defer = skipActions(tick1)[0];
    expect(defer?.reason).toBe('uncovered_not_ready');
    expect(defer?.record?.primary).toBe('no_ready_for_review');
    expect(startReviewActions(tick1)).toHaveLength(0);

    const tick2 = planReconcile({
      ...base,
      sessions: [
        {
          name: 'opk-16',
          role: 'worker',
          prNumber,
          status: 'ready_for_review',
          reports: [
            {
              reportState: 'ready_for_review',
              reportedAt: '2026-06-06T01:45:00.000Z',
            },
          ],
        },
      ],
    });
    expect(startReviewActions(tick2)).toHaveLength(1);
    expect(skipActions(tick2)).toHaveLength(0);
  });

  it('AC7: gating outcomes unchanged across existing #195 fixtures', () => {
    const cases: Array<{ fixture: string; starts: number; skipReason?: string }> = [
      { fixture: 'ready-head-triggers.json', starts: 1 },
      { fixture: 'uncovered-no-report.json', starts: 0, skipReason: 'uncovered_not_ready' },
      { fixture: 'intermediate-commit.json', starts: 0, skipReason: 'uncovered_not_ready' },
      { fixture: 'red-ci-defer.json', starts: 0, skipReason: 'ci_red_defer' },
      { fixture: 'pending-ci-triggers.json', starts: 1 },
      { fixture: 'covered-clean.json', starts: 0, skipReason: 'head_covered' },
      { fixture: 'uncovered-only-outdated.json', starts: 1 },
    ];

    for (const { fixture, starts, skipReason } of cases) {
      const actions = planReconcile(loadFixture(fixture));
      expect(startReviewActions(actions), fixture).toHaveLength(starts);
      if (skipReason) {
        expect(skipActions(actions).some((a) => a.reason === skipReason), fixture).toBe(true);
      }
    }
  });
});
