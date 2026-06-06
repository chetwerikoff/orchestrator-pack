import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATE_CONFIRMED,
  DELIVERY_STATE_ESCALATED,
  planDeliveryConfirmActions,
  type DeliveryConfirmAction,
} from '../docs/review-finding-delivery-confirm.mjs';
import {
  assertSubmitArgvIsEnterOnly,
  buildSubmitDecisionKey,
  buildSubmitEnterArgv,
  DEFAULT_MAX_SUBMITS,
  evaluateSubmitEligibility,
  hasInterveningInputActivity,
  resolveSubmitConfig,
} from '../docs/worker-input-draft-submit.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/review-finding-delivery-submit',
);

type FixturePayload = {
  description?: string;
  reviewRuns: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  openPrs?: Array<{ number: number; headRefOid: string }>;
  tracking?: { runs?: Record<string, Record<string, unknown>> };
  nowMs: number;
  config?: Record<string, unknown>;
  aoEvents?: Record<string, unknown>[];
  floodActiveSessions?: Record<string, boolean>;
};

function loadFixture(name: string): FixturePayload {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as FixturePayload;
}

function planFromFixture(name: string) {
  const fixture = loadFixture(name);
  return planDeliveryConfirmActions({
    reviewRuns: fixture.reviewRuns,
    sessions: fixture.sessions,
    openPrs: fixture.openPrs ?? [],
    tracking: fixture.tracking ?? { runs: {} },
    nowMs: fixture.nowMs,
    config: fixture.config,
    aoEvents: fixture.aoEvents ?? [],
    floodActiveSessions: fixture.floodActiveSessions ?? {},
  });
}

describe('submit when delivered-but-unconsumed (AC1)', () => {
  it('emits exactly one submit after redeliveries exhausted', () => {
    const { actions, tracking } = planFromFixture('redeliveries-exhausted-submit.json');
    const submits = actions.filter(
      (a): a is Extract<DeliveryConfirmAction, { type: 'submit' }> => a.type === 'submit',
    );
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({
      runId: 'run-submit-1',
      sessionId: 'opk-worker-live',
      prNumber: 166,
      attempt: 1,
      maxSubmits: 1,
      decisionKey: 'run-submit-1:sha166b',
    });
    expect(tracking.runs?.['run-submit-1']?.submitCount).toBe(1);
    expect(tracking.runs?.['run-submit-1']?.submitDecisionKey).toBe('run-submit-1:sha166b');
  });
});

describe('causal consumption only (AC2)', () => {
  it('marks confirmed on addressing_reviews — no submit', () => {
    const { actions } = planFromFixture('addressing-reviews-no-submit.json');
    expect(actions.some((a) => a.type === 'submit')).toBe(false);
    expect(actions.some((a) => a.type === 'mark_confirmed')).toBe(true);
  });

  it('unrelated working report does not confirm — submit remains', () => {
    const { actions } = planFromFixture('unrelated-activity-still-submits.json');
    expect(actions.some((a) => a.type === 'mark_confirmed')).toBe(false);
    expect(actions.filter((a) => a.type === 'submit')).toHaveLength(1);
  });
});

describe('fail-closed on ambiguity (AC3)', () => {
  it('escalates dead session without submit', () => {
    const { actions } = planFromFixture('fail-closed-dead-session.json');
    expect(actions.some((a) => a.type === 'submit')).toBe(false);
    expect(
      actions.some(
        (a) => a.type === 'escalate' && a.reason === 'orphan_or_dead_linked_session',
      ),
    ).toBe(true);
  });
});

describe('bounded submit + escalate (AC4)', () => {
  it('defaults maxSubmits to one', () => {
    expect(DEFAULT_MAX_SUBMITS).toBe(1);
    expect(resolveSubmitConfig({}).maxSubmits).toBe(1);
  });

  it('escalates when submit budget exhausted', () => {
    const { actions, tracking } = planFromFixture('submit-budget-exhausted-escalate.json');
    expect(actions.some((a) => a.type === 'submit')).toBe(false);
    expect(
      actions.some(
        (a) => a.type === 'escalate' && a.reason === 'max_submits_exhausted',
      ),
    ).toBe(true);
    expect(tracking.runs?.['run-submit-exhausted']?.deliveryState).toBe(
      DELIVERY_STATE_ESCALATED,
    );
  });

  it('new head SHA resets submit budget', () => {
    const { actions } = planFromFixture('new-head-resets-submit-budget.json');
    expect(actions.filter((a) => a.type === 'submit')).toHaveLength(1);
    expect(buildSubmitDecisionKey('run-new-head', 'newhead99')).toBe('run-new-head:newhead99');
  });
});

