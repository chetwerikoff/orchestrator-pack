import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AO_PASTE_CHAR_THRESHOLD,
  buildReviewSendDeliveryId,
  classifyDeliveryPath,
  deriveMessageShape,
  DELIVERY_PATH_PENDING_DRAFT,
  DELIVERY_PATH_SELF_SUBMITTED,
  extractReviewFindingDeliveries,
  findOverwrittenDeliveries,
  isDeliveryConsumed,
  isSessionAlive,
  mergeDeliveryRecords,
  selectSurvivingDelivery,
  DISPATCH_SOURCE_REVIEW_SEND,
} from '../docs/worker-message-dispatch-observe.mjs';
import {
  applySubmitOutcomes,
  evaluateConcurrentSubmitClaim,
  evaluateSubmitDecision,
  isActiveSubmitClaim,
  OPERATOR_ESCALATION_PREFIX,
  planWorkerMessageSubmitActions,
} from '../docs/worker-message-submit-reconcile.mjs';
import type {
  SubmitTrackingState,
  WorkerMessageSubmitAction,
} from '../docs/worker-message-submit-reconcile.d.mts';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/worker-message-submit-reconcile',
);

type FixturePayload = {
  description?: string;
  nowMs: number;
  sessions: Record<string, unknown>[];
  dispatchJournal?: Record<string, Record<string, unknown>>;
  aoEvents?: Record<string, unknown>[];
  reviewRuns?: Record<string, unknown>[];
  tracking?: SubmitTrackingState;
  config?: Record<string, unknown>;
  reactionMessages?: Record<string, string>;
  floodActiveSessions?: Record<string, boolean>;
};

function loadFixture(name: string): FixturePayload {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as FixturePayload;
}

function planFixture(name: string) {
  const fixture = loadFixture(name);
  return planWorkerMessageSubmitActions({
    sessions: fixture.sessions,
    dispatchJournal: fixture.dispatchJournal ?? {},
    aoEvents: fixture.aoEvents ?? [],
    reviewRuns: fixture.reviewRuns ?? [],
    tracking: fixture.tracking ?? { deliveries: {}, audit: [] },
    floodActiveSessions: fixture.floodActiveSessions ?? {},
    reactionMessages: fixture.reactionMessages ?? {},
    nowMs: fixture.nowMs,
    config: fixture.config,
  });
}

function submitActions(actions: WorkerMessageSubmitAction[]) {
  return actions.filter((a) => a.type === 'submit');
}

describe('classifyDeliveryPath', () => {
  it('pending-draft for multi-line short message', () => {
    expect(classifyDeliveryPath({ charLength: 42, lineCount: 2 })).toBe(
      DELIVERY_PATH_PENDING_DRAFT,
    );
  });

  it('pending-draft for >200 chars', () => {
    expect(classifyDeliveryPath({ charLength: AO_PASTE_CHAR_THRESHOLD + 1, lineCount: 1 })).toBe(
      DELIVERY_PATH_PENDING_DRAFT,
    );
  });

  it('self-submitted for short single-line', () => {
    expect(classifyDeliveryPath({ charLength: 50, lineCount: 1 })).toBe(
      DELIVERY_PATH_SELF_SUBMITTED,
    );
  });

  it('borderline crosses 200 with sender prefix', () => {
    const shape = deriveMessageShape('x'.repeat(190), 'opk-orchestrator');
    expect(shape.deliveryPath).toBe(DELIVERY_PATH_PENDING_DRAFT);
  });
});

