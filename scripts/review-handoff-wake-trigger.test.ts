import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateWakePayload, probeReadyForReviewHandoffEnvelope } from '../docs/orchestrator-wake-filter.mjs';
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
  isQualifiedReviewPendingInfoHandoffEnvelope,
  seedHandoffAdmissionRecord,
  seedPendingAdmissionRetry,
  selectHandoffAdmissionReplay,
  parseSupervisedRepoSlugFromGitRemote,
  evaluatePendingAdmissionLookupRetry,
  recordPendingAdmissionLookupAttempt,
  HANDOFF_LOOKUP_RETRY_MAX_IDENTICAL,
  HANDOFF_LOOKUP_RETRY_MIN_SPACING_MS,
} from '../docs/review-handoff-wake-admission.mjs';
import {
  evaluateWakePreRunRecheck,
  evaluateWakeReviewTrigger,
  isEventReviewTriggerWake,
  isHandoffReviewTriggerWake,
  WAKE_TO_RUN_DECISION_MAX_MS,
} from '../docs/review-wake-trigger.mjs';
import { seedWatchFromWakeDefer, isDeferredReevalWatchSeedEligible } from '../docs/review-trigger-reeval.mjs';
import {
  hasTerminalHandoffOutcome,
  planReportStatePollTick,
  REPORT_STATE_SEED_TO_START_MAX_MS,
} from '../docs/review-ready-report-state-seed.mjs';
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


