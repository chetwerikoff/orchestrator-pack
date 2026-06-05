import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CI_GREEN_WAKE_INTERVAL_MS,
  buildTransitionId,
  classifyRequiredCiLevel,
  deriveGreenEpoch,
  evaluateCiGreenWakeCandidate,
  findForbiddenCiGreenWakeCommands,
  planCiGreenWakeActions,
  preSendRecheck,
  recordSuccessfulNudge,
  type CiGreenWakeAction,
  type PlanCiGreenWakeInput,
} from '../docs/ci-green-wake-reconcile.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/ci-green-wake-reconcile',
);

const greenChecks = [
  { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
  { name: 'PR scope guard', state: 'SUCCESS' },
  { name: 'Run pack contract tests', state: 'SUCCESS' },
  { name: 'Self-architect lint', state: 'SUCCESS' },
];

const redChecks = [
  { name: 'Verify orchestrator-pack structure', state: 'FAILURE' },
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
    runtime: 'alive',
    status: 'fixing_ci',
    reports: [],
    ...overrides,
  };
}

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

describe('planCiGreenWakeActions', () => {
  it('(a) nudges pre-hand-off worker when required CI is green', () => {
    const session = liveWorker({
      reports: [
        {
          reportState: 'fixing_ci',
          headRefOid: 'abc123',
          reportedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123' }],
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

  it('(b) skips second identical green observation after nudge recorded', () => {
    const transitionId = buildTransitionId(42, 'abc123', 1);
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123' }],
      sessions: [
        liveWorker({
          reports: [{ reportState: 'fixing_ci', headRefOid: 'abc123', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {
        heads: { '42:abc123': { lastCiLevel: 'green', greenEpoch: 1 } },
        nudged: { [transitionId]: { sessionId: 'op-worker', sentAtMs: 1 } },
      },
    });
    expect(nudgeActions(result.actions)).toHaveLength(0);
    expect(result.actions.some((a) => a.type === 'skip' && a.reason === 'already_nudged')).toBe(true);
  });

  it('(c) treats renewed red→green on same head as new transition', () => {
    const first = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123' }],
      sessions: [
        liveWorker({
          reports: [{ reportState: 'fixing_ci', headRefOid: 'abc123', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {
        heads: { '42:abc123': { lastCiLevel: 'red', greenEpoch: 1 } },
        nudged: { '42:abc123:1': { sessionId: 'op-worker', sentAtMs: 1 } },
      },
    });
    const nudges = nudgeActions(first.actions);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.transitionId).toBe('42:abc123:2');
  });

  it('(e) does not nudge when ready_for_review accepted for head', () => {
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123' }],
      sessions: [
        liveWorker({
          reports: [
            { reportState: 'fixing_ci', headRefOid: 'abc123', reportedAt: '2026-06-01T00:00:00.000Z' },
            { reportState: 'ready_for_review', headRefOid: 'abc123', reportedAt: '2026-06-01T01:00:00.000Z' },
          ],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {},
    });
    expect(nudgeActions(result.actions)).toHaveLength(0);
  });

  it('(f) does not nudge when runtime is not alive', () => {
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123' }],
      sessions: [
        liveWorker({
          runtime: 'exited',
          reports: [{ reportState: 'fixing_ci', headRefOid: 'abc123', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {},
    });
    expect(nudgeActions(result.actions)).toHaveLength(0);
  });

  it('(i) nudges head already green on first evaluation (level recovery)', () => {
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123' }],
      sessions: [
        liveWorker({
          reports: [{ reportState: 'fixing_ci', headRefOid: 'abc123', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {},
    });
    expect(nudgeActions(result.actions)).toHaveLength(1);
  });

  it('(d) plans at most one nudge per transition when called once', () => {
    const result = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123' }],
      sessions: [
        liveWorker({
          reports: [{ reportState: 'fixing_ci', headRefOid: 'abc123', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
      ],
      ciChecksByPr: { 42: greenChecks },
      tracking: {},
    });
    expect(nudgeActions(result.actions)).toHaveLength(1);
  });
});

describe('preSendRecheck', () => {
  const baseSession = liveWorker({
    reports: [{ reportState: 'fixing_ci', headRefOid: 'abc123', reportedAt: '2026-06-01T00:00:00.000Z' }],
  });

  it('fails when fresh snapshot shows CI no longer green', () => {
    const recheck = preSendRecheck(
      { sessionId: 'op-worker', prNumber: 42, headSha: 'abc123' },
      {
        openPrs: [{ number: 42, headRefOid: 'abc123' }],
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
        openPrs: [{ number: 42, headRefOid: 'newhead9' }],
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
        openPrs: [{ number: 42, headRefOid: 'abc123' }],
        sessions: [{ ...baseSession, runtime: 'exited' }],
        ciChecksByPr: { 42: greenChecks },
      },
    );
    expect(recheck.ok).toBe(false);
  });
});

describe('recordSuccessfulNudge / dedupe priority', () => {
  it('(h) allows benign duplicate when dedupe record was lost', () => {
    const tracking = recordSuccessfulNudge({}, '42:abc123:1', 'op-worker', 100);
    expect(tracking.nudged?.['42:abc123:1']).toBeDefined();

    const withoutDedupe = plan({
      openPrs: [{ number: 42, headRefOid: 'abc123' }],
      sessions: [
        liveWorker({
          reports: [{ reportState: 'fixing_ci', headRefOid: 'abc123', reportedAt: '2026-06-01T00:00:00.000Z' }],
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

describe('findForbiddenCiGreenWakeCommands', () => {
  it('forbids spawn, claim-pr, and kill but allows ao send', () => {
    expect(findForbiddenCiGreenWakeCommands(['ao send op-1 hello'])).toHaveLength(0);
    expect(findForbiddenCiGreenWakeCommands(['ao spawn worker'])).toHaveLength(1);
    expect(findForbiddenCiGreenWakeCommands(['ao session kill op-1'])).toHaveLength(1);
  });
});

describe('evaluateCiGreenWakeCandidate', () => {
  it('accepts pr_created and working states', () => {
    for (const state of ['pr_created', 'working'] as const) {
      const candidate = evaluateCiGreenWakeCandidate({
        session: liveWorker({
          reports: [{ reportState: state, headRefOid: 'abc123', reportedAt: '2026-06-01T00:00:00.000Z' }],
        }),
        prNumber: 42,
        headSha: 'abc123',
        openPrs: [{ number: 42, headRefOid: 'abc123' }],
        ciChecks: greenChecks,
      });
      expect(candidate.eligible).toBe(true);
    }
  });
});

describe('fixture payloads', () => {
  it('loads pre-hand-off-green fixture', () => {
    const fixture = loadFixture('pre-handoff-green.json');
    const result = plan(fixture);
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
