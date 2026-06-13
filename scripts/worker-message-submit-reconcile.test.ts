import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
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
  DISPATCH_SOURCE_AO_SEND,
} from '../docs/worker-message-dispatch-observe.mjs';
import {
  applySubmitOutcomes,
  evaluateConcurrentSubmitClaim,
  evaluateSubmitDecision,
  isActiveSubmitClaim,
  OPERATOR_ESCALATION_PREFIX,
  evaluateDispatchObservability,
  getFailedDeliveryStatus,
  planWorkerMessageSubmitActions,
  resolveBusyDispatchCapability,
  validateBusyDispatchMarker,
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

  it('short self-submitted path is tracked without Enter', () => {
    const { actions } = planFixture('short-self-submitted.json');
    expect(submitActions(actions)).toHaveLength(0);
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'noop' && a.reason === 'tracking_auto_submitted')).toBe(true);
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
    expect(decision.reason).toBe('tracking_auto_submitted');
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
  it('does not let a later failed pending send overwrite an earlier dispatched draft', () => {
    for (const dispatchOutcome of ['send_failed']) {
      const deliveries = [
        {
          deliveryId: `opk-failed-overwrite:1000:ao-send:first:${dispatchOutcome}`,
          sessionId: 'opk-failed-overwrite',
          deliveredAtMs: 1000,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
        },
        {
          deliveryId: `opk-failed-overwrite:2000:ao-send:failed:${dispatchOutcome}`,
          sessionId: 'opk-failed-overwrite',
          deliveredAtMs: 2000,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome,
        },
      ];
      expect(selectSurvivingDelivery(deliveries, 'opk-failed-overwrite')?.deliveryId).toBe(
        `opk-failed-overwrite:1000:ao-send:first:${dispatchOutcome}`,
      );
      expect(findOverwrittenDeliveries(deliveries, 'opk-failed-overwrite')).toHaveLength(0);
    }
  });

  it('submits earlier dispatched draft and escalates a later failed pending send', () => {
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-failed-overwrite', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', reports: [] }],
      dispatchJournal: {
        'opk-failed-overwrite:1000:ao-send:first': {
          deliveryId: 'opk-failed-overwrite:1000:ao-send:first',
          sessionId: 'opk-failed-overwrite',
          deliveredAtMs: 1000,
          source: 'ao-send',
          sourceKey: 'first',
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 300, lineCount: 2 },
        },
        'opk-failed-overwrite:2000:ao-send:failed': {
          deliveryId: 'opk-failed-overwrite:2000:ao-send:failed',
          sessionId: 'opk-failed-overwrite',
          deliveredAtMs: 2000,
          source: 'ao-send',
          sourceKey: 'failed',
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'send_failed',
          draftState: 'unknown',
          messageShape: { charLength: 280, lineCount: 2 },
        },
      },
      aoEvents: [],
      reviewRuns: [],
      tracking: { deliveries: {}, audit: [] },
      nowMs: 3000,
    });
    expect(submitActions(actions)).toHaveLength(1);
    expect(submitActions(actions)[0]?.deliveryId).toBe('opk-failed-overwrite:1000:ao-send:first');
    expect(actions.some((a) => a.type === 'escalate' && a.reason === 'send_failed' && a.deliveryId === 'opk-failed-overwrite:2000:ao-send:failed')).toBe(true);
  });

  it('does not submit a newer dispatched draft while an older same-session dispatch is still in flight', () => {
    const olderId = 'opk-older-inflight:1000:ao-send:first';
    const newerId = 'opk-older-inflight:2000:ao-send:newer';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-older-inflight', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', reports: [] }],
      dispatchJournal: {
        [olderId]: {
          deliveryId: olderId,
          sessionId: 'opk-older-inflight',
          deliveredAtMs: 1000,
          source: 'ao-send',
          sourceKey: 'first',
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatch_in_flight',
          draftState: 'unknown',
          messageShape: { charLength: 300, lineCount: 2 },
        },
        [newerId]: {
          deliveryId: newerId,
          sessionId: 'opk-older-inflight',
          deliveredAtMs: 2000,
          source: 'ao-send',
          sourceKey: 'newer',
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 280, lineCount: 2 },
        },
      },
      aoEvents: [],
      reviewRuns: [],
      tracking: { deliveries: {}, audit: [] },
      nowMs: 3000,
    });

    expect(submitActions(actions)).toHaveLength(0);
    expect(actions.some((a) => a.type === 'submit' && a.deliveryId === newerId)).toBe(false);
  });

  it('does not submit an older draft while a newer pending dispatch is ambiguous', () => {
    for (const dispatchOutcome of ['dispatch_in_flight', 'dispatch_unknown']) {
      const olderId = `opk-ambiguous-overwrite:1000:ao-send:first:${dispatchOutcome}`;
      const newerId = `opk-ambiguous-overwrite:2000:ao-send:newer:${dispatchOutcome}`;
      const { actions } = planWorkerMessageSubmitActions({
        sessions: [{ sessionId: 'opk-ambiguous-overwrite', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', reports: [] }],
        dispatchJournal: {
          [olderId]: {
            deliveryId: olderId,
            sessionId: 'opk-ambiguous-overwrite',
            deliveredAtMs: 1000,
            source: 'ao-send',
            sourceKey: 'first',
            deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
            dispatchOutcome: 'dispatched',
            draftState: 'draft_present',
            messageShape: { charLength: 300, lineCount: 2 },
          },
          [newerId]: {
            deliveryId: newerId,
            sessionId: 'opk-ambiguous-overwrite',
            deliveredAtMs: 2000,
            source: 'ao-send',
            sourceKey: 'newer',
            deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
            dispatchOutcome,
            draftState: 'unknown',
            messageShape: { charLength: 280, lineCount: 2 },
          },
        },
        aoEvents: [],
        reviewRuns: [],
        tracking: { deliveries: {}, audit: [] },
        nowMs: 3000,
      });
      expect(submitActions(actions)).toHaveLength(0);
      expect(actions.some((a) => a.type === 'submit' && a.deliveryId === olderId)).toBe(false);
    }
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

  it('fails closed for overwritten delivery with ambiguous generic worker report', () => {
    const { actions } = planFixture('consumed-overwritten-no-escalate.json');
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'escalate' &&
          a.reason === 'lost_delivery_overwritten' &&
          a.deliveryId === 'opk-consumed-overwrite:1717600900000:pack-send:first',
      ),
    ).toBe(true);
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'mark_consumed' &&
          a.deliveryId === 'opk-consumed-overwrite:1717600900000:pack-send:first',
      ),
    ).toBe(false);
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

describe('issue #293 busy dispatch, retry, and backstops', () => {
  const busyMarker = {
    backendKey: 'codex',
    dispatchSignature: 'tmux-enter-v1',
    runtimeFingerprint: 'codex-cli@1.0.0',
    tmuxFingerprint: 'tmux@3.4:default',
    smokedAt: '2026-06-13T12:00:00.000Z',
    runId: 'opk-61',
    busy_enter_enqueued_observed: true,
    consumed_after_flush_observed: true,
    no_manual_enter: true,
  } as const;

  it('dispatches while busy only on a smoke-enabled backend', () => {
    const baseInput = {
      delivery: {
        deliveryId: 'busy-1',
        sessionId: 'opk-busy',
        deliveredAtMs: 1000,
        deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
        draftState: 'draft_present',
      },
      session: {
        sessionId: 'opk-busy',
        role: 'worker',
        runtime: 'alive',
        status: 'working',
        activity: 'active',
      },
      tracking: { deliveries: {} },
      aoEvents: [],
      floodActiveSessions: {},
      nowMs: 2000,
    };

    const enabled = evaluateSubmitDecision({
      ...baseInput,
      delivery: {
        ...baseInput.delivery,
        backendKey: 'codex',
        dispatchSignature: 'tmux-enter-v1',
        runtimeFingerprint: 'codex-cli@1.0.0',
        tmuxFingerprint: 'tmux@3.4:default',
      },
      config: {
        busyDispatch: {
          markers: [busyMarker],
          environment: {
            backendKey: 'codex',
            dispatchSignature: 'tmux-enter-v1',
            runtimeFingerprint: 'codex-cli@1.0.0',
            tmuxFingerprint: 'tmux@3.4:default',
          },
        },
      },
    });
    expect(enabled.action).toBe('submit');
    expect(enabled.reason).toBe('pending_draft_busy_dispatch');

    const disabled = evaluateSubmitDecision({
      ...baseInput,
      delivery: {
        ...baseInput.delivery,
        backendKey: 'cursor-cli',
        dispatchSignature: 'tmux-enter-v1',
        runtimeFingerprint: 'cursor-cli@1.0.0',
        tmuxFingerprint: 'tmux@3.4:default',
      },
      config: {
        busyDispatch: {
          markers: [busyMarker],
          environment: {
            backendKey: 'cursor-cli',
            dispatchSignature: 'tmux-enter-v1',
            runtimeFingerprint: 'cursor-cli@1.0.0',
            tmuxFingerprint: 'tmux@3.4:default',
          },
        },
      },
    });
    expect(disabled.action).toBe('noop');
    expect(disabled.reason).toBe('streaming');
  });

  it('does not re-dispatch until the prior busy dispatch becomes settled-observable', () => {
    const base = {
      delivery: {
        deliveryId: 'busy-retry-1',
        sessionId: 'opk-busy-retry',
        deliveredAtMs: 1000,
        deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
        draftState: 'draft_present',
        backendKey: 'codex',
        dispatchSignature: 'tmux-enter-v1',
        runtimeFingerprint: 'codex-cli@1.0.0',
        tmuxFingerprint: 'tmux@3.4:default',
      },
      tracking: {
        deliveries: {
          'busy-retry-1': {
            deliveryId: 'busy-retry-1',
            firstObservedAtMs: 1000,
            draftIdentity: 'busy-retry-1',
            submitAttempts: 1,
            firstDispatchAtMs: 1500,
            lastSubmitAtMs: 1500,
            claimed: true,
            claimKey: 'busy-retry-1:1',
          },
        },
      },
      aoEvents: [],
      floodActiveSessions: {},
      config: {
        busyDispatch: {
          markers: [busyMarker],
          environment: {
            backendKey: 'codex',
            dispatchSignature: 'tmux-enter-v1',
            runtimeFingerprint: 'codex-cli@1.0.0',
            tmuxFingerprint: 'tmux@3.4:default',
          },
        },
      },
    };

    const stillBusy = evaluateSubmitDecision({
      ...base,
      session: { sessionId: 'opk-busy-retry', role: 'worker', runtime: 'alive', status: 'working', activity: 'active' },
      nowMs: 2500,
    });
    expect(stillBusy.action).toBe('noop');
    expect(stillBusy.reason).toBe('claim_held');

    const idleNotDrained = evaluateSubmitDecision({
      ...base,
      delivery: { ...base.delivery, drainSettled: false },
      session: { sessionId: 'opk-busy-retry', role: 'worker', runtime: 'alive', status: 'working', activity: 'idle', activityChangedAtMs: 2000 },
      nowMs: 2500,
    });
    expect(idleNotDrained.action).toBe('noop');
    expect(['observable_not_settled', 'claim_held']).toContain(idleNotDrained.reason);

    const settledAndStillPresent = evaluateSubmitDecision({
      ...base,
      session: { sessionId: 'opk-busy-retry', role: 'worker', runtime: 'alive', status: 'working', activity: 'idle', activityChangedAtMs: 1000 },
      nowMs: 20000,
    });
    expect(settledAndStillPresent.action).toBe('submit');
    expect(settledAndStillPresent.reason).toBe('pending_draft_retry_after_observable_non_consumption');
    expect(settledAndStillPresent.attempt).toBe(2);
  });

  it('fails closed when observability is indeterminate and escalates on the post-dispatch lease', () => {
    const pending = evaluateSubmitDecision({
      delivery: {
        deliveryId: 'obs-1',
        sessionId: 'opk-obs',
        deliveredAtMs: 1000,
        deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
        draftState: 'draft_present',
        observability: 'indeterminate',
      },
      session: { sessionId: 'opk-obs', role: 'worker', runtime: 'alive', status: 'working', activity: 'idle', activityChangedAtMs: 2000 },
      tracking: { deliveries: { 'obs-1': { deliveryId: 'obs-1', firstObservedAtMs: 1000, submitAttempts: 1, firstDispatchAtMs: 1500, lastSubmitAtMs: 1500 } } },
      aoEvents: [],
      floodActiveSessions: {},
      nowMs: 3000,
      config: { postDispatchLeaseMs: 10000 },
    });
    expect(pending.action).toBe('noop');
    expect(pending.reason).toBe('observability_indeterminate');

    const expired = evaluateSubmitDecision({
      delivery: {
        deliveryId: 'obs-1',
        sessionId: 'opk-obs',
        deliveredAtMs: 1000,
        deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
        draftState: 'draft_present',
        observability: 'indeterminate',
      },
      session: { sessionId: 'opk-obs', role: 'worker', runtime: 'alive', status: 'working', activity: 'idle', activityChangedAtMs: 2000 },
      tracking: { deliveries: { 'obs-1': { deliveryId: 'obs-1', firstObservedAtMs: 1000, submitAttempts: 1, firstDispatchAtMs: 1500, lastSubmitAtMs: 1500 } } },
      aoEvents: [],
      floodActiveSessions: {},
      nowMs: 20000,
      config: { postDispatchLeaseMs: 10000 },
    });
    expect(expired.action).toBe('escalate');
    expect(expired.reason).toBe('post_dispatch_lease_exhausted');
  });

  it('fails closed on foreign or unprovable draft identity before first dispatch', () => {
    const foreign = evaluateSubmitDecision({
      delivery: {
        deliveryId: 'foreign-1',
        sessionId: 'opk-foreign',
        deliveredAtMs: 1000,
        deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
        draftState: 'draft_present',
        draftIdentityStatus: 'shape_identical_foreign',
        busyDispatchAllowed: true,
      },
      session: { sessionId: 'opk-foreign', role: 'worker', runtime: 'alive', status: 'working', activity: 'active' },
      tracking: { deliveries: {} },
      aoEvents: [],
      floodActiveSessions: {},
      nowMs: 2000,
    });
    expect(foreign.action).toBe('escalate');
    expect(foreign.reason).toBe('shape_identical_foreign');

    const unprovable = evaluateSubmitDecision({
      delivery: {
        deliveryId: 'foreign-2',
        sessionId: 'opk-foreign',
        deliveredAtMs: 1000,
        deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
        draftState: 'draft_present',
        draftIdentityUnprovable: true,
        busyDispatchAllowed: true,
      },
      session: { sessionId: 'opk-foreign', role: 'worker', runtime: 'alive', status: 'working', activity: 'active' },
      tracking: { deliveries: {} },
      aoEvents: [],
      floodActiveSessions: {},
      nowMs: 2000,
    });
    expect(unprovable.action).toBe('noop');
    expect(unprovable.reason).toBe('draft_identity_unprovable');
  });

  it('records durable failed-delivery state and resolves it on late consumption', () => {
    const seededTracking = {
      deliveries: {
        'failed-1': {
          deliveryId: 'failed-1',
          sessionId: 'opk-failed',
          firstObservedAtMs: 1000,
          terminalState: 'escalated',
          escalatedAtMs: 20000,
          escalationReason: 'still_live_but_unconsumed',
          failedDelivery: {
            deliveryId: 'failed-1',
            sessionId: 'opk-failed',
            reason: 'still_live_but_unconsumed',
            unresolvedState: 'unresolved',
          },
        },
      },
      failedDeliveries: {
        'failed-1': {
          deliveryId: 'failed-1',
          sessionId: 'opk-failed',
          reason: 'still_live_but_unconsumed',
          unresolvedState: 'unresolved',
        },
      },
      audit: [],
    } satisfies SubmitTrackingState;

    const failedStatus = getFailedDeliveryStatus({ tracking: seededTracking, prNumber: 0 });
    expect(failedStatus.unresolved.some((r) => r.deliveryId === 'failed-1')).toBe(true);

    const second = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-failed', role: 'worker', runtime: 'alive', status: 'working', activity: 'idle', activityChangedAtMs: 1000, reports: [{ report_state: 'working', reportedAt: new Date(21000).toISOString(), note: 'consumed later' }] }],
      dispatchJournal: {
        'failed-1': {
          deliveryId: 'failed-1',
          sessionId: 'opk-failed',
          deliveredAtMs: 1000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: seededTracking,
      nowMs: 22000,
      config: { postDispatchLeaseMs: 5000 },
    });
    expect(second.actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed' && a.reason === 'late_consumed_after_terminal')).toBe(true);
    const resolved = getFailedDeliveryStatus({ tracking: second.tracking, prNumber: 0 });
    expect(resolved.unresolved.some((r) => r.deliveryId === 'failed-1')).toBe(false);
  });

  it('scopes unresolved failed deliveries by headSha even without prNumber or reviewRunId', () => {
    const tracking = {
      deliveries: {},
      failedDeliveries: {
        'failed-head-match': {
          deliveryId: 'failed-head-match',
          sessionId: 'opk-head',
          reason: 'still_live_but_unconsumed',
          unresolvedState: 'unresolved',
          headSha: 'sha-match',
        },
        'failed-head-other': {
          deliveryId: 'failed-head-other',
          sessionId: 'opk-head',
          reason: 'still_live_but_unconsumed',
          unresolvedState: 'unresolved',
          headSha: 'sha-other',
        },
      },
      audit: [],
    } satisfies SubmitTrackingState;

    const failedStatus = getFailedDeliveryStatus({ tracking, headSha: 'sha-match' });
    expect(failedStatus.ok).toBe(false);
    expect(failedStatus.failClosed).toBe(false);
    expect(failedStatus.unresolved.map((r) => r.deliveryId)).toEqual([
      'failed-head-match',
    ]);
  });

  it('validates busy-dispatch smoke markers and resolves backend capability by exact environment match', () => {
    expect(validateBusyDispatchMarker({ ...busyMarker })).toEqual({ ok: true });
    expect(validateBusyDispatchMarker({ backendKey: 'codex' })).toEqual({ ok: false, reason: 'busy_dispatch_marker_invalid', field: 'dispatchSignature' });

    const allowed = resolveBusyDispatchCapability({
      delivery: {},
      session: { backendKey: 'codex', dispatchSignature: 'tmux-enter-v1', runtimeFingerprint: 'codex-cli@1.0.0', tmuxFingerprint: 'tmux@3.4:default' },
      config: { busyDispatch: { markers: [busyMarker] } },
    });
    expect(allowed.allowed).toBe(true);

    const stale = resolveBusyDispatchCapability({
      delivery: {},
      session: { backendKey: 'codex', dispatchSignature: 'tmux-enter-v2', runtimeFingerprint: 'codex-cli@1.0.0', tmuxFingerprint: 'tmux@3.4:default' },
      config: { busyDispatch: { markers: [busyMarker] } },
    });
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toBe('busy_dispatch_marker_missing_or_stale');
  });

  it('matches busy-dispatch smoke markers against the live session before recorded delivery fingerprints', () => {
    const capability = resolveBusyDispatchCapability({
      delivery: {
        backendKey: 'codex',
        dispatchSignature: 'tmux-enter-v1',
        runtimeFingerprint: 'codex-cli@1.0.0',
        tmuxFingerprint: 'tmux@3.4:default',
      },
      session: {
        backendKey: 'codex',
        dispatchSignature: 'tmux-enter-v1',
        runtimeFingerprint: 'codex-cli@2.0.0',
        tmuxFingerprint: 'tmux@3.4:alternate',
      },
      config: { busyDispatch: { markers: [busyMarker] } },
    });
    expect(capability.allowed).toBe(false);
    expect(capability.reason).toBe('busy_dispatch_marker_missing_or_stale');
  });

  it('reports settled observability only after the drain-settle window', () => {
    const pending = evaluateDispatchObservability({
      session: { activity: 'idle', activityChangedAtMs: 10000, drainSettled: true },
      record: { lastSubmitAtMs: 9000 },
      nowMs: 15000,
      config: { observabilitySettleMs: 10000 },
    });
    expect(pending.observable).toBe(true);
    expect(pending.settled).toBe(false);

    const settled = evaluateDispatchObservability({
      session: { activity: 'idle', activityChangedAtMs: 10000, drainSettled: true },
      record: { lastSubmitAtMs: 9000 },
      nowMs: 25001,
      config: { observabilitySettleMs: 10000 },
    });
    expect(settled.observable).toBe(true);
    expect(settled.settled).toBe(true);
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


describe('issue #281 journaled worker-send delivery accounting', () => {
  const baseSession = {
    sessionId: 'opk-plain-send',
    name: 'opk-plain-send',
    role: 'worker',
    status: 'working',
    runtime: 'alive',
    activity: 'idle',
    reports: [],
  };

  it('plans Enter for a journaled dispatched pending-draft plain ao send', () => {
    const id = 'opk-plain-send:1717601000000:ao-send:sha256-branch';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [baseSession],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-plain-send',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_AO_SEND,
          sourceKey: 'sha256-branch',
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601010000,
    });
    expect(submitActions(actions)).toHaveLength(1);
    expect(submitActions(actions)[0]?.deliveryId).toBe(id);
  });

  it('send_failed is terminal escalation and never Enter', () => {
    const id = 'opk-plain-send:1717601000000:ao-send:failed';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [baseSession],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-plain-send',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'send_failed',
          draftState: 'unknown',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601010000,
    });
    expect(submitActions(actions)).toHaveLength(0);
    expect(actions.find((a: WorkerMessageSubmitAction) => a.type === 'escalate')?.reason).toBe('send_failed');
  });

  it('unknown authoritative draft state is not Enter-eligible and escalates after budget', () => {
    const id = 'opk-plain-send:1717601000000:ao-send:unknown-draft';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [baseSession],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-plain-send',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'unknown',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: { deliveries: {}, audit: [] },
      config: { deliveryBudgetMs: 1000 },
      nowMs: 1717601005000,
    });
    expect(submitActions(actions)).toHaveLength(0);
    expect(actions.find((a: WorkerMessageSubmitAction) => a.type === 'escalate')?.reason).toBe('draft_state_unknown');
  });

  it('ambiguous multiple in-flight deliveries are not falsely consumed by a generic report', () => {
    const id1 = 'opk-plain-send:1717601000000:ao-send:first';
    const id2 = 'opk-plain-send:1717601010000:ao-send:second';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ ...baseSession, reports: [{ report_state: 'working', reportedAt: new Date(1717601020000).toISOString(), note: 'generic progress' }] }],
      dispatchJournal: {
        [id1]: { deliveryId: id1, sessionId: 'opk-plain-send', deliveredAtMs: 1717601000000, source: DISPATCH_SOURCE_AO_SEND, deliveryPath: DELIVERY_PATH_PENDING_DRAFT, dispatchOutcome: 'dispatched', draftState: 'draft_present', messageShape: { charLength: 240, lineCount: 3 } },
        [id2]: { deliveryId: id2, sessionId: 'opk-plain-send', deliveredAtMs: 1717601010000, source: DISPATCH_SOURCE_AO_SEND, deliveryPath: DELIVERY_PATH_PENDING_DRAFT, dispatchOutcome: 'dispatched', draftState: 'draft_present', messageShape: { charLength: 240, lineCount: 3 } },
      },
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601025000,
    });
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed')).toBe(false);
  });

  it('does not make a dispatched draft ambiguous because a later send failed before reaching the pane', () => {
    const id1 = 'opk-plain-send:1717601000000:ao-send:first';
    const id2 = 'opk-plain-send:1717601010000:ao-send:failed';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ ...baseSession, reports: [{ report_state: 'working', reportedAt: new Date(1717601020000).toISOString(), note: 'generic progress' }] }],
      dispatchJournal: {
        [id1]: { deliveryId: id1, sessionId: 'opk-plain-send', deliveredAtMs: 1717601000000, source: DISPATCH_SOURCE_AO_SEND, deliveryPath: DELIVERY_PATH_PENDING_DRAFT, dispatchOutcome: 'dispatched', draftState: 'draft_present', messageShape: { charLength: 240, lineCount: 3 } },
        [id2]: { deliveryId: id2, sessionId: 'opk-plain-send', deliveredAtMs: 1717601010000, source: DISPATCH_SOURCE_AO_SEND, deliveryPath: DELIVERY_PATH_PENDING_DRAFT, dispatchOutcome: 'send_failed', draftState: 'unknown', messageShape: { charLength: 240, lineCount: 3 } },
      },
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601025000,
    });
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed' && a.deliveryId === id1)).toBe(true);
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'escalate' && a.reason === 'send_failed' && a.deliveryId === id2)).toBe(true);
    expect(submitActions(actions)).toHaveLength(0);
  });

  it('dispatch_unknown escalates instead of looping or replaying payload', () => {
    const id = 'opk-plain-send:1717601000000:ao-send:unknown';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [baseSession],
      dispatchJournal: {
        [id]: { deliveryId: id, sessionId: 'opk-plain-send', deliveredAtMs: 1717601000000, source: DISPATCH_SOURCE_AO_SEND, deliveryPath: DELIVERY_PATH_PENDING_DRAFT, dispatchOutcome: 'dispatch_unknown', draftState: 'unknown', messageShape: { charLength: 240, lineCount: 3 } },
      },
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601010000,
    });
    expect(submitActions(actions)).toHaveLength(0);
    expect(actions.find((a: WorkerMessageSubmitAction) => a.type === 'escalate')?.reason).toBe('dispatch_unknown');
  });

  it('dispatch_in_flight is not escalated as unknown until the finite budget expires', () => {
    const id = 'opk-plain-send:1717601000000:ao-send:in-flight';
    const fresh = planWorkerMessageSubmitActions({
      sessions: [baseSession],
      dispatchJournal: {
        [id]: { deliveryId: id, sessionId: 'opk-plain-send', deliveredAtMs: 1717601000000, source: DISPATCH_SOURCE_AO_SEND, deliveryPath: DELIVERY_PATH_PENDING_DRAFT, dispatchOutcome: 'dispatch_in_flight', draftState: 'unknown', messageShape: { charLength: 240, lineCount: 3 } },
      },
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601010000,
    });
    expect(submitActions(fresh.actions)).toHaveLength(0);
    expect(fresh.actions.some((a: WorkerMessageSubmitAction) => a.type === 'escalate')).toBe(false);

    const expired = planWorkerMessageSubmitActions({
      sessions: [baseSession],
      dispatchJournal: {
        [id]: { deliveryId: id, sessionId: 'opk-plain-send', deliveredAtMs: 1717601000000, source: DISPATCH_SOURCE_AO_SEND, deliveryPath: DELIVERY_PATH_PENDING_DRAFT, dispatchOutcome: 'dispatch_in_flight', draftState: 'unknown', messageShape: { charLength: 240, lineCount: 3 } },
      },
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601400001,
      config: { deliveryBackstopMs: 1000 },
    });
    expect(submitActions(expired.actions)).toHaveLength(0);
    expect(expired.actions.find((a: WorkerMessageSubmitAction) => a.type === 'escalate')?.reason).toBe('dispatch_unknown');
  });

  it('corrupt journal recovery metadata escalates fail-closed once', () => {
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'operator', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle' }],
      dispatchJournal: { _recovery: { fenceTrusted: false, reason: 'unparseable_no_backup', quarantined: '/tmp/corrupt' } as unknown as Record<string, unknown> },
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601010000,
    });
    const escalations = actions.filter((a: WorkerMessageSubmitAction) => a.type === 'escalate');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.reason).toBe('unparseable_no_backup');
  });

  it('does not re-escalate corrupt journal recovery after terminal tracking state', () => {
    const deliveryId = 'corrupt-dispatch-journal:/tmp/corrupt';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'operator', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle' }],
      dispatchJournal: { _recovery: { fenceTrusted: false, reason: 'unparseable_no_backup', quarantined: '/tmp/corrupt' } as unknown as Record<string, unknown> },
      tracking: { deliveries: { [deliveryId]: { deliveryId, terminalState: 'escalated', escalatedAtMs: 1717601000000 } }, audit: [] },
      nowMs: 1717601010000,
    });
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'escalate')).toBe(false);
  });

  it('untrusted journal recovery metadata suppresses normal delivery records fail-closed', () => {
    const id = 'opk-plain-send:1717601000000:ao-send:should-not-submit';
    const { actions, deliveryCount } = planWorkerMessageSubmitActions({
      sessions: [
        { sessionId: 'operator', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle' },
        baseSession,
      ],
      dispatchJournal: {
        _recovery: { fenceTrusted: false, reason: 'unparseable_no_backup', quarantined: '/tmp/corrupt' } as unknown as Record<string, unknown>,
        [id]: { deliveryId: id, sessionId: 'opk-plain-send', deliveredAtMs: 1717601000000, source: DISPATCH_SOURCE_AO_SEND, deliveryPath: DELIVERY_PATH_PENDING_DRAFT, dispatchOutcome: 'dispatched', draftState: 'draft_present', messageShape: { charLength: 240, lineCount: 3 } },
      },
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601010000,
    });
    expect(deliveryCount).toBe(1);
    expect(submitActions(actions)).toHaveLength(0);
    expect(actions.find((a: WorkerMessageSubmitAction) => a.type === 'escalate')?.reason).toBe('unparseable_no_backup');
  });

  it('invalid bounded-escalation overrides fail closed before tracking', () => {
    const { actions, deliveryCount } = planWorkerMessageSubmitActions({
      sessions: [baseSession],
      dispatchJournal: {},
      tracking: { deliveries: {}, audit: [] },
      config: { maxSubmitAttempts: 0 },
      nowMs: 1717601010000,
    });
    expect(deliveryCount).toBe(0);
    expect(actions.find((a: WorkerMessageSubmitAction) => a.type === 'escalate')?.reason).toBe('config_invalid');
  });
});