const reviewPendingGreenFixture: HandoffFixture = {
  wakeKind: 'ready_for_review',
  sessionId: 'opk-167',
  prNumber: 389,
  admittedBaseRef: 'main',
  openPrs: [
    {
      number: 389,
      headRefOid: 'pending389',
      headCommittedAt: '2026-06-21T15:40:00.000Z',
      baseRefName: 'main',
    },
  ],
  reviewRuns: [],
  sessions: [
    {
      name: 'opk-167',
      role: 'worker',
      prNumber: 389,
      status: 'ready_for_review',
      reports: [{ reportState: 'ready_for_review', reportedAt: '2026-06-21T15:46:00.000Z' }],
    },
  ],
  ciChecksByPr: {
    '389': [
      { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
      { name: 'PR scope guard', state: 'SUCCESS' },
      { name: 'Run pack contract tests', state: 'SUCCESS' },
      { name: 'Self-architect lint', state: 'SUCCESS' },
    ],
  },
  requiredCheckNamesByPr: {
    '389': [
      'Verify orchestrator-pack structure',
      'PR scope guard',
      'Run pack contract tests',
      'Self-architect lint',
    ],
  },
};

const reviewPendingNotReadyFixture: HandoffFixture = {
  ...reviewPendingGreenFixture,
  sessions: [
    {
      name: 'opk-167',
      role: 'worker',
      prNumber: 389,
      status: 'working',
      reports: [{ reportState: 'working', reportedAt: '2026-06-21T15:46:00.000Z' }],
    },
  ],
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
    admittedBaseRef: fixture.admittedBaseRef ?? (pr?.baseRefName ? String(pr.baseRefName) : undefined),
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
    expect(result.planned?.startReason).toBe('handoff_wake');
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

  it('AC8: rejects mismatched envelope and subject session ids', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    capture.event.sessionId = 'opk-supervised';
    capture.event.data.subject.session.id = 'opk-foreign';
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const result = evaluateWakePayload(capture, {
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      supervisedSessions: fixture.sessions,
      openPrs: fixture.openPrs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('session_identity_mismatch');
    }
  });

  it('AC16: supervised repository lookup failure is retryable unknown', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const result = evaluateWakePayload(capture, {
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: '',
      supervisedRepoLookupFailed: true,
      supervisedSessions: fixture.sessions,
      openPrs: fixture.openPrs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('admission_lookup_unknown');
      expect(result.retryable).toBe(true);
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

  it('rejects handoffs when open PR snapshot omits base ref', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const openPrs = fixture.openPrs!.map((openPr) => {
      const { baseRefName: _baseRefName, baseRef: _baseRef, ...rest } = openPr as {
        baseRefName?: string;
        baseRef?: string;
      } & typeof openPr;
      return rest;
    });
    const result = evaluateWakePayload(capture, {
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      supervisedSessions: fixture.sessions,
      openPrs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_base_ref');
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


  it('AC16: retains pending retry for transient trigger failures within receipt window', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'handoff-retry-'));
    const bodyJson = readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8');
    const seed = seedPendingAdmissionRetry({ existing: {}, bodyJson, nowMs: Date.now() - 5_000 });
    expect(seed.seeded).toBe(true);
    writeFileSync(
      path.join(dir, 'review-handoff-wake-admission.json'),
      JSON.stringify({ records: {}, pendingRetries: seed.pendingRetries, lastUpdatedMs: 1 }),
    );
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/Record-ReviewHandoffWakeAdmission.ps1');
    const stateRoot = dir.replace(/'/g, "''");
    const script = [
      `. '${lib.replace(/'/g, "''")}'`,
      '$filter = [pscustomobject]@{',
      '  ok = $true',
      "  wakeKind = 'ready_for_review'",
      "  sessionId = 'opk-27'",
      "  projectId = 'orchestrator-pack'",
      '  prNumber = 234',
      "  prUrl = 'https://github.com/chetwerikoff/orchestrator-pack/pull/234'",
      "  wakeMessage = 'wake ready_for_review session=opk-27 pr=#234'",
      '  handoffAdmission = @{ admittedBaseRef = \'main\'; admittedHeadSha = \'abc123\'; audit = @{} }',
      '}',
      `Invoke-ReviewHandoffWakeAdmissionRecovery -StateRoot '${stateRoot}' -ListenerReadyMs 1700000010000 -PendingRetriesOnly \``,
      '  -InvokeWakeFilter { param($BodyJson,$OpenPrs,$Failed) return $filter } `',
      '  -ResolveOpenPrs { return @(@{ number = 234; headRefOid = \'abc123\'; baseRefName = \'main\' }) } `',
      "  -InvokeTrigger { param($FilterResult,$WakeReceivedMs) return @{ triggerResult = @{ triggered = $false; reason = 'side_effect_in_flight' } } } `",
      '  -LogWriter { param($Message) }',
      `$state = Get-ReviewHandoffWakeAdmissionState -Path (Join-Path '${stateRoot}' 'review-handoff-wake-admission.json')`,
      'if ($state.pendingRetries.Count -ne 1) { throw "expected pending retry retained, got $($state.pendingRetries.Count)" }',
    ].join('\n');
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'pwsh failed');
    }
  });


  it('AC16: clears pending retry when receipt window expired before recovery trigger', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'handoff-retry-expired-'));
    const bodyJson = readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8');
    const seed = seedPendingAdmissionRetry({ existing: {}, bodyJson, nowMs: 1_000_000_000_000 });
    expect(seed.seeded).toBe(true);
    writeFileSync(
      path.join(dir, 'review-handoff-wake-admission.json'),
      JSON.stringify({ records: {}, pendingRetries: seed.pendingRetries, lastUpdatedMs: 1 }),
    );
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/Record-ReviewHandoffWakeAdmission.ps1');
    const stateRoot = dir.replace(/'/g, "''");
    const script = [
      `. '${lib.replace(/'/g, "''")}'`,
      '$filter = [pscustomobject]@{',
      '  ok = $true',
      "  wakeKind = 'ready_for_review'",
      "  sessionId = 'opk-27'",
      "  projectId = 'orchestrator-pack'",
      '  prNumber = 234',
      "  prUrl = 'https://github.com/chetwerikoff/orchestrator-pack/pull/234'",
      "  wakeMessage = 'wake ready_for_review session=opk-27 pr=#234'",
      '  handoffAdmission = @{ admittedBaseRef = \'main\'; admittedHeadSha = \'abc123\'; audit = @{} }',
      '}',
      `Invoke-ReviewHandoffWakeAdmissionRecovery -StateRoot '${stateRoot}' -ListenerReadyMs 1700000010000 -PendingRetriesOnly \``,
      '  -InvokeWakeFilter { param($BodyJson,$OpenPrs,$Failed) return $filter } `',
      '  -ResolveOpenPrs { return @(@{ number = 234; headRefOid = \'abc123\'; baseRefName = \'main\' }) } `',
      "  -InvokeTrigger { throw 'trigger should not run for expired receipt window' } `",
      '  -LogWriter { param($Message) }',
      `$state = Get-ReviewHandoffWakeAdmissionState -Path (Join-Path '${stateRoot}' 'review-handoff-wake-admission.json')`,
      'if ($state.pendingRetries.Count -ne 0) { throw "expected expired pending retry cleared, got $($state.pendingRetries.Count)" }',
    ].join('\n');
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'pwsh failed');
    }
  });

  it('AC16: clears pending retry when recovery trigger returns handoff_receipt_bound_exceeded', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'handoff-retry-bound-'));
    const bodyJson = readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8');
    const seed = seedPendingAdmissionRetry({ existing: {}, bodyJson, nowMs: Date.now() - 5_000 });
    expect(seed.seeded).toBe(true);
    writeFileSync(
      path.join(dir, 'review-handoff-wake-admission.json'),
      JSON.stringify({ records: {}, pendingRetries: seed.pendingRetries, lastUpdatedMs: 1 }),
    );
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/Record-ReviewHandoffWakeAdmission.ps1');
    const stateRoot = dir.replace(/'/g, "''");
    const script = [
      `. '${lib.replace(/'/g, "''")}'`,
      '$filter = [pscustomobject]@{',
      '  ok = $true',
      "  wakeKind = 'ready_for_review'",
      "  sessionId = 'opk-27'",
      "  projectId = 'orchestrator-pack'",
      '  prNumber = 234',
      "  prUrl = 'https://github.com/chetwerikoff/orchestrator-pack/pull/234'",
      "  wakeMessage = 'wake ready_for_review session=opk-27 pr=#234'",
      '  handoffAdmission = @{ admittedBaseRef = \'main\'; admittedHeadSha = \'abc123\'; audit = @{} }',
      '}',
      `Invoke-ReviewHandoffWakeAdmissionRecovery -StateRoot '${stateRoot}' -ListenerReadyMs 1700000010000 -PendingRetriesOnly \``,
      '  -InvokeWakeFilter { param($BodyJson,$OpenPrs,$Failed) return $filter } `',
      '  -ResolveOpenPrs { return @(@{ number = 234; headRefOid = \'abc123\'; baseRefName = \'main\' }) } `',
      "  -InvokeTrigger { param($FilterResult,$WakeReceivedMs) return @{ triggerResult = @{ triggered = $false; reason = 'handoff_receipt_bound_exceeded' } } } `",
      '  -LogWriter { param($Message) }',
      `$state = Get-ReviewHandoffWakeAdmissionState -Path (Join-Path '${stateRoot}' 'review-handoff-wake-admission.json')`,
      'if ($state.pendingRetries.Count -ne 0) { throw "expected terminal pending retry cleared, got $($state.pendingRetries.Count)" }',
    ].join('\n');
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'pwsh failed');
    }
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