describe('dispatch observation helpers (review)', () => {
  it('treats non-live AO session statuses as not alive', () => {
    for (const status of ['errored', 'exited', 'cleanup', 'closed', 'detecting']) {
      expect(isSessionAlive({ status, runtime: 'alive' })).toBe(false);
    }
    expect(isSessionAlive({ status: 'working' })).toBe(true);
    expect(isSessionAlive({ status: 'working', runtime: 'alive' })).toBe(true);
    expect(isSessionAlive({ status: 'working', runtime: 'exited' })).toBe(false);
    expect(isSessionAlive({ status: 'working', runtime: 'unreachable' })).toBe(false);
  });
  it('uses stable review-run send anchor from updatedAt', () => {
    const run = {
      id: 'run-stable-ts',
      linkedSessionId: 'opk-stable',
      sentFindingCount: 1,
      status: 'waiting_update',
      updatedAt: '2026-06-04T12:00:00.000Z',
    };
    const first = extractReviewFindingDeliveries([run], 1_000);
    const second = extractReviewFindingDeliveries([run], 9_999_999);
    expect(first).toHaveLength(1);
    expect(second[0]?.deliveryId).toBe(first[0]?.deliveryId);
    expect(second[0]?.deliveredAtMs).toBe(first[0]?.deliveredAtMs);
  });

  it('uses stable review-run delivery id when send timestamps are missing', () => {
    const run = {
      id: 'run-no-ts',
      linkedSessionId: 'opk-no-ts',
      sentFindingCount: 1,
      status: 'waiting_update',
    };
    const first = extractReviewFindingDeliveries([run], 1_000);
    const second = extractReviewFindingDeliveries([run], 9_999_999);
    expect(first).toHaveLength(1);
    expect(first[0]?.deliveryId).toBe('opk-no-ts:review-send:run-no-ts');
    expect(second[0]?.deliveryId).toBe(first[0]?.deliveryId);
    expect(second[0]?.deliveredAtMs).toBe(0);
  });

  it('buildReviewSendDeliveryId keeps timestamped ids when run has sentAt', () => {
    const ms = Date.parse('2026-06-04T12:00:00.000Z');
    expect(buildReviewSendDeliveryId('opk-ts', 'run-ts', ms)).toBe(
      `opk-ts:${ms}:review-send:run-ts`,
    );
  });

  it('honors report timestamp and state aliases for consumption', () => {
    const consumed = isDeliveryConsumed(
      {
        sessionId: 'opk-alias',
        reports: [
          {
            report_state: 'addressing_reviews',
            reportedAt: '2026-06-04T12:05:00.000Z',
            accepted: true,
          },
        ],
      },
      { source: DISPATCH_SOURCE_REVIEW_SEND },
      Date.parse('2026-06-04T12:00:00.000Z'),
    );
    expect(consumed).toBe(true);
  });

  it('treats fixing_ci and ready_for_review as consumed for review-send', () => {
    const deliveredAtMs = Date.parse('2026-06-04T12:00:00.000Z');
    for (const state of ['fixing_ci', 'ready_for_review'] as const) {
      expect(
        isDeliveryConsumed(
          {
            reports: [
              {
                report_state: state,
                reportedAt: '2026-06-04T12:05:00.000Z',
                accepted: true,
              },
            ],
          },
          { source: DISPATCH_SOURCE_REVIEW_SEND },
          deliveredAtMs,
        ),
      ).toBe(true);
    }
  });
});

describe('stale input guard (review)', () => {
  it('refuses submit after intervening input-affecting activity', () => {
    const { actions } = planFixture('stale-input-after-activity.json');
    expect(submitActions(actions)).toHaveLength(0);
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) => a.type === 'noop' && a.reason === 'stale_input',
      ),
    ).toBe(true);
  });
});

describe('session identifier matching (review)', () => {
  it('submits when delivery sessionId matches row sessionId but not name', () => {
    const { actions } = planFixture('linked-session-id-with-name.json');
    expect(submitActions(actions)).toHaveLength(1);
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) => a.type === 'noop' && a.reason === 'session_id_mismatch',
      ),
    ).toBe(false);
  });
});

describe('coverage floor hang classes (AC2)', () => {
  const submitCases = [
    'long-script-nudge.json',
    'multiline-short.json',
    'borderline-sender-prefix.json',
    'first-finding-delivery.json',
    'restore-retry-resend.json',
    'orchestrator-composed-send.json',
  ];

  it.each(submitCases)('%s plans exactly one submit', (fixtureName) => {
    const { actions } = planFixture(fixtureName);
    expect(submitActions(actions)).toHaveLength(1);
  });
});

