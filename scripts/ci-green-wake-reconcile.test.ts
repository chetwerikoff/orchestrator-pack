import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CI_GREEN_WAKE_INTERVAL_MS,
  buildTransitionId,
  classifyRequiredCiLevel,
  deriveGreenEpoch,
  evaluateCiGreenWakeCandidate,
  isPreHandOffWorkerForHead,
  findForbiddenCiGreenWakeCommands,
  mergeBranchRequiredCheckNames,
  planCiGreenWakeActions,
  resolveHeadOwningWorkerSessionId,
  preSendRecheck,
  recordSuccessfulNudge,
  mergeLegacyNudgedWithPendingJournal,
  commitNudgeSentCycleState,
  type CiGreenWakeAction,
  type PlanCiGreenWakeInput,
} from '../docs/ci-green-wake-reconcile.mjs';
import type { AoSession } from '../docs/review-trigger-reconcile.d.mts';
import { QUIESCENCE_DEBOUNCE_MS } from '../docs/worker-iteration-cycle.mjs';
import { liveWorker, packGreenCiChecks, packRedCiChecks } from './_test-worker-session-fixtures.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/ci-green-wake-reconcile',
);

const greenChecks = [...packGreenCiChecks];
const redChecks = [...packRedCiChecks];

function plan(input: PlanCiGreenWakeInput) {
  return planCiGreenWakeActions(input);
}

function nudgeActions(actions: CiGreenWakeAction[]) {
  return actions.filter(
    (a): a is Extract<CiGreenWakeAction, { type: 'nudge' }> => a.type === 'nudge',
  );
}

function loadFixture(name: string): PlanCiGreenWakeInput {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as PlanCiGreenWakeInput;
}

describe('classifyRequiredCiLevel', () => {
  it('classifies merge-contract green', () => {
    expect(classifyRequiredCiLevel(greenChecks)).toBe('green');
  });

  it('classifies red when a required check failed', () => {
    expect(classifyRequiredCiLevel(redChecks)).toBe('red');
  });

  it('honors branch-required checks beyond pack fallback', () => {
    const packGreenOnly = [
      ...greenChecks,
      { name: 'External gate', state: 'FAILURE' },
    ];
    expect(classifyRequiredCiLevel(packGreenOnly)).toBe('green');

    expect(
      classifyRequiredCiLevel(packGreenOnly, {
        requiredCheckNames: ['External gate', ...greenChecks.map((c) => c.name)],
      }),
    ).toBe('red');
  });

  it('returns pending when branch-required checks are missing from output', () => {
    expect(
      classifyRequiredCiLevel(greenChecks, {
        requiredCheckNames: ['Missing required job'],
      }),
    ).toBe('pending');
  });

  it('returns pending when required-check lookup failed', () => {
    expect(
      classifyRequiredCiLevel(greenChecks, { requiredCheckLookupFailed: true }),
    ).toBe('pending');
  });
});

describe('mergeBranchRequiredCheckNames', () => {
  it('merges legacy contexts and app-style checks[].context', () => {
    expect(
      mergeBranchRequiredCheckNames(
        ['PR scope guard', 'Verify orchestrator-pack structure'],
        [{ context: 'External gate' }, { context: 'PR scope guard' }],
      ),
    ).toEqual([
      'PR scope guard',
      'Verify orchestrator-pack structure',
      'External gate',
    ]);
  });

  it('returns checks-only names when contexts is empty', () => {
    expect(mergeBranchRequiredCheckNames([], [{ context: 'ci/build' }])).toEqual(['ci/build']);
  });

  it('returns empty when both sources are unset', () => {
    expect(mergeBranchRequiredCheckNames(undefined, undefined)).toEqual([]);
  });
});

describe('deriveGreenEpoch', () => {
  it('starts epoch 1 on first green observation', () => {
    expect(deriveGreenEpoch(undefined, 'green')).toEqual({
      greenEpoch: 1,
      lastCiLevel: 'green',
    });
  });

  it('increments epoch on red→green flap (same head)', () => {
    const afterRed = deriveGreenEpoch({ lastCiLevel: 'red', greenEpoch: 1 }, 'green');
    expect(afterRed.greenEpoch).toBe(2);
  });

  it('keeps epoch on stable green', () => {
    const stable = deriveGreenEpoch({ lastCiLevel: 'green', greenEpoch: 2 }, 'green');
    expect(stable.greenEpoch).toBe(2);
  });
});

