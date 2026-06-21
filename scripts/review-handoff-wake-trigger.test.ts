import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateWakePayload } from '../docs/orchestrator-wake-filter.mjs';
import {
  evaluateHandoffIdentityAdmission,
  evaluateHandoffPreClaimRecheck,
  formatHandoffWakeAuditLine,
  HANDOFF_RECEIPT_TO_RUN_MAX_MS,
  HANDOFF_WAKE_KIND,
  isReadyForReviewHandoffEnvelope,
  seedHandoffAdmissionRecord,
  selectHandoffAdmissionReplay,
} from '../docs/review-handoff-wake-admission.mjs';
import {
  evaluateWakePreRunRecheck,
  evaluateWakeReviewTrigger,
  isEventReviewTriggerWake,
  isHandoffReviewTriggerWake,
  WAKE_TO_RUN_DECISION_MAX_MS,
} from '../docs/review-wake-trigger.mjs';
import { seedWatchFromWakeDefer } from '../docs/review-trigger-reeval.mjs';
import type { OpenPr } from '../docs/review-trigger-reconcile.d.mts';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/review-handoff-wake-trigger',
);
const captureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/external-output-references/captures/ao-webhook-notification',
);

type HandoffFixture = {
  wakeKind?: string;
  sessionId?: string;
  prNumber?: number;
  admittedBaseRef?: string;
  openPrs?: OpenPr[];
  reviewRuns?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
  ciChecksByPr?: Record<string, Array<{ name: string; state: string }>>;
  requiredCheckNamesByPr?: Record<string, string[]>;
  cycleState?: Record<string, unknown>;
  expect?: Record<string, unknown>;
};

function loadFixture(name: string): HandoffFixture {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as HandoffFixture;
}

function admissionContext(fixture?: HandoffFixture) {
  return {
    supervisedProjectId: 'orchestrator-pack',
    supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
    openPrs: fixture?.openPrs ?? [],
  };
}

function evaluateHandoffFixture(fixture: HandoffFixture, nowMs = 1_700_000_000_000) {
  const prKey = String(fixture.prNumber);
  return evaluateWakeReviewTrigger({
    wakeKind: fixture.wakeKind ?? HANDOFF_WAKE_KIND,
    sessionId: fixture.sessionId,
    prNumber: fixture.prNumber,
    wakeReceivedMs: nowMs,
    nowMs,
    admittedBaseRef: fixture.admittedBaseRef,
    openPrs: fixture.openPrs,
    reviewRuns: fixture.reviewRuns,
    sessions: fixture.sessions,
    ciChecks: fixture.ciChecksByPr?.[prKey],
    requiredCheckNames: fixture.requiredCheckNamesByPr?.[prKey],
    cycleState: fixture.cycleState,
  });
}