describe('human input never submits (AC3)', () => {
  it('no dispatch record yields no submit', () => {
    const { actions } = planFixture('human-input-no-dispatch.json');
    expect(submitActions(actions)).toHaveLength(0);
  });
});

describe('negative AO states (AC4/AC8)', () => {
  it('consumed delivery is not submitted', () => {
    const { actions } = planFixture('already-consumed.json');
    expect(submitActions(actions)).toHaveLength(0);
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed')).toBe(
      true,
    );
  });

  it('consumed delivery with report aliases is not submitted', () => {
    const { actions } = planFixture('consumed-report-aliases.json');
    expect(submitActions(actions)).toHaveLength(0);
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed')).toBe(
      true,
    );
  });

  it('streaming session is not submitted', () => {
    const { actions } = planFixture('streaming-no-submit.json');
    expect(submitActions(actions)).toHaveLength(0);
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) => a.type === 'noop' && a.reason === 'streaming',
      ),
    ).toBe(true);
  });

  it('short self-submitted path is no-op', () => {
    const { actions } = planFixture('short-self-submitted.json');
    expect(submitActions(actions)).toHaveLength(0);
    expect(actions).toHaveLength(0);
  });

  it('future self-submitting AO delivery path is safe no-op (constructed)', () => {
    const decision = evaluateSubmitDecision({
      delivery: {
        deliveryId: 'future-1',
        sessionId: 'opk-future',
        deliveredAtMs: 1000,
        deliveryPath: DELIVERY_PATH_SELF_SUBMITTED,
      },
      session: {
        sessionId: 'opk-future',
        activity: 'idle',
        status: 'working',
        runtime: 'alive',
        reports: [],
      },
      tracking: { deliveries: {} },
      floodActiveSessions: {},
      nowMs: 5000,
    });
    expect(decision.action).toBe('noop');
    expect(decision.reason).toBe('already_submitted_path');
  });
});

describe('submit claim lifecycle (review)', () => {
  it('releases claim on failed submit outcome without incrementing attempts', () => {
    const tracking = applySubmitOutcomes(
      {
        deliveries: {
          'delivery-1': {
            deliveryId: 'delivery-1',
            provisionalClaimKey: 'delivery-1:1',
            provisionalClaimSinceMs: 1000,
            submitAttempts: 0,
          },
        },
        audit: [],
      },
      [{ deliveryId: 'delivery-1', claimKey: 'delivery-1:1', outcome: 'released', reason: 'tmux_unavailable' }],
      2000,
    );
    const record = tracking.deliveries?.['delivery-1'];
    expect(record?.claimed).toBeUndefined();
    expect(record?.provisionalClaimKey).toBeUndefined();
    expect(Number(record?.submitAttempts ?? 0)).toBe(0);
  });

  it('confirms claim on successful submit outcome', () => {
    const tracking = applySubmitOutcomes(
      {
        deliveries: {
          'delivery-1': {
            deliveryId: 'delivery-1',
            provisionalClaimKey: 'delivery-1:1',
            provisionalClaimSinceMs: 1000,
          },
        },
        audit: [],
      },
      [{ deliveryId: 'delivery-1', claimKey: 'delivery-1:1', outcome: 'confirmed' }],
      2000,
    );
    const record = tracking.deliveries?.['delivery-1'];
    expect(record?.claimed).toBe(true);
    expect(record?.submitAttempts).toBe(1);
    expect(record?.lastSubmitAtMs).toBe(2000);
    expect(record?.provisionalClaimKey).toBeUndefined();
  });

  it('retries after stale confirmed claim', () => {
    const { actions } = planFixture('stale-claim-retry.json');
    expect(submitActions(actions)).toHaveLength(1);
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) => a.type === 'noop' && a.reason === 'claim_held',
      ),
    ).toBe(false);
  });

  it('fresh provisional claim remains active', () => {
    expect(
      isActiveSubmitClaim(
        {
          provisionalClaimKey: 'delivery-1:1',
          provisionalClaimSinceMs: 1000,
        },
        1500,
        { claimStaleMs: 60000 },
      ),
    ).toBe(true);
  });
});