describe('flood defer (AC5)', () => {
  it('defers submit without escalating when flood active', () => {
    const { actions } = planFromFixture('flood-active-defer.json');
    expect(actions.some((a) => a.type === 'submit')).toBe(false);
    expect(actions.some((a) => a.type === 'escalate')).toBe(false);
    expect(actions.some((a) => a.type === 'defer' && a.reason === 'flood_active')).toBe(
      true,
    );
  });
});

describe('dedupe restart-safe (AC6)', () => {
  it('does not plan second submit when decision key already recorded', () => {
    const fixture = loadFixture('redeliveries-exhausted-submit.json');
    const first = planDeliveryConfirmActions({
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      openPrs: fixture.openPrs ?? [],
      tracking: fixture.tracking ?? { runs: {} },
      nowMs: fixture.nowMs,
      config: fixture.config,
      aoEvents: [],
      floodActiveSessions: {},
    });
    const second = planDeliveryConfirmActions({
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      openPrs: fixture.openPrs ?? [],
      tracking: first.tracking,
      nowMs: fixture.nowMs + 60_000,
      config: fixture.config,
      aoEvents: [],
      floodActiveSessions: {},
    });
    expect(first.actions.filter((a) => a.type === 'submit')).toHaveLength(1);
    expect(second.actions.filter((a) => a.type === 'submit')).toHaveLength(0);
  });
});

describe('never authors content (AC7)', () => {
  it('submit action carries no composed finding text', () => {
    const { actions } = planFromFixture('redeliveries-exhausted-submit.json');
    const submit = actions.find((a) => a.type === 'submit');
    expect(submit).toBeDefined();
    const serialized = JSON.stringify(submit);
    expect(serialized).not.toMatch(/finding|severity|file:|line \d+/i);
    expect(Object.keys(submit ?? {})).not.toContain('message');
    expect(Object.keys(submit ?? {})).not.toContain('findingText');
  });

  it('submit argv is Enter-only to tmux', () => {
    const argv = buildSubmitEnterArgv('opk-worker-live');
    assertSubmitArgvIsEnterOnly(argv);
    expect(argv).toEqual(['send-keys', '-t', 'opk-worker-live', 'Enter']);
    expect(argv.join(' ')).not.toMatch(/paste|load-buffer|Escape|-l /);
  });
});

describe('stale input refused (AC8)', () => {
  it('escalates when intervening input-affecting activity detected', () => {
    const { actions } = planFromFixture('stale-input-refused.json');
    expect(actions.some((a) => a.type === 'submit')).toBe(false);
    expect(
      actions.some(
        (a) => a.type === 'escalate' && a.reason === 'stale_input_refused',
      ),
    ).toBe(true);
  });

  it('hasInterveningInputActivity detects activity.transition to active', () => {
    const events = [
      {
        kind: 'activity.transition',
        sessionId: 'opk-1',
        tsEpoch: 2000,
        data: { to: 'active' },
      },
    ];
    expect(hasInterveningInputActivity(events, 'opk-1', 1000)).toBe(true);
    expect(hasInterveningInputActivity(events, 'opk-1', 3000)).toBe(false);
  });
});

describe('confirmed runs skip submit path', () => {
  it('records confirmed without submit', () => {
    const { actions, tracking } = planFromFixture('addressing-reviews-no-submit.json');
    expect(actions.some((a) => a.type === 'submit')).toBe(false);
    expect(tracking.runs?.['run-confirmed']?.deliveryState).toBe(DELIVERY_STATE_CONFIRMED);
  });
});

describe('evaluateSubmitEligibility unit', () => {
  it('returns defer for flood', () => {
    const result = evaluateSubmitEligibility({
      run: {
        id: 'r1',
        prNumber: 1,
        targetSha: 'abc',
        linkedSessionId: 's1',
        status: 'sent_to_agent',
        sentFindingCount: 1,
      },
      sessions: [
        { sessionId: 's1', role: 'worker', prNumber: 1, status: 'working' },
      ],
      tracking: {
        runs: {
          r1: { redeliveryCount: 2, sendObservedAtMs: 1000, lastRedeliveryAtMs: 2000 },
        },
      },
      allRuns: [],
      openPrs: [{ number: 1, headRefOid: 'abc' }],
      aoEvents: [],
      floodActiveSessions: { s1: true },
      nowMs: 5000,
      config: { maxSubmits: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.defer).toBe(true);
    expect(result.reason).toBe('flood_active');
  });
});
