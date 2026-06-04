import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIRMATION_WINDOW_MS,
  DEFAULT_MAX_REDELIVERIES,
  DEFAULT_TICK_INTERVAL_MS,
  DELIVERY_STATE_CONFIRMED,
  DELIVERY_STATE_ESCALATED,
  DELIVERY_STATE_UNCONFIRMED,
  buildEscalationMessage,
  buildReviewSendArgv,
  evaluateDeliveryTickInterval,
  findForbiddenDeliveryLifecycleCommands,
  isDeliveryConfirmed,
  isPendingSentDeliveryRun,
  planDeliveryConfirmActions,
  getConfirmationAnchorMs,
  resolveDeliveryConfig,
  resolveSendObservedAtMs,
  type DeliveryConfirmAction,
} from '../docs/review-finding-delivery-confirm.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/review-finding-delivery-confirm',
);

type FixturePayload = {
  description?: string;
  reviewRuns: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
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
    tracking: fixture.tracking ?? { runs: {} },
    nowMs: fixture.nowMs,
    config: fixture.config,
  });
}

describe('isPendingSentDeliveryRun', () => {
  it('is true for waiting_update with sent findings', () => {
    expect(
      isPendingSentDeliveryRun({
        status: 'waiting_update',
        sentFindingCount: 1,
      }),
    ).toBe(true);
  });

  it('is false for needs_triage (not yet sent)', () => {
    expect(
      isPendingSentDeliveryRun({
        status: 'needs_triage',
        sentFindingCount: 0,
      }),
    ).toBe(false);
  });
});

describe('delivery confirmation signal (AC1)', () => {
  it('AC1a: sent_to_agent without addressing_reviews is not confirmed', () => {
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
});

describe('ambiguous overlapping runs (AC1a)', () => {
  it('does not credit one addressing_reviews report to either run', () => {
    const { actions, tracking } = planFromFixture('ambiguous-overlap-two-runs.json');
    expect(actions.some((a: DeliveryConfirmAction) => a.type === 'mark_confirmed')).toBe(
      false,
    );
    expect(tracking.runs?.['run-a']?.deliveryState).not.toBe(DELIVERY_STATE_CONFIRMED);
    expect(tracking.runs?.['run-b']?.deliveryState).not.toBe(DELIVERY_STATE_CONFIRMED);
    expect(
      actions.filter(
        (a: DeliveryConfirmAction) => a.type === 'redeliver' || a.type === 'escalate',
      ).length,
    ).toBeGreaterThan(0);
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

describe('confirmation anchor after re-delivery', () => {
  it('waits from lastRedeliveryAtMs before another re-deliver', () => {
    const nowMs = 1_000_000;
    const sendObservedAtMs = nowMs - 600_000;
    const lastRedeliveryAtMs = nowMs - 60_000;
    const { actions } = planDeliveryConfirmActions({
      reviewRuns: [
        {
          id: 'run-anchor',
          status: 'waiting_update',
          sentFindingCount: 1,
          linkedSessionId: 'opk-worker',
          prNumber: 42,
        },
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
    expect(
      actions.filter((a: DeliveryConfirmAction) => a.type === 'redeliver'),
    ).toHaveLength(0);
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

describe('bounded re-delivery (AC4)', () => {
  it('re-delivers to the same linked session within max count', () => {
    const { actions } = planFromFixture('window-elapsed-redeliver.json');
    const redelivers = actions.filter(
      (a): a is Extract<DeliveryConfirmAction, { type: 'redeliver' }> =>
        a.type === 'redeliver',
    );
    expect(redelivers).toHaveLength(1);
    expect(redelivers[0]).toMatchObject({
      runId: 'run-redeliver-1',
      sessionId: 'opk-worker-live',
      prNumber: 166,
      attempt: 1,
      maxRedeliveries: 2,
    });
  });
});

describe('orphan linked session (AC4a)', () => {
  it('escalates immediately with zero re-sends', () => {
    const { actions } = planFromFixture('orphan-dead-session.json');
    expect(
      actions.filter((a: DeliveryConfirmAction) => a.type === 'redeliver'),
    ).toHaveLength(0);
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
  it('redeliver argv uses ao review send only', () => {
    const argv = buildReviewSendArgv('run-abc');
    const commandLine = `ao ${argv.join(' ')}`;
    expect(findForbiddenDeliveryLifecycleCommands([commandLine])).toEqual([]);
    expect(
      findForbiddenDeliveryLifecycleCommands([
        'ao spawn --claim-pr 1',
        'ao session kill op-1',
        'ao send op-2 ping',
      ]).length,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe('escalation after max redeliveries (AC6)', () => {
  it('stops retrying and emits actionable escalation', () => {
    const { actions, tracking } = planFromFixture('max-redeliveries-escalate.json');
    expect(
      actions.filter((a: DeliveryConfirmAction) => a.type === 'redeliver'),
    ).toHaveLength(0);
    const escalation = actions.find(
      (a): a is Extract<DeliveryConfirmAction, { type: 'escalate' }> =>
        a.type === 'escalate',
    );
    expect(escalation).toMatchObject({
      runId: 'run-exhausted',
      sessionId: 'opk-worker-live',
      prNumber: 166,
      reason: 'max_redeliveries_exhausted',
    });
    expect(String(escalation?.message)).toContain('run-exhausted');
    expect(String(escalation?.message)).toContain('PR #166');
    expect(String(escalation?.message)).toContain('opk-worker-live');
    expect(String(escalation?.message)).toContain('Operator remedy');
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
    expect(
      actions.filter((a: DeliveryConfirmAction) => a.type === 'redeliver'),
    ).toHaveLength(0);
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
