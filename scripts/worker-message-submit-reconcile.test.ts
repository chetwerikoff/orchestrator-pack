import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AO_SEND_0102_HELP, buildAoSend0102Stub } from './_ao-send-0102-test-fixture.js';
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
  observeReactionDeliveries,
  selectSurvivingDelivery,
  DISPATCH_SOURCE_REVIEW_SEND,
  DISPATCH_SOURCE_AO_SEND,
} from '../docs/worker-message-dispatch-observe.mjs';
import { readReactionMessagesFromYamlFile } from './reaction-config-messages.mjs';
import {
  applySubmitOutcomes,
  evaluateConcurrentSubmitClaim,
  evaluateSubmitDecision,
  isActiveSubmitClaim,
  OPERATOR_ESCALATION_PREFIX,
  evaluateDispatchObservability,
  getFailedDeliveryStatus,
  evaluateWorktreeDriftVanishSuppression,
  planWorkerMessageSubmitActions,
  resolveBusyDispatchCapability,
  resolveSubmitReconcileConfig,
  validateBusyDispatchMarker,
  evaluateStateRootReSeatEligibility,
  evaluateStateRootReSeat,
  STATE_ROOT_RECOVERY_REASON,
  DEFAULT_DELIVERY_BACKSTOP_MS,
} from '../docs/worker-message-submit-reconcile.mjs';
import type {
  SubmitTrackingState,
  WorkerMessageSubmitAction,
} from '../docs/worker-message-submit-reconcile.d.mts';

type ReSeatEligibilityInput = Parameters<typeof evaluateStateRootReSeatEligibility>[0] & {
  anchorState?: Record<string, unknown> | null;
  nowMs?: number;
};

function callReSeatEligibility(input: ReSeatEligibilityInput) {
  return evaluateStateRootReSeatEligibility(
    input as Parameters<typeof evaluateStateRootReSeatEligibility>[0],
  );
}


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

