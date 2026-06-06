import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AO_PASTE_CHAR_THRESHOLD,
  classifyDeliveryPath,
  deriveMessageShape,
  DELIVERY_PATH_PENDING_DRAFT,
  DELIVERY_PATH_SELF_SUBMITTED,
  mergeDeliveryRecords,
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

describe('multiple pending deliveries (AC10)', () => {
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

describe('mergeDeliveryRecords from AO events', () => {
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