describe('journaled-worker-send wrapper transport', () => {
  it('uses Windows PowerShell 5.1-compatible ProcessStartInfo APIs', () => {
    const text = readFileSync('scripts/journaled-worker-send.ps1', 'utf8');
    expect(text).not.toContain('.ArgumentList');
    expect(text).not.toContain('.Environment[');
    expect(text).toContain('.EnvironmentVariables[');
  });

  it('fails closed when ao send stdin contract is absent', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-no-stdin-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, '#!/usr/bin/env bash\nif [[ "$1" == "send" && "$2" == "--help" ]]; then echo "Usage: ao send <session> [message...]"; exit 0; fi\nexit 99\n');
    chmodSync(fakeAo, 0o755);
    const secret = 'opk_secret_TOKEN_SHOULD_NOT_LEAK';
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal], { input: secret, encoding: 'utf8' });
    expect(result.status).toBe(42);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(existsSync(journal)).toBe(false);
  });

  it('sets reentrancy sentinel while probing ao send stdin help', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-help-sentinel-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then
  if [[ -z "\${AO_JOURNALED_SEND_INTERNAL:-}" ]]; then exit 88; fi
  echo "Usage: ao send --stdin <session>"
  exit 0
fi
if [[ -z "\${AO_JOURNALED_SEND_INTERNAL:-}" ]]; then exit 89; fi
cat >/dev/null
exit 0
`);
    chmodSync(fakeAo, 0o755);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-TimeoutSeconds', '5'], { input: 'payload', encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(readFileSync(journal, 'utf8')).toContain('"dispatchOutcome":"dispatched"');
  });

  it('fails closed before sending when dispatch journal is untrusted', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-untrusted-journal-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    const sentMarker = path.join(dir, 'sent.txt');
    writeFileSync(journal, '{not-json');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then echo "Usage: ao send --stdin <session>"; exit 0; fi
cat >/dev/null
printf sent > '${sentMarker}'
exit 0
`);
    chmodSync(fakeAo, 0o755);

    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-TimeoutSeconds', '5'], { input: 'payload', encoding: 'utf8' });

    expect(result.status).toBe(43);
    expect(result.stdout).toContain('journal_untrusted');
    expect(existsSync(sentMarker)).toBe(false);
    expect(readFileSync(journal, 'utf8')).toContain('"fenceTrusted":false');
  });

  it('adds unique hashed source keys for default plain ao-send deliveries', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-unique-source-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then echo "Usage: ao send --stdin <session>"; exit 0; fi
cat >/dev/null
exit 0
`);
    chmodSync(fakeAo, 0o755);

    const first = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-TimeoutSeconds', '5'], { input: 'payload one', encoding: 'utf8' });
    const second = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-TimeoutSeconds', '5'], { input: 'payload two', encoding: 'utf8' });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const records = Object.values(JSON.parse(readFileSync(journal, 'utf8')) as Record<string, Record<string, unknown>>);
    expect(records).toHaveLength(2);
    const sourceKeys = records.map((record) => String(record.sourceKey));
    expect(sourceKeys.every((key) => /^sha256-[0-9a-f]{24}$/.test(key))).toBe(true);
    expect(new Set(sourceKeys).size).toBe(2);
  });

  it('passes multiline payload through stdin and stores metadata only', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-stdin-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    const stdinCapture = path.join(dir, 'stdin.txt');
    const argvCapture = path.join(dir, 'argv.txt');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then echo "Usage: ao send --stdin <session>"; exit 0; fi
printf '%s\n' "$@" > "${argvCapture}"
cat > "${stdinCapture}"
exit 0
`);
    chmodSync(fakeAo, 0o755);
    const payload = `first line with spaces /tmp/path with spaces\n${'x'.repeat(230)}\nopk_secret_TOKEN_SHOULD_NOT_LEAK`;
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-SourceKey', 'branch with spaces'], { input: payload, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(readFileSync(stdinCapture, 'utf8')).toBe(payload);
    expect(readFileSync(argvCapture, 'utf8')).not.toContain('opk_secret_TOKEN_SHOULD_NOT_LEAK');
    const journalText = readFileSync(journal, 'utf8');
    expect(journalText).not.toContain('opk_secret_TOKEN_SHOULD_NOT_LEAK');
    expect(journalText).not.toContain('branch with spaces');
    expect(journalText).toContain('"dispatchOutcome":"dispatched"');
    expect(journalText).toContain('"lineCount":3');
  });

  it('fails closed when post-send outcome update cannot be recorded', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-update-fail-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then echo "Usage: ao send --stdin <session>"; exit 0; fi
cat >/dev/null
printf '{"startedAt":"2999-01-01T00:00:00Z"}' > "${journal}.lock"
exit 0
`);
    chmodSync(fakeAo, 0o755);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-TimeoutSeconds', '5'], { input: 'payload', encoding: 'utf8' });
    expect(result.status).toBe(47);
    expect(result.stdout).toContain('dispatch outcome update failed');
    expect(readFileSync(journal, 'utf8')).toContain('"dispatchOutcome":"dispatch_in_flight"');
  });

  it('drains redirected ao stdout and stderr while waiting', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-drain-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then echo "Usage: ao send --stdin <session>"; exit 0; fi
cat >/dev/null
python3 - <<'PY2'
import sys
sys.stdout.write('o' * 1048576)
sys.stdout.flush()
sys.stderr.write('e' * 1048576)
sys.stderr.flush()
PY2
exit 0
`);
    chmodSync(fakeAo, 0o755);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-TimeoutSeconds', '5'], { input: 'payload', encoding: 'utf8', timeout: 15000 });
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeLessThan(1000);
    expect(readFileSync(journal, 'utf8')).toContain('"dispatchOutcome":"dispatched"');
  });
});


