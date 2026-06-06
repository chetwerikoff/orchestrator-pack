import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BLIND_RECOVERY_FORBIDDEN,
  DEFAULT_GRACE_MS,
  GRACE_MINUTES_ENV_VAR,
  classifyReviewReadySnapshot,
  findBlindRecoveryViolations,
  getGraceAnchorMs,
  graceTrackingKey,
  isMergeContractCiGreen,
  isRuntimeAlive,
  isWithinGrace,
  planStuckGuardReaction,
  resolveGraceMs,
} from '../docs/review-ready-stuck-guard.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/review-ready-stuck-guard',
);

type FixturePayload = {
  description?: string;
  session: Record<string, unknown>;
  openPr: { number: number; headRefOid: string };
  reviewRuns: Record<string, unknown>[];
  ciChecks: Array<{ name: string; state: string }>;
  tracking?: { snapshots?: Record<string, { firstFalseStuckAtMs?: number }> };
  unreachability?: Record<string, boolean>;
  graceMs?: number;
  nowMs: number;
  expect?: Record<string, unknown>;
};

function loadFixture(name: string): FixturePayload {
  const raw = readFileSync(path.join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as FixturePayload;
}

function classifyFromFixture(name: string) {
  const fixture = loadFixture(name);
  return classifyReviewReadySnapshot({
    session: fixture.session,
    openPr: fixture.openPr,
    reviewRuns: fixture.reviewRuns,
    ciChecks: fixture.ciChecks,
    sessions: [fixture.session],
  });
}

function planFromFixture(name: string) {
  const fixture = loadFixture(name);
  return planStuckGuardReaction({
    session: fixture.session,
    openPr: fixture.openPr,
    reviewRuns: fixture.reviewRuns,
    ciChecks: fixture.ciChecks,
    sessions: [fixture.session],
    tracking: fixture.tracking,
    unreachability: fixture.unreachability,
    nowMs: fixture.nowMs,
    graceMs: fixture.graceMs,
  });
}

describe('isRuntimeAlive (explicit runtime only)', () => {
  it('is true only for runtime alive', () => {
    expect(isRuntimeAlive({ runtime: 'alive' })).toBe(true);
    expect(isRuntimeAlive({ runtime: 'ALIVE' })).toBe(true);
  });

  it('fails closed when runtime is missing or unrecognized', () => {
    expect(isRuntimeAlive({ status: 'working' })).toBe(false);
    expect(isRuntimeAlive({ runtime: 'exited' })).toBe(false);
    expect(isRuntimeAlive({ runtime: 'detecting' })).toBe(false);
    expect(isRuntimeAlive({ runtime: '' })).toBe(false);
  });
});

describe('resolveGraceMs', () => {
  const previousEnv = process.env[GRACE_MINUTES_ENV_VAR];

  beforeEach(() => {
    delete process.env[GRACE_MINUTES_ENV_VAR];
  });

  afterEach(() => {
    if (previousEnv === undefined) {
      delete process.env[GRACE_MINUTES_ENV_VAR];
    } else {
      process.env[GRACE_MINUTES_ENV_VAR] = previousEnv;
    }
  });

  it('uses DEFAULT_GRACE_MS when unset', () => {
    expect(resolveGraceMs({})).toBe(DEFAULT_GRACE_MS);
  });

  it('honors AO_REVIEW_READY_STUCK_GRACE_MINUTES', () => {
    process.env[GRACE_MINUTES_ENV_VAR] = '30';
    expect(resolveGraceMs({})).toBe(30 * 60 * 1000);
  });

  it('prefers explicit graceMs over env minutes', () => {
    process.env[GRACE_MINUTES_ENV_VAR] = '30';
    expect(resolveGraceMs({ graceMs: 120_000 })).toBe(120_000);
  });
});

describe('isMergeContractCiGreen', () => {
  it('requires all pack merge-contract checks success', () => {
    expect(
      isMergeContractCiGreen([
        { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
        { name: 'PR scope guard', state: 'SUCCESS' },
        { name: 'Run pack contract tests', state: 'SUCCESS' },
        { name: 'Self-architect lint', state: 'SUCCESS' },
      ]),
    ).toBe(true);
  });

  it('rejects pending and failure on required checks', () => {
    expect(
      isMergeContractCiGreen([
        { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
        { name: 'PR scope guard', state: 'PENDING' },
        { name: 'Run pack contract tests', state: 'SUCCESS' },
        { name: 'Self-architect lint', state: 'SUCCESS' },
      ]),
    ).toBe(false);
  });

  it('ignores optional or third-party checks that are red or pending', () => {
    expect(
      isMergeContractCiGreen([
        { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
        { name: 'PR scope guard', state: 'SUCCESS' },
        { name: 'Run pack contract tests', state: 'SUCCESS' },
        { name: 'Self-architect lint', state: 'SUCCESS' },
        { name: 'Codecov', state: 'FAILURE' },
        { name: 'Some optional workflow', state: 'PENDING' },
      ]),
    ).toBe(true);
  });
});

describe('grace tracking (AC3)', () => {
  it('anchors once per session/head key', () => {
    const key = graceTrackingKey('opk-1', 'abc123');
    expect(key).toBe('opk-1:abc123');
    const anchor = getGraceAnchorMs(
      { snapshots: { [key]: { firstFalseStuckAtMs: 1000 } } },
      'opk-1',
      'abc123',
      5000,
    );
    expect(anchor).toBe(1000);
    expect(isWithinGrace(anchor, 5000, DEFAULT_GRACE_MS)).toBe(true);
    expect(isWithinGrace(anchor, 1000 + DEFAULT_GRACE_MS, DEFAULT_GRACE_MS)).toBe(false);
  });
});

describe('classifyReviewReadySnapshot shape', () => {
  it('early exit returns full ReviewReadyClassification fields', () => {
    const result = classifyReviewReadySnapshot({
      session: {},
      openPr: { number: 0, headRefOid: '' },
      reviewRuns: [],
      ciChecks: [],
    });
    expect(result).toMatchObject({
      reviewReady: false,
      reasons: ['missing_snapshot_ids'],
      prNumber: 0,
      headSha: '',
      sessionId: '',
      readyReport: null,
      cleanRun: null,
    });
  });
});

describe('consistent-snapshot classification (AC1)', () => {
  it('positive fixture is review-ready', () => {
    const result = classifyFromFixture('positive-review-ready-alive.json');
    expect(result.reviewReady).toBe(true);
  });

  it('Issue #218: SHA-less ready_for_review is review-ready when head commit predates report', () => {
    const result = classifyFromFixture('positive-sha-less-ready.json');
    expect(result.reviewReady).toBe(true);
    expect(result.reasons).not.toContain('no_ready_for_review_for_head');
  });

  it('stale head-moved is not review-ready', () => {
    const result = classifyFromFixture('negative-stale-head-moved.json');
    expect(result.reviewReady).toBe(false);
    expect(result.reasons).toContain('no_ready_for_review_for_head');
  });

  it('red CI is not review-ready', () => {
    const result = classifyFromFixture('negative-red-ci.json');
    expect(result.reviewReady).toBe(false);
    expect(result.reasons).toContain('ci_not_green');
  });

  it('pending CI is not review-ready', () => {
    const result = classifyFromFixture('negative-pending-ci.json');
    expect(result.reviewReady).toBe(false);
    expect(result.reasons).toContain('ci_not_green');
  });

  it('headless ready_for_review does not match current head (stale-head race)', () => {
    const fixture = loadFixture('positive-review-ready-alive.json');
    const result = classifyReviewReadySnapshot({
      session: {
        ...fixture.session,
        ownedHeadSha: 'deadbeef174',
        reports: [
          {
            reportState: 'ready_for_review',
            reportedAt: '2026-06-04T11:00:00Z',
          },
        ],
      },
      openPr: fixture.openPr,
      reviewRuns: fixture.reviewRuns,
      ciChecks: fixture.ciChecks,
      sessions: [fixture.session],
    });
    expect(result.reviewReady).toBe(false);
    expect(result.reasons).toContain('no_ready_for_review_for_head');
  });

  it('missing runtime is not review-ready (fail closed)', () => {
    const fixture = loadFixture('positive-review-ready-alive.json');
    const result = classifyReviewReadySnapshot({
      session: { ...fixture.session, runtime: undefined },
      openPr: fixture.openPr,
      reviewRuns: fixture.reviewRuns,
      ciChecks: fixture.ciChecks,
      sessions: [fixture.session],
    });
    expect(result.reviewReady).toBe(false);
    expect(result.reasons).toContain('runtime_not_alive');
  });
});

describe('covering clean run only (AC2)', () => {
  it('waiting_update does not grant protection', () => {
    const result = classifyFromFixture('negative-waiting-update-not-protected.json');
    expect(result.reviewReady).toBe(false);
    expect(result.reasons).toContain('no_covering_clean_run');
  });
});

describe('stuck guard reactions', () => {
  it('AC3: holds grace without immediate lifecycle', () => {
    const { action } = planFromFixture('grace-hold-no-immediate-lifecycle.json');
    expect(action.type).toBe('hold_grace');
    expect(action).toMatchObject({ forbidImmediateLifecycle: true });
  });

  it('AC3: repeated stuck does not extend grace past deadline', () => {
    const { action } = planFromFixture('grace-monotonic-repeated-stuck.json');
    expect(action.type).toBe('allow_normal');
    expect(action.reason).toBe('grace_expired_no_affirmative_unreachable');
  });

  it('AC4a: affirmative unreachable allows recycle escalate', () => {
    const { action } = planFromFixture('recovery-affirmative-unreachable.json');
    expect(action.type).toBe('recycle_escalate');
    expect(action).toMatchObject({ forbidBlindRecovery: true });
  });

  it('AC4b: quiet worker stays on hold within grace', () => {
    const { action } = planFromFixture('recovery-quiet-within-grace.json');
    expect(action.type).toBe('hold_grace');
  });

  it('AC5: dead runtime is not shielded', () => {
    const { classification, action } = planFromFixture('dead-runtime-not-shielded.json');
    expect(classification.reviewReady).toBe(false);
    expect(action.type).toBe('allow_normal');
  });

  it('AC6: ordinary stuck without review-ready uses normal handling', () => {
    const { classification, action } = planFromFixture('ordinary-stuck-not-shielded.json');
    expect(classification.reviewReady).toBe(false);
    expect(action.type).toBe('allow_normal');
  });
});

describe('blind recovery forbidden (AC4)', () => {
  it('flags ao spawn and --claim-pr', () => {
    const violations = findBlindRecoveryViolations([
      'ao spawn --claim-pr 42',
      'ao session kill opk-1',
    ]);
    expect(violations.length).toBeGreaterThanOrEqual(2);
    expect(BLIND_RECOVERY_FORBIDDEN.length).toBeGreaterThan(0);
  });
});

describe('fixture expectations', () => {
  const fixtureNames = [
    'positive-review-ready-alive.json',
    'negative-stale-head-moved.json',
    'negative-red-ci.json',
    'negative-pending-ci.json',
    'negative-waiting-update-not-protected.json',
    'grace-hold-no-immediate-lifecycle.json',
    'grace-monotonic-repeated-stuck.json',
    'recovery-affirmative-unreachable.json',
    'recovery-quiet-within-grace.json',
    'dead-runtime-not-shielded.json',
    'ordinary-stuck-not-shielded.json',
  ];

  for (const name of fixtureNames) {
    it(`honours expect block in ${name}`, () => {
      const fixture = loadFixture(name);
      const expectBlock = fixture.expect ?? {};
      const classification = classifyReviewReadySnapshot({
        session: fixture.session,
        openPr: fixture.openPr,
        reviewRuns: fixture.reviewRuns,
        ciChecks: fixture.ciChecks,
        sessions: [fixture.session],
      });
      if (typeof expectBlock.reviewReady === 'boolean') {
        expect(classification.reviewReady).toBe(expectBlock.reviewReady);
      }
      if (expectBlock.actionType) {
        const { action } = planStuckGuardReaction({
          session: fixture.session,
          openPr: fixture.openPr,
          reviewRuns: fixture.reviewRuns,
          ciChecks: fixture.ciChecks,
          sessions: [fixture.session],
          tracking: fixture.tracking,
          unreachability: fixture.unreachability,
          nowMs: fixture.nowMs,
          graceMs: fixture.graceMs,
        });
        expect(action.type).toBe(expectBlock.actionType);
      }
    });
  }
});