describe('handoff envelope admission (Issue #381)', () => {
  it('classifies capture-backed ready_for_review envelope', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    expect(isReadyForReviewHandoffEnvelope(capture, capture.event)).toBe(true);
  });

  it('AC1: info-priority capture promotes and reaches trigger within 30s bound', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const wake = evaluateWakePayload(capture, admissionContext(loadFixture('green-info-handoff-triggers.json')));
    expect(wake.ok).toBe(true);
    if (wake.ok) {
      expect(wake.wakeKind).toBe('ready_for_review');
      expect(wake.handoffAdmission?.promotedFromInfoPriority).toBe(true);
      expect(wake.handoffAdmission?.auditLine).toContain('review-handoff-wake:');
      expect(wake.handoffAdmission?.auditLine).toContain('outcome=promoted');
    }

    const fixture = loadFixture('green-info-handoff-triggers.json');
    const receiptMs = 1_700_000_000_000;
    const runCreatedMs = receiptMs + 2_000;
    const result = evaluateHandoffFixture(fixture, runCreatedMs);
    expect(result.triggerReviewRun).toBe(true);
    expect(result.withinLatencyBound).toBe(true);
    expect(result.processingMs).toBeLessThanOrEqual(HANDOFF_RECEIPT_TO_RUN_MAX_MS);
    expect(result.processingMs).toBeLessThan(10 * 60 * 1000);
  });

  it('AC2: action-priority capture reaches the same start decision', () => {
    const infoCapture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const actionCapture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.action-priority.raw.json'), 'utf8'),
    );
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const ctx = admissionContext(fixture);
    const infoWake = evaluateWakePayload(infoCapture, ctx);
    const actionWake = evaluateWakePayload(actionCapture, ctx);
    expect(infoWake.ok).toBe(true);
    expect(actionWake.ok).toBe(true);

    const infoEval = evaluateHandoffFixture(fixture);
    const actionEval = evaluateHandoffFixture({ ...fixture, wakeKind: 'ready_for_review' });
    expect(infoEval.triggerReviewRun).toBe(actionEval.triggerReviewRun);
    expect(infoEval.reason).toBe(actionEval.reason);
  });

  it('AC6: non-hand-off info notification stays dropped', () => {
    const result = evaluateWakePayload(
      {
        type: 'notification',
        event: {
          type: 'session.working',
          priority: 'info',
          sessionId: 'opk-1',
          projectId: 'orchestrator-pack',
          data: {
            schemaVersion: 3,
            semanticType: 'session.working',
            subject: { session: { id: 'opk-1', projectId: 'orchestrator-pack' } },
          },
        },
      },
      admissionContext(),
    );
    expect(result).toEqual({ ok: false, reason: 'info_priority', detail: 'info' });
  });

  it('AC10: bare semanticType without full envelope stays dropped at info priority', () => {
    const result = evaluateWakePayload(
      {
        type: 'notification',
        event: {
          type: 'ci.failing',
          priority: 'info',
          sessionId: 'opk-1',
          projectId: 'orchestrator-pack',
          data: {
            schemaVersion: 3,
            semanticType: 'ready_for_review',
            subject: { session: { id: 'opk-1', projectId: 'orchestrator-pack' } },
          },
        },
      },
      admissionContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('info_priority');
    }
  });

  it('AC8: rejects foreign project at filter', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    capture.event.projectId = 'foreign-project';
    const result = evaluateWakePayload(capture, {
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      openPrs: loadFixture('green-info-handoff-triggers.json').openPrs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('foreign_project');
      expect(result.auditLine).toContain('outcome=filter_reject');
    }
  });

  it('AC8: rejects foreign repository via PR url selector', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    capture.event.data.subject.pr.url = 'https://github.com/other-org/other-repo/pull/99';
    const result = evaluateWakePayload(capture, admissionContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('foreign_repository');
    }
  });

  it('AC16: transient open-PR lookup yields retryable unknown', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const result = evaluateWakePayload(capture, {
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      openPrLookupFailed: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('admission_lookup_unknown');
      expect(result.retryable).toBe(true);
      expect(result.auditLine).toContain('outcome=unknown');
    }
  });
});