describe('worker-message-send adoption preflight', () => {
  it('fails present-but-incomplete routing branch coverage', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adoption-preflight-missing-'));
    const journal = path.join(dir, 'journal.json');
    const state = path.join(dir, 'state.json');
    writeFileSync(journal, JSON.stringify({
      probe1: { deliveryId: 'probe1', sessionId: 'synthetic', deliveredAtMs: 1, source: 'adoption-probe', sourceKey: 'plain-ao-send:pending-draft', adoptionProbe: true, dispatchOutcome: 'dispatched', draftState: 'auto_submitted', messageShape: { charLength: 0, lineCount: 0 } },
    }));
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/worker-message-send-adoption-preflight.ps1', '-JournalPath', journal, '-StateFile', state], { encoding: 'utf8' });
    expect(result.status).toBe(46);
    expect(result.stdout).toContain('wrapper_not_adopted');
  });

  it('requires adoption probe records to have dispatched outcomes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adoption-preflight-outcome-'));
    const journal = path.join(dir, 'journal.json');
    const state = path.join(dir, 'state.json');
    writeFileSync(journal, JSON.stringify({
      probe1: { deliveryId: 'probe1', sessionId: 'synthetic', deliveredAtMs: 1, source: 'adoption-probe', sourceKey: 'plain-ao-send:pending-draft', adoptionProbe: true, dispatchOutcome: 'dispatched', draftState: 'auto_submitted', messageShape: { charLength: 240, lineCount: 2 } },
      probe2: { deliveryId: 'probe2', sessionId: 'synthetic', deliveredAtMs: 2, source: 'adoption-probe', sourceKey: 'plain-ao-send:self-submitted', adoptionProbe: true, dispatchOutcome: 'send_failed', draftState: 'unknown', messageShape: { charLength: 20, lineCount: 1 } },
    }));
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/worker-message-send-adoption-preflight.ps1', '-JournalPath', journal, '-StateFile', state], { encoding: 'utf8' });
    expect(result.status).toBe(46);
    expect(result.stdout).toContain('wrapper_not_adopted');
  });

  it('passes only when every required routing branch is outbox-observed', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adoption-preflight-ok-'));
    const journal = path.join(dir, 'journal.json');
    const state = path.join(dir, 'state.json');
    writeFileSync(journal, JSON.stringify({
      probe1: { deliveryId: 'probe1', sessionId: 'synthetic', deliveredAtMs: 1, source: 'adoption-probe', sourceKey: 'plain-ao-send:pending-draft', adoptionProbe: true, dispatchOutcome: 'dispatched', draftState: 'auto_submitted', messageShape: { charLength: 0, lineCount: 0 } },
      probe2: { deliveryId: 'probe2', sessionId: 'synthetic', deliveredAtMs: 2, source: 'adoption-probe', sourceKey: 'plain-ao-send:self-submitted', adoptionProbe: true, dispatchOutcome: 'dispatched', draftState: 'auto_submitted', messageShape: { charLength: 0, lineCount: 0 } },
    }));
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/worker-message-send-adoption-preflight.ps1', '-JournalPath', journal, '-StateFile', state], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('effective routing adopted');
  });

  it('can generate current epoch/config probe entries through the wrapper before validating a fresh journal', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adoption-preflight-generate-'));
    const journal = path.join(dir, 'journal.json');
    const state = path.join(dir, 'state.json');
    const fakeAo = path.join(dir, 'ao');
    const wrapperPath = path.resolve('scripts/journaled-worker-send.ps1').replace(/'/g, `'\''`);
    writeFileSync(fakeAo, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "$1" == "send" && "${2:-}" == "--help" ]]; then echo "Usage: ao send --stdin <session>"; exit 0; fi',
      'if [[ "$1" != "send" ]]; then exit 64; fi',
      'payload=$(cat)',
      `printf "%s" "$payload" | pwsh -NoProfile -File '${wrapperPath}' -SessionId synthetic-adoption-probe -AoPath "$0"`,
      '',
    ].join('\n'));
    chmodSync(fakeAo, 0o755);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/worker-message-send-adoption-preflight.ps1', '-JournalPath', journal, '-StateFile', state, '-AoEpoch', 'epoch-fresh', '-ConfigPath', '/cfg/fresh.yaml', '-AoPath', fakeAo, '-WriteProbeEntries'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('effective routing adopted');
    const journalText = readFileSync(journal, 'utf8');
    expect(journalText).toContain('\"adoptionProbe\":true');
    const branchHash = (value: string) => `sha256-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
    const pendingBranchHash = branchHash('plain-ao-send:pending-draft');
    const selfSubmittedBranchHash = branchHash('plain-ao-send:self-submitted');
    expect(journalText).toContain(pendingBranchHash);
    expect(journalText).toContain(selfSubmittedBranchHash);
    const parsedJournal = JSON.parse(journalText) as Record<string, Record<string, unknown>>;
    const probeRecords = Object.values(parsedJournal);
    const pendingProbe = probeRecords.find((record) => record.sourceKey === pendingBranchHash);
    const selfSubmittedProbe = probeRecords.find((record) => record.sourceKey === selfSubmittedBranchHash);
    expect(pendingProbe?.deliveryPath).toBe('pending-draft');
    expect((pendingProbe?.messageShape as { charLength?: number; lineCount?: number } | undefined)?.charLength).toBeGreaterThan(200);
    expect((pendingProbe?.messageShape as { charLength?: number; lineCount?: number } | undefined)?.lineCount).toBeGreaterThan(1);
    expect(selfSubmittedProbe?.deliveryPath).toBe('self-submitted');
    expect((selfSubmittedProbe?.messageShape as { charLength?: number; lineCount?: number } | undefined)?.charLength).toBeLessThanOrEqual(200);
    expect((selfSubmittedProbe?.messageShape as { charLength?: number; lineCount?: number } | undefined)?.lineCount).toBe(1);
    const deliveries = mergeDeliveryRecords({
      dispatchJournal: parsedJournal,
      aoEvents: [],
      reviewRuns: [],
      reactionMessages: {},
      nowMs: 1717601010000,
    });
    expect(deliveries).toHaveLength(0);
  });

  it('requires WriteProbeEntries validation to observe probes from the current run', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adoption-preflight-current-run-'));
    const journal = path.join(dir, 'journal.json');
    const state = path.join(dir, 'state.json');
    const fakeAo = path.join(dir, 'ao');
    const hash = (value: string) => `sha256-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
    writeFileSync(journal, JSON.stringify({
      staleProbe1: { deliveryId: 'staleProbe1', sessionId: 'synthetic', deliveredAtMs: 1, source: 'adoption-probe', sourceKey: hash('plain-ao-send:pending-draft'), adoptionProbe: true, aoEpochHash: hash('epoch-current'), configPathHash: hash('/cfg/current.yaml'), adoptionProbeRunIdHash: hash('old-run'), dispatchOutcome: 'dispatched', draftState: 'auto_submitted', messageShape: { charLength: 240, lineCount: 2 } },
      staleProbe2: { deliveryId: 'staleProbe2', sessionId: 'synthetic', deliveredAtMs: 2, source: 'adoption-probe', sourceKey: hash('plain-ao-send:self-submitted'), adoptionProbe: true, aoEpochHash: hash('epoch-current'), configPathHash: hash('/cfg/current.yaml'), adoptionProbeRunIdHash: hash('old-run'), dispatchOutcome: 'dispatched', draftState: 'auto_submitted', messageShape: { charLength: 20, lineCount: 1 } },
    }));
    writeFileSync(fakeAo, '#!/usr/bin/env bash\nif [[ "$1" == "send" ]]; then cat >/dev/null; exit 0; fi\nexit 64\n');
    chmodSync(fakeAo, 0o755);

    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/worker-message-send-adoption-preflight.ps1', '-JournalPath', journal, '-StateFile', state, '-AoEpoch', 'epoch-current', '-ConfigPath', '/cfg/current.yaml', '-AoPath', fakeAo, '-WriteProbeEntries'], { encoding: 'utf8' });

    expect(result.status).toBe(46);
    expect(result.stdout).toContain('wrapper_not_adopted');
  });

  it('keeps dry-run generated probes out of the live dispatch journal', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adoption-preflight-dryrun-'));
    const prodJournal = path.join(dir, 'prod-journal.json');
    const state = path.join(dir, 'state.json');
    const fakeAo = path.join(dir, 'ao');
    const wrapperPath = path.resolve('scripts/journaled-worker-send.ps1').replace(/'/g, `'\''`);
    writeFileSync(prodJournal, JSON.stringify({ existing: { deliveryId: 'existing', adoptionProbe: false } }));
    writeFileSync(fakeAo, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "$1" == "send" && "${2:-}" == "--help" ]]; then echo "Usage: ao send --stdin <session>"; exit 0; fi',
      'if [[ "$1" != "send" ]]; then exit 64; fi',
      'payload=$(cat)',
      `printf "%s" "$payload" | pwsh -NoProfile -File '${wrapperPath}' -SessionId synthetic-adoption-probe -AoPath "$0"`,
      '',
    ].join('\n'));
    chmodSync(fakeAo, 0o755);

    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/worker-message-send-adoption-preflight.ps1', '-StateFile', state, '-AoEpoch', 'epoch-dry', '-ConfigPath', '/cfg/dry.yaml', '-AoPath', fakeAo, '-WriteProbeEntries', '-DryRun'], {
      encoding: 'utf8',
      env: { ...process.env, AO_WORKER_MESSAGE_DISPATCH_JOURNAL: prodJournal, TMPDIR: dir },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('effective routing adopted');
    expect(readFileSync(prodJournal, 'utf8')).toBe(JSON.stringify({ existing: { deliveryId: 'existing', adoptionProbe: false } }));
  });

  it('requires adoption probe hash to match supplied AO epoch and config path', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adoption-preflight-epoch-'));
    const journal = path.join(dir, 'journal.json');
    const state = path.join(dir, 'state.json');
    const hash = (value: string) => `sha256-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
    writeFileSync(journal, JSON.stringify({
      staleProbe1: { deliveryId: 'staleProbe1', sessionId: 'synthetic', deliveredAtMs: 1, source: 'adoption-probe', sourceKey: 'plain-ao-send:pending-draft', adoptionProbe: true, dispatchOutcome: 'dispatched', draftState: 'auto_submitted', messageShape: { charLength: 0, lineCount: 0 } },
      staleProbe2: { deliveryId: 'staleProbe2', sessionId: 'synthetic', deliveredAtMs: 2, source: 'adoption-probe', sourceKey: 'plain-ao-send:self-submitted', adoptionProbe: true, dispatchOutcome: 'dispatched', draftState: 'auto_submitted', messageShape: { charLength: 0, lineCount: 0 } },
    }));
    const stale = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/worker-message-send-adoption-preflight.ps1', '-JournalPath', journal, '-StateFile', state, '-AoEpoch', 'epoch-current', '-ConfigPath', '/cfg/current.yaml'], { encoding: 'utf8' });
    expect(stale.status).toBe(46);

    writeFileSync(journal, JSON.stringify({
      probe1: { deliveryId: 'probe1', sessionId: 'synthetic', deliveredAtMs: 1, source: 'adoption-probe', sourceKey: 'plain-ao-send:pending-draft', adoptionProbe: true, aoEpochHash: hash('epoch-current'), configPathHash: hash('/cfg/current.yaml'), dispatchOutcome: 'dispatched', draftState: 'auto_submitted', messageShape: { charLength: 0, lineCount: 0 } },
      probe2: { deliveryId: 'probe2', sessionId: 'synthetic', deliveredAtMs: 2, source: 'adoption-probe', sourceKey: 'plain-ao-send:self-submitted', adoptionProbe: true, aoEpochHash: hash('epoch-current'), configPathHash: hash('/cfg/current.yaml'), dispatchOutcome: 'dispatched', draftState: 'auto_submitted', messageShape: { charLength: 0, lineCount: 0 } },
    }));
    const current = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/worker-message-send-adoption-preflight.ps1', '-JournalPath', journal, '-StateFile', state, '-AoEpoch', 'epoch-current', '-ConfigPath', '/cfg/current.yaml'], { encoding: 'utf8' });
    expect(current.status).toBe(0);
  });
});
