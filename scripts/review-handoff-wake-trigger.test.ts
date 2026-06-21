import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateWakePayload } from '../docs/orchestrator-wake-filter.mjs';
import {
  evaluateHandoffIdentityAdmission,
  parsePrNumberFromPrUrl,
  evaluateHandoffPreClaimRecheck,
  evaluateHandoffReceiptToRunBound,
  formatHandoffWakeAuditLine,
  HANDOFF_LISTENER_RECOVERY_MAX_MS,
  HANDOFF_RECEIPT_TO_RUN_MAX_MS,
  HANDOFF_WAKE_KIND,
  isReadyForReviewHandoffEnvelope,
  seedHandoffAdmissionRecord,
  seedPendingAdmissionRetry,
  selectHandoffAdmissionReplay,
} from '../docs/review-handoff-wake-admission.mjs';
import {
  evaluateWakePreRunRecheck,
  evaluateWakeReviewTrigger,
  isEventReviewTriggerWake,
  isHandoffReviewTriggerWake,
  WAKE_TO_RUN_DECISION_MAX_MS,
} from '../docs/review-wake-trigger.mjs';
import { seedWatchFromWakeDefer, isDeferredReevalWatchSeedEligible } from '../docs/review-trigger-reeval.mjs';
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
  admittedHeadSha?: string;
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
    supervisedSessions: fixture?.sessions ?? [],
    openPrs: fixture?.openPrs ?? [],
  };
}

