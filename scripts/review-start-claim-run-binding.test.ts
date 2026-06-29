import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { evaluateReclaimDecision } from '../docs/review-start-claim-lifecycle.mjs';
import {
  MISSING_CLAIM_FOR_REVIEW_RUN,
  applyRunBindingToReclaimDecision,
  diagnoseMissingClaimForReviewRun,
  evaluateAutomatedLaunchClaimGate,
  evaluateCursorGuardOffSurface,
  evaluateLaunchPendingRunReconciliation,
  isManualOperatorReviewRun,
  isPackOwnedAutomatedReviewRun,
} from '../docs/review-start-claim-run-binding.mjs';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const bindingLibPath = path.join(repoRoot, 'scripts/lib/Review-StartClaimRunBinding.ps1');
const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');
const claimLibPath = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
const fixturesDir = path.join(repoRoot, 'tests/external-output-references/review-start-claim-run-binding');

const pr519NoClaimHead = 'a7f0e4d190556d2a61082878e82c6e5164f6a31e';
const pr519ReconcileHead = '5a20a5d5c3d590ce6ec041e57a390ea63e39158a';
const pr519RunId = 'review-run-fa05d810-85e6-4f1c-8f06-57d50790c6b5';
const pr519ReviewerSession = 'opk-rev-1072';

function fakeHolder() {
  return {
    surface: 'review-trigger-reeval',
    pid: 424242,
    host: 'test-host',
    processGuid: 'guid-521',
    startTimeTicks: '100',
    bootIdHash: 'boot-a',
  };
}

