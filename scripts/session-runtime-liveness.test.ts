import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateCiGreenWakeCandidate, planCiGreenWakeActions } from '../docs/ci-green-wake-reconcile.mjs';
import {
  classifyReviewReadySnapshot,
  planStuckGuardReaction,
  preShieldRecheck,
} from '../docs/review-ready-stuck-guard.mjs';
import {
  evaluateFirstSendCandidate,
  planReviewSendActions,
  preSendRecheck,
} from '../docs/review-send-reconcile.mjs';
import {
  AFFIRMATIVE_LIVE_RUNTIME,
  classifyRuntimeField,
  hasRuntimeField,
  isRuntimeAlive,
  isRuntimeFieldLive,
  TERMINAL_RUNTIME_VALUES,
} from '../docs/session-runtime-liveness.mjs';
import { isSessionAlive } from '../docs/worker-message-dispatch-observe.mjs';
import { evaluateSubmitDecision } from '../docs/worker-message-submit-reconcile.mjs';
import { loadVariantCatalog } from './external-output-shape-guard.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const referencesRoot = path.join(repoRoot, 'tests/external-output-references');
const { catalog } = loadVariantCatalog(referencesRoot);

const greenChecks = [
  { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
  { name: 'PR scope guard', state: 'SUCCESS' },
  { name: 'Run pack contract tests', state: 'SUCCESS' },
  { name: 'Self-architect lint', state: 'SUCCESS' },
];

function loadCapture(name: string) {
  return JSON.parse(
    readFileSync(path.join(referencesRoot, 'captures/ao-status-session', name), 'utf8'),
  ) as Record<string, unknown>;
}

function productionWorker(overrides: Record<string, unknown> = {}) {
  return {
    ...loadCapture('working-no-runtime.raw.json'),
    prNumber: 42,
    ownedHeadSha: 'deadbeef',
    ...overrides,
  };
}

describe('session-runtime-liveness contract', () => {
  it('treats absent runtime as live at field level', () => {
    expect(hasRuntimeField({ status: 'working' })).toBe(false);
    expect(isRuntimeFieldLive({ status: 'working' })).toBe(true);
    expect(classifyRuntimeField({ status: 'working' })).toBe('absent');
  });

  it('accepts affirmative alive and rejects terminal death', () => {
    expect(isRuntimeFieldLive({ runtime: AFFIRMATIVE_LIVE_RUNTIME })).toBe(true);
    for (const death of TERMINAL_RUNTIME_VALUES) {
      expect(isRuntimeFieldLive({ runtime: death })).toBe(false);
      expect(classifyRuntimeField({ runtime: death })).toBe('terminal_death');
    }
  });

  it('fails closed on present unknown or empty runtime', () => {
    for (const value of ['unreachable', 'starting', 'detecting', '', '   ']) {
      expect(isRuntimeFieldLive({ runtime: value })).toBe(false);
      expect(classifyRuntimeField({ runtime: value })).toBe('present_non_live');
    }
  });

  it('isSessionAlive rejects present non-live runtime before status fallback', () => {
    expect(isSessionAlive({ status: 'working', runtime: 'unreachable' })).toBe(false);
    expect(isSessionAlive({ status: 'working' })).toBe(true);
    expect(isSessionAlive({ status: 'killed', runtime: AFFIRMATIVE_LIVE_RUNTIME })).toBe(false);
  });
});

describe('review-send reconcile (production-shape)', () => {
  const run = {
    id: 'run-send',
    prNumber: 42,
    targetSha: 'deadbeef',
    status: 'needs_triage',
    openFindingCount: 1,
    sentFindingCount: 0,
    linkedSessionId: 'opk-33',
  };

  it('plans send when runtime field is absent', () => {
    const session = productionWorker({ name: 'opk-33' });
    const candidate = evaluateFirstSendCandidate(run, [session], [{ number: 42, headRefOid: 'deadbeef' }], new Set());
    expect(candidate.eligible).toBe(true);
    const { actions } = planReviewSendActions({
      reviewRuns: [run],
      sessions: [session],
      openPrs: [{ number: 42, headRefOid: 'deadbeef' }],
      tracking: { sent: {} },
    });
    expect(actions.some((a) => a.type === 'send')).toBe(true);
  });

  it('skips on terminal runtime death', () => {
    const session = productionWorker({ name: 'opk-33', runtime: 'exited' });
    const candidate = evaluateFirstSendCandidate(run, [session], [{ number: 42, headRefOid: 'deadbeef' }], new Set());
    expect(candidate.eligible).toBe(false);
    expect(candidate.reason).toBe('linked_session_runtime_not_alive');
  });

  it('skips on present unknown runtime', () => {
    const session = productionWorker({ name: 'opk-33', runtime: 'unreachable' });
    const candidate = evaluateFirstSendCandidate(run, [session], [{ number: 42, headRefOid: 'deadbeef' }], new Set());
    expect(candidate.eligible).toBe(false);
    expect(candidate.reason).toBe('linked_session_runtime_not_alive');
  });

  it('incident opk-rev-177 plans send not runtime_not_alive skip', () => {
    const fixture = JSON.parse(
      readFileSync(
        path.join(repoRoot, 'tests/fixtures/review-send-reconcile/incident-opk-rev-177.json'),
        'utf8',
      ),
    );
    const { actions } = planReviewSendActions(fixture);
    expect(actions.some((a) => a.type === 'send')).toBe(true);
    expect(
      actions.some((a) => a.type === 'skip' && a.reason === 'linked_session_runtime_not_alive'),
    ).toBe(false);
  });

  it('pre-send recheck fails when session disappears', () => {
    const planned = { runId: 'run-send', prNumber: 42, targetSha: 'deadbeef', sessionId: 'opk-33' };
    expect(
      preSendRecheck(planned, {
        reviewRuns: [run],
        sessions: [],
        openPrs: [{ number: 42, headRefOid: 'deadbeef' }],
      }).ok,
    ).toBe(false);
  });
});

describe('ci-green wake reconcile (production-shape)', () => {
  it('nudges when runtime field is absent', () => {
    const session = productionWorker({
      name: 'op-fix',
      status: 'fixing_ci',
      reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-09T12:00:00.000Z' }],
    });
    const candidate = evaluateCiGreenWakeCandidate({
      session,
      prNumber: 42,
      headSha: 'deadbeef',
      openPrs: [{ number: 42, headRefOid: 'deadbeef' }],
      ciChecks: greenChecks,
    });
    expect(candidate.eligible).toBe(true);
  });

  it('does not nudge on terminal runtime or present unknown', () => {
    for (const runtime of ['exited', 'process_missing', 'unreachable']) {
      const session = productionWorker({ runtime, status: 'fixing_ci' });
      const candidate = evaluateCiGreenWakeCandidate({
        session,
        prNumber: 42,
        headSha: 'deadbeef',
        openPrs: [{ number: 42, headRefOid: 'deadbeef' }],
        ciChecks: greenChecks,
      });
      expect(candidate.eligible).toBe(false);
      expect(candidate.reasons).toContain('runtime_not_alive');
    }
  });
});

describe('review-ready stuck guard (production-shape)', () => {
  const openPr = { number: 174, headRefOid: 'deadbeef174', headCommittedAt: '2026-06-04T12:00:00Z' };
  const reviewRuns = [
    {
      id: 'run-clean',
      prNumber: 174,
      targetSha: 'deadbeef174',
      status: 'clean',
      findingCount: 0,
      linkedSessionId: 'opk-worker',
    },
  ];

  function reviewReadySession(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: 'opk-worker',
      role: 'worker',
      prNumber: 174,
      status: 'stuck',
      ownedHeadSha: 'deadbeef174',
      reports: [{ reportState: 'ready_for_review', reportedAt: '2026-06-04T12:00:00Z' }],
      ...overrides,
    };
  }

  it('shields missing-runtime stuck worker within grace (AC10a)', () => {
    const session = reviewReadySession();
    const classification = classifyReviewReadySnapshot({
      session,
      openPr,
      reviewRuns,
      ciChecks: greenChecks,
      sessions: [session],
    });
    expect(classification.reviewReady).toBe(true);
    const { action } = planStuckGuardReaction({
      session,
      openPr,
      reviewRuns,
      ciChecks: greenChecks,
      sessions: [session],
      nowMs: 1_717_503_000_000,
    });
    expect(action.type).toBe('hold_grace');
  });

  it('does not shield on terminal runtime death (AC3)', () => {
    const session = reviewReadySession({ runtime: 'exited' });
    const classification = classifyReviewReadySnapshot({
      session,
      openPr,
      reviewRuns,
      ciChecks: greenChecks,
      sessions: [session],
    });
    expect(classification.reviewReady).toBe(false);
    expect(classification.reasons).toContain('runtime_not_alive');
  });

  it('does not shield on terminal session status even with runtime alive (AC4)', () => {
    const session = reviewReadySession({ status: 'killed', runtime: 'alive' });
    const classification = classifyReviewReadySnapshot({
      session,
      openPr,
      reviewRuns,
      ciChecks: greenChecks,
      sessions: [session],
    });
    expect(classification.reviewReady).toBe(false);
    expect(classification.reasons).toContain('session_not_live');
  });

  it('pre-shield recheck fails when head moves', () => {
    const session = reviewReadySession();
    const planned = { sessionId: 'opk-worker', prNumber: 174, headSha: 'deadbeef174' };
    expect(
      preShieldRecheck(planned, {
        sessions: [reviewReadySession({ ownedHeadSha: 'newhead' })],
        openPrs: [{ number: 174, headRefOid: 'newhead' }],
        reviewRuns,
        ciChecks: greenChecks,
      }).ok,
    ).toBe(false);
  });
});

