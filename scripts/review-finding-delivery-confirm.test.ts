import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultPrSessionBindingCache, writePrSessionBindingCacheFile } from '../docs/pr-session-binding-cache.mjs';
import {
  DEFAULT_CONFIRMATION_WINDOW_MS,
  DEFAULT_MAX_REDELIVERIES,
  DEFAULT_TICK_INTERVAL_MS,
  DELIVERY_STATE_CONFIRMED,
  DELIVERY_STATE_ESCALATED,
  DELIVERY_STATE_UNCONFIRMED,
  buildEscalationMessage,
  evaluateDeliveryTickInterval,
  findForbiddenDeliveryLifecycleCommands,
  isDeliveryConfirmed,
  isPendingSentDeliveryRun,
  planDeliveryConfirmActions,
  getConfirmationAnchorMs,
  isLinkedSessionLiveOwner,
  resolveDeliveryConfig,
  resolveSendObservedAtMs,
  sessionOwnsRunHead,
  type DeliveryConfirmAction,
} from '../docs/review-finding-delivery-confirm.mjs';

let isolatedBindingCachePath = '';

beforeEach(() => {
  isolatedBindingCachePath = path.join(
    mkdtempSync(path.join(tmpdir(), 'delivery-confirm-binding-cache-')),
    'cache.json',
  );
  process.env.AO_PR_SESSION_BINDING_CACHE = isolatedBindingCachePath;
  writePrSessionBindingCacheFile(
    isolatedBindingCachePath,
    createDefaultPrSessionBindingCache(),
  );
});

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/review-finding-delivery-confirm',
);

type FixturePayload = {
  description?: string;
  reviewRuns: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  openPrs?: Array<{ number: number; headRefOid: string }>;
  tracking?: { runs?: Record<string, Record<string, unknown>> };
  nowMs: number;
  config?: { confirmationWindowMs?: number; maxRedeliveries?: number };
  expect?: Record<string, unknown>;
};

function loadFixture(name: string): FixturePayload {
  const raw = readFileSync(path.join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as FixturePayload;
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
  });
}
/** AO 0.10: delivered changes_requested (was waiting_update / sent_to_agent). */
function deliveredRun(overrides: Record<string, unknown> = {}) {
  return {
    status: 'changes_requested',
    prReviewStatus: 'changes_requested',
    deliveredAt: '2026-06-04T11:00:00.000Z',
    deliveredFindingCount: 1,
    ...overrides,
  };
}

/** AO 0.10: undelivered changes_requested (was needs_triage). */
function undeliveredRun(overrides: Record<string, unknown> = {}) {
  return {
    status: 'changes_requested',
    prReviewStatus: 'changes_requested',
    deliveredFindingCount: 0,
    ...overrides,
  };
}


describe('isPendingSentDeliveryRun', () => {
  it('is true for delivered changes_requested with findings', () => {
    expect(isPendingSentDeliveryRun(deliveredRun())).toBe(true);
  });

  it('is true when prReviewStatus carries the delivered state', () => {
    expect(
      isPendingSentDeliveryRun({
        prReviewStatus: 'changes_requested',
        deliveredAt: '2026-06-04T11:00:00.000Z',
        deliveredFindingCount: 2,
      }),
    ).toBe(true);
  });

  it('is false for undelivered changes_requested', () => {
    expect(isPendingSentDeliveryRun(undeliveredRun())).toBe(false);
  });
});