describe('exactly one submit owner (AC5)', () => {
  it('durable claim prevents second submit', () => {
    const first = planFixture('long-script-nudge.json');
    const second = planWorkerMessageSubmitActions({
      ...loadFixture('long-script-nudge.json'),
      tracking: first.tracking,
      floodActiveSessions: {},
      reactionMessages: {},
    });
    expect(submitActions(first.actions)).toHaveLength(1);
    expect(submitActions(second.actions)).toHaveLength(0);
  });

  it('concurrent observer sees claim held', () => {
    const { actions } = planFixture('claim-prevents-double.json');
    expect(submitActions(actions)).toHaveLength(0);
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) => a.type === 'noop' && a.reason === 'claim_held',
      ),
    ).toBe(true);
  });

  it('evaluateConcurrentSubmitClaim rejects duplicate', () => {
    const result = evaluateConcurrentSubmitClaim({
      existingClaim: 'id:1',
      newClaimKey: 'id:1',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('duplicate_claim');
  });
});

describe('surviving delivery selection (review)', () => {
  it('ignores stale pending draft after later self-submitted send', () => {
    const deliveries = [
      {
        deliveryId: 'opk-stale:1000:pack-send:long',
        sessionId: 'opk-stale',
        deliveredAtMs: 1000,
        deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
      },
      {
        deliveryId: 'opk-stale:2000:pack-send:short',
        sessionId: 'opk-stale',
        deliveredAtMs: 2000,
        deliveryPath: DELIVERY_PATH_SELF_SUBMITTED,
      },
    ];
    expect(selectSurvivingDelivery(deliveries, 'opk-stale')).toBeNull();
    expect(findOverwrittenDeliveries(deliveries, 'opk-stale')).toHaveLength(1);
  });

  it('plans no submit when pending draft was invalidated by later self-submitted send', () => {
    const { actions } = planFixture('stale-pending-after-self-submitted.json');
    expect(submitActions(actions)).toHaveLength(0);
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'escalate' && a.reason === 'lost_delivery_overwritten',
      ),
    ).toBe(true);
  });
});

describe('multiple pending deliveries (AC10)', () => {
  it('does not escalate overwritten delivery already marked submitted', () => {
    const { actions } = planFixture('submitted-overwritten-no-escalate.json');
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'escalate' &&
          a.reason === 'lost_delivery_overwritten' &&
          a.deliveryId === 'opk-submitted-overwrite:1717600900000:pack-send:first',
      ),
    ).toBe(false);
    expect(submitActions(actions)).toHaveLength(1);
    expect(submitActions(actions)[0]?.deliveryId).toBe(
      'opk-submitted-overwrite:1717600950000:pack-send:second',
    );
  });

  it('does not escalate overwritten delivery already consumed via worker report', () => {
    const { actions } = planFixture('consumed-overwritten-no-escalate.json');
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'escalate' &&
          a.reason === 'lost_delivery_overwritten' &&
          a.deliveryId === 'opk-consumed-overwrite:1717600900000:pack-send:first',
      ),
    ).toBe(false);
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'mark_consumed' &&
          a.deliveryId === 'opk-consumed-overwrite:1717600900000:pack-send:first',
      ),
    ).toBe(true);
    expect(submitActions(actions)).toHaveLength(1);
    expect(submitActions(actions)[0]?.deliveryId).toBe(
      'opk-consumed-overwrite:1717600950000:pack-send:second',
    );
  });

  it('submits surviving record once and escalates overwritten', () => {
    const { actions } = planFixture('two-pending-overwrite.json');
    expect(submitActions(actions)).toHaveLength(1);
    expect(
      submitActions(actions)[0]?.deliveryId,
    ).toBe('opk-dual-232:1717600950000:ao-send:second');
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'escalate' &&
          a.reason === 'lost_delivery_overwritten' &&
          a.deliveryId === 'opk-dual-232:1717600900000:ao-send:first',
      ),
    ).toBe(true);
  });
});