function writeFakeAoCli(dir: string): string {
  const aoPath = path.join(dir, 'ao');
  writeFileSync(
    aoPath,
    `#!/usr/bin/env bash
if [[ "$1" == "status" ]]; then echo '{"data":[]}'; exit 0; fi
if [[ "$1" == "session" && "$2" == "ls" && "$3" == "--json" ]]; then echo '{"data":[]}'; exit 0; fi
if [[ "$1" == "orchestrator" && "$2" == "ls" && "$3" == "--json" ]]; then echo '{"data":[]}'; exit 0; fi
if [[ "$1" == "events" && "$2" == "list" ]]; then echo '{"events":[]}'; exit 0; fi
if [[ "$1" == "review" && "$2" == "list" ]]; then echo '{"runs":[]}'; exit 0; fi
echo "unsupported: $*" >&2; exit 99
`,
  );
  chmodSync(aoPath, 0o755);
  return dir;
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

  it('forwards journal consumption evidence into merged deliveries', () => {
    const deliveryId = 'opk-journal:1717601000000:ao-send:flush';
    const deliveredAtMs = 1717601000000;
    const [fromBooleanFlag] = mergeDeliveryRecords({
      dispatchJournal: {
        [deliveryId]: {
          deliveryId,
          sessionId: 'opk-journal',
          deliveredAtMs,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          consumedAfterFlushObserved: true,
        },
      },
      aoEvents: [],
      reviewRuns: [],
      nowMs: deliveredAtMs + 20_000,
    });
    expect(fromBooleanFlag?.consumedAfterFlushObserved).toBe(true);
    expect(
      isDeliveryConsumed({ reports: [] }, fromBooleanFlag, deliveredAtMs),
    ).toBe(true);

    const evidenceId = 'opk-journal:1717601010000:ao-send:evidence';
    const [fromEvidenceString] = mergeDeliveryRecords({
      dispatchJournal: {
        [evidenceId]: {
          deliveryId: evidenceId,
          sessionId: 'opk-journal',
          deliveredAtMs: deliveredAtMs + 10_000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          consumptionEvidence: 'consumed_after_flush_observed',
        },
      },
      aoEvents: [],
      reviewRuns: [],
      nowMs: deliveredAtMs + 30_000,
    });
    expect(fromEvidenceString?.consumptionEvidence).toBe('consumed_after_flush_observed');
    expect(
      isDeliveryConsumed({ reports: [] }, fromEvidenceString, deliveredAtMs + 10_000),
    ).toBe(true);
  });

  it('does not treat unrelated non-review report states as ao-send consumption', () => {
    const deliveryId = 'opk-plain-send:1717601000000:ao-send:uncorrelated';
    const deliveredAtMs = 1717601000000;
    expect(
      isDeliveryConsumed(
        {
          reports: [
            {
              report_state: 'ready_for_review',
              reportedAt: new Date(1717601015000).toISOString(),
              note: 'unrelated progress',
            },
          ],
        },
        {
          deliveryId,
          source: DISPATCH_SOURCE_AO_SEND,
          draftState: 'draft_present',
        },
        deliveredAtMs,
      ),
    ).toBe(false);
    expect(
      isDeliveryConsumed(
        {
          reports: [
            {
              report_state: 'ready_for_review',
              reportedAt: new Date(1717601015000).toISOString(),
              note: `handoff ${deliveryId}`,
            },
          ],
        },
        {
          deliveryId,
          source: DISPATCH_SOURCE_AO_SEND,
          draftState: 'draft_present',
        },
        deliveredAtMs,
      ),
    ).toBe(true);
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
  it('does not escalate overwritten delivery already marked noop', () => {
    const { actions } = planFixture('noop-overwritten-no-escalate.json');
    expect(
      actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'escalate' &&
          a.reason === 'lost_delivery_overwritten' &&
          a.deliveryId === 'opk-noop-overwrite:1717600900000:pack-send:first',
      ),
    ).toBe(false);
    expect(submitActions(actions)).toHaveLength(1);
    expect(submitActions(actions)[0]?.deliveryId).toBe(
      'opk-noop-overwrite:1717600950000:pack-send:second',
    );
  });

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
      sessions: [{ sessionId: 'opk-failed', role: 'worker', runtime: 'alive', status: 'working', activity: 'idle', activityChangedAtMs: 1000, reports: [{ report_state: 'working', reportedAt: new Date(21000).toISOString(), note: 'consumed failed-1' }] }],
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

  it('does not hide unresolved failed deliveries that match one supplied scope and lack another', () => {
    const tracking = {
      deliveries: {},
      failedDeliveries: {
        'failed-run-no-head': {
          deliveryId: 'failed-run-no-head',
          sessionId: 'opk-partial',
          reason: 'still_live_but_unconsumed',
          unresolvedState: 'unresolved',
          reviewRunId: 'review-run-match',
        },
        'failed-pr-no-head': {
          deliveryId: 'failed-pr-no-head',
          sessionId: 'opk-partial',
          reason: 'still_live_but_unconsumed',
          unresolvedState: 'unresolved',
          prNumber: 297,
        },
        'failed-other-pr': {
          deliveryId: 'failed-other-pr',
          sessionId: 'opk-partial',
          reason: 'still_live_but_unconsumed',
          unresolvedState: 'unresolved',
          prNumber: 298,
        },
      },
      audit: [],
    } satisfies SubmitTrackingState;

    const failedStatus = getFailedDeliveryStatus({
      tracking,
      prNumber: 297,
      reviewRunId: 'review-run-match',
      headSha: 'sha-current',
    });
    expect(failedStatus.ok).toBe(false);
    expect(failedStatus.failClosed).toBe(false);
    expect(failedStatus.unresolved.map((r) => r.deliveryId).sort()).toEqual([
      'failed-pr-no-head',
      'failed-run-no-head',
    ]);
  });

  it('propagates journaled delivery observation fields into runtime decisions', () => {
    const foreign = planWorkerMessageSubmitActions({
      sessions: [{
        sessionId: 'opk-foreign',
        role: 'worker',
        runtime: 'alive',
        status: 'working',
        activity: 'active',
      }],
      dispatchJournal: {
        'foreign-1': {
          deliveryId: 'foreign-1',
          sessionId: 'opk-foreign',
          deliveredAtMs: 1000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          draftState: 'draft_present',
          draftIdentityStatus: 'shape_identical_foreign',
          dispatchOutcome: 'dispatched',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: { deliveries: {}, failedDeliveries: {}, audit: [] },
      aoEvents: [],
      floodActiveSessions: {},
      nowMs: 2000,
    });
    expect(
      foreign.actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'escalate' && a.deliveryId === 'foreign-1' && a.reason === 'shape_identical_foreign',
      ),
    ).toBe(true);

    const observability = planWorkerMessageSubmitActions({
      sessions: [{
        sessionId: 'opk-obs',
        role: 'worker',
        runtime: 'alive',
        status: 'working',
        activity: 'idle',
        activityChangedAtMs: 2000,
      }],
      dispatchJournal: {
        'obs-1': {
          deliveryId: 'obs-1',
          sessionId: 'opk-obs',
          deliveredAtMs: 1000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          draftState: 'draft_present',
          observability: 'indeterminate',
          dispatchOutcome: 'dispatched',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: {
        deliveries: {
          'obs-1': {
            deliveryId: 'obs-1',
            firstObservedAtMs: 1000,
            submitAttempts: 1,
            firstDispatchAtMs: 1500,
            lastSubmitAtMs: 1500,
          },
        },
        failedDeliveries: {},
        audit: [],
      },
      aoEvents: [],
      floodActiveSessions: {},
      nowMs: 3000,
    });
    expect(
      observability.actions.some(
        (a: WorkerMessageSubmitAction) =>
          a.type === 'noop' && a.deliveryId === 'obs-1' && a.reason === 'observability_indeterminate',
      ),
    ).toBe(true);
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

  it('can resolve busy-dispatch capability from configured live environment fingerprints', () => {
    const allowed = resolveBusyDispatchCapability({
      delivery: {},
      session: {},
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
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toBe('busy_dispatch_marker_match');
  });

  it('derives marker fingerprints for diagnostics without trusting them as observed environment', () => {
    const resolved = resolveSubmitReconcileConfig({
      busyDispatch: {
        markers: [busyMarker],
      },
    });
    expect(resolved.busyDispatch.environment).toEqual({
      backendKey: 'codex',
      dispatchSignature: 'tmux-enter-v1',
      runtimeFingerprint: 'codex-cli@1.0.0',
      tmuxFingerprint: 'tmux@3.4:default',
    });
    expect(resolved.busyDispatch.environmentSource).toBe('marker');

    const capability = resolveBusyDispatchCapability({
      delivery: {},
      session: {},
      config: { busyDispatch: { markers: [busyMarker] } },
    });
    expect(capability.allowed).toBe(false);
    expect(capability.reason).toBe('busy_dispatch_environment_unknown');

    const resolvedCapability = resolveBusyDispatchCapability({
      delivery: {},
      session: {},
      config: resolved,
    });
    expect(resolvedCapability.allowed).toBe(false);
    expect(resolvedCapability.reason).toBe('busy_dispatch_environment_unknown');
  });

  it('preserves live busy-dispatch capability when multiple valid smoke markers exist', () => {
    const olderMarker = {
      ...busyMarker,
      backendKey: 'older',
      dispatchSignature: 'tmux-enter-v0',
      runtimeFingerprint: 'codex-cli@0.9.0',
      tmuxFingerprint: 'tmux@3.3:default',
      smokedAt: '2026-06-12T12:00:00.000Z',
    };
    const resolved = resolveSubmitReconcileConfig({
      busyDispatch: {
        markers: [olderMarker, busyMarker],
      },
    });
    expect(resolved.busyDispatch.environment).toEqual({
      backendKey: 'codex',
      dispatchSignature: 'tmux-enter-v1',
      runtimeFingerprint: 'codex-cli@1.0.0',
      tmuxFingerprint: 'tmux@3.4:default',
    });
    expect(resolved.busyDispatch.environmentSource).toBe('marker');

    const capability = resolveBusyDispatchCapability({
      delivery: {},
      session: {
        backendKey: 'codex',
        dispatchSignature: 'tmux-enter-v1',
        runtimeFingerprint: 'codex-cli@1.0.0',
        tmuxFingerprint: 'tmux@3.4:default',
      },
      config: { busyDispatch: { markers: [olderMarker, busyMarker] } },
    });
    expect(capability.allowed).toBe(true);
    expect(capability.reason).toBe('busy_dispatch_marker_match');
  });

  it('does not let delivery busyDispatchAllowed bypass smoke markers', () => {
    const capability = resolveBusyDispatchCapability({
      delivery: {
        busyDispatchAllowed: true,
      },
      session: {},
      config: { busyDispatch: { markers: [] } },
    });
    expect(capability.allowed).toBe(false);
    expect(capability.reason).toBe('busy_dispatch_environment_unknown');
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


describe('issue #402 static reaction delivery shape from live config', () => {
  const liveReportStale =
    'Worker idle (report-stale backstop). Check pending AO review findings via `ao review list` and report `ao report addressing_reviews`, or report a terminal failure with a reason. Do not stay silent after review findings land.';
  const stubReportStale =
    'Agent report is stale (30 minutes since last report). Continue your task.';
  const reactionEvent = {
    kind: 'reaction.action_succeeded',
    sessionId: 'opk-165',
    tsEpoch: 1782123033110,
    data: { action: 'send-to-agent', reactionKey: 'report-stale' },
  };
  const idleWorker = {
    sessionId: 'opk-165',
    role: 'worker',
    status: 'working',
    runtime: 'alive',
    activity: 'idle',
    reports: [],
  };

  it('AC1/AC4/AC8: report-stale live text classifies pending-draft and plans submit', () => {
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [idleWorker],
      dispatchJournal: {},
      aoEvents: [reactionEvent],
      reviewRuns: [],
      tracking: { deliveries: {}, audit: [] },
      floodActiveSessions: {},
      reactionMessages: { 'report-stale': liveReportStale },
      nowMs: 1782123034000,
      config: {},
    });
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'submit')).toBe(true);
    const { deliveries } = observeReactionDeliveries({
      aoEvents: [reactionEvent],
      dispatchJournal: {},
      reviewRuns: [],
      reactionMessages: { 'report-stale': liveReportStale },
      nowMs: 1782123034000,
    });
    expect(deliveries[0]?.deliveryPath).toBe(DELIVERY_PATH_PENDING_DRAFT);
    expect(deliveries[0]?.messageShape?.charLength).toBe(224);
  });

  it('AC8 negative: stale 73-char stub classifies self-submitted and does not submit', () => {
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [idleWorker],
      dispatchJournal: {},
      aoEvents: [reactionEvent],
      reviewRuns: [],
      tracking: { deliveries: {}, audit: [] },
      floodActiveSessions: {},
      reactionMessages: { 'report-stale': stubReportStale },
      nowMs: 1782123034000,
      config: {},
    });
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'submit')).toBe(false);
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'noop' && a.reason === 'tracking_auto_submitted')).toBe(true);
  });

  it('AC6: unresolved reaction key emits audit, not delivery tracking', () => {
    const unresolvedEvent = {
      kind: 'reaction.action_succeeded',
      sessionId: 'opk-changes',
      tsEpoch: 1717600000000,
      data: { action: 'send-to-agent', reactionKey: 'changes-requested' },
    };
    const { deliveries, reactionAudits } = observeReactionDeliveries({
      aoEvents: [unresolvedEvent],
      dispatchJournal: {},
      reviewRuns: [],
      reactionMessages: {},
      nowMs: 1717600001000,
    });
    expect(deliveries).toHaveLength(0);
    expect(reactionAudits[0]?.reason).toBe('reaction_message_unresolved');
    expect(reactionAudits[0]?.reactionKey).toBe('changes-requested');
  });

  it('AC6b: config read failure is unavailable (no stub fallback surface)', () => {
    const result = readReactionMessagesFromYamlFile('/does/not/exist/agent-orchestrator.yaml');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('reaction_config_unavailable');
  });

  it('AC5: ci-failed notify reaction is absent from shape map (negative control)', () => {
    const { deliveries, reactionAudits } = observeReactionDeliveries({
      aoEvents: [
        {
          kind: 'reaction.action_succeeded',
          sessionId: 'opk-ci',
          tsEpoch: 1717600000000,
          data: { action: 'send-to-agent', reactionKey: 'ci-failed' },
        },
      ],
      dispatchJournal: {},
      reviewRuns: [],
      reactionMessages: {},
      nowMs: 1717600001000,
    });
    expect(deliveries).toHaveLength(0);
    expect(reactionAudits[0]?.reactionKey).toBe('ci-failed');
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

  it('does not mark a submitted delivery consumed without positive consumption evidence', () => {
    const id = 'opk-plain-send:1717601000000:ao-send:submitted-no-evidence';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ ...baseSession, reports: [{ report_state: 'working', reportedAt: new Date(1717601020000).toISOString(), note: 'generic progress' }] }],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-plain-send',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: {
        deliveries: {
          [id]: {
            deliveryId: id,
            sessionId: 'opk-plain-send',
            firstObservedAtMs: 1717601000000,
            deliveredAtMs: 1717601000000,
            submitAttempts: 1,
            firstDispatchAtMs: 1717601005000,
            lastSubmitAtMs: 1717601005000,
            terminalState: 'submitted',
          },
        },
        audit: [],
      },
      nowMs: 1717601025000,
    });
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed')).toBe(false);
    expect(actions.some((a: WorkerMessageSubmitAction) => a.deliveryId === id)).toBe(false);
  });

  it('does not make a dispatched draft ambiguous because a later send failed before reaching the pane', () => {
    const id1 = 'opk-plain-send:1717601000000:ao-send:first';
    const id2 = 'opk-plain-send:1717601010000:ao-send:failed';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ ...baseSession, reports: [{ report_state: 'working', reportedAt: new Date(1717601020000).toISOString(), note: `consumed ${id1}` }] }],
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
  it('requires claim token only for gated nudges (#384; legacy #281 transport ungated)', () => {
    const text = readFileSync('scripts/journaled-worker-send.ps1', 'utf8');
    expect(text).toContain('[switch]$GatedNudge');
    expect(text).toContain('if ($GatedNudge -and -not $ClaimToken)');
    expect(text).toContain("if ($ClaimToken) {");
  });

  it('uses Windows PowerShell 5.1-compatible ProcessStartInfo APIs', () => {
    const text = readFileSync('scripts/journaled-worker-send.ps1', 'utf8');
    expect(text).not.toContain('.ArgumentList');
    expect(text).not.toContain('.Environment[');
    expect(text).toContain('.EnvironmentVariables[');
  });

  it('verifies transport privacy on Windows and uses BSD stat on macOS', () => {
    const text = readFileSync('scripts/lib/MechanicalReconcileNode.ps1', 'utf8');
    expect(text).toContain('AreAccessRulesProtected');
    expect(text).toContain("stat -f '%OLp'");
    expect(text).toContain('Get-MechanicalTransportUnixModeString');
  });

  it('classifies private payload setup failure as send_failed', () => {
    const text = readFileSync('scripts/journaled-worker-send.ps1', 'utf8');
    expect(text).toContain('payload_transport_not_private');
    expect(text).toMatch(/process_not_started\|session_not_found\|arg_rejected\|exception_before_send\|payload_transport_not_private\|inline_message_too_large/);
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', `
      $Reason = 'payload_transport_not_private'
      $ExitCode = 1
      if ($ExitCode -eq 0) { $outcome = 'dispatched' }
      elseif ($Reason -match '^(timeout_interrupted|interrupted)$') { $outcome = 'dispatch_unknown' }
      elseif ($Reason -match '^(process_not_started|session_not_found|arg_rejected|exception_before_send|payload_transport_not_private)$') { $outcome = 'send_failed' }
      elseif ($ExitCode -ge 64 -and $ExitCode -le 69) { $outcome = 'send_failed' }
      else { $outcome = 'dispatch_unknown' }
      if ($outcome -eq 'dispatched') { exit 0 }
      if ($outcome -eq 'dispatch_unknown') { exit 44 }
      exit 45
    `], { encoding: 'utf8' });
    expect(result.status).toBe(45);
  });

  it('fails closed when ao send --message/--session contract is absent', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-no-file-'));
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

  it('sets reentrancy sentinel while probing ao send --help', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-help-sentinel-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then
  if [[ -z "\${AO_JOURNALED_SEND_INTERNAL:-}" ]]; then exit 88; fi
  cat <<'AO_SEND_HELP_EOF'
Send a message to a running agent session

Usage:
  ao send [flags]

Flags:
  -h, --help             help for send
      --message string   Message body (required)
      --session string   Session id (required)
AO_SEND_HELP_EOF
  exit 0
fi
if [[ -z "\${AO_JOURNALED_SEND_INTERNAL:-}" ]]; then exit 89; fi
message=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    send) shift ;;
    --message) message="$2"; shift 2 ;;
    --session) shift 2 ;;
    *) shift ;;
  esac
done
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
if [[ "$1" == "send" && "$2" == "--help" ]]; then
  cat <<'AO_SEND_HELP_EOF'
Send a message to a running agent session

Usage:
  ao send [flags]

Flags:
  -h, --help             help for send
      --message string   Message body (required)
      --session string   Session id (required)
AO_SEND_HELP_EOF
  exit 0; fi
message=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    send) shift ;;
    --message) message="$2"; shift 2 ;;
    --session) shift 2 ;;
    *) shift ;;
  esac
done
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
if [[ "$1" == "send" && "$2" == "--help" ]]; then
  cat <<'AO_SEND_HELP_EOF'
Send a message to a running agent session

Usage:
  ao send [flags]

Flags:
  -h, --help             help for send
      --message string   Message body (required)
      --session string   Session id (required)
AO_SEND_HELP_EOF
  exit 0; fi
message=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    send) shift ;;
    --message) message="$2"; shift 2 ;;
    --session) shift 2 ;;
    *) shift ;;
  esac
done
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

  it('passes multiline option-shaped payload through --message and stores metadata only', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-file-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    const fileCapture = path.join(dir, 'payload.txt');
    const argvCapture = path.join(dir, 'argv.txt');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then
  cat <<'AO_SEND_HELP_EOF'
Send a message to a running agent session

Usage:
  ao send [flags]

Flags:
  -h, --help             help for send
      --message string   Message body (required)
      --session string   Session id (required)
AO_SEND_HELP_EOF
  exit 0; fi
printf '%s\n' "$@" > "${argvCapture}"
message=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    send) shift ;;
    --message) message="$2"; shift 2 ;;
    --session) shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$message" > "${fileCapture}"
exit 0
`);
    chmodSync(fakeAo, 0o755);
    const payload = `-leading option\n--file embedded flag\nfirst line with spaces /tmp/path with spaces\n${'x'.repeat(230)}\nopk_secret_TOKEN_SHOULD_NOT_LEAK`;
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-SourceKey', 'branch with spaces'], { input: payload, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(readFileSync(fileCapture, 'utf8')).toBe(payload);
    const argvText = readFileSync(argvCapture, 'utf8');
    expect(argvText).toContain('--message');
    expect(argvText).toContain('--session');
    expect(argvText).toContain('opk_secret_TOKEN_SHOULD_NOT_LEAK');
    const journalText = readFileSync(journal, 'utf8');
    expect(journalText).not.toContain('opk_secret_TOKEN_SHOULD_NOT_LEAK');
    expect(journalText).not.toContain('branch with spaces');
    expect(journalText).toContain('"dispatchOutcome":"dispatched"');
    expect(journalText).toContain('"lineCount":5');
  });

  it('uses user-private mechanical transport files and removes them after send', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-private-transport-'));
    const transportRoot = path.join(dir, 'mechanical-transport');
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then
  cat <<'AO_SEND_HELP_EOF'
Send a message to a running agent session

Usage:
  ao send [flags]

Flags:
  -h, --help             help for send
      --message string   Message body (required)
      --session string   Session id (required)
AO_SEND_HELP_EOF
  exit 0; fi
message=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    send) shift ;;
    --message) message="$2"; shift 2 ;;
    --session) shift 2 ;;
    *) shift ;;
  esac