describe('delivery confirmation signal (AC1)', () => {
  it('AC1a: delivered changes_requested without addressing_reviews is not confirmed', () => {
    const fixture = loadFixture('sent-no-review-round-report.json');
    const sendMs = resolveSendObservedAtMs(fixture.reviewRuns[0]!, fixture.nowMs);
    expect(
      isDeliveryConfirmed(
        fixture.reviewRuns[0]!,
        fixture.sessions,
        sendMs,
        fixture.reviewRuns,
        fixture.tracking ?? { runs: {} },
      ),
    ).toBe(false);

    const { actions, tracking } = planFromFixture('sent-no-review-round-report.json');
    expect(actions.some((a: DeliveryConfirmAction) => a.type === 'mark_confirmed')).toBe(
      false,
    );
    expect(tracking.runs?.['run-opk8-166']?.deliveryState).not.toBe(
      DELIVERY_STATE_CONFIRMED,
    );
  });

  it('AC1b: unrelated post-send working report does not confirm', () => {
    const fixture = loadFixture('unrelated-activity-only.json');
    const sendMs = resolveSendObservedAtMs(fixture.reviewRuns[0]!, fixture.nowMs);
    expect(
      isDeliveryConfirmed(
        fixture.reviewRuns[0]!,
        fixture.sessions,
        sendMs,
        fixture.reviewRuns,
        fixture.tracking ?? { runs: {} },
      ),
    ).toBe(false);
  });

  it('does not confirm when linked session was reassigned to another PR', () => {
    const fixture = loadFixture('session-reassigned-other-pr.json');
    const sendMs = resolveSendObservedAtMs(fixture.reviewRuns[0]!, fixture.nowMs);
    expect(
      isDeliveryConfirmed(
        fixture.reviewRuns[0]!,
        fixture.sessions,
        sendMs,
        fixture.reviewRuns,
        fixture.tracking ?? { runs: {} },
      ),
    ).toBe(false);

    const { actions, tracking } = planFromFixture('session-reassigned-other-pr.json');
    expect(actions.some((a: DeliveryConfirmAction) => a.type === 'mark_confirmed')).toBe(
      false,
    );
    expect(tracking.runs?.['run-reassign-pr188']?.deliveryState).not.toBe(
      DELIVERY_STATE_CONFIRMED,
    );
    expect(
      actions.some(
        (a: DeliveryConfirmAction) =>
          a.type === 'escalate' && a.reason === 'orphan_or_dead_linked_session',
      ),
    ).toBe(true);
  });


  it('fails closed when cache has no binding and backfill cannot resolve session', () => {
    const run = {
      prNumber: 180,
      targetSha: 'abc123',
      linkedSessionId: 'opk-cache-miss',
    };
    const sessions = [
      {
        name: 'opk-cache-miss',
        role: 'worker',
        status: 'working',
      },
    ];
    const openPrs = [{ number: 180, headRefOid: 'abc123' }];
    expect(isLinkedSessionLiveOwner(run, sessions, openPrs, { writeBackfill: false })).toBe(false);
  });

  it('accepts linked session when cache backfill resolves binding', () => {
    const run = {
      prNumber: 166,
      targetSha: 'abc123',
      linkedSessionId: 'opk-8',
    };
    const sessions = [
      {
        name: 'opk-8',
        role: 'worker',
        prNumber: 166,
        status: 'working',
      },
    ];
    const openPrs = [{ number: 166, headRefOid: 'abc123' }];
    expect(isLinkedSessionLiveOwner(run, sessions, openPrs)).toBe(true);
  });

  it('does not confirm when PR head advanced past run targetSha', () => {
    const run = {
      prNumber: 180,
      targetSha: 'oldhead00',
      linkedSessionId: 'opk-16',
    };
    const sessions = [
      {
        name: 'opk-16',
        role: 'worker',
        prNumber: 180,
        ownedHeadSha: 'newhead11',
        status: 'working',
        reports: [
          {
            reportState: 'addressing_reviews',
            reportedAt: '2026-06-04T14:00:00.000Z',
          },
        ],
      },
    ];
    const openPrs = [{ number: 180, headRefOid: 'newhead11' }];
    expect(sessionOwnsRunHead(sessions[0]!, 180, 'oldhead00', openPrs)).toBe(false);
    expect(isLinkedSessionLiveOwner(run, sessions, openPrs)).toBe(false);
  });
});

