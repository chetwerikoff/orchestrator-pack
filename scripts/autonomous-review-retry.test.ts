// @ts-nocheck
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyPostRunFailure,
  enrichReviewRun,
  enrichReviewRuns,
  evaluatePostRunRetryDecision,
  FAILURE_CLASS_UNKNOWN,
  INFRA_NO_TRUSTWORTHY_VERDICT_ESCALATION,
  isPreLaunchFailureClass,
  resolveFailedRunRetryEligibility,
  shouldRouteNeedsTriageToSend,
  TIMEOUT_NO_VERDICT_FAILURE_CLASS,
  validateSidecarJoin,
} from '../docs/autonomous-review-retry.mjs';
import {
  applyPostRunRetryAttempt,
  postRunLedgerKey,
  readPostRunLedgerEntry,
  recordManualOperatorRetryAudit,
} from '../docs/post-run-retry-ledger.mjs';
import {
  evaluateOrchestratorTurnGate,
  evaluateAutonomousReviewRunBoundary,
  evaluateScenarioMatrixCell,
} from '../docs/orchestrator-claimed-review-run.mjs';
import { evaluateWakeReviewTrigger } from '../docs/review-wake-trigger.mjs';
import { preRunHeadReadyRecheck } from '../docs/review-head-ready.mjs';
import { fingerprintRun } from '../docs/review-run-liveness.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'autonomous-review-retry',
);

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as T;
}

function evidenceForFixture(fixture: {
  rawRun?: Record<string, unknown>;
  run?: Record<string, unknown>;
  sidecar?: Record<string, unknown>;
  artifact?: Record<string, unknown>;
  pointer?: Record<string, unknown>;
}) {
  const run = fixture.rawRun ?? fixture.run;
  const artifact = fixture.sidecar ?? fixture.artifact;
  const runId = String(run?.id ?? '');
  if (!runId || !artifact) {
    return {};
  }
  return {
    [runId]: {
      artifact,
      pointer: fixture.pointer,
    },
  };
}