done
exit 0
`);
    chmodSync(fakeAo, 0o755);
    const secret = 'opk_secret_TOKEN_SHOULD_NOT_LEAK';
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-TimeoutSeconds', '5'], {
      input: secret,
      encoding: 'utf8',
      env: { ...process.env, AO_MECHANICAL_TRANSPORT_TEMP: transportRoot },
    });
    expect(result.status).toBe(0);
    const payloadFiles = existsSync(transportRoot)
      ? readdirSync(transportRoot).filter((name: string) => name.endsWith('.payload'))
      : [];
    expect(payloadFiles).toHaveLength(0);
    if (process.platform !== 'win32') {
      const rootMode = statSync(transportRoot).mode & 0o777;
      expect(rootMode).toBe(0o700);
    }
  });

  it('sweeps stale mechanical transport payload files before send', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-stale-transport-'));
    const transportRoot = path.join(dir, 'mechanical-transport');
    mkdirSync(transportRoot, { recursive: true });
    const stalePath = path.join(transportRoot, 'stale.payload');
    const staleSecret = 'opk_secret_STALE_SHOULD_BE_REMOVED';
    writeFileSync(stalePath, staleSecret);
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stalePath, staleTime, staleTime);
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then
  cat <<'AO_SEND_HELP_EOF'
Send a message to a running agent session

Usage:
  ao send [flags]

Flags:
  -h, --help             help for send
      --message string   Message body (required)
      --session string   Session id (required)
AO_SEND_HELP_EOF
  exit 0; fi
message=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    send) shift ;;
    --message) message="$2"; shift 2 ;;
    --session) shift 2 ;;
    *) shift ;;
  esac
done
exit 0
`);
    chmodSync(fakeAo, 0o755);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-TimeoutSeconds', '5'], {
      input: 'fresh payload',
      encoding: 'utf8',
      env: { ...process.env, AO_MECHANICAL_TRANSPORT_TEMP: transportRoot, AO_MECHANICAL_TRANSPORT_MAX_AGE_SECONDS: '3600' },
    });
    expect(result.status).toBe(0);
    expect(existsSync(stalePath)).toBe(false);
    const remaining = readdirSync(transportRoot).filter((name: string) => name.endsWith('.payload'));
    expect(remaining).toHaveLength(0);
  });

  it('does not sweep stale mechanical-node exchange files during payload cleanup', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-stale-exchange-'));
    const transportRoot = path.join(dir, 'mechanical-transport');
    mkdirSync(transportRoot, { recursive: true });
    const staleExchange = path.join(transportRoot, 'stale.in.json');
    writeFileSync(staleExchange, '{"keep":true}');
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(staleExchange, staleTime, staleTime);
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then
  cat <<'AO_SEND_HELP_EOF'
Send a message to a running agent session

Usage:
  ao send [flags]

Flags:
  -h, --help             help for send
      --message string   Message body (required)
      --session string   Session id (required)
AO_SEND_HELP_EOF
  exit 0; fi
message=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    send) shift ;;
    --message) message="$2"; shift 2 ;;
    --session) shift 2 ;;
    *) shift ;;
  esac
done
exit 0
`);
    chmodSync(fakeAo, 0o755);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-TimeoutSeconds', '5'], {
      input: 'fresh payload',
      encoding: 'utf8',
      env: { ...process.env, AO_MECHANICAL_TRANSPORT_TEMP: transportRoot, AO_MECHANICAL_TRANSPORT_MAX_AGE_SECONDS: '3600' },
    });
    expect(result.status).toBe(0);
    expect(existsSync(staleExchange)).toBe(true);
    expect(readFileSync(staleExchange, 'utf8')).toContain('keep');
  });

  it('fails closed when post-send outcome update cannot be recorded', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-update-fail-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then
  cat <<'AO_SEND_HELP_EOF'
Send a message to a running agent session

Usage:
  ao send [flags]

Flags:
  -h, --help             help for send
      --message string   Message body (required)
      --session string   Session id (required)
AO_SEND_HELP_EOF
  exit 0; fi
message=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    send) shift ;;
    --message) message="$2"; shift 2 ;;
    --session) shift 2 ;;
    *) shift ;;
  esac
done
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
if [[ "$1" == "send" && "$2" == "--help" ]]; then
  cat <<'AO_SEND_HELP_EOF'
Send a message to a running agent session

Usage:
  ao send [flags]

Flags:
  -h, --help             help for send
      --message string   Message body (required)
      --session string   Session id (required)
AO_SEND_HELP_EOF
  exit 0; fi
message=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    send) shift ;;
    --message) message="$2"; shift 2 ;;
    --session) shift 2 ;;
    *) shift ;;
  esac
done
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




  it('ao send help probe trap', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-help-trap-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, `#!/usr/bin/env bash
if [[ "$1" == "send" && "$2" == "--help" ]]; then
  echo "Usage: ao [command]"
  echo "Available Commands:"
  exit 0