describe('review.pending info handoff admission (Issue #390)', () => {
  function loadReviewPendingCapture() {
    return JSON.parse(
      readFileSync(path.join(captureDir, 'review_pending.raw.json'), 'utf8'),
    );
  }

  function reviewPendingAdmissionContext(fixture?: HandoffFixture) {
    return {
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      supervisedSessions: fixture?.sessions ?? [],
      openPrs: fixture?.openPrs ?? [],
    };
  }

  it('classifies capture-backed review_pending envelope', () => {
    const capture = loadReviewPendingCapture();
    expect(isQualifiedReviewPendingInfoHandoffEnvelope(capture, capture.event)).toBe(true);
    expect(isReadyForReviewHandoffEnvelope(capture, capture.event)).toBe(true);
    expect(probeReadyForReviewHandoffEnvelope(capture)).toEqual({ handoffEnvelope: true });
  });

  it('live envelope admission promotes info review.pending through handoff evaluate', () => {
    const capture = loadReviewPendingCapture();
    const fixture = reviewPendingGreenFixture;
    const wake = evaluateWakePayload(capture, reviewPendingAdmissionContext(fixture));
    expect(wake.ok).toBe(true);
    if (wake.ok) {
      expect(wake.wakeKind).toBe('ready_for_review');
      expect(wake.wakeKind).not.toBe('review.changes_requested');
      expect(wake.handoffAdmission?.promotedFromInfoPriority).toBe(true);
      expect(wake.handoffAdmission?.auditLine).toContain('outcome=promoted');
    }
  });

  it('#195-ready recurrence reaches handoff_wake within receipt bound', () => {
    const fixture = reviewPendingGreenFixture;
    const receiptMs = 1_700_000_000_000;
    const runCreatedMs = receiptMs + 2_000;
    const result = evaluateHandoffFixture(fixture, runCreatedMs);
    expect(result.triggerReviewRun).toBe(true);
    expect(result.withinLatencyBound).toBe(true);
    expect(result.processingMs).toBeLessThanOrEqual(HANDOFF_RECEIPT_TO_RUN_MAX_MS);
  });

  it('#195-not-ready defer is auditable and not info_priority drop', () => {
    const capture = loadReviewPendingCapture();
    const fixture = reviewPendingNotReadyFixture;
    const wake = evaluateWakePayload(capture, reviewPendingAdmissionContext(fixture));
    expect(wake.ok).toBe(true);
    if (wake.ok) {
      expect(wake.wakeKind).toBe('ready_for_review');
    }

    const result = evaluateHandoffFixture(fixture);
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).not.toBe('info_priority');
  });

  it('info-storm negative control without handoff semantic stays dropped', () => {
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
      reviewPendingAdmissionContext(),
    );
    expect(result).toEqual({ ok: false, reason: 'info_priority', detail: 'info' });
  });

  it('discriminator negative controls fail qualification independently', () => {
    const capture = loadReviewPendingCapture();
    const variants = [
      { mutate: (event: Record<string, unknown>) => { event.type = 'session.working'; } },
      { mutate: (event: Record<string, unknown>) => {
        const data = event.data as Record<string, unknown>;
        data.semanticType = 'ready_for_review';
      } },
      { mutate: (event: Record<string, unknown>) => { event.priority = 'action'; } },
      { mutate: (event: Record<string, unknown>) => {
        const data = event.data as Record<string, unknown>;
        data.schemaVersion = 2;
      } },
    ];
    for (const variant of variants) {
      const body = structuredClone(capture);
      variant.mutate(body.event);
      expect(isQualifiedReviewPendingInfoHandoffEnvelope(body, body.event)).toBe(false);
      const wake = evaluateWakePayload(body, reviewPendingAdmissionContext());
      if (body.event.priority === 'action' && body.event.type === 'review.pending') {
        expect(wake.ok).toBe(true);
        if (wake.ok) {
          expect(wake.wakeKind).toBe('review.changes_requested');
        }
      } else if (body.event.priority === 'info') {
        expect(wake.ok).toBe(false);
        if (!wake.ok) {
          expect(wake.reason).toBe('info_priority');
        }
      }
    }
  });

  it('manifest honesty: review_pending representative, ready_for_review webhook not', () => {
    const reviewPendingProv = JSON.parse(
      readFileSync(path.join(captureDir, 'review_pending.provenance.json'), 'utf8'),
    );
    const readyForReviewProv = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.provenance.json'), 'utf8'),
    );
    expect(reviewPendingProv.representative).toBe(true);
    expect(readyForReviewProv.representative).toBe(false);
  });
});