describe('resolveHeadOwningWorkerSessionId', () => {
  it('skips stale live PR session and returns head owner', () => {
    const headSha = 'currenthead';
    const sessions: AoSession[] = [
      {
        name: 'op-stale',
        role: 'worker',
        prNumber: 42,
        ownedHeadSha: 'oldhead00',
        runtime: 'alive',
        status: 'working',
      },
      {
        name: 'op-owner',
        role: 'worker',
        prNumber: 42,
        ownedHeadSha: headSha,
        runtime: 'alive',
        status: 'fixing_ci',
      },
    ];

    expect(
      resolveHeadOwningWorkerSessionId(sessions, 42, headSha, [
        { number: 42, headRefOid: headSha },
      ]),
    ).toBe('op-owner');
  });
});

describe('planCiGreenWakeActions', () => {
  it('(a) nudges pre-hand-off worker when required CI is green', () => {
    const session = liveWorker({
      reports: [
        {
          reportState: 'fixing_ci',

          reportedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      sessions: [session],
      ciChecksByPr: { 42: greenChecks },
      tracking: {},
    });
    expect(nudgeActions(result.actions)).toHaveLength(1);
    expect(nudgeActions(result.actions)[0]).toMatchObject({
      sessionId: 'op-worker',
      prNumber: 42,
      headSha: 'abc123',
    });
  });

  it('defers nudge when dispatch journal records pending unconsumed delivery', () => {
    const nowMs = Date.parse('2026-06-01T01:00:00.000Z');
    const settledAtMs = nowMs - QUIESCENCE_DEBOUNCE_MS - 1000;
    const deliveredAtMs = settledAtMs - 60_000;
    const result = plan({
      openPrs: [
        {
          number: 42,
          headRefOid: 'abc123',
          headCommittedAt: new Date(settledAtMs).toISOString(),
        },
      ],
      sessions: [
        liveWorker({
          activity: 'idle',
          status: 'working',
          reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: { heads: { '42:abc123': { lastCiLevel: 'green', greenEpoch: 1 } } },
      dispatchJournal: {
        'op-worker:1000:pack-send:ci-green:tr-42': {
          deliveryId: 'op-worker:1000:pack-send:ci-green:tr-42',
          sessionId: 'op-worker',
          deliveredAtMs,
          source: 'pack-send',
          sourceKey: 'ci-green:tr-42',
          deliveryPath: 'pending-draft',
        },
      },
      aoEvents: [],
      nowMs,
    });
    expect(nudgeActions(result.actions)).toHaveLength(0);
    const skip = result.actions.find((a) => a.type === 'skip');
    expect(
      skip?.reason === 'worker_actively_working' ||
        String(skip?.reason ?? '').includes('pending_unconsumed_delivery'),
    ).toBe(true);
  });

  it('(b) skips second identical green observation after nudge recorded', () => {
    const transitionId = buildTransitionId(42, 'abc123', 1);
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      sessions: [
        liveWorker({
          reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {
        heads: { '42:abc123': { lastCiLevel: 'green', greenEpoch: 1 } },
        nudged: { [transitionId]: { sessionId: 'op-worker', sentAtMs: 1 } },
      },
    });
    expect(nudgeActions(result.actions)).toHaveLength(0);
    expect(
      result.actions.some(
        (a) =>
          a.type === 'skip' &&
          (a.reason === 'already_nudged' || a.reason === 'already_nudged_this_cycle'),
      ),
    ).toBe(true);
  });

  it('(c) does not re-nudge on red→green flap within the same worker cycle (#332 C6b)', () => {
    const first = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      sessions: [
        liveWorker({
          reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {
        heads: { '42:abc123': { lastCiLevel: 'red', greenEpoch: 1 } },
        nudged: { '42:abc123:1': { sessionId: 'op-worker', sentAtMs: 1 } },
        cycleState: {
          repoId: 'orchestrator-pack',
          ownerCycles: {
            'orchestrator-pack:pr:42:owner:op-worker': {
              cycleId: 'seed-cycle',
              ownerSessionId: 'op-worker',
              prNumber: 42,
              nudgeArmed: true,
              nudgeSentAtMs: 1,
              nudgeExpiresAtMs: Date.now() + 60_000,
            },
          },
        },
      },
    });
    expect(nudgeActions(first.actions)).toHaveLength(0);
  });

  it('(e) does not nudge when ready_for_review accepted for head', () => {
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      sessions: [
        liveWorker({
          reports: [
            { reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' },
            { reportState: 'ready_for_review', reportedAt: '2026-06-01T01:00:00.000Z' },
          ],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {},
    });
    expect(nudgeActions(result.actions)).toHaveLength(0);
  });

  it('nudges when first live PR session is stale but a later session owns the head', () => {
    const headSha = 'currenthead';
    const result = plan({
      openPrs: [{ number: 77, headRefOid: headSha, headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      sessions: [
        {
          name: 'op-stale',
          role: 'worker',
          prNumber: 77,
          ownedHeadSha: 'oldhead00',
          runtime: 'alive',
          reports: [
            {
              reportState: 'fixing_ci',

              reportedAt: '2026-06-01T00:00:00.000Z',
            },
          ],
        } as unknown as AoSession,
        {
          name: 'op-owner',
          role: 'worker',
          prNumber: 77,
          ownedHeadSha: headSha,
          runtime: 'alive',
          reports: [
            { reportState: 'fixing_ci', reportedAt: '2026-06-05T00:00:00.000Z' },
          ],
        } as unknown as AoSession,
      ],
      ciChecksByPr: {
        77: [
          { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
          { name: 'PR scope guard', state: 'SUCCESS' },
          { name: 'Run pack contract tests', state: 'SUCCESS' },
          { name: 'Self-architect lint', state: 'SUCCESS' },
        ],
      },
      tracking: {},
    });

    const nudges = nudgeActions(result.actions);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.sessionId).toBe('op-owner');
  });

  it('(f) does not nudge when runtime is not alive', () => {
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      sessions: [
        liveWorker({
          runtime: 'exited',
          reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {},
    });
    expect(nudgeActions(result.actions)).toHaveLength(0);
  });

  it('(i) nudges head already green on first evaluation (level recovery)', () => {
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      sessions: [
        liveWorker({
          reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {},
    });
    expect(nudgeActions(result.actions)).toHaveLength(1);
  });

  it('(d) plans at most one nudge per transition when called once', () => {
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      sessions: [
        liveWorker({
          reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {},
    });
    expect(nudgeActions(result.actions)).toHaveLength(1);
  });

  it('does not mark nudgeArmed in cycleState during planning', () => {
    const settledAt = Date.parse('2026-06-01T00:00:00.000Z');
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: settledAt }],
      sessions: [
        liveWorker({
          reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {},
      nowMs: settledAt + QUIESCENCE_DEBOUNCE_MS + 1000,
    });
    const nudge = nudgeActions(result.actions)[0];
    expect(nudge?.ownerCycle).toBeDefined();
    const ownerCycles = (result.cycleState?.ownerCycles ?? {}) as Record<
      string,
      { nudgeArmed?: boolean }
    >;
    expect(Object.values(ownerCycles).every((cycle) => !cycle?.nudgeArmed)).toBe(true);
    const committed = commitNudgeSentCycleState(result.cycleState ?? {}, {
      repoId: nudge.ownerCycle!.repoId,
      prNumber: 42,
      ownerSessionId: nudge.sessionId,
      cycle: nudge.ownerCycle!.cycle,
      sentAtMs: settledAt + QUIESCENCE_DEBOUNCE_MS + 1000,
    });
    const armedCycles = (committed.ownerCycles ?? {}) as Record<string, { nudgeArmed?: boolean }>;
    expect(Object.values(armedCycles).some((cycle) => cycle?.nudgeArmed)).toBe(true);
  });
});

describe('preSendRecheck', () => {
  const baseSession = liveWorker({
    reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
  });

  it('fails when fresh snapshot shows CI no longer green', () => {
    const recheck = preSendRecheck(
      { sessionId: 'op-worker', prNumber: 42, headSha: 'abc123' },
      {
        openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
        sessions: [baseSession],
        ciChecksByPr: { 42: redChecks },
        requiredCheckNamesByPr: {},
      },
    );
    expect(recheck.ok).toBe(false);
    expect(recheck.reason).toContain('ci_red');
  });

  it('(g) fails closed when head moved before send', () => {
    const recheck = preSendRecheck(
      { sessionId: 'op-worker', prNumber: 42, headSha: 'abc123' },
      {
        openPrs: [{ number: 42, headRefOid: 'newhead9', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
        sessions: [baseSession],
        ciChecksByPr: { 42: greenChecks },
      },
    );
    expect(recheck.ok).toBe(false);
  });

  it('(g) fails closed when runtime not alive at send', () => {
    const recheck = preSendRecheck(
      { sessionId: 'op-worker', prNumber: 42, headSha: 'abc123' },
      {
        openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
        sessions: [{ ...baseSession, runtime: 'exited' }],
        ciChecksByPr: { 42: greenChecks },
      },
    );
    expect(recheck.ok).toBe(false);
  });

  it('fails when worker resumed active work after planning', () => {
    const nowMs = Date.parse('2026-06-01T01:00:00.000Z');
    const settledAtMs = nowMs - QUIESCENCE_DEBOUNCE_MS - 1000;
    const recheck = preSendRecheck(
      { sessionId: 'op-worker', prNumber: 42, headSha: 'abc123' },
      {
        openPrs: [
          {
            number: 42,
            headRefOid: 'abc123',
            headCommittedAt: new Date(settledAtMs).toISOString(),
          },
        ],
        sessions: [
          liveWorker({
            activity: 'active',
            reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
          }),
        ],
        ciChecksByPr: { 42: greenChecks },
        nowMs,
      },
    );
    expect(recheck.ok).toBe(false);
    expect(recheck.reason).toContain('worker_actively_working');
  });

  it('fails when fresh snapshot shows unconsumed delivery', () => {
    const nowMs = Date.parse('2026-06-01T01:00:00.000Z');
    const settledAtMs = nowMs - QUIESCENCE_DEBOUNCE_MS - 1000;
    const deliveredAtMs = settledAtMs - 60_000;
    const recheck = preSendRecheck(
      { sessionId: 'op-worker', prNumber: 42, headSha: 'abc123' },
      {
        openPrs: [
          {
            number: 42,
            headRefOid: 'abc123',
            headCommittedAt: new Date(settledAtMs).toISOString(),
          },
        ],
        sessions: [
          liveWorker({
            activity: 'idle',
            status: 'working',
            reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
          }),
        ],
        ciChecksByPr: { 42: greenChecks },
        dispatchJournal: {
          'op-worker:1000:pack-send:ci-green:tr-42': {
            deliveryId: 'op-worker:1000:pack-send:ci-green:tr-42',
            sessionId: 'op-worker',
            deliveredAtMs,
            source: 'pack-send',
            sourceKey: 'ci-green:tr-42',
            deliveryPath: 'pending-draft',
          },
        },
        aoEvents: [],
        nowMs,
      },
    );
    expect(recheck.ok).toBe(false);
    expect(recheck.reason).toContain('worker_actively_working');
  });

  it('fails when prior review revision opened after planning', () => {
    const nowMs = Date.parse('2026-06-01T01:00:00.000Z');
    const settledAtMs = nowMs - QUIESCENCE_DEBOUNCE_MS - 1000;
    const recheck = preSendRecheck(
      { sessionId: 'op-worker', prNumber: 42, headSha: 'abc123' },
      {
        openPrs: [
          {
            number: 42,
            headRefOid: 'abc123',
            headCommittedAt: new Date(settledAtMs).toISOString(),
          },
        ],
        sessions: [
          liveWorker({
            activity: 'idle',
            reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
          }),
        ],
        ciChecksByPr: { 42: greenChecks },
        reviewRuns: [
          {
            id: 'rev-open',
            prNumber: 42,
            targetSha: 'abc123',
            status: 'needs_triage',
            findingCount: 1,
            openFindingCount: 1,
            sentFindingCount: 1,
          },
        ],
        nowMs,
      },
    );
    expect(recheck.ok).toBe(false);
    expect(recheck.reason).toContain('prior_revision_open');
  });
});

describe('recordSuccessfulNudge / dedupe priority', () => {
  it('(h) allows benign duplicate when dedupe record was lost', () => {
    const tracking = recordSuccessfulNudge({}, '42:abc123:1', 'op-worker', 100);
    expect(tracking.nudged?.['42:abc123:1']).toBeDefined();

    const withoutDedupe = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      sessions: [
        liveWorker({
          reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {
        heads: { '42:abc123': { lastCiLevel: 'green', greenEpoch: 1 } },
        nudged: {},
      },
    });
    expect(nudgeActions(withoutDedupe.actions)).toHaveLength(1);
  });
});

describe('mergeLegacyNudgedWithPendingJournal', () => {
  it('folds pending journal sends into legacy nudged evidence', () => {
    const merged = mergeLegacyNudgedWithPendingJournal(
      {},
      {
        '42:abc123:1': {
          sessionId: 'op-worker',
          sentAtMs: 5000,
          message: 'hand off',
        },
      },
    );
    expect(merged).toEqual({
      '42:abc123:1': { sessionId: 'op-worker', sentAtMs: 5000 },
    });
  });

  it('keeps committed nudged records when both maps contain the same transition', () => {
    const merged = mergeLegacyNudgedWithPendingJournal(
      { '42:abc123:1': { sessionId: 'op-worker', sentAtMs: 9000 } },
      { '42:abc123:1': { sessionId: 'op-worker', sentAtMs: 5000, message: 'hand off' } },
    );
    expect(merged['42:abc123:1']?.sentAtMs).toBe(9000);
  });
});

describe('findForbiddenCiGreenWakeCommands', () => {
  it('forbids spawn, claim-pr, and kill but allows ao send', () => {
    expect(findForbiddenCiGreenWakeCommands(['ao send op-1 hello'])).toHaveLength(0);
    expect(findForbiddenCiGreenWakeCommands(['ao spawn worker'])).toHaveLength(1);
    expect(findForbiddenCiGreenWakeCommands(['ao session kill op-1'])).toHaveLength(1);
  });
});

describe('isPreHandOffWorkerForHead', () => {
  it('fails closed when reports are missing and session status is post-hand-off', () => {
    expect(
      isPreHandOffWorkerForHead(
        liveWorker({ status: 'addressing_reviews', reports: [] }),
        'abc123',
      ),
    ).toBe(false);
  });

  it('allows pre-hand-off when reports are missing but session status is eligible', () => {
    expect(
      isPreHandOffWorkerForHead(liveWorker({ status: 'fixing_ci', reports: [] }), 'abc123'),
    ).toBe(true);
  });
});

describe('evaluateCiGreenWakeCandidate', () => {
  it('rejects nudge when required-check lookup failed even if pack checks are green', () => {
    const candidate = evaluateCiGreenWakeCandidate({
      session: liveWorker({
        reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
      }),
      prNumber: 42,
      headSha: 'abc123',
      openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
      ciChecks: greenChecks,
      requiredCheckLookupFailed: true,
    });
    expect(candidate.eligible).toBe(false);
    expect(candidate.reasons).toContain('ci_pending');
  });

  it('accepts pr_created and working states', () => {
    for (const state of ['pr_created', 'working'] as const) {
      const candidate = evaluateCiGreenWakeCandidate({
        session: liveWorker({
          reports: [
            state === 'pr_created'
              ? {
                  reportState: 'pr_created',
                  prNumber: 42,
                  reportedAt: '2026-06-01T00:00:00.000Z',
                }
              : { reportState: 'working', reportedAt: '2026-06-01T00:00:00.000Z' },
          ],
        }),
        prNumber: 42,
        headSha: 'abc123',
        openPrs: [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }],
        ciChecks: greenChecks,
      });
      expect(candidate.eligible).toBe(true);
    }
  });
});

describe('fixture payloads', () => {
  it('loads pre-hand-off-green fixture', () => {
    const fixture = loadFixture('pre-handoff-green.json');
    const result = plan({
      ...fixture,
      nowMs: Date.parse('2026-06-05T14:00:00.000Z'),
      sessions: fixture.sessions.map((session) => ({
        ...session,
        runtime: 'alive',
        activity: 'idle',
      })),
    });
    expect(nudgeActions(result.actions).length).toBeGreaterThanOrEqual(1);
  });
});

describe('backstop preserved (AC6)', () => {
  it('example yaml still wires report-stale and ci-failed reactions', () => {
    const example = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../agent-orchestrator.yaml.example'),
      'utf8',
    );
    expect(example).toMatch(/ci-failed:[\s\S]*action:\s*send-to-agent/);
    expect(example).toMatch(/report-stale:[\s\S]*action:\s*send-to-agent/);
    expect(example).toContain('ci-green-wake-reconcile.ps1');
  });
});

describe('latency bound (AC1)', () => {
  it('defaults to 1-minute mechanical tick', () => {
    expect(DEFAULT_CI_GREEN_WAKE_INTERVAL_MS).toBe(60 * 1000);
  });
});

describe('native plan CLI', () => {
  it('initializes without circular import failure', () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = spawnSync('node', ['docs/ci-green-wake-reconcile.mjs', 'plan'], {
      cwd: repoRoot,
      input: '{}',
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/before initialization/);
    expect(JSON.parse(result.stdout || '{}')).toEqual(expect.objectContaining({ actions: expect.any(Array) }));
  });
});