describe('ambiguous overlapping runs (AC1a)', () => {
  it('does not credit one addressing_reviews when linked ids use name vs sessionId aliases', () => {
    const nowMs = 1_717_502_000_000;
    const { actions, tracking } = planDeliveryConfirmActions({
      reviewRuns: [
        deliveredRun({
          id: 'run-a',
          prNumber: 99,
          targetSha: 'deadbeef',
          linkedSessionId: 'op-live',
          deliveredAt: '2024-06-04T10:00:00.000Z',
        }),
        deliveredRun({
          id: 'run-b',
          prNumber: 99,
          targetSha: 'deadbeef',
          linkedSessionId: 'stable-session-id',
          deliveredAt: '2024-06-04T10:01:00.000Z',
        }),
      ],
      sessions: [
        {
          name: 'op-live',
          sessionId: 'stable-session-id',
          role: 'worker',
          prNumber: 99,
          status: 'working',
          reports: [
            {
              reportState: 'addressing_reviews',
              reportedAt: '2026-06-04T10:05:00Z',
            },
          ],
        },
      ],
      openPrs: [{ number: 99, headRefOid: 'deadbeef' }],
      tracking: { runs: {} },
      nowMs,
      config: { confirmationWindowMs: 60_000, maxRedeliveries: 0 },
    });
    expect(actions.some((a: DeliveryConfirmAction) => a.type === 'mark_confirmed')).toBe(
      false,
    );
    expect(tracking.runs?.['run-a']?.deliveryState).not.toBe(DELIVERY_STATE_CONFIRMED);
    expect(tracking.runs?.['run-b']?.deliveryState).not.toBe(DELIVERY_STATE_CONFIRMED);
  });

  it('does not credit one addressing_reviews report to either run', () => {
    const { actions, tracking } = planFromFixture('ambiguous-overlap-two-runs.json');
    expect(actions.some((a: DeliveryConfirmAction) => a.type === 'mark_confirmed')).toBe(
      false,
    );
    expect(tracking.runs?.['run-a']?.deliveryState).not.toBe(DELIVERY_STATE_CONFIRMED);
    expect(tracking.runs?.['run-b']?.deliveryState).not.toBe(DELIVERY_STATE_CONFIRMED);
    expect(
      actions.filter((a: DeliveryConfirmAction) => a.type === 'escalate').length,
    ).toBeGreaterThan(0);
  });

  it('does not confirm a peer after same-tick escalation of an overlapping run', () => {
    const nowMs = 1_717_502_000_000;
    const { actions, tracking } = planDeliveryConfirmActions({
      reviewRuns: [
        deliveredRun({
          id: 'run-a',
          prNumber: 99,
          targetSha: 'deadbeef',
          linkedSessionId: 'op-live',
          deliveredAt: '2024-06-04T10:00:00.000Z',
        }),
        deliveredRun({
          id: 'run-b',
          prNumber: 99,
          targetSha: 'deadbeef',
          linkedSessionId: 'op-live',
          deliveredAt: '2024-06-04T10:01:00.000Z',
        }),
      ],
      sessions: [
        {
          name: 'op-live',
          role: 'worker',
          prNumber: 99,
          status: 'working',
          reports: [
            {
              reportState: 'addressing_reviews',
              reportedAt: '2026-06-04T10:05:00Z',
            },
          ],
        },
      ],
      openPrs: [{ number: 99, headRefOid: 'deadbeef' }],
      tracking: { runs: {} },
      nowMs,
      config: { confirmationWindowMs: 60_000, maxRedeliveries: 0 },
    });
    expect(actions.some((a: DeliveryConfirmAction) => a.type === 'mark_confirmed')).toBe(
      false,
    );
    expect(tracking.runs?.['run-a']?.deliveryState).toBe(DELIVERY_STATE_ESCALATED);
    expect(tracking.runs?.['run-b']?.deliveryState).not.toBe(DELIVERY_STATE_CONFIRMED);
  });
});

describe('run-level observable source only (AC2)', () => {
  it('plans from review list + status reports without per-finding files', () => {
    const { actions } = planFromFixture('confirmed-idempotent.json');
    expect(actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'mark_confirmed' })]),
    );
  });
});

