import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATE_ESCALATED,
  planDeliveryConfirmActions,
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

function loadSubmitFixture(name: string): FixturePayload {
  const fixturePath = path.join(fixturesDir, name);
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as FixturePayload;
}

function planSubmitScenario(name: string) {
  const fixture = loadSubmitFixture(name);
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

describe('delivery confirm no longer owns submit (Issue #232)', () => {
  it('escalates after redeliveries exhausted — submit is unified arbiter', () => {
    const { actions } = planSubmitScenario('redeliveries-exhausted-submit.json');
    expect(actions.some((a) => a.type === 'submit')).toBe(false);
    expect(
      actions.some(
        (a) => a.type === 'escalate' && a.reason === 'max_redeliveries_exhausted',
      ),
    ).toBe(true);
  });

  it('unrelated working report escalates after redeliveries — not submit', () => {
    const { actions } = planSubmitScenario('unrelated-activity-still-submits.json');
    expect(actions.some((a) => a.type === 'submit')).toBe(false);
    expect(actions.some((a) => a.type === 'escalate')).toBe(true);
  });

  it('escalates dead session without submit', () => {
    const { actions } = planSubmitScenario('fail-closed-dead-session.json');
    expect(actions.some((a) => a.type === 'submit')).toBe(false);
    expect(
      actions.some(
        (a) => a.type === 'escalate' && a.reason === 'orphan_or_dead_linked_session',
      ),
    ).toBe(true);
  });
});

describe('causal consumption only', () => {
  it('marks confirmed on addressing_reviews — no submit', () => {
    const { actions } = planSubmitScenario('addressing-reviews-no-submit.json');
    expect(actions.some((a) => a.type === 'submit')).toBe(false);
    expect(actions.some((a) => a.type === 'mark_confirmed')).toBe(true);
  });
});

describe('submit adapter helpers (Issue #216 bridge)', () => {
  it('defaults maxSubmits to one', () => {
    expect(DEFAULT_MAX_SUBMITS).toBe(1);
    expect(resolveSubmitConfig({}).maxSubmits).toBe(1);
  });

  it('submit argv is Enter-only to tmux', () => {
    const argv = buildSubmitEnterArgv('opk-worker-live');
    assertSubmitArgvIsEnterOnly(argv);
    expect(argv).toEqual(['send-keys', '-t', 'opk-worker-live', 'Enter']);
  });

  it('buildSubmitDecisionKey is stable', () => {
    expect(buildSubmitDecisionKey('run-new-head', 'newhead99ac4')).toBe(
      'run-new-head:newhead99ac4',
    );
  });
});

describe('evaluateSubmitEligibility unit (legacy helper)', () => {
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
    const { actions, tracking } = planSubmitScenario('addressing-reviews-no-submit.json');
    expect(actions.some((a) => a.type === 'submit')).toBe(false);
    expect(tracking.runs?.['run-confirmed']?.deliveryState).not.toBe(DELIVERY_STATE_ESCALATED);
  });
});