describe('handoff review trigger path', () => {
  it('AC3: red/pending CI defers with uncovered_not_ready for reeval seeding', () => {
    const fixture = loadFixture('red-ci-defer-seed-reeval.json');
    const result = evaluateHandoffFixture(fixture);
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).toBe('ci_red_defer');

    const pr = fixture.openPrs?.[0];
    expect(pr).toBeDefined();
    const seed = seedWatchFromWakeDefer({
      prNumber: Number(fixture.prNumber),
      headSha: String(pr!.headRefOid),
      sessionId: String(fixture.sessionId),
      deferReason: 'uncovered_not_ready',
      deferRecord: { primary: 'no_ready_for_review' },
      existingWatches: {},
      nowMs: Date.now(),
    });
    expect(seed.seeded).toBe(true);
  });

  it('AC11: merge.ready remains an event review trigger wake', () => {
    expect(isEventReviewTriggerWake('merge.ready')).toBe(true);
    expect(isHandoffReviewTriggerWake('merge.ready')).toBe(false);
  });

  it('AC12: pre-claim TOCTOU rejects retargeted base ref', () => {
    const recheck = evaluateHandoffPreClaimRecheck({
      planned: {
        prNumber: 234,
        headSha: 'handoff234',
        sessionId: 'opk-27',
        admittedBaseRef: 'main',
        startReason: 'handoff_wake',
      },
      fresh: {
        openPrs: [{ number: 234, headRefOid: 'handoff234', baseRefName: 'release' }],
      },
    });
    expect(recheck.emitReviewRun).toBe(false);
    expect(recheck.reason).toBe('pre_claim_toctou_base_retargeted');
    expect(formatHandoffWakeAuditLine(recheck.audit!)).toContain('toctou_reject');
  });

  it('AC12: pre-claim TOCTOU rejects closed PR', () => {
    const recheck = evaluateHandoffPreClaimRecheck({
      planned: {
        prNumber: 234,
        headSha: 'handoff234',
        sessionId: 'opk-27',
        admittedBaseRef: 'main',
        startReason: 'handoff_wake',
      },
      fresh: { openPrs: [] },
    });
    expect(recheck.emitReviewRun).toBe(false);
    expect(recheck.reason).toBe('pre_claim_toctou_pr_closed');
  });

  it('AC13: durable admission record replays within recovery bound', () => {
    const listenerReadyMs = 1_700_000_010_000;
    const seed = seedHandoffAdmissionRecord({
      existing: {},
      admission: {
        subject: {
          projectId: 'orchestrator-pack',
          prNumber: 234,
          prUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/234',
          sessionId: 'opk-27',
          priority: 'info',
          receivedAtMs: listenerReadyMs - 5_000,
        },
        admittedHeadSha: 'handoff234',
        admittedBaseRef: 'main',
        outcome: 'promoted',
      },
      nowMs: listenerReadyMs - 5_000,
    });
    const replay = selectHandoffAdmissionReplay({
      records: seed.records,
      listenerReadyMs,
      nowMs: listenerReadyMs + 2_000,
    }) as { replay: Array<{ withinRecoveryBound?: boolean }> };
    expect(replay.replay).toHaveLength(1);
    expect(replay.replay[0]?.withinRecoveryBound).toBe(true);
  });

  it('AC14: audit line is greppable for promoted + claim win outcomes', () => {
    const promoted = formatHandoffWakeAuditLine({
      outcome: 'promoted',
      reason: 'handoff_promoted',
      wakeKind: HANDOFF_WAKE_KIND,
      priority: 'info',
      sessionId: 'opk-27',
      prNumber: 234,
    });
    const claimWin = formatHandoffWakeAuditLine({
      outcome: 'claim_win',
      reason: 'head_ready_for_review',
      claimOutcome: 'win',
      sessionId: 'opk-27',
      prNumber: 234,
    });
    expect(promoted).toMatch(/^review-handoff-wake:/);
    expect(promoted).toContain('outcome=promoted');
    expect(claimWin).toContain('claim=win');
  });
});

describe('wake trigger integration', () => {
  it('completion wake keeps 5s processing bound', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(fixturesDir, '../review-wake-trigger/green-wake-triggers.json'), 'utf8'),
    );
    const now = 1_700_000_000_000;
    const result = evaluateWakeReviewTrigger({
      wakeKind: 'merge.ready',
      sessionId: fixture.sessionId,
      prNumber: fixture.prNumber,
      wakeReceivedMs: now,
      nowMs: now + 1_000,
      openPrs: fixture.openPrs,
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      ciChecks: fixture.ciChecksByPr?.[String(fixture.prNumber)],
    });
    expect(result.withinLatencyBound).toBe(true);
    expect(WAKE_TO_RUN_DECISION_MAX_MS).toBe(5_000);
  });

  it('handoff pre-run recheck composes head-ready + TOCTOU guards', () => {
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const pr = fixture.openPrs?.[0];
    expect(pr).toBeDefined();
    const recheck = evaluateWakePreRunRecheck({
      wakeKind: HANDOFF_WAKE_KIND,
      planned: {
        prNumber: Number(fixture.prNumber),
        headSha: String(pr!.headRefOid),
        sessionId: String(fixture.sessionId),
        admittedBaseRef: 'main',
        startReason: 'handoff_wake',
      },
      fresh: {
        openPrs: fixture.openPrs,
        reviewRuns: fixture.reviewRuns,
        sessions: fixture.sessions,
        ciChecks: fixture.ciChecksByPr?.[String(fixture.prNumber)],
      },
    });
    expect(recheck.emitReviewRun).toBe(true);
  });
});

describe('identity admission unit', () => {
  it('evaluates in-project session + open PR as promoted', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const admission = evaluateHandoffIdentityAdmission({
      event: capture.event,
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      openPrs: loadFixture('green-info-handoff-triggers.json').openPrs,
    });
    expect(admission.admitted).toBe(true);
    expect(admission.outcome).toBe('promoted');
  });
});
