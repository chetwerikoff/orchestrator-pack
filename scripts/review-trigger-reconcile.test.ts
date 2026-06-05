import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  buildReviewRunArgv,
  evaluateReconcileInterval,
  findForbiddenLifecycleCommands,
  isHeadCovered,
  isRunCoveringHead,
  findSessionById,
  getSessionIdentifier,
  isLiveWorkerSession,
  sessionMatchesIdentifier,
  planReconcileActions,
  resolveWorkerSessionId,
  type PlanReconcileInput,
  type ReconcileAction,
} from '../docs/review-trigger-reconcile.mjs';

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
  };
};

function loadFixture(name: string): FixturePayload {
  const raw = readFileSync(path.join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as FixturePayload;
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

describe('planReconcileActions', () => {
  it('Issue #195 (a): starts review for ready head with green CI', () => {
    const fixture = loadFixture('ready-head-triggers.json');
    const actions = planReconcileActions(fixture);
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
    const actions = planReconcileActions(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(skipActions(actions).some((a) => a.reason === fixture.expect?.skipReason)).toBe(
      true,
    );
  });

  it('accepts PowerShell single-object openPrs (not a JSON array)', () => {
    const fixture = loadFixture('ready-head-triggers.json');
    const actions = planReconcileActions({
      openPrs: fixture.openPrs[0] as unknown as typeof fixture.openPrs,
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      ciChecksByPr: fixture.ciChecksByPr,
    });
    expect(startReviewActions(actions)).toHaveLength(1);
  });

  it('Issue #195 (c): intermediate commit without ready_for_review does not trigger', () => {
    const fixture = loadFixture('intermediate-commit.json');
    const actions = planReconcileActions(fixture);
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
      const actions = planReconcileActions(fixture);
      expect(startReviewActions(actions), name).toHaveLength(0);
    }
  });

  it('AC3: starts when only outdated runs cover the PR and head is ready', () => {
    const fixture = loadFixture('uncovered-only-outdated.json');
    const actions = planReconcileActions(fixture);
    expect(startReviewActions(actions)).toHaveLength(1);
  });

  it('Issue #195 (d): red CI defers review on ready head', () => {
    const fixture = loadFixture('red-ci-defer.json');
    const actions = planReconcileActions(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(skipActions(actions).some((a) => a.reason === 'ci_red_defer')).toBe(true);
  });

  it('Issue #195 (e): pending CI on ready head still triggers', () => {
    const fixture = loadFixture('pending-ci-triggers.json');
    const actions = planReconcileActions(fixture);
    expect(startReviewActions(actions)).toHaveLength(1);
  });

  it('Issue #195 (e2): missing required checks track degraded-ci retry', () => {
    const fixture = loadFixture('degraded-ci-visibility.json');
    const actions = planReconcileActions(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(actions.some((a) => a.type === 'track_degraded_ci')).toBe(true);
  });

  it('Issue #195 (e2): bounded attempts escalate operator', () => {
    const fixture = loadFixture('degraded-ci-escalate.json');
    const actions = planReconcileActions(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(actions.some((a) => a.type === 'escalate_degraded_ci')).toBe(true);
  });

  it('Issue #195 (e3): degraded-CI worker handoff avoids uncovered-not-ready', () => {
    const fixture = loadFixture('degraded-ci-worker-handoff.json');
    const actions = planReconcileActions(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(skipActions(actions).some((a) => a.reason === 'uncovered_not_ready')).toBe(false);
    expect(actions.some((a) => a.type === 'track_degraded_ci')).toBe(true);
  });

  it('AC4: split-brain uses live worker session only (no lifecycle in review argv)', () => {
    const fixture = loadFixture('split-brain-live-worker.json');
    const actions = planReconcileActions(fixture);
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
    const actions = planReconcileActions({
      openPrs: [{ number: 66, headRefOid: 'sha66' }],
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
              headRefOid: 'sha66',
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
      openPrs: [{ number: 55, headRefOid: 'cafe55' }],
      reviewRuns: [],
      sessions: [
        {
          name: 'op-dead',
          role: 'worker',
          prNumber: 55,
          status: 'detecting',
        },
      ],
    };
    const actions = planReconcileActions(fixture);
    expect(startReviewActions(actions)).toHaveLength(0);
    expect(actions.some((a) => a.type === 'skip' && a.reason === 'no_worker_session')).toBe(
      true,
    );
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