describe('parseSupervisedRepoSlugFromGitRemote', () => {
  it('preserves dots in repository names and strips optional .git suffix', () => {
    expect(parseSupervisedRepoSlugFromGitRemote('git@github.com:owner/foo.bar.git')).toBe('owner/foo.bar');
    expect(parseSupervisedRepoSlugFromGitRemote('https://github.com/owner/foo.bar.git')).toBe('owner/foo.bar');
    expect(parseSupervisedRepoSlugFromGitRemote('https://github.com/owner/foo.bar')).toBe('owner/foo.bar');
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
    const nowMs = listenerReadyMs + 2_000;
    const seed = seedHandoffAdmissionRecord({
      existing: {},
      admission: {
        subject: {
          projectId: 'orchestrator-pack',
          prNumber: 234,
          prUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/234',
          sessionId: 'opk-27',
          priority: 'info',
          eventId: 'evt-ready-for-review-info',
          receivedAtMs: nowMs - 2_000,
        },
        admittedHeadSha: 'handoff234',
        admittedBaseRef: 'main',
        outcome: 'promoted',
      },
      nowMs: nowMs - 2_000,
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
    });
    const replay = selectHandoffAdmissionReplay({
      records: seed.records,
      listenerReadyMs,
      nowMs,
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
    }) as { replay: Array<{ withinRecoveryBound?: boolean }> };
    expect(replay.replay).toHaveLength(1);
    expect(replay.replay[0]?.withinRecoveryBound).toBe(true);

    const stale = selectHandoffAdmissionReplay({
      records: seed.records,
      listenerReadyMs,
      nowMs: listenerReadyMs + HANDOFF_LISTENER_RECOVERY_MAX_MS + 1_000,
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
    }) as { replay: Array<{ withinRecoveryBound?: boolean }> };
    expect(stale.replay).toHaveLength(0);
  });

  it('AC13: replay preserves original receipt timestamp for retained admissions', () => {
    const listenerReadyMs = 1_700_000_100_000;
    const originalReceipt = listenerReadyMs - 5_000;
    const seed = seedHandoffAdmissionRecord({
      existing: {},
      admission: {
        subject: {
          projectId: 'orchestrator-pack',
          prNumber: 234,
          prUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/234',
          sessionId: 'opk-27',
          priority: 'info',
          eventId: 'evt-ready-for-review-info',
          receivedAtMs: originalReceipt,
        },
        admittedHeadSha: 'handoff234',
        admittedBaseRef: 'main',
        outcome: 'promoted',
      },
      nowMs: originalReceipt,
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
    });
    const replay = selectHandoffAdmissionReplay({
      records: seed.records,
      listenerReadyMs,
      nowMs: listenerReadyMs + 5_000,
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
    }) as { replay: Array<{ withinRecoveryBound?: boolean; originalReceivedAtMs?: number; replayReceivedAtMs?: number }> };
    expect(replay.replay[0]?.withinRecoveryBound).toBe(true);
    expect(replay.replay[0]?.originalReceivedAtMs).toBe(originalReceipt);
    expect(replay.replay[0]?.replayReceivedAtMs).toBeUndefined();
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


  it('rejects handoff evaluation when admitted base ref is missing', () => {
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const pr = fixture.openPrs?.[0];
    const result = evaluateWakeReviewTrigger({
      wakeKind: HANDOFF_WAKE_KIND,
      sessionId: fixture.sessionId,
      prNumber: fixture.prNumber,
      wakeReceivedMs: 1_700_000_000_000,
      nowMs: 1_700_000_000_000,
      admittedHeadSha: pr?.headRefOid ? String(pr.headRefOid) : undefined,
      openPrs: fixture.openPrs,
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      ciChecks: fixture.ciChecksByPr?.[String(fixture.prNumber)],
      requiredCheckNames: fixture.requiredCheckNamesByPr?.[String(fixture.prNumber)],
    });
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).toBe('missing_admitted_base_ref');
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
  it('merge.ready completion wake does not emit handoff claim audit lines', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(fixturesDir, '../review-wake-trigger/green-wake-triggers.json'), 'utf8'),
    );
    const wakeSha = String(fixture.openPrs?.[0]?.headRefOid ?? 'abc123');
    const triggerLib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/Invoke-ReviewWakeTrigger.ps1');
    const claimLib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/Review-StartClaim.ps1');
    const dir = mkdtempSync(path.join(tmpdir(), 'handoff-claim-audit-'));
    const dirEscaped = dir.replace(/'/g, "''");
    const claimLibEscaped = claimLib.replace(/'/g, "''");
    const triggerLibEscaped = triggerLib.replace(/'/g, "''");
    const script = [
      `. '${claimLibEscaped}'`,
      `. '${triggerLibEscaped}'`,
      `$env:AO_REVIEW_CLAIM_DIR = '${dirEscaped}'`,
      '$logs = New-Object System.Collections.Generic.List[string]',
      `function Invoke-GhOpenPrList { param([string]$RepoRoot) @(@{ number = 42; headRefOid = '${wakeSha}'; baseRefName = 'main' }) }`,
      "function Get-WorkerStatusDecisionSessions { @(@{ name = 'opk-11'; role = 'worker'; prNumber = 42; status = 'idle'; reports = @() }) }",
      'function Get-GhChecksBundleByPr {',
      '  param([string]$RepoRoot, [array]$OpenPrs, [scriptblock]$MergeRequiredNames, [string]$ProtectionLookupWarningTemplate)',
      "  @{ ciChecksByPr = @{ '42' = @() }; requiredCheckNamesByPr = @{ '42' = @() }; requiredCheckLookupFailedByPr = @{ '42' = $false } }",
      '}',
      'function Get-AoReviewRuns { param([string]$Project) @() }',
      'function Get-ReviewWakeCycleStateFromReconcile { @{} }',
      '$null = Invoke-ReviewWakeTriggerOnCompletionWake -FilterResult @{',
      '  ok = $true',
      "  wakeKind = 'merge.ready'",
      '  prNumber = 42',
      "  sessionId = 'opk-11'",
      `} -ProjectId 'orchestrator-pack' -ReviewCommand 'echo review' -RepoRoot '.' -StateRoot '${dirEscaped}' -DryRun -LogWriter {`,
      '  param([string]$Message)',
      '  $logs.Add([string]$Message) | Out-Null',
      '}',
      "$logs -join '\n'",
    ].join('\n');
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8', cwd: path.dirname(fileURLToPath(import.meta.url)) });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'pwsh failed');
    }
    const joined = result.stdout;
    expect(joined).not.toMatch(/claim=(win|loss)/);
    expect(joined).not.toMatch(/outcome=claim_(win|loss)/);
  });

  it('records post-run retry ledger only after handoff receipt bound check', () => {
    const triggerLib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/Invoke-ReviewWakeTrigger.ps1');
    const src = readFileSync(triggerLib, 'utf8');
    const fenceBlockStart = src.indexOf('$handoffReceiptAbort = $false');
    expect(fenceBlockStart).toBeGreaterThan(-1);
    const handoffIdx = src.indexOf('if ($isHandoffWake) {', fenceBlockStart);
    const ledgerIdx = src.indexOf('Register-PostRunAutonomousRetryAttemptFromClaim', fenceBlockStart);
    const triggerIdx = src.indexOf('Invoke-AoReviewTriggerForWorker', fenceBlockStart);
    expect(handoffIdx).toBeGreaterThan(-1);
    expect(ledgerIdx).toBeGreaterThan(handoffIdx);
    expect(triggerIdx).toBeGreaterThan(ledgerIdx);
  });

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

  it('preRunRecheck rejects handoff when admitted base ref is missing', () => {
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const pr = fixture.openPrs?.[0];
    expect(pr).toBeDefined();
    const recheck = evaluateWakePreRunRecheck({
      wakeKind: HANDOFF_WAKE_KIND,
      planned: {
        prNumber: Number(fixture.prNumber),
        headSha: String(pr!.headRefOid),
        sessionId: String(fixture.sessionId),
        startReason: 'handoff_wake',
      },
      fresh: {
        openPrs: fixture.openPrs,
        reviewRuns: fixture.reviewRuns,
        sessions: fixture.sessions,
        ciChecks: fixture.ciChecksByPr?.[String(fixture.prNumber)],
      },
    });
    expect(recheck.emitReviewRun).toBe(false);
    expect(recheck.reason).toBe('missing_admitted_base_ref');
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


  it('refuses to seed admission records without admitted base ref', () => {
    const seed = seedHandoffAdmissionRecord({
      existing: {},
      admission: {
        subject: {
          projectId: 'orchestrator-pack',
          prNumber: 234,
          prUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/234',
          sessionId: 'opk-27',
          priority: 'info',
          receivedAtMs: 1_700_000_000_000,
        },
        admittedHeadSha: 'handoff234',
        outcome: 'promoted',
      },
      nowMs: 1_700_000_000_000,
    });
    expect(seed.seeded).toBe(false);
    expect(seed.reason).toBe('missing_admitted_base_ref');
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

describe('handoff lookup degrade on admission failure (Issue #418)', () => {
  const capture = () =>
    JSON.parse(readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'));

  it('names openPr lookup dimension in audit', () => {
    const result = evaluateHandoffIdentityAdmission({
      event: capture().event,
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      openPrLookupFailed: true,
    });
    expect(result.reason).toBe('admission_lookup_unknown');
    expect(result.audit.lookupDimension).toBe('openPr');
    expect(formatHandoffWakeAuditLine(result.audit)).toContain('lookupDimension=openPr');
  });

  it('names session lookup dimension in audit', () => {
    const result = evaluateHandoffIdentityAdmission({
      event: capture().event,
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      supervisedSessions: [],
      sessionLookupFailed: true,
    });
    expect(result.audit.lookupDimension).toBe('session');
    expect(formatHandoffWakeAuditLine(result.audit)).toContain('lookupDimension=session');
  });

  it('names supervisedRepo lookup dimension in audit', () => {
    const result = evaluateHandoffIdentityAdmission({
      event: capture().event,
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      supervisedRepoLookupFailed: true,
      openPrs: loadFixture('green-info-handoff-triggers.json').openPrs,
    });
    expect(result.audit.lookupDimension).toBe('supervisedRepo');
    expect(formatHandoffWakeAuditLine(result.audit)).toContain('lookupDimension=supervisedRepo');
  });

  it('resets lookup attempt counts when failure dimension changes', () => {
    const bodyJson = JSON.stringify(capture());
    const t0 = 1_700_000_000_000;
    const seed = seedPendingAdmissionRetry({
      existing: {},
      bodyJson,
      lookupDimension: 'openPr',
      nowMs: t0,
    });
    const key = String(seed.key);
    let pending = seed.pendingRetries as Record<string, Record<string, unknown>>;
    const afterOpenPr = recordPendingAdmissionLookupAttempt({
      existing: pending,
      key,
      lookupDimension: 'openPr',
      nowMs: t0 + HANDOFF_LOOKUP_RETRY_MIN_SPACING_MS,
    });
    expect(afterOpenPr.recorded).toBe(true);
    expect(Number((afterOpenPr.record as Record<string, unknown>).lookupAttemptCount)).toBe(2);

    const dimensionSwitch = seedPendingAdmissionRetry({
      existing: afterOpenPr.pendingRetries as Record<string, Record<string, unknown>>,
      bodyJson,
      lookupDimension: 'session',
      nowMs: t0 + HANDOFF_LOOKUP_RETRY_MIN_SPACING_MS * 2,
    });
    expect(dimensionSwitch.seeded).toBe(true);
    const switched = dimensionSwitch.record as Record<string, unknown>;
    expect(switched.lookupDimension).toBe('session');
    expect(switched.failureIdentity).toContain('session|');
    expect(Number(switched.lookupAttemptCount)).toBe(1);
    expect(switched.lookupDegraded).toBe(false);

    const sessionAttempt = recordPendingAdmissionLookupAttempt({
      existing: dimensionSwitch.pendingRetries as Record<string, Record<string, unknown>>,
      key,
      lookupDimension: 'session',
      nowMs: t0 + HANDOFF_LOOKUP_RETRY_MIN_SPACING_MS * 3,
    });
    expect(Number((sessionAttempt.record as Record<string, unknown>).lookupAttemptCount)).toBe(2);
    expect((sessionAttempt.record as Record<string, unknown>).lookupDegraded).toBe(false);
  });

  it('bounds identical openPr lookup retries with spacing and degrades', () => {
    const bodyJson = JSON.stringify(capture());
    const t0 = 1_700_000_000_000;
    const seed = seedPendingAdmissionRetry({
      existing: {},
      bodyJson,
      lookupDimension: 'openPr',
      nowMs: t0,
    });
    expect(seed.seeded).toBe(true);
    let record = seed.record as Record<string, unknown>;
    let pending = seed.pendingRetries as Record<string, Record<string, unknown>>;

    const gateFirst = evaluatePendingAdmissionLookupRetry({ record, nowMs: t0 + 1_000 });
    expect(gateFirst.shouldAttempt).toBe(true);

    for (let attempt = 2; attempt <= HANDOFF_LOOKUP_RETRY_MAX_IDENTICAL; attempt += 1) {
      const nowMs = t0 + attempt * HANDOFF_LOOKUP_RETRY_MIN_SPACING_MS;
      const gate = evaluatePendingAdmissionLookupRetry({ record, nowMs });
      expect(gate.shouldAttempt).toBe(true);
      const recorded = recordPendingAdmissionLookupAttempt({
        existing: pending,
        key: String(record.key),
        lookupDimension: 'openPr',
        nowMs,
      });
      expect(recorded.recorded).toBe(true);
      record = recorded.record as Record<string, unknown>;
      pending = recorded.pendingRetries as Record<string, Record<string, unknown>>;
    }

    const exhausted = evaluatePendingAdmissionLookupRetry({
      record,
      nowMs: t0 + HANDOFF_LOOKUP_RETRY_MAX_IDENTICAL * HANDOFF_LOOKUP_RETRY_MIN_SPACING_MS,
    });
    expect(exhausted.shouldAttempt).toBe(false);
    expect(exhausted.reason).toMatch(/lookup_(retry_exhausted|degraded)/);
    expect(exhausted.yieldToBackstop).toBe(true);

    const backoff = evaluatePendingAdmissionLookupRetry({
      record: {
        ...record,
        lookupAttemptCount: 2,
        lookupDegraded: false,
        lastLookupAttemptAtMs: t0,
      },
      nowMs: t0 + 1_000,
    });
    expect(backoff.shouldAttempt).toBe(false);
    expect(backoff.reason).toBe('lookup_retry_backoff');
  });

  it('lookup-degraded pending retry does not block report-state seed', () => {
    const headSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const handoffRecords = {
      'orchestrator-pack|chetwerikoff/orchestrator-pack|418|deadbeefdeadbeefdeadbeefdeadbeefdeadbeef': {
        outcome: 'promoted',
        prNumber: 418,
        headSha,
      },
    };
    expect(
      hasTerminalHandoffOutcome({
        supervisedProject: 'orchestrator-pack',
        repoSlug: 'chetwerikoff/orchestrator-pack',
        prNumber: 418,
        headSha,
        handoffRecords,
      }).terminal,
    ).toBe(false);

    const plan = planReportStatePollTick({
      sessions: [{
        name: 'opk-418',
        role: 'worker',
        prNumber: 418,
        reports: [{
          timestamp: '2026-06-23T10:00:00.000Z',
          reportState: 'ready_for_review',
          accepted: true,
          prNumber: 418,
        }],
      }],
      openPrs: [{
        number: 418,
        headRefOid: headSha,
        headCommittedAt: '2026-06-23T09:59:00.000Z',
        baseRefName: 'main',
      }],
      reviewRuns: [],
      ciChecksByPr: { '418': [{ name: 'PR scope guard', state: 'SUCCESS' }] },
      requiredCheckNamesByPr: { '418': [] },
      requiredCheckLookupFailedByPr: { '418': false },
      handoffRecords,
      nowMs: Date.parse('2026-06-23T10:00:05.000Z'),
    }) as { candidates: unknown[]; nowMs: number };
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.nowMs - Date.parse('2026-06-23T10:00:00.000Z')).toBeLessThanOrEqual(
      REPORT_STATE_SEED_TO_START_MAX_MS,
    );
  });

    it('pwsh recovery stops tight-looping openPr lookup failures', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'handoff-lookup-degrade-'));
    const bodyJson = readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8');
    const t0 = 1_700_000_000_000;
    const seed = seedPendingAdmissionRetry({ existing: {}, bodyJson, lookupDimension: 'openPr', nowMs: t0 });
    const key = String(seed.key);
    const retry = {
      ...(seed.record as Record<string, unknown>),
      lookupAttemptCount: 2,
      lastLookupAttemptAtMs: t0 - HANDOFF_LOOKUP_RETRY_MIN_SPACING_MS - 1,
      lookupDegraded: false,
    };
    writeFileSync(
      path.join(dir, 'review-handoff-wake-admission.json'),
      JSON.stringify({ records: {}, pendingRetries: { [key]: retry }, lastUpdatedMs: t0 }, null, 2),
    );
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/Record-ReviewHandoffWakeAdmission.ps1');
    const stateRoot = dir.replace(/'/g, "''");
    const runRecovery = (label: string) => {
      const script = [
        `. '${lib.replace(/'/g, "''")}'`,
        '$calls = 0',
        `Invoke-ReviewHandoffWakeAdmissionRecovery -StateRoot '${stateRoot}' -ListenerReadyMs ${t0} -PendingRetriesOnly \``,
        `  -InvokeWakeFilter { throw "filter should not run (${label})" } \``,
        '  -ResolveOpenPrs { $script:calls++; throw "gh open pr lookup failed" } `',
        "  -InvokeTrigger { throw 'trigger should not run' } `",
        '  -LogWriter { param($Message) }',
        '$calls',
      ].join('\n');
      return spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    };

    const first = runRecovery('final attempt');
    expect(first.status).toBe(0);
    expect(Number(first.stdout.trim())).toBe(1);
    const stateAfterFirst = JSON.parse(readFileSync(path.join(dir, 'review-handoff-wake-admission.json'), 'utf8'));
    const afterFirst = Object.values(stateAfterFirst.pendingRetries)[0] as Record<string, unknown>;
    expect(Number(afterFirst.lookupAttemptCount)).toBe(HANDOFF_LOOKUP_RETRY_MAX_IDENTICAL);
    expect(afterFirst.lookupDegraded).toBe(true);

    const second = runRecovery('after degrade');
    expect(second.status).toBe(0);
    expect(Number(second.stdout.trim())).toBe(0);
  });

  it('preserves actedOn tombstones and replayCursor on openPr lookup retry writes (#712)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'handoff-lookup-lifecycle-'));
    const bodyJson = readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8');
    const t0 = 1_700_000_000_000;
    const admissionId = 'admission-durable-trigger-712';
    const actedOn = {
      [admissionId]: {
        admissionId,
        reason: 'delete_on_durable_trigger',
        recordedAtMs: t0,
      },
    };
    const seed = seedPendingAdmissionRetry({ existing: {}, bodyJson, lookupDimension: 'openPr', nowMs: t0 });
    const key = String(seed.key);
    writeFileSync(
      path.join(dir, 'review-handoff-wake-admission.json'),
      JSON.stringify(
        {
          records: {},
          pendingRetries: { [key]: seed.record },
          actedOn,
          replayCursor: 3,
          lastUpdatedMs: t0,
        },
        null,
        2,
      ),
    );
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/Record-ReviewHandoffWakeAdmission.ps1');
    const stateRoot = dir.replace(/'/g, "''");
    const script = [
      `. '${lib.replace(/'/g, "''")}'`,
      `Invoke-ReviewHandoffWakeAdmissionRecovery -StateRoot '${stateRoot}' -ListenerReadyMs ${t0} -PendingRetriesOnly \``,
      `  -InvokeWakeFilter { throw 'filter should not run' } \``,
      '  -ResolveOpenPrs { throw "gh open pr lookup failed" } `',
      "  -InvokeTrigger { throw 'trigger should not run' } `",
      '  -LogWriter { param($Message) }',
    ].join('\n');
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'pwsh failed');
    }
    const state = JSON.parse(readFileSync(path.join(dir, 'review-handoff-wake-admission.json'), 'utf8'));
    expect(state.actedOn?.[admissionId]).toBeTruthy();
    expect(state.replayCursor).toBe(3);
    expect(Object.keys(state.pendingRetries ?? {}).length).toBe(1);
  });

  it('preserves actedOn tombstones and replayCursor on admission_lookup_unknown retry writes (#712)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'handoff-admission-lookup-lifecycle-'));
    const bodyJson = readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8');
    const t0 = 1_700_000_000_000;
    const admissionId = 'admission-lookup-unknown-712';
    const actedOn = {
      [admissionId]: {
        admissionId,
        reason: 'delete_on_durable_trigger',
        recordedAtMs: t0,
      },
    };
    const seed = seedPendingAdmissionRetry({ existing: {}, bodyJson, lookupDimension: 'session', nowMs: t0 });
    const key = String(seed.key);
    writeFileSync(
      path.join(dir, 'review-handoff-wake-admission.json'),
      JSON.stringify(
        {
          records: {},
          pendingRetries: { [key]: seed.record },
          actedOn,
          replayCursor: 5,
          lastUpdatedMs: t0,
        },
        null,
        2,
      ),
    );
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/Record-ReviewHandoffWakeAdmission.ps1');
    const stateRoot = dir.replace(/'/g, "''");
    const script = [
      `. '${lib.replace(/'/g, "''")}'`,
      '$filter = @{',
      '  ok = $false',
      "  retryable = $true",
      "  reason = 'admission_lookup_unknown'",
      "  audit = @{ lookupDimension = 'session' }",
      '}',
      `Invoke-ReviewHandoffWakeAdmissionRecovery -StateRoot '${stateRoot}' -ListenerReadyMs ${t0} -PendingRetriesOnly \``,
      '  -InvokeWakeFilter { param($BodyJson,$OpenPrs,$Failed) return $filter } `',
      '  -ResolveOpenPrs { return @() } `',
      "  -InvokeTrigger { throw 'trigger should not run' } `",
      '  -LogWriter { param($Message) }',
    ].join('\n');
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'pwsh failed');
    }
    const state = JSON.parse(readFileSync(path.join(dir, 'review-handoff-wake-admission.json'), 'utf8'));
    expect(state.actedOn?.[admissionId]).toBeTruthy();
    expect(state.replayCursor).toBe(5);
    expect(Object.keys(state.pendingRetries ?? {}).length).toBe(1);
  });


  it('regression: successful lookups still promote handoff within receipt bound', () => {
    const fixture = loadFixture('green-info-handoff-triggers.json');
    const pr = fixture.openPrs?.[0];
    const wakeReceivedMs = 1_700_000_000_000;
    const result = evaluateWakeReviewTrigger({
      wakeKind: HANDOFF_WAKE_KIND,
      sessionId: fixture.sessionId,
      prNumber: fixture.prNumber,
      wakeReceivedMs,
      nowMs: wakeReceivedMs + 2_000,
      admittedBaseRef: 'main',
      admittedHeadSha: pr?.headRefOid ? String(pr.headRefOid) : undefined,
      openPrs: fixture.openPrs,
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      ciChecks: fixture.ciChecksByPr?.[String(fixture.prNumber)],
      requiredCheckNames: fixture.requiredCheckNamesByPr?.[String(fixture.prNumber)],
    });
    expect(result.triggerReviewRun).toBe(true);
    expect(result.withinReceiptBound).toBe(true);
  });
});