describe('autonomous-review-retry', () => {
  it('enriches PR #528-class timeout from sidecar when raw termination is generic', () => {
    const fixture = loadFixture<{
      rawRun: Record<string, unknown>;
      sidecar: Record<string, unknown>;
      pointer: Record<string, unknown>;
      expect: { failureClass: string; retryEligible: boolean };
    }>('pr528-timeout-sidecar.json');

    const artifact = { ...fixture.sidecar, runFingerprint: fingerprintRun(fixture.rawRun) };
    const enriched = enrichReviewRun(fixture.rawRun, {
      evidenceByRunId: {
        [String(fixture.rawRun.id)]: { artifact, pointer: fixture.pointer },
      },
      allRuns: [fixture.rawRun],
    });

    expect(enriched.failureClass).toBe(fixture.expect.failureClass);
    expect(enriched.retryEligible).toBe(fixture.expect.retryEligible);
  });

  it('allows first bounded autonomous retry for timeout_no_verdict via shared decision', () => {
    const fixture = loadFixture<typeof import('./fixtures/autonomous-review-retry/pr528-timeout-sidecar.json')>(
      'pr528-timeout-sidecar.json',
    );
    const artifact = { ...fixture.sidecar, runFingerprint: fingerprintRun(fixture.rawRun) };
    const runs = enrichReviewRuns([fixture.rawRun], {
      evidenceByRunId: evidenceForFixture({ ...fixture, sidecar: artifact }),
    });

    const gate = evaluateOrchestratorTurnGate({
      prNumber: 528,
      sessionId: 'opk-528',
      openPrs: [
        {
          number: 528,
          headRefOid: fixture.rawRun.targetSha,
          headCommittedAt: '2026-06-28T00:00:00.000Z',
        },
      ],
      reviewRuns: runs,
      sessions: [
        {
          name: 'opk-528',
          prNumber: 528,
          status: 'working',
          reports: [{ reportState: 'ready_for_review', reportedAt: '2026-06-28T00:00:00.000Z' }],
        },
      ],
      ciChecks: [{ name: 'Verify orchestrator-pack structure', state: 'SUCCESS' }],
      requiredCheckNames: ['Verify orchestrator-pack structure'],
      claimWindow: 'free',
      provenanceAutonomous: true,
    });

    expect(gate.launch).toBe(true);
    expect(['failed_retry_once', 'failed_retry_after_recheck']).toContain(gate.reason);
  });

  it('shares the same retry decision across wake and orchestrator turn gates', () => {
    const fixture = loadFixture<typeof import('./fixtures/autonomous-review-retry/pr528-timeout-sidecar.json')>(
      'pr528-timeout-sidecar.json',
    );
    const artifact = { ...fixture.sidecar, runFingerprint: fingerprintRun(fixture.rawRun) };
    const runs = enrichReviewRuns([fixture.rawRun], {
      evidenceByRunId: evidenceForFixture({ ...fixture, sidecar: artifact }),
    });

    const wake = evaluateWakeReviewTrigger({
      wakeKind: 'merge.ready',
      sessionId: 'opk-528',
      prNumber: 528,
      openPrs: [{ number: 528, headRefOid: fixture.rawRun.targetSha, headCommittedAt: '2026-06-28T00:00:00.000Z' }],
      reviewRuns: runs,
      sessions: [
        {
          name: 'opk-528',
          prNumber: 528,
          reports: [{ reportState: 'ready_for_review', reportedAt: '2026-06-28T00:00:00.000Z' }],
        },
      ],
      ciChecks: [{ name: 'Verify orchestrator-pack structure', state: 'SUCCESS' }],
      requiredCheckNames: ['Verify orchestrator-pack structure'],
    });

    const turn = evaluateScenarioMatrixCell({
      claimWindow: 'free',
      reviewRuns: runs,
      prNumber: 528,
      headSha: String(fixture.rawRun.targetSha),
    });

    expect(wake.triggerReviewRun).toBe(true);
    expect(turn.launch).toBe(true);
    expect(wake.reason).not.toBe('retry_bound_exhausted');
    expect(turn.reason).toBe('failed_retry_once');
  });

  it('integrates reconcile pre-run recheck with shared post-run retry decision', () => {
    const fixture = loadFixture<typeof import('./fixtures/autonomous-review-retry/pr528-timeout-sidecar.json')>(
      'pr528-timeout-sidecar.json',
    );
    const artifact = { ...fixture.sidecar, runFingerprint: fingerprintRun(fixture.rawRun) };
    const runs = enrichReviewRuns([fixture.rawRun], {
      evidenceByRunId: evidenceForFixture({ ...fixture, sidecar: artifact }),
    });
    const headSha = String(fixture.rawRun.targetSha);

    const recheck = preRunHeadReadyRecheck(
      {
        prNumber: 528,
        headSha,
        sessionId: 'opk-528',
        startReason: 'periodic=reconcile',
      },
      {
        openPrs: [{ number: 528, headRefOid: headSha, headCommittedAt: '2026-06-28T00:00:00.000Z' }],
        reviewRuns: runs,
        sessions: [
          {
            sessionId: 'opk-528',
            name: 'opk-528',
            prNumber: 528,
            reports: [{ reportState: 'ready_for_review', reportedAt: '2026-06-28T00:00:00.000Z' }],
          },
        ],
        ciChecks: [{ name: 'Verify orchestrator-pack structure', state: 'SUCCESS' }],
        requiredCheckNames: ['Verify orchestrator-pack structure'],
      },
    );

    expect(recheck.emitReviewRun).toBe(true);
    expect(recheck.reason).toBe('failed_retry_after_recheck');
  });

  it('denies launch with retry_bound_exhausted after repeated same-class failures', () => {
    const headSha = 'abc53900000000000000000000000000000000000';
    const runs = [
      {
        id: 'timeout-1',
        prNumber: 539,
        targetSha: headSha,
        status: 'failed',
        findingCount: 0,
        terminationReason:
          'reviewer-evidence:{"reviewer":{"failureClass":"timeout_no_verdict"}}',
        createdAt: '2026-06-30T00:00:00.000Z',
      },
      {
        id: 'timeout-2',
        prNumber: 539,
        targetSha: headSha,
        status: 'failed',
        findingCount: 0,
        terminationReason:
          'reviewer-evidence:{"reviewer":{"failureClass":"timeout_no_verdict"}}',
        createdAt: '2026-06-30T01:00:00.000Z',
      },
    ];
    const enriched = enrichReviewRuns(runs);
    const gate = evaluateScenarioMatrixCell({
      claimWindow: 'free',
      reviewRuns: enriched,
      prNumber: 539,
      headSha,
    });
    expect(gate.launch).toBe(false);
    expect(gate.reason).toBe('retry_bound_exhausted');
    expect(gate.coverage.escalationReason).toBeTruthy();
  });

  it('denies launch with retry_bound_exhausted for sidecar-only sibling failures', () => {
    const fixture = loadFixture<typeof import('./fixtures/autonomous-review-retry/pr528-timeout-sidecar.json')>(
      'pr528-timeout-sidecar.json',
    );
    const headSha = String(fixture.rawRun.targetSha);
    const run1 = {
      ...fixture.rawRun,
      id: 'sidecar-timeout-1',
      reviewerSessionId: 'opk-rev-sidecar-1',
      createdAt: '2026-06-30T00:00:00.000Z',
    };
    const run2 = {
      ...fixture.rawRun,
      id: 'sidecar-timeout-2',
      reviewerSessionId: 'opk-rev-sidecar-2',
      createdAt: '2026-06-30T01:00:00.000Z',
    };
    const artifact1 = {
      ...fixture.sidecar,
      runId: 'sidecar-timeout-1',
      reviewerSessionId: 'opk-rev-sidecar-1',
      runFingerprint: fingerprintRun(run1),
    };
    const artifact2 = {
      ...fixture.sidecar,
      runId: 'sidecar-timeout-2',
      reviewerSessionId: 'opk-rev-sidecar-2',
      runFingerprint: fingerprintRun(run2),
    };
    const pointer1 = { ...fixture.pointer, runId: 'sidecar-timeout-1', reviewerSessionId: 'opk-rev-sidecar-1' };
    const pointer2 = { ...fixture.pointer, runId: 'sidecar-timeout-2', reviewerSessionId: 'opk-rev-sidecar-2' };
    const evidenceByRunId = {
      'sidecar-timeout-1': { artifact: artifact1, pointer: pointer1 },
      'sidecar-timeout-2': { artifact: artifact2, pointer: pointer2 },
    };
    const enriched = enrichReviewRuns([run1, run2], { evidenceByRunId });
    const latest = enriched.find((run) => run.id === 'sidecar-timeout-2');
    expect(latest?.failureClass).toBe('timeout_no_verdict');
    expect(latest?.retryEligible).toBe(false);
    expect(latest?.failureCount).toBe(2);

    const gate = evaluateScenarioMatrixCell({
      claimWindow: 'free',
      reviewRuns: enriched,
      prNumber: 528,
      headSha,
    });
    expect(gate.launch).toBe(false);
    expect(gate.reason).toBe('retry_bound_exhausted');
  });

  it('denies retry when ledger records attempt without a second failed run row', () => {
    const headSha = 'abc53900000000000000000000000000000000000';
    const failedRun = {
      id: 'timeout-1',
      prNumber: 539,
      targetSha: headSha,
      status: 'failed',
      findingCount: 0,
      terminationReason:
        'reviewer-evidence:{"reviewer":{"failureClass":"timeout_no_verdict"}}',
      createdAt: '2026-06-30T00:00:00.000Z',
    };
    const ledgerAttempt = applyPostRunRetryAttempt({
      ledger: { entries: {}, manualAudit: [] },
      prNumber: 539,
      headSha,
      failureClass: TIMEOUT_NO_VERDICT_FAILURE_CLASS,
      runId: 'timeout-1',
    });
    const enriched = enrichReviewRuns([failedRun], { ledger: ledgerAttempt.ledger });
    const decision = evaluatePostRunRetryDecision(
      enriched[0],
      enriched,
      539,
      headSha,
      { ledger: ledgerAttempt.ledger },
    );

    expect(decision.failureCount).toBe(1);
    expect(decision.autonomousAttemptCount).toBe(1);
    expect(decision.effectiveFailureCount).toBe(2);
    expect(decision.retryEligible).toBe(false);

    const gate = evaluateScenarioMatrixCell({
      claimWindow: 'free',
      reviewRuns: enriched,
      prNumber: 539,
      headSha,
    });
    expect(gate.launch).toBe(false);
    expect(gate.reason).toBe('retry_bound_exhausted');
  });

  it('resets retry budget on new head SHA', () => {
    const oldHead = 'abc53900000000000000000000000000000000000';
    const newHead = 'def53900000000000000000000000000000000000';
    const exhausted = enrichReviewRuns([
      {
        id: 'old-1',
        prNumber: 539,
        targetSha: oldHead,
        status: 'failed',
        terminationReason:
          'reviewer-evidence:{"reviewer":{"failureClass":"timeout_no_verdict"}}',
        createdAt: '2026-06-30T00:00:00.000Z',
      },
      {
        id: 'old-2',
        prNumber: 539,
        targetSha: oldHead,
        status: 'failed',
        terminationReason:
          'reviewer-evidence:{"reviewer":{"failureClass":"timeout_no_verdict"}}',
        createdAt: '2026-06-30T01:00:00.000Z',
      },
    ]);
    const oldGate = evaluateScenarioMatrixCell({
      claimWindow: 'free',
      reviewRuns: exhausted,
      prNumber: 539,
      headSha: oldHead,
    });
    expect(oldGate.launch).toBe(false);

    const freshHeadRuns = enrichReviewRuns([
      ...exhausted,
      {
        id: 'new-1',
        prNumber: 539,
        targetSha: newHead,
        status: 'failed',
        terminationReason:
          'reviewer-evidence:{"reviewer":{"failureClass":"timeout_no_verdict"}}',
        createdAt: '2026-06-30T02:00:00.000Z',
      },
    ]);
    const newGate = evaluateScenarioMatrixCell({
      claimWindow: 'free',
      reviewRuns: freshHeadRuns,
      prNumber: 539,
      headSha: newHead,
    });
    expect(newGate.launch).toBe(true);
  });

  it('routes needs_triage with unsent findings to send not retry', () => {
    const headSha = 'abc53900000000000000000000000000000000000000';
    const runs = [
      {
        id: 'triage-1',
        prNumber: 539,
        targetSha: headSha,
        status: 'needs_triage',
        openFindingCount: 2,
        sentFindingCount: 0,
      },
    ];
    expect(shouldRouteNeedsTriageToSend(runs, 539, headSha)).toBe(true);
    const gate = evaluateScenarioMatrixCell({
      claimWindow: 'free',
      reviewRuns: runs,
      prNumber: 539,
      headSha,
    });
    expect(gate.launch).toBe(false);
    expect(gate.reason).toBe('head_covered');
  });

  it('fails closed for unknown evidence without fresh sidecar', () => {
    const run = {
      id: 'unknown-1',
      prNumber: 539,
      targetSha: 'abc53900000000000000000000000000000000000',
      status: 'failed',
      findingCount: 0,
      terminationReason: 'Command failed with no structured evidence',
      createdAt: '2026-06-30T00:00:00.000Z',
    };
    const enriched = enrichReviewRun(run, { allRuns: [run] });
    expect(enriched.failureClass).toBe(FAILURE_CLASS_UNKNOWN);
    expect(enriched.retryEligible).toBe(false);
  });

  it('rejects non-retryable post-run classes', () => {
    for (const name of ['non-retryable-auth.json', 'non-retryable-quota.json']) {
      const fixture = loadFixture<{
        failureClass: string;
        terminationReason: string;
        expect: { retryEligible: boolean };
      }>(name);
      const run = {
        id: name,
        prNumber: 539,
        targetSha: 'abc53900000000000000000000000000000000000000',
        status: 'failed',
        findingCount: 0,
        terminationReason: fixture.terminationReason,
        createdAt: '2026-06-30T00:00:00.000Z',
      };
      const enriched = enrichReviewRun(run, { allRuns: [run] });
      expect(enriched.failureClass).toBe(fixture.failureClass);
      expect(enriched.retryEligible).toBe(fixture.expect.retryEligible);
    }
  });

  it('rejects sidecar evidence without by-run pointer', () => {
    const headSha = 'abc53900000000000000000000000000000000000';
    const run = {
      id: 'run-no-pointer',
      prNumber: 539,
      targetSha: headSha,
      reviewerSessionId: 'opk-rev-no-pointer',
      status: 'failed',
      findingCount: 0,
      terminationReason: 'Command failed',
      createdAt: '2026-06-30T00:00:00.000Z',
    };
    const artifact = {
      schemaVersion: 1,
      reviewerSessionId: 'opk-rev-no-pointer',
      runId: 'run-no-pointer',
      phases: [],
      stderrTail:
        'reviewer-evidence:{"reviewer":{"failureClass":"timeout_no_verdict"}}',
    };
    const enriched = enrichReviewRun(run, {
      evidenceByRunId: { 'run-no-pointer': { artifact } },
      allRuns: [run],
    });
    expect(enriched.failureClass).toBe('unknown');
    expect(enriched.retryEligible).toBe(false);
  });

  it('rejects reused reviewer session across unrelated runs on enrich path', () => {
    const headSha = 'abc53900000000000000000000000000000000000';
    const runA = {
      id: 'run-a',
      prNumber: 539,
      targetSha: headSha,
      reviewerSessionId: 'opk-rev-shared',
      status: 'failed',
      findingCount: 0,
      terminationReason: 'Command failed',
      createdAt: '2026-06-30T00:00:00.000Z',
    };
    const runB = {
      id: 'run-b',
      prNumber: 539,
      targetSha: headSha,
      reviewerSessionId: 'opk-rev-shared',
      status: 'failed',
      findingCount: 0,
      terminationReason: 'Command failed',
      createdAt: '2026-06-30T01:00:00.000Z',
    };
    const artifact = {
      schemaVersion: 1,
      reviewerSessionId: 'opk-rev-shared',
      runId: 'run-a',
      phases: [],
      stderrTail:
        'reviewer-evidence:{"reviewer":{"failureClass":"timeout_no_verdict"}}',
    };
    const pointer = {
      schemaVersion: 1,
      runId: 'run-a',
      reviewerSessionId: 'opk-rev-shared',
    };
    const enriched = enrichReviewRun(runA, {
      evidenceByRunId: { 'run-a': { artifact, pointer } },
      allRuns: [runA, runB],
    });
    expect(enriched.failureClass).toBe('unknown');
    expect(enriched.retryEligible).toBe(false);
  });

  it('rejects stale sidecar linkage', () => {
    for (const name of ['sidecar-stale-pointer.json', 'sidecar-fingerprint-mismatch.json']) {
      const fixture = loadFixture<{
        run: Record<string, unknown>;
        artifact: Record<string, unknown>;
        pointer?: Record<string, unknown>;
        expect: { failureClass: string; retryEligible: boolean };
      }>(name);
      const join = validateSidecarJoin(
        fixture.run,
        fixture.artifact,
        fixture.pointer,
        [fixture.run],
      );
      if (name.includes('fingerprint')) {
        expect(join.ok).toBe(false);
      }
      const enriched = enrichReviewRun(fixture.run, {
        evidenceByRunId: evidenceForFixture(fixture),
        allRuns: [fixture.run],
      });
      expect(enriched.failureClass).toBe(fixture.expect.failureClass);
      expect(enriched.retryEligible).toBe(fixture.expect.retryEligible);
    }
  });

  it('blocks duplicate retry when in-flight run covers head', () => {
    const headSha = 'abc53900000000000000000000000000000000000000';
    const runs = [
      {
        id: 'failed-1',
        prNumber: 539,
        targetSha: headSha,
        status: 'failed',
        terminationReason:
          'reviewer-evidence:{"reviewer":{"failureClass":"timeout_no_verdict"}}',
      },
      {
        id: 'inflight-1',
        prNumber: 539,
        targetSha: headSha,
        status: 'running',
      },
    ];
    const gate = evaluateScenarioMatrixCell({
      claimWindow: 'free',
      reviewRuns: enrichReviewRuns(runs),
      prNumber: 539,
      headSha,
    });
    expect(gate.launch).toBe(false);
    expect(gate.reason).toBe('head_covered');
  });

  it('denies raw autonomous ao review run from LLM turn', () => {
    const verdict = evaluateAutonomousReviewRunBoundary({
      commandLine: 'ao review run opk-93 --execute --command ./review.sh',
      autonomousSurface: true,
      claimedBypass: false,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('autonomous_raw_review_run_denied');
  });

  it('audits manual operator retry separately without resetting autonomous ledger', () => {
    const headSha = 'abc53900000000000000000000000000000000000000';
    let ledger = { entries: {}, manualAudit: [] as unknown[] };
    const autonomous = applyPostRunRetryAttempt({
      ledger,
      prNumber: 539,
      headSha,
      failureClass: TIMEOUT_NO_VERDICT_FAILURE_CLASS,
      runId: 'timeout-1',
    });
    ledger = autonomous.ledger;
    const before = readPostRunLedgerEntry({
      ledger,
      prNumber: 539,
      headSha,
      failureClass: TIMEOUT_NO_VERDICT_FAILURE_CLASS,
    });
    expect(before.autonomousAttemptCount).toBe(1);

    const manual = recordManualOperatorRetryAudit({
      ledger,
      prNumber: 539,
      headSha,
      failureClass: TIMEOUT_NO_VERDICT_FAILURE_CLASS,
      runId: 'manual-1',
    });
    const after = readPostRunLedgerEntry({
      ledger: manual.ledger,
      prNumber: 539,
      headSha,
      failureClass: TIMEOUT_NO_VERDICT_FAILURE_CLASS,
    });
    expect(after.autonomousAttemptCount).toBe(1);
    expect(manual.ledger.manualAudit).toHaveLength(1);
    expect(manual.entry.provenance).toBe('manual-operator');
  });

  it('does not increment post-run ledger for pre-launch infra_transport (#516 guard)', () => {
    expect(isPreLaunchFailureClass('infra_transport')).toBe(true);
    const result = applyPostRunRetryAttempt({
      ledger: { entries: {} },
      prNumber: 539,
      headSha: 'abc53900000000000000000000000000000000000000',
      failureClass: 'infra_transport',
      runId: 'prelaunch-1',
    });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('pre_launch_or_missing_class');
    const decision = evaluatePostRunRetryDecision(
      {
        id: 'prelaunch-1',
        prNumber: 539,
        targetSha: 'abc53900000000000000000000000000000000000',
        status: 'failed',
        failureClass: 'infra_transport',
      },
      [],
      539,
      'abc53900000000000000000000000000000000000',
    );
    expect(decision.preLaunchOwnedBy516).toBe(true);
    expect(decision.retryEligible).toBe(false);
  });

  it('emits infra escalation reason for exhausted recoverable infra failures', () => {
    const headSha = 'abc53900000000000000000000000000000000000';
    const runs = enrichReviewRuns([
      {
        id: 'crash-1',
        prNumber: 539,
        targetSha: headSha,
        status: 'failed',
        findingCount: 0,
        terminationReason: 'terminated_by_signal_9 during reviewer wrapper',
        createdAt: '2026-06-30T00:00:00.000Z',
      },
      {
        id: 'crash-2',
        prNumber: 539,
        targetSha: headSha,
        status: 'failed',
        findingCount: 0,
        terminationReason: 'terminated_by_signal_9 during reviewer wrapper',
        createdAt: '2026-06-30T01:00:00.000Z',
      },
    ]);
    const decision = resolveFailedRunRetryEligibility(runs[1], runs, 539, headSha);
    expect(decision.retryEligible).toBe(false);
    expect(decision.escalationReason).toBe(INFRA_NO_TRUSTWORTHY_VERDICT_ESCALATION);
    expect(postRunLedgerKey(539, headSha, 'reviewer_process_crash')).toContain('reviewer_process_crash');
  });
});