fi
exit 99
`);
    chmodSync(fakeAo, 0o755);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal], { input: 'payload', encoding: 'utf8' });
    expect(result.status).toBe(42);
    expect(`${result.stdout}${result.stderr}`).toMatch(/ao send --message\/--session contract is unavailable/i);
    expect(existsSync(journal)).toBe(false);
  });


  it('rejects argv-budget overflow well below legacy 1.5 MiB guard', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-argv-budget-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, buildAoSend0102Stub({ onSendBody: 'exit 0' }));
    chmodSync(fakeAo, 0o755);
    const payload = 'x'.repeat(33000);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-TimeoutSeconds', '5'], { input: payload, encoding: 'utf8', timeout: 60000 });
    expect(result.status).toBe(45);
    expect(`${result.stdout}${result.stderr}`).toMatch(/inline message exceeds argv budget/i);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/exception_before_send/i);
    expect(readFileSync(journal, 'utf8')).toContain('"dispatchOutcome":"send_failed"');
  });

  it('fails closed before ao send when inline message exceeds argv budget', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'journaled-send-oversized-'));
    const fakeAo = path.join(dir, 'ao');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(fakeAo, buildAoSend0102Stub({ onSendBody: 'exit 0' }));
    chmodSync(fakeAo, 0o755);
    const payload = 'x'.repeat(33000);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/journaled-worker-send.ps1', '-SessionId', 'worker one', '-AoPath', fakeAo, '-JournalPath', journal, '-TimeoutSeconds', '5'], { input: payload, encoding: 'utf8', timeout: 60000 });
    expect(result.status).toBe(45);
    expect(`${result.stdout}${result.stderr}`).toMatch(/inline message exceeds argv budget/i);
    expect(readFileSync(journal, 'utf8')).toContain('"dispatchOutcome":"send_failed"');
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
      'if [[ "$1" == "send" && "${2:-}" == "--help" ]]; then cat <<\'AO_SEND_HELP_EOF\'',
            'Send a message to a running agent session',
      '',
      'Usage:',
      '  ao send [flags]',
      '',
      'Flags:',
      '  -h, --help             help for send',
      '      --message string   Message body (required)',
      '      --session string   Session id (required)',
      'AO_SEND_HELP_EOF',
      'exit 0; fi',
      'if [[ "$1" != "send" ]]; then exit 64; fi',
      'message=""',
      'while [[ $# -gt 0 ]]; do',
      '  case "$1" in',
      '    send) shift ;;',
      '    --message) message="$2"; shift 2 ;;',
      '    --session) shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      `printf "%s" "$message" | pwsh -NoProfile -File '${wrapperPath}' -SessionId synthetic-adoption-probe -AoPath "$0"`,
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
    writeFileSync(fakeAo, '#!/usr/bin/env bash\nif [[ "$1" == "send" ]]; then exit 0; fi\nexit 64\n');
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
      'if [[ "$1" == "send" && "${2:-}" == "--help" ]]; then cat <<\'AO_SEND_HELP_EOF\'',
            'Send a message to a running agent session',
      '',
      'Usage:',
      '  ao send [flags]',
      '',
      'Flags:',
      '  -h, --help             help for send',
      '      --message string   Message body (required)',
      '      --session string   Session id (required)',
      'AO_SEND_HELP_EOF',
      'exit 0; fi',
      'if [[ "$1" != "send" ]]; then exit 64; fi',
      'message=""',
      'while [[ $# -gt 0 ]]; do',
      '  case "$1" in',
      '    send) shift ;;',
      '    --message) message="$2"; shift 2 ;;',
      '    --session) shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      `printf "%s" "$message" | pwsh -NoProfile -File '${wrapperPath}' -SessionId synthetic-adoption-probe -AoPath "$0"`,
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

describe('issue #373 vanish and worktree-drift handling', () => {
  it('escalates when a tracked non-terminal delivery vanishes from all sources', () => {
    const id = 'opk-vanish:1717601000000:ao-send:gone';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-vanish', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', reports: [] }],
      dispatchJournal: {},
      tracking: {
        deliveries: {
          [id]: {
            deliveryId: id,
            sessionId: 'opk-vanish',
            source: DISPATCH_SOURCE_AO_SEND,
            firstObservedAtMs: 1717601000000,
            deliveredAtMs: 1717601000000,
          },
        },
        audit: [],
      },
      nowMs: 1717602000000,
    });
    expect((actions.find((a: WorkerMessageSubmitAction) => a.type === 'escalate' && a.deliveryId === id) as Extract<WorkerMessageSubmitAction, { type: 'escalate' }> | undefined)?.reason).toBe('delivery_vanished');
  });

  it('suppresses vanish escalation for proven worktree drift on review-send', () => {
    const id = 'opk-drift:review-send:run-1';
    const targetSha = 'abc123def4567890abcdef1234567890abcdef12';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-drift', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', ownedHeadSha: 'fedcba0987654321fedcba0987654321fedcba09', reports: [] }],
      dispatchJournal: {},
      reviewRuns: [{ id: 'run-1', prNumber: 42, targetSha, status: 'outdated', linkedSessionId: 'opk-drift' }],
      tracking: {
        deliveries: {
          [id]: {
            deliveryId: id,
            sessionId: 'opk-drift',
            source: DISPATCH_SOURCE_REVIEW_SEND,
            reviewRunId: 'run-1',
            prNumber: 42,
            headSha: targetSha,
            firstObservedAtMs: 1717601000000,
          },
        },
        audit: [],
      },
      nowMs: 1717602000000,
    });
    expect(actions.find((a: WorkerMessageSubmitAction) => a.type === 'escalate' && a.deliveryId === id)).toBeUndefined();
    expect((actions.find((a: WorkerMessageSubmitAction) => a.type === 'noop' && a.deliveryId === id) as Extract<WorkerMessageSubmitAction, { type: 'noop' }> | undefined)?.reason).toBe('proven_worktree_drift');
  });

  it('uses exact reviewRunId when multiple runs exist for the same PR', () => {
    const targetSha = 'abc123def4567890abcdef1234567890abcdef12';
    const drift = evaluateWorktreeDriftVanishSuppression({
      record: {
        source: DISPATCH_SOURCE_REVIEW_SEND,
        reviewRunId: 'run-old',
        headSha: targetSha,
        prNumber: 42,
        sessionId: 'opk-drift',
      },
      reviewRuns: [
        { id: 'run-new', prNumber: 42, targetSha, status: 'waiting_update', linkedSessionId: 'opk-drift' },
        { id: 'run-old', prNumber: 42, targetSha, status: 'outdated', linkedSessionId: 'opk-drift' },
      ],
      sessions: [{ sessionId: 'opk-drift', ownedHeadSha: 'fedcba0987654321fedcba0987654321fedcba09' }],
    });
    expect(drift.suppress).toBe(true);
    expect(drift.reason).toBe('proven_worktree_drift');
  });

  it('persists delivery source from ensureTrackingSeed before vanished drift evaluation', () => {
    const targetSha = 'abc123def4567890abcdef1234567890abcdef12';
    const tick1 = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-drift', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', reports: [] }],
      reviewRuns: [{ id: 'run-seed', prNumber: 42, targetSha, status: 'waiting_update', linkedSessionId: 'opk-drift', sentFindingCount: 1 }],
      dispatchJournal: {},
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601000000,
    });
    const deliveries = tick1.tracking?.deliveries ?? {};
    const deliveryId = Object.keys(deliveries)[0];
    expect(deliveryId).toBeTruthy();
    expect(deliveries[deliveryId]?.source).toBe(DISPATCH_SOURCE_REVIEW_SEND);
    const tick2 = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-drift', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', ownedHeadSha: 'fedcba0987654321fedcba0987654321fedcba09', reports: [] }],
      reviewRuns: [{ id: 'run-seed', prNumber: 42, targetSha, status: 'outdated', linkedSessionId: 'opk-drift' }],
      dispatchJournal: {},
      tracking: tick1.tracking,
      nowMs: 1717602000000,
    });
    expect(tick2.actions.find((a: WorkerMessageSubmitAction) => a.type === 'escalate' && a.deliveryId === deliveryId)).toBeUndefined();
    expect((tick2.actions.find((a: WorkerMessageSubmitAction) => a.type === 'noop' && a.deliveryId === deliveryId) as Extract<WorkerMessageSubmitAction, { type: 'noop' }> | undefined)?.reason).toBe('proven_worktree_drift');
  });


  it('does not re-emit vanished handling for terminal noop deliveries', () => {
    const targetSha = 'abc123def4567890abcdef1234567890abcdef12';
    const tick1 = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-drift', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', reports: [] }],
      reviewRuns: [{ id: 'run-seed', prNumber: 42, targetSha, status: 'waiting_update', linkedSessionId: 'opk-drift', sentFindingCount: 1 }],
      dispatchJournal: {},
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601000000,
    });
    const deliveries = tick1.tracking?.deliveries ?? {};
    const deliveryId = Object.keys(deliveries)[0];
    const tick2 = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-drift', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', ownedHeadSha: 'fedcba0987654321fedcba0987654321fedcba09', reports: [] }],
      reviewRuns: [{ id: 'run-seed', prNumber: 42, targetSha, status: 'outdated', linkedSessionId: 'opk-drift' }],
      dispatchJournal: {},
      tracking: tick1.tracking,
      nowMs: 1717602000000,
    });
    expect((tick2.actions.find((a: WorkerMessageSubmitAction) => a.type === 'noop' && a.deliveryId === deliveryId) as Extract<WorkerMessageSubmitAction, { type: 'noop' }> | undefined)?.reason).toBe('proven_worktree_drift');
    const tick3 = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-drift', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', ownedHeadSha: 'fedcba0987654321fedcba0987654321fedcba09', reports: [] }],
      reviewRuns: [{ id: 'run-seed', prNumber: 42, targetSha, status: 'outdated', linkedSessionId: 'opk-drift' }],
      dispatchJournal: {},
      tracking: tick2.tracking,
      nowMs: 1717603000000,
    });
    expect(tick3.actions.filter((a: WorkerMessageSubmitAction) => a.deliveryId === deliveryId)).toHaveLength(0);
  });

  it('does not submit when a drift-suppressed noop delivery reappears', () => {
    const targetSha = 'abc123def4567890abcdef1234567890abcdef12';
    const tick1 = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-drift', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', reports: [] }],
      reviewRuns: [{ id: 'run-seed', prNumber: 42, targetSha, status: 'waiting_update', linkedSessionId: 'opk-drift', sentFindingCount: 1 }],
      dispatchJournal: {},
      tracking: { deliveries: {}, audit: [] },
      nowMs: 1717601000000,
    });
    const deliveries = tick1.tracking?.deliveries ?? {};
    const deliveryId = Object.keys(deliveries)[0];
    const tick2 = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-drift', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', ownedHeadSha: 'fedcba0987654321fedcba0987654321fedcba09', reports: [] }],
      reviewRuns: [{ id: 'run-seed', prNumber: 42, targetSha, status: 'outdated', linkedSessionId: 'opk-drift' }],
      dispatchJournal: {},
      tracking: tick1.tracking,
      nowMs: 1717602000000,
    });
    expect(tick2.tracking?.deliveries?.[deliveryId]?.terminalState).toBe('noop');
    const tick3 = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-drift', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', ownedHeadSha: 'fedcba0987654321fedcba0987654321fedcba09', reports: [] }],
      reviewRuns: [{ id: 'run-seed', prNumber: 42, targetSha, status: 'waiting_update', linkedSessionId: 'opk-drift', sentFindingCount: 1 }],
      dispatchJournal: {},
      tracking: tick2.tracking,
      nowMs: 1717603000000,
    });
    expect(tick3.actions.filter((a: WorkerMessageSubmitAction) => a.type === 'submit' && a.deliveryId === deliveryId)).toHaveLength(0);
    expect((tick3.actions.find((a: WorkerMessageSubmitAction) => a.type === 'noop' && a.deliveryId === deliveryId) as Extract<WorkerMessageSubmitAction, { type: 'noop' }> | undefined)?.reason).toBe('terminal_state');
  });

  it('escalates ambiguous when drift evidence is missing', () => {
    const id = 'opk-drift:review-send:ambiguous';
    const targetSha = 'abc123def4567890abcdef1234567890abcdef12';
    const drift = evaluateWorktreeDriftVanishSuppression({
      record: { source: DISPATCH_SOURCE_REVIEW_SEND, headSha: targetSha, prNumber: 42, sessionId: 'opk-drift' },
      reviewRuns: [],
      sessions: [{ sessionId: 'opk-drift', ownedHeadSha: 'fedcba0987654321fedcba0987654321fedcba09' }],
    });
    expect(drift.suppress).toBe(false);
    expect(drift.reason).toBe('ambiguous_missing_drift_evidence');
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-drift', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', reports: [] }],
      dispatchJournal: {},
      reviewRuns: [],
      tracking: {
        deliveries: {
          [id]: {
            deliveryId: id,
            sessionId: 'opk-drift',
            source: DISPATCH_SOURCE_REVIEW_SEND,
            prNumber: 42,
            headSha: targetSha,
            firstObservedAtMs: 1717601000000,
          },
        },
        audit: [],
      },
      nowMs: 1717602000000,
    });
    expect((actions.find((a: WorkerMessageSubmitAction) => a.type === 'escalate' && a.deliveryId === id) as Extract<WorkerMessageSubmitAction, { type: 'escalate' }> | undefined)?.reason).toBe('delivery_vanished_ambiguous');
  });
});

describe('issue #373 supervised adoption preflight', () => {
  it('records wrapper_not_adopted as telemetry without blocking reconcile', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-adoption-'));
    const journal = path.join(dir, 'journal.json');
    const state = path.join(dir, 'state.json');
    writeFileSync(journal, JSON.stringify({}));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-IntervalSeconds', '1', '-StateFile', state, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-live',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/live.yaml',
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('wrapper_not_adopted');
    expect(result.stdout).toContain('tick complete');
    expect(result.stdout).not.toContain('tick blocked');
    const tracking = JSON.parse(readFileSync(state, 'utf8')) as Record<string, unknown>;
    expect(tracking.adoptionStatus).toBe('wrapper_not_adopted');
  });


  it('does not surface wrapper_not_adopted through the supervised tick_error channel', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-adoption-tick-error-'));
    const journal = path.join(dir, 'journal.json');
    const state = path.join(dir, 'state.json');
    const progressDir = path.join(dir, 'progress');
    mkdirSync(progressDir);
    writeFileSync(journal, JSON.stringify({}));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-IntervalSeconds', '1', '-StateFile', state, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_SIDE_PROCESS_PROGRESS_DIR: progressDir,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-tick-error',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/tick-error.yaml',
      },
    });
    expect(result.status).toBe(0);
    const progress = JSON.parse(readFileSync(path.join(progressDir, 'worker-message-submit-reconcile.progress.json'), 'utf8')) as Record<string, unknown>;
    expect(progress.tickOutcome).toBe('success');
  });

  it('does not mint adoption escalation per epoch/config while reconcile continues', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-adoption-dedupe-'));
    const journal = path.join(dir, 'journal.json');
    const state = path.join(dir, 'state.json');
    writeFileSync(journal, JSON.stringify({}));
    const env = {
      ...process.env,
      AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-dedupe',
      AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/dedupe.yaml',
    };
    const fakeAoDir = writeFakeAoCli(dir);
    const envWithAo = { ...env, PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}` };
    const first = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1', '-Once', '-IntervalSeconds', '1', '-StateFile', state, '-DispatchJournalPath', journal], { encoding: 'utf8', env: envWithAo });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    const second = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1', '-Once', '-IntervalSeconds', '1', '-StateFile', state, '-DispatchJournalPath', journal], { encoding: 'utf8', env: envWithAo });
    const escalationMatches = (output: string) => (output.match(/ESCALATION: wrapper_not_adopted/g) ?? []).length;
    expect(escalationMatches(first.stdout)).toBe(1);
    expect(escalationMatches(second.stdout)).toBe(0);
    expect(first.stdout).toContain('tick complete');
    expect(second.stdout).toContain('tick complete');
  });

  it('allows Enter for review-send deliveries when adoption is red', () => {
    const id = 'opk-review:1717601000000:review-send:run-1';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{ sessionId: 'opk-review', name: 'opk-review', role: 'worker', status: 'working', runtime: 'alive', activity: 'idle', reports: [] }],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-review',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_REVIEW_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: {
        deliveries: {},
        audit: [],
        adoptionStatus: 'wrapper_not_adopted',
      },
      nowMs: 1717601010000,
    });
    expect(submitActions(actions)).toHaveLength(1);
  });
});


  it('binds adoption epoch to the AO running.json instance when env override is absent', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adoption-binding-running-json-'));
    const runningDir = path.join(dir, 'agent-orchestrator');
    mkdirSync(runningDir, { recursive: true });
    const runningPath = path.join(runningDir, 'running.json');
    writeFileSync(runningPath, JSON.stringify({
      pid: 424242,
      configPath: '/cfg/from-running.json',
      startedAt: '2026-06-20T12:34:56.789Z',
    }));
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', `
      . '${path.resolve('scripts/lib/Get-WorkerMessageAdoptionBinding.ps1').replace(/'/g, "''")}'
      $env:AO_AGENT_ORCHESTRATOR_STATE_DIR = '${runningDir.replace(/'/g, "''")}'
      Remove-Item Env:AO_WORKER_MESSAGE_ADOPTION_EPOCH -ErrorAction SilentlyContinue
      Remove-Item Env:AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH -ErrorAction SilentlyContinue
      $binding = Get-WorkerMessageAdoptionBinding -PackRoot '${path.resolve('.').replace(/'/g, "''")}'
      @{ AoEpoch = $binding.AoEpoch; ConfigPath = $binding.ConfigPath } | ConvertTo-Json -Compress
    `], { encoding: 'utf8', cwd: process.cwd() });
    expect(result.status).toBe(0);
    const binding = JSON.parse(result.stdout.trim()) as { AoEpoch: string; ConfigPath: string };
    expect(binding.AoEpoch).toBe('2026-06-20T12:34:56.789Z|424242|/cfg/from-running.json');
    expect(binding.ConfigPath).toBe('/cfg/from-running.json');
  });


describe('ao send transport contract (Issue #373)', () => {
  it('confirms committed capture-backed evidence documents AO 0.10.2 inline send flags', () => {
    const evidencePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs/ao-send-transport-contract.txt');
    expect(existsSync(evidencePath)).toBe(true);
    const text = readFileSync(evidencePath, 'utf8');
    expect(text).toContain('Issue #640');
    expect(text).toMatch(/--message/i);
    expect(text).toMatch(/--session/i);
    expect(text).toMatch(/ao send \[flags\]/i);
  });
});

describe('issue #373 state-root identity quarantine', () => {
  it('fails closed when active deliveries survive a mismatched state root', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-state-root-'));
    const state = path.join(dir, 'state.json');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(journal, JSON.stringify({}));
    writeFileSync(state, JSON.stringify({
      stateRootIdentity: 'stale-identity-hash',
      deliveries: {
        'delivery-1': {
          deliveryId: 'delivery-1',
          sessionId: 'opk-test',
          firstObservedAtMs: 1717601000000,
        },
      },
      audit: [],
    }));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-StateFile', state, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-new',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/new.yaml',
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}
${result.stderr}`).toMatch(/wrong_state_root_active_deliveries|STATE FENCES UNTRUSTED/i);
  });

  it('rebinds identity on epoch change when only terminal deliveries remain', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-state-root-'));
    const state = path.join(dir, 'state.json');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(journal, JSON.stringify({}));
    writeFileSync(state, JSON.stringify({
      stateRootIdentity: 'stale-identity-hash',
      deliveries: {
        'delivery-1': {
          deliveryId: 'delivery-1',
          sessionId: 'opk-test',
          terminalState: 'submitted',
          firstObservedAtMs: 1717601000000,
        },
      },
      audit: [],
    }));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-StateFile', state, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-new',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/new.yaml',
      },
    });
    expect(result.status).toBe(0);
    const persisted = JSON.parse(readFileSync(state, 'utf8')) as SubmitTrackingState;
    expect(persisted.stateRootIdentity).toBeTruthy();
    expect(persisted.stateRootIdentity).not.toBe('stale-identity-hash');
  });

  it('rebinds identity on epoch change when compacted state has no deliveries', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-state-root-empty-'));
    const state = path.join(dir, 'state.json');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(journal, JSON.stringify({}));
    writeFileSync(state, JSON.stringify({
      stateRootIdentity: 'stale-identity-hash',
      deliveries: {},
      audit: [],
      lastTickMs: 1717601000000,
    }));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-StateFile', state, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-new',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/new.yaml',
      },
    });
    expect(result.status).toBe(0);
    const persisted = JSON.parse(readFileSync(state, 'utf8')) as SubmitTrackingState;
    expect(persisted.stateRootIdentity).toBeTruthy();
    expect(persisted.stateRootIdentity).not.toBe('stale-identity-hash');
  });


  it('fails closed when a new empty state file abandons anchored active deliveries', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-anchor-abandon-'));
    const journal = path.join(dir, 'journal.json');
    const stateA = path.join(dir, 'state-a.json');
    const stateB = path.join(dir, 'state-b.json');
    const anchor = path.join(dir, 'worker-message-submit-state-root.anchor.json');
    writeFileSync(journal, JSON.stringify({}));
    writeFileSync(stateA, JSON.stringify({
      stateRootIdentity: 'identity-bound-to-state-a',
      deliveries: {
        'delivery-1': {
          deliveryId: 'delivery-1',
          sessionId: 'opk-test',
          firstObservedAtMs: 1717601000000,
        },
      },
      audit: [],
    }));
    writeFileSync(anchor, JSON.stringify({
      stateRootIdentity: 'identity-bound-to-state-a',
      statePath: stateA,
      activeDeliveryCount: 1,
      updatedAtMs: 1717601000000,
    }));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-StateFile', stateB, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-live',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/live.yaml',
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}
${result.stderr}`).toMatch(/wrong_state_root_active_deliveries|STATE FENCES UNTRUSTED/i);
  });

  it('fails closed when effective CLI state path changes under active deliveries', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-state-root-'));
    const stateA = path.join(dir, 'state-a.json');
    const stateB = path.join(dir, 'state-b.json');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(journal, JSON.stringify({}));
    const payload = {
      stateRootIdentity: 'identity-bound-to-state-a',
      deliveries: {
        'delivery-1': {
          deliveryId: 'delivery-1',
          sessionId: 'opk-test',
          firstObservedAtMs: 1717601000000,
        },
      },
      audit: [],
    };
    writeFileSync(stateA, JSON.stringify(payload));
    writeFileSync(stateB, JSON.stringify(payload));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-StateFile', stateB, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-live',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/live.yaml',
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}
${result.stderr}`).toMatch(/wrong_state_root_active_deliveries|STATE FENCES UNTRUSTED/i);
  });
});