describe('review-start-claim-run-binding', () => {
  it('review-start-claim-run-binding: launch-without-live-claim-fails-before-run', () => {
    const gate = evaluateAutomatedLaunchClaimGate({
      claim: null,
      prNumber: 519,
      headSha: pr519NoClaimHead,
      projectId: 'orchestrator-pack',
      surface: 'review-trigger-reconcile',
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('missing_live_claim');
    expect(gate.failClosed).toBe(true);

    const activeWrongHead = evaluateAutomatedLaunchClaimGate({
      claim: { state: 'active', prNumber: 519, headSha: 'b'.repeat(40) },
      prNumber: 519,
      headSha: pr519NoClaimHead,
      projectId: 'orchestrator-pack',
      surface: 'review-trigger-reconcile',
    });
    expect(activeWrongHead.allowed).toBe(false);
    expect(activeWrongHead.reason).toBe('claim_binding_mismatch');
  });

  it('review-start-claim-run-binding: observed-no-claim-run-diagnostic-before-worktree-denial', () => {
    const run = {
      id: 'opk-rev-1092',
      prNumber: 519,
      targetSha: pr519NoClaimHead,
      status: 'running',
      projectId: 'orchestrator-pack',
      provenance: 'review-trigger-reeval',
      reviewerSessionId: 'opk-rev-1092',
    };
    const diagnostic = diagnoseMissingClaimForReviewRun({
      run,
      claims: [],
      projectId: 'orchestrator-pack',
      detectionPoint: 'pre_worktree_boundary',
      surface: 'review-trigger-reeval',
    });
    expect(diagnostic).toMatchObject({
      diagnostic: MISSING_CLAIM_FOR_REVIEW_RUN,
      prNumber: 519,
      headSha: pr519NoClaimHead,
      runId: 'opk-rev-1092',
      reviewerSessionId: 'opk-rev-1092',
      detectionPoint: 'pre_worktree_boundary',
      projectId: 'orchestrator-pack',
    });

    const aoBase = mkdtempSync(path.join(tmpdir(), 'binding-worktree-'));
    const headSha = pr519NoClaimHead;
    const workspaces = path.join(aoBase, 'projects', 'orchestrator-pack', 'code-reviews', 'workspaces');
    const target = path.join(workspaces, 'opk-rev-1092');
    try {
      const result = JSON.parse(runPwsh(`
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        $env:AO_BASE_DIR = ${psString(aoBase)}
        . ${psString(bindingLibPath)}
        . ${psString(boundaryLibPath)}
        $diag = Get-MissingClaimForReviewRunDiagnostic -Run @{
          id = 'opk-rev-1092'
          prNumber = 519
          targetSha = ${psString(headSha)}
          status = 'running'
          projectId = 'orchestrator-pack'
          provenance = 'review-trigger-reeval'
          reviewerSessionId = 'opk-rev-1092'
        } -Claims @() -DetectionPoint 'pre_worktree_boundary' -Surface 'review-trigger-reeval'
        $gate = Test-AutonomousGitDenied -Argv @('worktree','add','--detach',${psString(target)},${psString(headSha)})
        [pscustomobject]@{ diagnostic=$diag.diagnostic; gateDenied=[bool]$gate.denied; gateReason=[string]$gate.reason } | ConvertTo-Json -Compress
      `));
      expect(result.diagnostic).toBe(MISSING_CLAIM_FOR_REVIEW_RUN);
      expect(result.gateDenied).toBe(true);
      expect(result.gateReason).toBe('autonomous_mutating_git_denied');
    } finally {
      rmSync(aoBase, { recursive: true, force: true });
    }
  });

  it('review-start-claim-run-binding: launch-pending-visible-run-not-budget-terminalized', () => {
    const claim = {
      state: 'active',
      key: `pr-519-${pr519ReconcileHead}`,
      prNumber: 519,
      headSha: pr519ReconcileHead,
      holder: fakeHolder(),
      acquiredAtUtc: '2026-06-28T15:44:00.000Z',
      launchPendingInvokedAtUtc: '2026-06-28T15:44:30Z',
      launchPending: { atUtc: '2026-06-28T15:44:30Z', budgetMs: 15_000 },
    };
    const reviewRuns = [{
      id: pr519RunId,
      prNumber: 519,
      targetSha: pr519ReconcileHead,
      status: 'clean',
      createdAt: '2026-06-28T15:44:30.964Z',
      reviewerSessionId: pr519ReviewerSession,
    }];
    const nowMs = Date.parse('2026-06-28T15:48:14.000Z');
    const reconciliation = evaluateLaunchPendingRunReconciliation({
      claim,
      reviewRuns,
      nowMs,
      projectId: 'orchestrator-pack',
    });
    expect(reconciliation.reconcile).toBe(true);
    expect(reconciliation.outcome).toBe('run_started');
    expect(reconciliation.runId).toBe(pr519RunId);

    const decision = evaluateReclaimDecision({
      claim,
      holderLiveness: { outcome: 'provably_not_alive', reason: 'proc_entry_missing' },
      reviewRuns,
      nowMs,
      projectId: 'orchestrator-pack',
    });
    expect(decision.outcome).not.toBe('launch_pending_budget_exceeded');
    expect(decision.outcome).toBe('run_started');
  });

  it('review-start-claim-run-binding: completed-reviewer-not-launch-pending-budget', () => {
    const claim = {
      state: 'active',
      prNumber: 519,
      headSha: pr519ReconcileHead,
      holder: fakeHolder(),
      acquiredAtUtc: '2026-06-28T15:44:00.000Z',
      launchPendingInvokedAtUtc: '2026-06-28T15:44:30Z',
      launchPending: { atUtc: '2026-06-28T15:44:30Z', budgetMs: 15_000 },
      boundRunId: pr519RunId,
    };
    const reviewRuns = [{
      id: pr519RunId,
      prNumber: 519,
      targetSha: pr519ReconcileHead,
      status: 'clean',
      createdAt: '2026-06-28T15:44:30.964Z',
      reviewerSessionId: pr519ReviewerSession,
    }];
    const nowMs = Date.parse('2026-06-28T15:48:14.000Z');
    const reconciliation = evaluateLaunchPendingRunReconciliation({
      claim,
      reviewRuns,
      reviewerEvidence: {
        exitCode: 0,
        completionStatus: 'normal',
        reviewerSessionId: pr519ReviewerSession,
        completedAtUtc: '2026-06-28T15:47:46Z',
      },
      nowMs,
    });
    expect(reconciliation.reconcile).toBe(true);
    expect(reconciliation.outcome).toBe('run_started');

    const bound = applyRunBindingToReclaimDecision({
      decision: {
        action: 'terminalize',
        outcome: 'launch_pending_budget_exceeded',
        reason: 'launch_pending_budget_exceeded',
      },
      claim,
      reviewRuns,
      reviewerEvidence: {
        exitCode: 0,
        completionStatus: 'normal',
        reviewerSessionId: pr519ReviewerSession,
      },
      nowMs,
    });
    expect(bound.outcome).toBe('run_started');
    expect(bound.outcome).not.toBe('launch_pending_budget_exceeded');
  });

  it('review-start-claim-run-binding: visible-terminal-run-not-launch-pending-budget', () => {
    const claim = {
      state: 'active',
      prNumber: 519,
      headSha: pr519ReconcileHead,
      holder: fakeHolder(),
      launchPendingInvokedAtUtc: '2026-06-28T15:44:30Z',
      launchPending: { atUtc: '2026-06-28T15:44:30Z', budgetMs: 15_000 },
    };
    const reviewRuns = [{
      id: 'review-run-failed-521',
      prNumber: 519,
      targetSha: pr519ReconcileHead,
      status: 'failed',
      createdAt: '2026-06-28T15:45:00.000Z',
    }];
    const nowMs = Date.parse('2026-06-28T15:48:14.000Z');
    const reconciliation = evaluateLaunchPendingRunReconciliation({
      claim,
      reviewRuns,
      nowMs,
    });
    expect(reconciliation.reconcile).toBe(true);
    expect(reconciliation.outcome).toBe('released_after_run_terminalized');

    const cancelledRuns = [{
      id: 'review-run-cancelled-521',
      prNumber: 519,
      targetSha: pr519ReconcileHead,
      status: 'cancelled',
      createdAt: '2026-06-28T15:45:10.000Z',
    }];
    const cancelled = evaluateLaunchPendingRunReconciliation({
      claim,
      reviewRuns: cancelledRuns,
      nowMs,
    });
    expect(cancelled.reconcile).toBe(true);
    expect(cancelled.outcome).toBe('released_after_run_terminalized');
  });

  it('review-start-claim-run-binding: no-live-claim-worktree-denial-preserved', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'binding-deny-'));
    const headSha = pr519NoClaimHead;
    const workspaces = path.join(aoBase, 'projects', 'orchestrator-pack', 'code-reviews', 'workspaces');
    const target = path.join(workspaces, 'opk-rev-1095');
    try {
      const result = JSON.parse(runPwsh(`
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        $env:AO_BASE_DIR = ${psString(aoBase)}
        . ${psString(boundaryLibPath)}
        $gate = Test-AutonomousGitDenied -Argv @('worktree','add','--detach',${psString(target)},${psString(headSha)})
        [pscustomobject]@{ denied=[bool]$gate.denied; reason=[string]$gate.reason } | ConvertTo-Json -Compress
      `));
      expect(result.denied).toBe(true);
      expect(result.reason).toBe('autonomous_mutating_git_denied');
    } finally {
      rmSync(aoBase, { recursive: true, force: true });
    }
  });

  it('review-start-claim-run-binding: cursor-guard-off-surface-covered', () => {
    const run = {
      id: 'opk-rev-cursor-off',
      prNumber: 519,
      targetSha: pr519NoClaimHead,
      status: 'running',
      provenance: 'cursor-autonomous-review-start',
    };
    const guarded = evaluateCursorGuardOffSurface({
      autonomousSurfaceActive: true,
      guardInstalled: true,
      liveClaim: null,
      run,
      claims: [],
    });
    expect(guarded.launchAllowed).toBe(false);

    const guardOff = evaluateCursorGuardOffSurface({
      autonomousSurfaceActive: false,
      guardInstalled: true,
      liveClaim: null,
      run,
      claims: [],
      projectId: 'orchestrator-pack',
    });
    expect(guardOff.manualOnly).toBe(true);
    expect(guardOff).toMatchObject({ diagnostic: { diagnostic: MISSING_CLAIM_FOR_REVIEW_RUN } });

    const gate = evaluateAutomatedLaunchClaimGate({
      claim: null,
      prNumber: 519,
      headSha: pr519NoClaimHead,
      surface: 'cursor-autonomous-review-start',
    });
    expect(gate.allowed).toBe(false);

    const guardPath = path.join(repoRoot, 'scripts/ao-autonomous-guard.ps1');
    const rawDenied = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath, 'review', 'run', 'opk-1'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1' },
      },
    );
    expect(rawDenied.status).toBe(93);
  });

  it('review-start-claim-run-binding: provenance-and-namespace-isolation', () => {
    const manualRun = {
      id: 'manual-run-521',
      prNumber: 519,
      targetSha: pr519NoClaimHead,
      status: 'running',
      provenance: 'invoke-manual-review-run',
    };
    expect(isManualOperatorReviewRun(manualRun)).toBe(true);
    expect(diagnoseMissingClaimForReviewRun({ run: manualRun, claims: [] })).toBeNull();

    const otherHeadRun = {
      id: 'other-head-run',
      prNumber: 519,
      targetSha: 'c'.repeat(40),
      status: 'running',
      provenance: 'review-trigger-reconcile',
      projectId: 'orchestrator-pack',
    };
    const claim = {
      state: 'active',
      prNumber: 519,
      headSha: pr519ReconcileHead,
      projectId: 'orchestrator-pack',
    };
    expect(
      evaluateAutomatedLaunchClaimGate({
        claim,
        prNumber: 519,
        headSha: pr519ReconcileHead,
        projectId: 'orchestrator-pack',
      }).allowed,
    ).toBe(true);
    expect(
      evaluateLaunchPendingRunReconciliation({
        claim,
        reviewRuns: [otherHeadRun],
        nowMs: Date.now(),
      }).reconcile,
    ).toBe(false);

    const otherProjectRun = {
      id: 'other-project-run',
      prNumber: 519,
      targetSha: pr519ReconcileHead,
      status: 'running',
      provenance: 'review-trigger-reconcile',
      projectId: 'other-pack',
    };
    expect(
      evaluateLaunchPendingRunReconciliation({
        claim,
        reviewRuns: [otherProjectRun],
        projectId: 'orchestrator-pack',
      }).reconcile,
    ).toBe(false);
    expect(isPackOwnedAutomatedReviewRun(otherProjectRun)).toBe(true);
  });

  it('review-start-claim-run-binding: ps-launch-gate-integration', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'binding-launch-'));
    try {
      const result = JSON.parse(runPwsh(`
        $env:AO_REVIEW_CLAIM_DIR = ${psString(path.join(aoBase, 'claims'))}
        . ${psString(claimLibPath)}
        . ${psString(bindingLibPath)}
        $ns = Get-ReviewStartClaimProjectNamespace -ProjectId 'orchestrator-pack'
        Initialize-ReviewStartClaimNamespace -Namespace $ns
        $deny = Confirm-ReviewStartClaimRunBindingLaunch -ClaimResult $null -PrNumber 521 -HeadSha ${psString(pr519NoClaimHead)} -Surface 'review-trigger-reconcile'
        $claim = Acquire-ReviewStartClaim -PrNumber 521 -HeadSha ${psString(pr519NoClaimHead)} -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $allow = Confirm-ReviewStartClaimRunBindingLaunch -ClaimResult $claim -PrNumber 521 -HeadSha ${psString(pr519NoClaimHead)} -Surface 'review-trigger-reconcile'
        [pscustomobject]@{ denyOk=[bool]$deny.ok; allowOk=[bool]$allow.ok } | ConvertTo-Json -Compress
      `));
      expect(result.denyOk).toBe(false);
      expect(result.allowOk).toBe(true);
    } finally {
      rmSync(aoBase, { recursive: true, force: true });
    }
  });

  it('review-start-claim-run-binding: external-fixture-snapshot-present', () => {
    const fixturePath = path.join(fixturesDir, 'pr-519-incident-redacted.json');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    expect(fixture.pr519NoClaimHead).toBe(pr519NoClaimHead);
    expect(fixture.pr519ReconcileHead).toBe(pr519ReconcileHead);
    expect(fixture.reviewRunId).toBe(pr519RunId);
  });
});