describe('escalation on stuck branches (AC9)', () => {
  it('escalates waiting_input delivery after submit budget is exhausted', () => {
    const { actions } = planFixture('waiting-input-budget-escalate.json');
    expect(submitActions(actions)).toHaveLength(0);
    const escalation = actions.find(
      (a: WorkerMessageSubmitAction) => a.type === 'escalate',
    );
    expect(escalation?.reason).toBe('submit_attempts_exhausted');
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'noop' && a.reason === 'next_prompt_possible',
      ),
    ).toBe(false);
  });

  it('retries waiting_input delivery after budget expires with attempts remaining', () => {
    const { actions } = planFixture('waiting-input-budget-retry.json');
    expect(submitActions(actions)).toHaveLength(1);
    expect(submitActions(actions)[0]?.attempt).toBe(2);
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'noop' && a.reason === 'next_prompt_possible',
      ),
    ).toBe(false);
  });

  it('defers waiting_input delivery while budget is still open', () => {
    const decision = evaluateSubmitDecision({
      delivery: {
        deliveryId: 'opk-wait-defer:1000:pack-send:defer',
        sessionId: 'opk-wait-defer',
        deliveredAtMs: 1000,
        deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
      },
      session: {
        sessionId: 'opk-wait-defer',
        role: 'worker',
        runtime: 'alive',
        activity: 'waiting_input',
      },
      tracking: {
        deliveries: {
          'opk-wait-defer:1000:pack-send:defer': {
            firstObservedAtMs: 1000,
            submitAttempts: 1,
          },
        },
      },
      aoEvents: [],
      floodActiveSessions: {},
      nowMs: 5000,
      config: { deliveryBudgetMs: 60000, maxSubmitAttempts: 3 },
    });
    expect(decision.action).toBe('noop');
    expect(decision.reason).toBe('next_prompt_possible');
  });

  it('escalates when submit attempts exhausted', () => {
    const { actions } = planFixture('submit-budget-escalate.json');
    expect(submitActions(actions)).toHaveLength(0);
    const escalation = actions.find(
      (a: WorkerMessageSubmitAction) => a.type === 'escalate',
    );
    expect(escalation?.reason).toBe('submit_attempts_exhausted');
    expect(String(escalation?.diagnosis)).toContain(OPERATOR_ESCALATION_PREFIX);
  });

  it('escalates when observation stayed ambiguous', () => {
    const { actions } = planFixture('ambiguous-budget-escalate.json');
    expect(submitActions(actions)).toHaveLength(0);
    const escalation = actions.find(
      (a: WorkerMessageSubmitAction) => a.type === 'escalate',
    );
    expect(escalation?.reason).toBe('ambiguous_budget_exhausted');
    expect(String(escalation?.diagnosis)).toContain(OPERATOR_ESCALATION_PREFIX);
  });
});

describe('auditable decisions (AC7)', () => {
  it('records audit entries per action', () => {
    const { tracking } = planFixture('long-script-nudge.json');
    expect(Array.isArray(tracking.audit)).toBe(true);
    expect(tracking.audit?.length).toBeGreaterThan(0);
  });
});

describe('review-send journal path (review)', () => {
  it('does not submit review-send when worker already reported fixing_ci', () => {
    const { actions } = planFixture('review-send-fixing-ci-consumed.json');
    expect(submitActions(actions)).toHaveLength(0);
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'mark_consumed' && a.reason === 'consumed',
      ),
    ).toBe(true);
  });

  it('submits when review-send journal records pending-draft despite short placeholder', () => {
    const { actions } = planFixture('review-send-journal-pending-draft.json');
    expect(submitActions(actions)).toHaveLength(1);
    expect(submitActions(actions)[0]?.deliveryId).toBe(
      'opk-review-journal:1717600200000:review-send:run-journal-pending',
    );
  });
});