function evaluateHandoffFixture(fixture: HandoffFixture, nowMs = 1_700_000_000_000) {
  const prKey = String(fixture.prNumber);
  const pr = fixture.openPrs?.find((openPr) => openPr.number === fixture.prNumber);
  return evaluateWakeReviewTrigger({
    wakeKind: fixture.wakeKind ?? HANDOFF_WAKE_KIND,
    sessionId: fixture.sessionId,
    prNumber: fixture.prNumber,
    wakeReceivedMs: nowMs,
    nowMs,
    admittedBaseRef: fixture.admittedBaseRef,
    admittedHeadSha: fixture.admittedHeadSha ?? (pr?.headRefOid ? String(pr.headRefOid) : undefined),
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
    if (infoWake.ok && actionWake.ok) {
      expect(infoWake.handoffAdmission?.admittedHeadSha).toBeTruthy();
      expect(actionWake.handoffAdmission?.admittedHeadSha).toBeTruthy();
      expect(actionWake.handoffAdmission?.promotedFromInfoPriority).toBe(false);
    }

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

  it('AC8: rejects foreign session not in supervised ao status', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const result = evaluateWakePayload(capture, {
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      supervisedSessions: [
        {
          name: 'opk-foreign',
          role: 'worker',
          prNumber: 999,
          status: 'working',
        },
      ],
      openPrs: fixture.openPrs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('foreign_session');
      expect(result.auditLine).toContain('outcome=filter_reject');
    }
  });

  it('rejects handoffs when open-PR lookup succeeds but list is empty', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const result = evaluateWakePayload(capture, {
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      openPrs: [],
      openPrLookupFailed: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_open_pr');
    }
  });

  it('action-priority foreign repository is identity-rejected', () => {
    const actionCapture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.action-priority.raw.json'), 'utf8'),
    );
    actionCapture.event.data.subject.pr.url = 'https://github.com/other/repo/pull/999';
    const result = evaluateWakePayload(actionCapture, {
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      openPrs: loadFixture('green-info-handoff-triggers.json').openPrs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('foreign_repository');
    }
  });

  it('retains retryable admission lookup failures for later retry', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const bodyJson = JSON.stringify(capture);
    const seed = seedPendingAdmissionRetry({ existing: {}, bodyJson, nowMs: 1_700_000_000_000 });
    expect(seed.seeded).toBe(true);
    expect(seed.key).toBeTruthy();
  });

  it('measures handoff receipt-to-run bound through run createdAt', () => {
    const receiptMs = 1_700_000_000_000;
    const runCreatedMs = receiptMs + 2_000;
    const bound = evaluateHandoffReceiptToRunBound(receiptMs, runCreatedMs);
    expect(bound.withinBound).toBe(true);
    expect(bound.receiptToRunMs).toBe(2_000);

    const late = evaluateHandoffReceiptToRunBound(receiptMs, receiptMs + HANDOFF_RECEIPT_TO_RUN_MAX_MS + 1);
    expect(late.withinBound).toBe(false);
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
  it('AC3: red/pending CI defers with ci_red_defer and seeds reeval watch', () => {
    const fixture = loadFixture('red-ci-defer-seed-reeval.json');
    const result = evaluateHandoffFixture(fixture);
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).toBe('ci_red_defer');

    const pr = fixture.openPrs?.[0];
    expect(pr).toBeDefined();
    expect(isDeferredReevalWatchSeedEligible('ci_red_defer', { primary: 'ci_red' })).toBe(true);
    const seed = seedWatchFromWakeDefer({
      prNumber: Number(fixture.prNumber),
      headSha: String(pr!.headRefOid),
      sessionId: String(fixture.sessionId),
      deferReason: 'ci_red_defer',
      deferRecord: { primary: 'ci_red' },
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

    const stale = selectHandoffAdmissionReplay({
      records: seed.records,
      listenerReadyMs,
      nowMs: listenerReadyMs + HANDOFF_LISTENER_RECOVERY_MAX_MS + 1_000,
    }) as { replay: Array<{ withinRecoveryBound?: boolean }> };
    expect(stale.replay[0]?.withinRecoveryBound).toBe(false);
  });

  it('AC13: listener readiness resets recovery window for retained admissions', () => {
    const listenerReadyMs = 1_700_000_100_000;
    const seed = seedHandoffAdmissionRecord({
      existing: {},
      admission: {
        subject: {
          projectId: 'orchestrator-pack',
          prNumber: 234,
          prUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/234',
          sessionId: 'opk-27',
          priority: 'info',
          receivedAtMs: listenerReadyMs - 120_000,
        },
        admittedHeadSha: 'handoff234',
        admittedBaseRef: 'main',
        outcome: 'promoted',
      },
      nowMs: listenerReadyMs - 120_000,
    });
    const replay = selectHandoffAdmissionReplay({
      records: seed.records,
      listenerReadyMs,
      nowMs: listenerReadyMs + 5_000,
    }) as { replay: Array<{ withinRecoveryBound?: boolean; replayReceivedAtMs?: number }> };
    expect(replay.replay[0]?.withinRecoveryBound).toBe(true);
    expect(replay.replay[0]?.replayReceivedAtMs).toBe(listenerReadyMs);
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



  it('rejects handoff evaluation when receipt-to-run bound is exceeded', () => {
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const pr = fixture.openPrs?.[0];
    const wakeReceivedMs = 1_700_000_000_000;
    const result = evaluateWakeReviewTrigger({
      wakeKind: HANDOFF_WAKE_KIND,
      sessionId: fixture.sessionId,
      prNumber: fixture.prNumber,
      wakeReceivedMs,
      nowMs: wakeReceivedMs + HANDOFF_RECEIPT_TO_RUN_MAX_MS + 1,
      admittedBaseRef: 'main',
      admittedHeadSha: pr?.headRefOid ? String(pr.headRefOid) : undefined,
      openPrs: fixture.openPrs,
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      ciChecks: fixture.ciChecksByPr?.[String(fixture.prNumber)],
      requiredCheckNames: fixture.requiredCheckNamesByPr?.[String(fixture.prNumber)],
    });
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).toBe('handoff_receipt_bound_exceeded');
  });

  it('rejects handoff evaluation when admitted head advanced before snapshot', () => {
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const result = evaluateWakeReviewTrigger({
      wakeKind: HANDOFF_WAKE_KIND,
      sessionId: fixture.sessionId,
      prNumber: fixture.prNumber,
      wakeReceivedMs: 1_700_000_000_000,
      nowMs: 1_700_000_000_000,
      admittedBaseRef: 'main',
      admittedHeadSha: 'stale-handoff-head',
      openPrs: fixture.openPrs,
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      ciChecks: fixture.ciChecksByPr?.[String(fixture.prNumber)],
      requiredCheckNames: fixture.requiredCheckNamesByPr?.[String(fixture.prNumber)],
    });
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).toBe('handoff_head_advanced');
  });

  it('resolves URL-only handoff PR number for identity admission', () => {
    expect(parsePrNumberFromPrUrl('https://github.com/chetwerikoff/orchestrator-pack/pull/234')).toBe(234);
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const event = structuredClone(capture.event);
    if (event.data?.subject?.pr) {
      delete event.data.subject.pr.number;
    }
    const admission = evaluateHandoffIdentityAdmission({
      event,
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      openPrs: loadFixture('green-info-handoff-triggers.json').openPrs,
    });
    expect(admission.admitted).toBe(true);
    expect(admission.subject?.prNumber).toBe(234);
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
  it('preRunRecheck uses wakeKind when planned startReason is omitted', () => {
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const pr = fixture.openPrs?.[0];
    expect(pr).toBeDefined();
    const retargetedOpenPrs = fixture.openPrs!.map((openPr) =>
      openPr.number === pr!.number ? { ...openPr, baseRefName: 'release' } : openPr,
    );
    const recheck = evaluateWakePreRunRecheck({
      wakeKind: HANDOFF_WAKE_KIND,
      planned: {
        prNumber: Number(fixture.prNumber),
        headSha: String(pr!.headRefOid),
        sessionId: String(fixture.sessionId),
        admittedBaseRef: 'main',
      },
      fresh: {
        openPrs: retargetedOpenPrs,
        reviewRuns: fixture.reviewRuns,
        sessions: fixture.sessions,
        ciChecks: fixture.ciChecksByPr?.[String(fixture.prNumber)],
      },
    });
    expect(recheck.emitReviewRun).toBe(false);
    expect(recheck.reason).toBe('pre_claim_toctou_base_retargeted');
  });

});

describe('identity admission unit', () => {
  it('evaluates in-project session + open PR as promoted', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const admission = evaluateHandoffIdentityAdmission({
      event: capture.event,
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      supervisedSessions: fixture.sessions,
      openPrs: fixture.openPrs,
    });
    expect(admission.admitted).toBe(true);
    expect(admission.outcome).toBe('promoted');
  });
  it('rejects handoff missing project identity when supervised', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const event = structuredClone(capture.event);
    delete event.projectId;
    if (event.data?.subject?.session) {
      delete event.data.subject.session.projectId;
    }
    const admission = evaluateHandoffIdentityAdmission({
      event,
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      openPrs: loadFixture('green-info-handoff-triggers.json').openPrs,
    });
    expect(admission.admitted).toBe(false);
    expect(admission.reason).toBe('missing_project_identity');
  });

  it('rejects handoff missing repository identity when supervised', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const event = structuredClone(capture.event);
    if (event.data?.subject?.pr) {
      delete event.data.subject.pr.url;
    }
    const admission = evaluateHandoffIdentityAdmission({
      event,
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      openPrs: loadFixture('green-info-handoff-triggers.json').openPrs,
    });
    expect(admission.admitted).toBe(false);
    expect(admission.reason).toBe('missing_repository_identity');
  });

});

  it('records admission with listener receipt timestamp instead of write time', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'handoff-admission-receipt-'));
    const stateRoot = dir;
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/Record-ReviewHandoffWakeAdmission.ps1');
    const listenerReceiptMs = 1_700_000_000_000;
    const script = `
. '${lib.replace(/'/g, "''")}'
$filter = [pscustomobject]@{
  sessionId = 'opk-27'
  projectId = 'orchestrator-pack'
  prNumber = 234
  prUrl = 'https://github.com/chetwerikoff/orchestrator-pack/pull/234'
  handoffAdmission = [pscustomobject]@{
    admittedBaseRef = 'main'
    admittedHeadSha = 'handoff234'
    audit = [pscustomobject]@{ priority = 'info' }
  }
}
$result = Record-ReviewHandoffWakeAdmission -StateRoot '${stateRoot.replace(/'/g, "''")}' -FilterResult $filter -WakeReceivedMs ${listenerReceiptMs}
if (-not $result.recorded) { throw 'expected admission record' }
$path = Join-Path '${stateRoot.replace(/'/g, "''")}' 'review-handoff-wake-admission.json'
$state = Get-ReviewHandoffWakeAdmissionState -Path $path
$record = $state.records.Values | Select-Object -First 1
if ([long]$record.receivedAtMs -ne ${listenerReceiptMs}) {
  throw "expected receivedAtMs ${listenerReceiptMs}, got $($record.receivedAtMs)"
}
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

describe('handoff admission state persistence', () => {
  it('loads persisted records without PSCustomObject hashtable merge failure', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'handoff-admission-'));
    const statePath = path.join(dir, 'review-handoff-wake-admission.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        records: {
          'orchestrator-pack|chetwerikoff/orchestrator-pack|234|abc': {
            key: 'orchestrator-pack|chetwerikoff/orchestrator-pack|234|abc',
            prNumber: 234,
            sessionId: 'opk-27',
          },
        },
        pendingRetries: {},
        lastUpdatedMs: 1,
      }),
    );
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/Record-ReviewHandoffWakeAdmission.ps1');
    const script = `
. '${lib.replace(/'/g, "''")}'
$state = Get-ReviewHandoffWakeAdmissionState -Path '${statePath.replace(/'/g, "''")}'
if ($state.records.Count -ne 1) { throw "expected 1 record, got $($state.records.Count)" }
if (-not $state.records.ContainsKey('orchestrator-pack|chetwerikoff/orchestrator-pack|234|abc')) { throw 'missing record key' }
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