describe('issue #373 state-root quarantine re-seat', () => {
  const recoveryLatch = {
    fenceTrusted: false,
    reason: STATE_ROOT_RECOVERY_REASON,
    quarantined: '/tmp/state.json',
  };

  it('is eligible when prior-epoch deliveries are terminal and journal is resolved', () => {
    const result = evaluateStateRootReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {
          'opk-25:1717601000000:ao-send:orphan': {
            deliveryId: 'opk-25:1717601000000:ao-send:orphan',
            terminalState: 'escalated',
            escalationReason: 'delivery_vanished',
          },
        },
      },
      journal: {},
      anchor: { activeDeliveryCount: 1, stateRootIdentity: 'stale-anchor' },
    });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('prior_epoch_work_terminal');
  });

  it('remains eligible when escalated delivery keeps unresolved failed-delivery record', () => {
    const deliveryId = 'opk-25:1717601000000:ao-send:orphan';
    const result = evaluateStateRootReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {
          [deliveryId]: {
            deliveryId,
            terminalState: 'escalated',
            escalationReason: 'delivery_vanished',
            failedDelivery: {
              deliveryId,
              unresolvedState: 'unresolved',
              reason: 'delivery_vanished',
            },
          },
        },
        failedDeliveries: {
          [deliveryId]: {
            deliveryId,
            unresolvedState: 'unresolved',
            reason: 'delivery_vanished',
          },
        },
      },
      journal: {},
      anchor: { activeDeliveryCount: 1, stateRootIdentity: 'stale-anchor' },
    });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('prior_epoch_work_terminal');
  });

  it('blocks re-seat when unresolved failed delivery has no terminal delivery record', () => {
    const result = evaluateStateRootReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {},
        failedDeliveries: {
          'orphan-failed': {
            deliveryId: 'orphan-failed',
            unresolvedState: 'unresolved',
            reason: 'delivery_vanished',
          },
        },
      },
      journal: {},
      anchor: { activeDeliveryCount: 0 },
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('unresolved_failed_delivery');
  });

  it('blocks re-seat when journal still has unresolved pending-draft records', () => {
    const result = evaluateStateRootReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {},
      },
      journal: {
        'pending-delivery': {
          deliveryId: 'pending-delivery',
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          fenceLifecycle: 'pending',
          dispatchOutcome: 'dispatched',
        },
      },
      anchor: { activeDeliveryCount: 0 },
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('unresolved_journal_entry');
  });

  it('blocks re-seat when a tracked delivery is still non-terminal', () => {
    const result = evaluateStateRootReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {
          live: { deliveryId: 'live', sessionId: 'opk-live' },
        },
      },
      journal: {},
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('unresolved_state_delivery');
  });

  it('blocks re-seat when anchor still reports active work without terminal evidence', () => {
    const result = evaluateStateRootReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {},
      },
      journal: {},
      anchor: { activeDeliveryCount: 1, stateRootIdentity: 'stale-anchor' },
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('anchor_active_without_terminal_evidence');
  });

  it('reclaims stale orphan-anchor when no state or journal deliveries corroborate active work', () => {
    const nowMs = 1717603000000;
    const result = callReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {},
        failedDeliveries: {},
      },
      journal: {},
      anchor: {
        activeDeliveryCount: 1,
        stateRootIdentity: 'stale-anchor',
        updatedAtMs: nowMs - DEFAULT_DELIVERY_BACKSTOP_MS - 1,
      },
      nowMs,
    });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('orphan_anchor_quarantine');
    expect(result.evidence).toContain('stateActiveDeliveryCount=0');
    expect(result.evidence).toContain('corroboratingJournalDeliveryCount=0');
  });

  it('reclaims stale orphan-anchor when only terminal state deliveries remain', () => {
    const nowMs = 1717603000000;
    const result = callReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {
          terminal: { deliveryId: 'terminal', sessionId: 'opk-terminal', terminalState: 'submitted' },
        },
        failedDeliveries: {},
      },
      journal: {},
      anchor: {
        activeDeliveryCount: 2,
        stateRootIdentity: 'stale-anchor',
        updatedAtMs: nowMs - DEFAULT_DELIVERY_BACKSTOP_MS - 1,
      },
      nowMs,
    });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('orphan_anchor_quarantine');
  });

  it('blocks re-seat for fresh orphan-looking anchor until the backstop expires', () => {
    const nowMs = 1717603000000;
    const result = callReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {},
        failedDeliveries: {},
      },
      journal: {},
      anchor: {
        activeDeliveryCount: 1,
        stateRootIdentity: 'fresh-anchor',
        updatedAtMs: nowMs - DEFAULT_DELIVERY_BACKSTOP_MS + 1,
      },
      nowMs,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('anchor_active_without_terminal_evidence');
  });

  it('blocks stale anchor reclaim when the anchor backing state still has an active delivery', () => {
    const nowMs = 1717603000000;
    const result = callReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {},
        failedDeliveries: {},
      },
      journal: {},
      anchor: {
        activeDeliveryCount: 1,
        stateRootIdentity: 'stale-anchor',
        statePath: '/tmp/old-state.json',
        updatedAtMs: nowMs - DEFAULT_DELIVERY_BACKSTOP_MS - 1,
      },
      anchorState: {
        deliveries: {
          live: { deliveryId: 'live', sessionId: 'opk-live' },
        },
      },
      nowMs,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('anchor_active_without_terminal_evidence');
  });

  it('blocks re-seat when anchor active count exceeds terminal delivery evidence', () => {
    const result = evaluateStateRootReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {
          'delivery-one': {
            deliveryId: 'delivery-one',
            terminalState: 'escalated',
            escalationReason: 'delivery_vanished',
          },
        },
      },
      journal: {},
      anchor: { activeDeliveryCount: 2, stateRootIdentity: 'stale-anchor' },
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('anchor_active_without_terminal_evidence');
    expect(result.evidence).toContain('anchorActiveDeliveryCount=2');
    expect(result.evidence).toContain('terminalEvidenceCount=1');
  });

  it('blocks re-seat when only failed-uncertain journal entries exist for anchor', () => {
    const result = evaluateStateRootReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {},
      },
      journal: {
        'unrelated-delivery': {
          deliveryId: 'unrelated-delivery',
          fenceLifecycle: 'failed-uncertain',
          dispatchOutcome: 'dispatched',
        },
      },
      anchor: { activeDeliveryCount: 1, stateRootIdentity: 'stale-anchor' },
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('anchor_active_without_terminal_evidence');
  });

  it('reclaims stale orphan-anchor when completed journal entries are the only journal records', () => {
    const nowMs = 1717603000000;
    const result = callReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {},
      },
      journal: {
        'unrelated-delivery': {
          deliveryId: 'unrelated-delivery',
          fenceLifecycle: 'completed',
          dispatchOutcome: 'dispatched',
        },
      },
      anchor: {
        activeDeliveryCount: 1,
        stateRootIdentity: 'stale-anchor',
        updatedAtMs: nowMs - DEFAULT_DELIVERY_BACKSTOP_MS - 1,
      },
      nowMs,
    });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('orphan_anchor_quarantine');
    expect(result.evidence).toContain('corroboratingJournalDeliveryCount=0');
  });

  it('is eligible for persisted wrong-root recovery when deliveries are empty and anchor is absent', () => {
    const result = evaluateStateRootReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {},
        failedDeliveries: {},
      },
      journal: {},
      anchor: null,
    });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('empty_root_quarantine');
    expect(result.evidence).toBe('anchor_absent');
  });

  it('is eligible for persisted wrong-root recovery when anchor reports no active deliveries', () => {
    const result = evaluateStateRootReSeatEligibility({
      state: {
        _recovery: recoveryLatch,
        deliveries: {},
        failedDeliveries: {},
      },
      journal: {},
      anchor: { activeDeliveryCount: 0, stateRootIdentity: 'stale-anchor' },
    });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('empty_root_quarantine');
    expect(result.evidence).toBe('anchor_active_delivery_count_zero');
  });

  it('clears latched recovery and stamps identity with an audit record', () => {
    const nowMs = 1717603000000;
    const result = evaluateStateRootReSeat({
      state: {
        _recovery: recoveryLatch,
        stateRootIdentity: 'stale-identity',
        deliveries: {
          'delivery-terminal': { deliveryId: 'delivery-terminal', terminalState: 'escalated' },
        },
        audit: [],
      },
      journal: {},
      anchor: { activeDeliveryCount: 1 },
      identity: 'fresh-identity',
      nowMs,
    });
    expect(result.eligible).toBe(true);
    expect((result.state as SubmitTrackingState)._recovery).toBeUndefined();
    expect(result.state.stateRootIdentity).toBe('fresh-identity');
    const audit = (result.state as SubmitTrackingState).audit ?? [];
    expect(audit.some((row) => row.action === 'state_root_reseat' && row.priorRecoveryReason === STATE_ROOT_RECOVERY_REASON)).toBe(true);
  });

  it('re-seats empty-root quarantine after terminal recovery', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-empty-root-reseat-'));
    const journal = path.join(dir, 'journal.json');
    const stateA = path.join(dir, 'state-a.json');
    const stateB = path.join(dir, 'state-b.json');
    const anchor = path.join(dir, 'worker-message-submit-state-root.anchor.json');
    const deliveryId = 'opk-empty-root:1717601000000:ao-send:orphan';
    writeFileSync(journal, JSON.stringify({}));
    writeFileSync(stateA, JSON.stringify({
      stateRootIdentity: 'identity-bound-to-state-a',
      deliveries: {
        'delivery-1': {
          deliveryId: 'delivery-1',
          sessionId: 'opk-test',
          firstObservedAtMs: 1717601000000,
        },
      },
      audit: [],
    }));
    writeFileSync(anchor, JSON.stringify({
      stateRootIdentity: 'identity-bound-to-state-a',
      statePath: stateA,
      activeDeliveryCount: 1,
      updatedAtMs: 1717601000000,
    }));
    writeFileSync(stateB, JSON.stringify({
      _recovery: {
        fenceTrusted: false,
        reason: 'wrong_state_root_active_deliveries',
        quarantined: stateB,
      },
      deliveries: {
        [deliveryId]: {
          deliveryId,
          sessionId: 'opk-empty-root',
          source: DISPATCH_SOURCE_AO_SEND,
          terminalState: 'escalated',
          escalationReason: 'delivery_vanished',
          firstObservedAtMs: 1717601000000,
        },
      },
      audit: [],
    }));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-StateFile', stateB, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-new',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/new.yaml',
      },
    });
    expect(result.status).toBe(0);
    const persisted = JSON.parse(readFileSync(stateB, 'utf8')) as SubmitTrackingState & { _recovery?: unknown };
    expect(persisted._recovery).toBeUndefined();
    expect(persisted.stateRootIdentity).toBeTruthy();
    expect(persisted.stateRootIdentity).not.toBe('identity-bound-to-state-a');
    expect((persisted.audit ?? []).some((row) => row.action === 'state_root_reseat')).toBe(true);
    expect(`${result.stdout}
${result.stderr}`).toMatch(/state-root re-seat/i);
  });

  it('self-heals persisted empty-root quarantine without pressing Enter', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-empty-latch-'));
    const state = path.join(dir, 'state.json');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(journal, JSON.stringify({}));
    writeFileSync(state, JSON.stringify({
      _recovery: {
        fenceTrusted: false,
        reason: 'wrong_state_root_active_deliveries',
        quarantined: state,
      },
      adoptionStatus: 'wrapper_not_adopted',
      deliveries: {},
      failedDeliveries: {},
      audit: [],
      lastTickMs: null,
    }));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-StateFile', state, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-new',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/new.yaml',
      },
    });
    expect(result.status).toBe(0);
    const persisted = JSON.parse(readFileSync(state, 'utf8')) as SubmitTrackingState & { _recovery?: unknown };
    expect(persisted._recovery).toBeUndefined();
    expect(persisted.stateRootIdentity).toBeTruthy();
    expect(persisted.lastTickMs).toBeGreaterThan(0);
    expect((persisted.audit ?? []).some((row) => row.action === 'state_root_reseat' && row.reason === 'empty_root_quarantine')).toBe(true);
    expect(`${result.stdout}
${result.stderr}`).toMatch(/state-root re-seat/i);
    expect(`${result.stdout}
${result.stderr}`).not.toMatch(/submitted:/i);
  });

  it('self-heals live orphan-anchor latch from AO side-process state dir', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-live-orphan-anchor-'));
    const state = path.join(dir, 'state.json');
    const journal = path.join(dir, 'journal.json');
    const sideProcessStateDir = path.join(dir, 'side-process');
    const anchor = path.join(sideProcessStateDir, 'worker-message-submit-state-root.anchor.json');
    mkdirSync(sideProcessStateDir);
    writeFileSync(journal, JSON.stringify({}));
    writeFileSync(anchor, JSON.stringify({
      stateRootIdentity: 'stale-anchor-identity',
      statePath: state,
      activeDeliveryCount: 1,
      updatedAtMs: 1717603000000 - DEFAULT_DELIVERY_BACKSTOP_MS - 1,
    }));
    writeFileSync(state, JSON.stringify({
      _recovery: {
        fenceTrusted: false,
        reason: 'wrong_state_root_active_deliveries',
        quarantined: state,
      },
      deliveries: {},
      failedDeliveries: {},
      audit: [],
      lastTickMs: null,
    }));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-StateFile', state, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_SIDE_PROCESS_STATE_DIR: sideProcessStateDir,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-new',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/new.yaml',
      },
    });
    expect(result.status).toBe(0);
    const persisted = JSON.parse(readFileSync(state, 'utf8')) as SubmitTrackingState & { _recovery?: unknown };
    const persistedAnchor = JSON.parse(readFileSync(anchor, 'utf8')) as { activeDeliveryCount?: number; stateRootIdentity?: string };
    expect(persisted._recovery).toBeUndefined();
    expect(persisted.stateRootIdentity).toBeTruthy();
    expect(persistedAnchor.activeDeliveryCount).toBe(0);
    expect(persistedAnchor.stateRootIdentity).toBe(persisted.stateRootIdentity);
    expect((persisted.audit ?? []).some((row) => row.action === 'state_root_reseat' && row.reason === 'orphan_anchor_quarantine')).toBe(true);
    expect(`${result.stdout}
${result.stderr}`).toMatch(/state-root re-seat/i);
  });

  it('re-seats a persisted latch after terminal orphan escalation (opk-25 class)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-reseat-'));
    const state = path.join(dir, 'state.json');
    const journal = path.join(dir, 'journal.json');
    const anchor = path.join(dir, 'worker-message-submit-state-root.anchor.json');
    const deliveryId = 'opk-25:1717601000000:ao-send:orphan';
    writeFileSync(journal, JSON.stringify({}));
    writeFileSync(anchor, JSON.stringify({
      stateRootIdentity: 'stale-identity-hash',
      statePath: state,
      activeDeliveryCount: 1,
      updatedAtMs: 1717601000000,
    }));
    writeFileSync(state, JSON.stringify({
      stateRootIdentity: 'stale-identity-hash',
      _recovery: {
        fenceTrusted: false,
        reason: 'wrong_state_root_active_deliveries',
        quarantined: state,
      },
      deliveries: {
        [deliveryId]: {
          deliveryId,
          sessionId: 'opk-25',
          source: DISPATCH_SOURCE_AO_SEND,
          terminalState: 'escalated',
          escalationReason: 'delivery_vanished',
          firstObservedAtMs: 1717601000000,
        },
      },
      audit: [],
    }));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-StateFile', state, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-new',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/new.yaml',
      },
    });
    expect(result.status).toBe(0);
    const persisted = JSON.parse(readFileSync(state, 'utf8')) as SubmitTrackingState & { _recovery?: unknown };
    expect(persisted._recovery).toBeUndefined();
    expect(persisted.stateRootIdentity).toBeTruthy();
    expect(persisted.stateRootIdentity).not.toBe('stale-identity-hash');
    expect((persisted.audit ?? []).some((row) => row.action === 'state_root_reseat')).toBe(true);
    expect(`${result.stdout}
${result.stderr}`).toMatch(/state-root re-seat/i);
  });

  it('keeps quarantine when journal pending records remain after deliveries drain', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-reseat-blocked-'));
    const state = path.join(dir, 'state.json');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(journal, JSON.stringify({
      'pending-journal': {
        deliveryId: 'pending-journal',
        deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
        fenceLifecycle: 'pending',
        dispatchOutcome: 'dispatched',
      },
    }));
    writeFileSync(state, JSON.stringify({
      stateRootIdentity: 'stale-identity-hash',
      _recovery: {
        fenceTrusted: false,
        reason: 'wrong_state_root_active_deliveries',
        quarantined: state,
      },
      deliveries: {},
      audit: [],
    }));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-StateFile', state, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-new',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/new.yaml',
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}
${result.stderr}`).toMatch(/wrong_state_root_active_deliveries|STATE FENCES UNTRUSTED/i);
    const persisted = JSON.parse(readFileSync(state, 'utf8')) as { _recovery?: { reason?: string } };
    expect(persisted._recovery?.reason).toBe('wrong_state_root_active_deliveries');
  });

  it('heartbeats legitimate fail-closed ticks without clearing active-delivery quarantine', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'submit-reconcile-heartbeat-failclosed-'));
    const state = path.join(dir, 'state.json');
    const journal = path.join(dir, 'journal.json');
    writeFileSync(journal, JSON.stringify({}));
    writeFileSync(state, JSON.stringify({
      stateRootIdentity: 'stale-identity-hash',
      _recovery: {
        fenceTrusted: false,
        reason: 'wrong_state_root_active_deliveries',
        quarantined: state,
      },
      deliveries: {
        live: { deliveryId: 'live', sessionId: 'opk-live', firstObservedAtMs: 1717601000000 },
      },
      audit: [],
      lastTickMs: null,
    }));
    const fakeAoDir = writeFakeAoCli(dir);
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', 'scripts/worker-message-submit-reconcile.ps1',
      '-Once', '-StateFile', state, '-DispatchJournalPath', journal,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeAoDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AO_WORKER_MESSAGE_ADOPTION_EPOCH: 'epoch-new',
        AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH: '/cfg/new.yaml',
      },
    });
    expect(result.status).not.toBe(0);
    const persisted = JSON.parse(readFileSync(state, 'utf8')) as SubmitTrackingState & { _recovery?: { reason?: string } };
    expect(persisted._recovery?.reason).toBe('wrong_state_root_active_deliveries');
    expect(persisted.lastTickMs).toBeGreaterThan(0);
  });
});


describe('issue #602 adoption and consumption proof (S1-S7)', () => {
  const baseSession = {
    sessionId: 'opk-scenario',
    name: 'opk-scenario',
    role: 'worker',
    status: 'working',
    runtime: 'alive',
    activity: 'idle',
    activityChangedAtMs: 1717601005000,
    reports: [],
  };
  const busyMarker = {
    backendKey: 'codex',
    dispatchSignature: 'tmux-enter-v1',
    runtimeFingerprint: 'codex-cli@1.0.0',
    tmuxFingerprint: 'tmux@3.4:default',
    smokedAt: '2026-06-13T12:00:00.000Z',
    runId: 'opk-602',
    busy_enter_enqueued_observed: true,
    consumed_after_flush_observed: true,
    no_manual_enter: true,
  } as const;

  it('S1: observed consumption after Enter may mark consumed', () => {
    const id = 'opk-scenario:1717601000000:ao-send:s1';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{
        ...baseSession,
        reports: [{ report_state: 'fixing_ci', reportedAt: new Date(1717601015000).toISOString(), note: `progress ${id}` }],
      }],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-scenario',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: {
        deliveries: {
          [id]: {
            deliveryId: id,
            sessionId: 'opk-scenario',
            firstObservedAtMs: 1717601000000,
            submitAttempts: 1,
            firstDispatchAtMs: 1717601008000,
            lastSubmitAtMs: 1717601008000,
          },
        },
        audit: [],
        adoptionStatus: 'adopted',
      },
      nowMs: 1717601020000,
    });
    expect(submitActions(actions)).toHaveLength(0);
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed' && a.deliveryId === id)).toBe(true);
  });

  it('S2: wrapper_not_adopted still permits Enter on AO 0.10.2', () => {
    const id = 'opk-scenario:1717601000000:ao-send:s2';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [baseSession],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-scenario',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: { deliveries: {}, audit: [], adoptionStatus: 'wrapper_not_adopted' },
      nowMs: 1717601010000,
    });
    expect(submitActions(actions)).toHaveLength(1);
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'submit' && a.deliveryId === id)).toBe(true);
  });

  it('S3: busy_dispatch_environment_unknown never marks consumed', () => {
    const id = 'opk-scenario:1717601000000:ao-send:s3';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{
        ...baseSession,
        activity: 'active',
        backendKey: 'codex',
        reports: [{ report_state: 'working', reportedAt: new Date(1717601015000).toISOString(), note: 'generic' }],
      }],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-scenario',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: {
        deliveries: {
          [id]: {
            deliveryId: id,
            sessionId: 'opk-scenario',
            firstObservedAtMs: 1717601000000,
            submitAttempts: 1,
            firstDispatchAtMs: 1717601008000,
            lastSubmitAtMs: 1717601008000,
            busyDispatchReason: 'busy_dispatch_environment_unknown',
          },
        },
        audit: [],
        adoptionStatus: 'adopted',
      },
      nowMs: 1717601020000,
      config: { observabilitySettleMs: 1000, postDispatchLeaseMs: 60000 },
    });
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed')).toBe(false);
  });

  it('S4: idle backstop sends one bounded Enter then waits for consumption proof', () => {
    const id = 'opk-scenario:1717601000000:ao-send:s4';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [baseSession],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-scenario',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: { deliveries: {}, audit: [], adoptionStatus: 'adopted' },
      nowMs: 1717601010000,
    });
    expect(submitActions(actions)).toHaveLength(1);
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed')).toBe(false);
  });

  it('S5: stale or changed draft identity refuses Enter', () => {
    const id = 'opk-scenario:1717601000000:ao-send:s5';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [baseSession],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-scenario',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          draftIdentityStatus: 'changed',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: { deliveries: {}, audit: [], adoptionStatus: 'adopted' },
      nowMs: 1717601010000,
      config: { deliveryBudgetMs: 1000 },
    });
    expect(submitActions(actions)).toHaveLength(0);
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'escalate' && a.reason === 'draft_absent_or_changed')).toBe(true);
  });

  it('S6: busy-safe dispatch marks consumed only after observed consumption', () => {
    const id = 'opk-scenario:1717601000000:ao-send:s6';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [{
        ...baseSession,
        activity: 'active',
        backendKey: 'codex',
        dispatchSignature: 'tmux-enter-v1',
        runtimeFingerprint: 'codex-cli@1.0.0',
        tmuxFingerprint: 'tmux@3.4:default',
        reports: [{ report_state: 'ready_for_review', reportedAt: new Date(1717601015000).toISOString(), note: `consumed ${id}` }],
      }],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-scenario',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: {
        deliveries: {
          [id]: {
            deliveryId: id,
            sessionId: 'opk-scenario',
            firstObservedAtMs: 1717601000000,
            submitAttempts: 1,
            firstDispatchAtMs: 1717601008000,
            lastSubmitAtMs: 1717601008000,
            busyDispatchAllowed: true,
            busyDispatchReason: 'busy_dispatch_marker_match',
          },
        },
        audit: [],
        adoptionStatus: 'adopted',
      },
      nowMs: 1717601020000,
      config: { busyDispatch: { markers: [busyMarker] }, observabilitySettleMs: 1000, postDispatchLeaseMs: 60000 },
    });
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed' && a.deliveryId === id)).toBe(true);
  });

  it('S7: absent draft never blind-enters', () => {
    const id = 'opk-scenario:1717601000000:ao-send:s7';
    const { actions } = planWorkerMessageSubmitActions({
      sessions: [baseSession],
      dispatchJournal: {
        [id]: {
          deliveryId: id,
          sessionId: 'opk-scenario',
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_AO_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'absent',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: { deliveries: {}, audit: [], adoptionStatus: 'adopted' },
      nowMs: 1717601010000,
      config: { deliveryBudgetMs: 1000 },
    });
    expect(submitActions(actions)).toHaveLength(0);
    expect(actions.some((a: WorkerMessageSubmitAction) => a.type === 'escalate' && a.reason === 'draft_absent_or_changed')).toBe(true);
  });

  it('reproduces sanitized opk-134 / review-run-9754242b false-consumption class', () => {
    const sessionId = 'opk-134-sanitized';
    const deliveryId = `${sessionId}:1717601000000:review-send:review-run-9754242b`;
    const first = planWorkerMessageSubmitActions({
      sessions: [{
        sessionId,
        role: 'worker',
        status: 'working',
        runtime: 'alive',
        activity: 'active',
        reports: [],
      }],
      dispatchJournal: {
        [deliveryId]: {
          deliveryId,
          sessionId,
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_REVIEW_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'draft_present',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: {
        deliveries: {},
        audit: [],
        adoptionStatus: 'wrapper_not_adopted',
      },
      nowMs: 1717601005000,
      config: { busyDispatch: { markers: [] } },
    });
    expect(submitActions(first.actions)).toHaveLength(0);
    expect(first.actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed')).toBe(false);

    const masked = planWorkerMessageSubmitActions({
      sessions: [{
        sessionId,
        role: 'worker',
        status: 'working',
        runtime: 'alive',
        activity: 'idle',
        activityChangedAtMs: 1717601010000,
        reports: [{ report_state: 'working', reportedAt: new Date(1717601015000).toISOString(), note: 'unrelated progress' }],
      }],
      dispatchJournal: {
        [deliveryId]: {
          deliveryId,
          sessionId,
          deliveredAtMs: 1717601000000,
          source: DISPATCH_SOURCE_REVIEW_SEND,
          deliveryPath: DELIVERY_PATH_PENDING_DRAFT,
          dispatchOutcome: 'dispatched',
          draftState: 'absent',
          observability: 'indeterminate',
          messageShape: { charLength: 240, lineCount: 3 },
        },
      },
      tracking: {
        deliveries: {
          [deliveryId]: {
            deliveryId,
            sessionId,
            firstObservedAtMs: 1717601000000,
            submitAttempts: 1,
            firstDispatchAtMs: 1717601008000,
            lastSubmitAtMs: 1717601008000,
            terminalState: 'submitted',
            busyDispatchReason: 'busy_dispatch_environment_unknown',
          },
        },
        audit: [],
        adoptionStatus: 'wrapper_not_adopted',
      },
      nowMs: 1717601020000,
    });
    expect(masked.actions.some((a: WorkerMessageSubmitAction) => a.type === 'mark_consumed')).toBe(false);
    expect(submitActions(masked.actions)).toHaveLength(0);
  });
});

describe('issue #602 delivery source audit', () => {
  it('documents journaled transport for worker-message delivery sources', () => {
    const audit = JSON.parse(readFileSync('docs/submit-reconcile-delivery-source-audit.json', 'utf8')) as {
      sources: Array<{ source: string; transport: string; outOfScope?: boolean }>;
    };
    const workerSources = audit.sources.filter((row) => !row.outOfScope);
    expect(workerSources.length).toBeGreaterThanOrEqual(4);
    for (const row of workerSources) {
      expect(['journaled-worker-send', 'ao-review-send', 'ao-auto-delivery', 'draft-submit']).toContain(row.transport);
    }
    const bySource = Object.fromEntries(audit.sources.map((row) => [row.source, row.transport]));
    expect(bySource['review-send']).toBe('ao-auto-delivery');
    expect(bySource['reaction-routed']).toBe('journaled-worker-send');
    expect(bySource['ci-failure-nudge']).toBe('journaled-worker-send');
    expect(bySource['ci-green-nudge']).toBe('journaled-worker-send');
    expect(bySource['submit-reconcile-backstop']).toBe('draft-submit');
  });
});