describe('mergeDeliveryRecords from AO events', () => {
  it('dedupes review-send when journal already records the run', () => {
    const run = {
      id: 'run-journal-dedupe',
      linkedSessionId: 'opk-dedupe',
      sentFindingCount: 2,
      status: 'waiting_update',
      sentAt: new Date(1717600300000).toISOString(),
      updatedAt: new Date(1717600300000).toISOString(),
      prNumber: 234,
      targetSha: 'abc123',
    };
    const deliveries = mergeDeliveryRecords({
      aoEvents: [],
      dispatchJournal: {
        'opk-dedupe:1717600300000:review-send:run-journal-dedupe': {
          deliveryId: 'opk-dedupe:1717600300000:review-send:run-journal-dedupe',
          sessionId: 'opk-dedupe',
          deliveredAtMs: 1717600300000,
          source: 'review-send',
          sourceKey: 'run-journal-dedupe',
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          messageShape: { charLength: 420, lineCount: 6 },
        },
      },
      reviewRuns: [run],
      reactionMessages: {},
      nowMs: 1717600400000,
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.deliveryId).toBe(
      'opk-dedupe:1717600300000:review-send:run-journal-dedupe',
    );
    expect(findOverwrittenDeliveries(deliveries, 'opk-dedupe')).toHaveLength(0);
  });

  it('preserves later review-send delivery when journal only records first send', () => {
    const journalAtMs = 1717600300000;
    const redeliveryAtMs = 1717600400000;
    const run = {
      id: 'run-redeliver-232',
      linkedSessionId: 'opk-redeliver',
      sentFindingCount: 2,
      status: 'waiting_update',
      sentAt: new Date(redeliveryAtMs).toISOString(),
      updatedAt: new Date(redeliveryAtMs).toISOString(),
      prNumber: 234,
      targetSha: 'abc123',
    };
    const deliveries = mergeDeliveryRecords({
      aoEvents: [],
      dispatchJournal: {
        'opk-redeliver:1717600300000:review-send:run-redeliver-232': {
          deliveryId: 'opk-redeliver:1717600300000:review-send:run-redeliver-232',
          sessionId: 'opk-redeliver',
          deliveredAtMs: journalAtMs,
          source: 'review-send',
          sourceKey: 'run-redeliver-232',
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          messageShape: { charLength: 420, lineCount: 6 },
        },
      },
      reviewRuns: [run],
      reactionMessages: {},
      nowMs: redeliveryAtMs + 1000,
    });
    expect(deliveries).toHaveLength(2);
    expect(
      deliveries.some(
        (d) =>
          String(d.sourceKey) === 'run-redeliver-232' &&
          Number(d.deliveredAtMs) === redeliveryAtMs,
      ),
    ).toBe(true);
    expect(selectSurvivingDelivery(deliveries, 'opk-redeliver')?.deliveredAtMs).toBe(
      redeliveryAtMs,
    );
  });

  it('skips unknown reaction keys without a configured message shape', () => {
    const deliveries = mergeDeliveryRecords({
      aoEvents: [
        {
          kind: 'reaction.action_succeeded',
          sessionId: 'opk-unknown-react',
          tsEpoch: 1717600000000,
          data: { action: 'send-to-agent', reactionKey: 'future-custom-reaction' },
        },
      ],
      dispatchJournal: {},
      reviewRuns: [],
      reactionMessages: { 'ci-failed': 'x'.repeat(250) },
      nowMs: 1717600001000,
    });
    expect(deliveries).toHaveLength(0);
  });

  it('ingests reaction.action_succeeded send-to-agent', () => {
    const deliveries = mergeDeliveryRecords({
      aoEvents: [
        {
          kind: 'reaction.action_succeeded',
          sessionId: 'opk-react',
          tsEpoch: 1717600000000,
          data: { action: 'send-to-agent', reactionKey: 'ci-failed' },
        },
      ],
      dispatchJournal: {},
      reviewRuns: [],
      reactionMessages: { 'ci-failed': 'x'.repeat(250) },
      nowMs: 1717600001000,
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.deliveryPath).toBe(DELIVERY_PATH_PENDING_DRAFT);
  });
});