describe('worker message submit (isSessionAlive)', () => {
  it('blocks submit on present non-live runtime', () => {
    const session = productionWorker({ name: 'opk-msg', runtime: 'unreachable', status: 'working' });
    const decision = evaluateSubmitDecision({
      delivery: {
        deliveryId: 'del-1',
        sessionId: 'opk-msg',
        deliveryPath: 'pending-draft',
        deliveredAtMs: 1_000,
      },
      session,
      tracking: { deliveries: {}, audit: [] },
      aoEvents: [],
      floodActiveSessions: {},
      nowMs: 2_000,
    });
    expect(decision.action).toBe('escalate');
    expect(decision.reason).toBe('worker_dead_or_gone');
  });
});

describe('golden-sample ao-status-session catalog', () => {
  it('includes mandatory working-no-runtime variant without runtime in capture', () => {
    const variant = catalog.get('ao-status-session/working-no-runtime') as
      | { forbiddenFields: string[] }
      | undefined;
    expect(variant).toBeDefined();
    expect(variant?.forbiddenFields).toContain('runtime');
    const capture = loadCapture('working-no-runtime.raw.json');
    expect(hasRuntimeField(capture)).toBe(false);
  });
});

describe('liveness gate inventory (AC12)', () => {
  it('documents every ao-status liveness gate', () => {
    const inventory = readFileSync(
      path.join(repoRoot, 'docs/session-runtime-liveness-gate-inventory.md'),
      'utf8',
    );
    const requiredGates = [
      'isRuntimeFieldLive',
      'isRuntimeAlive',
      'isSessionAlive',
      'Test-SessionRuntimeFieldLive',
      'ci-green-wake-reconcile',
      'review-ready-stuck-guard',
      'worker-message-submit-reconcile',
      'review-trigger-reconcile',
      'review-finding-delivery-confirm',
      'review-wake-trigger',
      'review-trigger-reeval',
    ];
    for (const gate of requiredGates) {
      expect(inventory).toContain(gate);
    }
  });
});