describe('confirmation window config (AC3)', () => {
  it('defaults to five minutes', () => {
    expect(DEFAULT_CONFIRMATION_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(resolveDeliveryConfig({}).confirmationWindowMs).toBe(
      DEFAULT_CONFIRMATION_WINDOW_MS,
    );
  });

  it('honors override', () => {
    const override = 2 * 60 * 1000;
    expect(resolveDeliveryConfig({ confirmationWindowMs: override }).confirmationWindowMs).toBe(
      override,
    );
  });

  it('defaults maxRedeliveries to two when omitted or undefined', () => {
    expect(resolveDeliveryConfig({}).maxRedeliveries).toBe(DEFAULT_MAX_REDELIVERIES);
    expect(resolveDeliveryConfig({ maxRedeliveries: undefined }).maxRedeliveries).toBe(
      DEFAULT_MAX_REDELIVERIES,
    );
  });
});

describe('confirmation anchor after prior delivery observation', () => {
  it('waits from lastRedeliveryAtMs before escalating', () => {
    const nowMs = 1_000_000;
    const sendObservedAtMs = nowMs - 600_000;
    const lastRedeliveryAtMs = nowMs - 60_000;
    const { actions } = planDeliveryConfirmActions({
      reviewRuns: [
        deliveredRun({
          id: 'run-anchor',
          linkedSessionId: 'opk-worker',
          prNumber: 42,
          targetSha: 'sha42',
        }),
      ],
      sessions: [
        {
          sessionId: 'opk-worker',
          role: 'worker',
          prNumber: 42,
          status: 'working',
          reports: [{ reportState: 'working', reportedAt: '1970-01-01T00:16:00.000Z' }],
        },
      ],
      openPrs: [{ number: 42, headRefOid: 'sha42' }],
      tracking: {
        runs: {
          'run-anchor': {
            sendObservedAtMs,
            lastRedeliveryAtMs,
            redeliveryCount: 1,
          },
        },
      },
      nowMs,
      config: { confirmationWindowMs: 300_000, maxRedeliveries: 2 },
    });

    expect(actions.some((a: DeliveryConfirmAction) => a.type === 'wait')).toBe(true);
    expect(actions.some((a: DeliveryConfirmAction) => a.type === 'escalate')).toBe(false);
  });

  it('getConfirmationAnchorMs prefers lastRedeliveryAtMs', () => {
    expect(
      getConfirmationAnchorMs(
        { sendObservedAtMs: 100, lastRedeliveryAtMs: 500 },
        100,
      ),
    ).toBe(500);
    expect(getConfirmationAnchorMs({ sendObservedAtMs: 100 }, 100)).toBe(100);
  });
});

describe('observe-only escalation (AC4)', () => {
  it('escalates when confirmation window elapsed (no pack redelivery)', () => {
    const { actions } = planFromFixture('window-elapsed-redeliver.json');
    expect(actions.some((a) => (a as { type: string }).type === 'redeliver')).toBe(false);
    expect(
      actions.some(
        (a) => a.type === 'escalate' && a.reason === 'max_redeliveries_exhausted',
      ),
    ).toBe(true);
    expect(actions[0]).toMatchObject({
      type: 'escalate',
      runId: 'run-redeliver-1',
      sessionId: 'opk-worker-live',
      prNumber: 166,
    });
  });
});

describe('linked session identifier matching', () => {
  it('treats linkedSessionId as sessionId when status row also has name', () => {
    const { actions } = planDeliveryConfirmActions({
      reviewRuns: [
        deliveredRun({
          id: 'run-id-match',
          prNumber: 166,
          targetSha: 'sha166',
          linkedSessionId: 'opk-worker-stable-id',
          deliveredAt: '2024-06-04T12:00:00.000Z',
        }),
      ],
      sessions: [
        {
          name: 'opk-worker-display',
          sessionId: 'opk-worker-stable-id',
          role: 'worker',
          prNumber: 166,
          status: 'working',
          reports: [],
        },
      ],
      openPrs: [{ number: 166, headRefOid: 'sha166' }],
      tracking: { runs: {} },
      nowMs: 1_717_504_000_000,
      config: { confirmationWindowMs: 300_000, maxRedeliveries: 2 },
    });
    expect(actions.some((a) => (a as { type: string }).type === 'redeliver')).toBe(false);
    expect(
      actions.some(
        (a) => a.type === 'escalate' && a.reason === 'max_redeliveries_exhausted',
      ),
    ).toBe(true);
  });
});

describe('openPrs passed to planner (live CLI path)', () => {
  it('escalates when session lacks ownedHeadSha but openPrs matches run head', () => {
    const nowMs = 1_717_520_000_000;
    const sendMs = nowMs - 600_000;
    const { actions } = planDeliveryConfirmActions({
      reviewRuns: [
        deliveredRun({
          id: 'run-open-prs',
          prNumber: 180,
          targetSha: 'livehead1',
          linkedSessionId: 'opk-16',
          deliveredAt: new Date(sendMs).toISOString(),
        }),
      ],
      sessions: [
        {
          name: 'opk-16',
          role: 'worker',
          prNumber: 180,
          status: 'working',
          reports: [{ reportState: 'working', reportedAt: '1970-01-01T00:00:00.000Z' }],
        },
      ],
      openPrs: [{ number: 180, headRefOid: 'livehead1' }],
      tracking: { runs: {} },
      nowMs,
      config: { confirmationWindowMs: 300_000, maxRedeliveries: 2 },
    });
    expect(actions.some((a) => (a as { type: string }).type === 'redeliver')).toBe(false);
    expect(
      actions.some(
        (a) => a.type === 'escalate' && a.reason === 'max_redeliveries_exhausted',
      ),
    ).toBe(true);
  });

  it('escalates when openPrs is omitted and session has no owned head', () => {
    const nowMs = 1_717_520_000_000;
    const { actions } = planDeliveryConfirmActions({
      reviewRuns: [
        deliveredRun({
          id: 'run-no-open-prs',
          prNumber: 180,
          targetSha: 'livehead1',
          linkedSessionId: 'opk-16',
          deliveredAt: '2026-06-04T14:00:00.000Z',
        }),
      ],
      sessions: [
        {
          name: 'opk-16',
          role: 'worker',
          prNumber: 180,
          status: 'working',
        },
      ],
      tracking: { runs: {} },
      nowMs,
      config: { confirmationWindowMs: 300_000, maxRedeliveries: 2 },
    });
    expect(
      actions.some(
        (a: DeliveryConfirmAction) =>
          a.type === 'escalate' && a.reason === 'orphan_or_dead_linked_session',
      ),
    ).toBe(true);
  });
});

describe('stale run head (ownership)', () => {
  it('escalates when PR head advanced past run targetSha', () => {
    const { actions } = planFromFixture('stale-head-advanced.json');
    expect(actions.some((a: DeliveryConfirmAction) => (a as { type: string }).type === 'redeliver')).toBe(false);
    expect(
      actions.some(
        (a: DeliveryConfirmAction) =>
          a.type === 'escalate' && a.reason === 'stale_run_head_not_owned',
      ),
    ).toBe(true);
  });
});

describe('orphan linked session (AC4a)', () => {
  it('escalates immediately with zero re-sends', () => {
    const { actions } = planFromFixture('orphan-dead-session.json');
    expect(actions.some((a: DeliveryConfirmAction) => (a as { type: string }).type === 'redeliver')).toBe(false);
    const escalation = actions.find(
      (a): a is Extract<DeliveryConfirmAction, { type: 'escalate' }> =>
        a.type === 'escalate',
    );
    expect(escalation).toMatchObject({
      runId: 'run-orphan-1',
      sessionId: 'opk-dead',
      prNumber: 97,
      reason: 'orphan_or_dead_linked_session',
    });
  });
});

describe('no worker lifecycle on no-confirmation path (AC5)', () => {
  it('observe-only planner never emits pack redelivery actions', () => {
    const { actions } = planFromFixture('window-elapsed-redeliver.json');
    expect(actions.some((a) => (a as { type: string }).type === 'redeliver')).toBe(false);
    expect(
      findForbiddenDeliveryLifecycleCommands([
        'ao review send run-abc',
        'ao spawn --claim-pr 1',
        'ao session kill op-1',
        'ao send op-2 ping',
      ]).length,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe('escalate after max redeliveries (submit owned by #232)', () => {
  it('escalates when redeliveries exhausted — no submit action', () => {
    const { actions, tracking } = planFromFixture('max-redeliveries-escalate.json');
    expect(actions.some((a) => (a as { type: string }).type === 'redeliver')).toBe(false);
    expect(actions.map((a) => a.type as string)).not.toContain('submit');
    expect(
      actions.some(
        (a) => a.type === 'escalate' && a.reason === 'max_redeliveries_exhausted',
      ),
    ).toBe(true);
    expect(tracking.runs?.['run-exhausted']?.deliveryState).toBe(DELIVERY_STATE_ESCALATED);
  });
});

describe('delivery state outcomes (AC7)', () => {
  it('records confirmed vs escalated distinctly', () => {
    const confirmed = planFromFixture('confirmed-idempotent.json');
    expect(confirmed.tracking.runs?.['run-confirmed']?.deliveryState).toBe(
      DELIVERY_STATE_CONFIRMED,
    );

    const escalated = planFromFixture('max-redeliveries-escalate.json');
    expect(escalated.tracking.runs?.['run-exhausted']?.deliveryState).toBe(
      DELIVERY_STATE_ESCALATED,
    );
  });
});

describe('idempotent confirmed runs (AC8)', () => {
  it('does not re-deliver when addressing_reviews exists after send', () => {
    const { actions } = planFromFixture('confirmed-idempotent.json');
    expect(actions.some((a) => (a as { type: string }).type === 'redeliver')).toBe(false);
    expect(actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'mark_confirmed' })]),
    );
  });
});

describe('mechanical tick interval (AC9)', () => {
  it('defaults to five-minute low-frequency cadence', () => {
    expect(DEFAULT_TICK_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('accepts tick without orchestrator involvement', () => {
    const now = 50_000_000;
    expect(
      evaluateDeliveryTickInterval({
        nowMs: now + DEFAULT_TICK_INTERVAL_MS,
        lastTickMs: now,
        intervalMs: DEFAULT_TICK_INTERVAL_MS,
      }).ok,
    ).toBe(true);
  });
});

describe('buildEscalationMessage', () => {
  it('includes run id, PR, session, and remedy', () => {
    const msg = buildEscalationMessage({
      runId: 'run-x',
      sessionId: 'opk-1',
      prNumber: 42,
    });
    expect(msg).toContain('run-x');
    expect(msg).toContain('PR #42');
    expect(msg).toContain('opk-1');
    expect(msg).toContain('Operator remedy');
  });
});

describe('max redeliveries default (AC4)', () => {
  it('defaults to two attempts', () => {
    expect(DEFAULT_MAX_REDELIVERIES).toBe(2);
  });
});
