import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MISSING_CLAIM_FOR_REVIEW_RUN,
  diagnoseMissingClaimForReviewRun,
  evaluateAutomatedLaunchClaimGate,
  evaluateClaimRunBinding,
  evaluateLaunchPendingBudgetDecision,
  evaluateLaunchPendingRunBinding,
  resolveBindingProjectNamespace,
  isManualOperatorProvenance,
  isPackOwnedAutomatedProvenance,
  runMatchesBindingKey,
} from '../docs/review-start-claim-run-binding.mjs';
import {
  evaluateLaunchPending,
  evaluateReclaimDecision,
} from '../docs/review-start-claim-lifecycle.mjs';
import { evaluateAutonomousReviewRunBoundary } from '../docs/orchestrator-claimed-review-run.mjs';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const fixtureDir = path.join(
  repoRoot,
  'tests/external-output-references/review-start-claim-run-binding',
);

function loadFixture(name: string) {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));
}

type BindingDiagnostic = {
  kind?: string;
  prNumber?: number;
  headSha?: string;
  reviewerSessionId?: string;
  detectionPoint?: string;
  surface?: string;
};

function diagnosticOf(result: { diagnostic?: unknown }) {
  return result.diagnostic as BindingDiagnostic | undefined;
}

describe('review-start-claim-run-binding', () => {
  it('launch-without-live-claim-fails-before-run', () => {
    const gate = evaluateAutomatedLaunchClaimGate({
      claims: [],
      prNumber: 519,
      headSha: 'a7f0e4d190556d2a61082878e82c6e5164f6a31e',
      projectNamespace: 'orchestrator-pack',
    });
    expect(gate.launch).toBe(false);
    expect(gate.reason).toBe('missing_live_claim_for_launch');

    const liveClaim = {
      state: 'active',
      prNumber: 519,
      headSha: 'a7f0e4d190556d2a61082878e82c6e5164f6a31e',
      projectId: 'orchestrator-pack',
      key: 'pr-519-a7f0e4d',
    };
    const allowed = evaluateAutomatedLaunchClaimGate({
      claim: liveClaim,
      prNumber: 519,
      headSha: 'a7f0e4d190556d2a61082878e82c6e5164f6a31e',
    });
    expect(allowed.launch).toBe(true);
    expect(allowed.reason).toBe('live_claim_present');

    const mismatchedClaim = {
      state: 'active',
      prNumber: 518,
      headSha: 'a7f0e4d190556d2a61082878e82c6e5164f6a31e',
      projectId: 'orchestrator-pack',
    };
    const mismatchedGate = evaluateAutomatedLaunchClaimGate({
      claim: mismatchedClaim,
      claims: [],
      prNumber: 519,
      headSha: 'a7f0e4d190556d2a61082878e82c6e5164f6a31e',
      projectNamespace: 'orchestrator-pack',
    });
    expect(mismatchedGate.launch).toBe(false);
    expect(mismatchedGate.reason).toBe('missing_live_claim_for_launch');
    expect(mismatchedGate.lineage).toBe('direct_claim_key_mismatch');
  });

  it('observed-no-claim-run-diagnostic-before-worktree-denial', () => {
    const fixture = loadFixture('pr519-no-claim-run.json');
    const run = fixture.runs[0];
    const result = diagnoseMissingClaimForReviewRun({
      run,
      claims: fixture.claims,
      projectNamespace: fixture.projectNamespace,
      detectionPoint: fixture.detectionPoint,
      surface: fixture.surface,
    });
    expect(result.emit).toBe(true);
    const diagnostic = diagnosticOf(result);
    expect(diagnostic?.kind).toBe(MISSING_CLAIM_FOR_REVIEW_RUN);
    expect(diagnostic?.prNumber).toBe(519);
    expect(diagnostic?.headSha).toBe('a7f0e4d190556d2a61082878e82c6e5164f6a31e');
    expect(diagnostic?.reviewerSessionId).toBe('opk-rev-1092');
    expect(diagnostic?.detectionPoint).toBe('worktree_gate');
    expect(diagnostic?.surface).toBe('review-wake-trigger');
  });

  it('launch-pending-visible-run-not-budget-terminalized', () => {
    const fixture = loadFixture('pr519-launch-pending-visible-run.json');
    const binding = evaluateLaunchPendingBudgetDecision({
      claim: fixture.claim,
      reviewRuns: fixture.reviewRuns,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(binding.action).toBe('reconcile');
    expect(binding.outcome).not.toBe('launch_pending_budget_exceeded');
    expect(binding.runId).toBe('review-run-fa05d810-85e6-4f1c-8f06-57d50790c6b5');

    const launch = evaluateLaunchPending({
      claim: fixture.claim,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(launch.expired).toBe(true);

    const decision = evaluateReclaimDecision({
      claim: fixture.claim,
      holderLiveness: { outcome: 'provably_not_alive', reason: 'dead' },
      reviewRuns: fixture.reviewRuns,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(decision.action).not.toBe('terminalize');
    expect(decision.outcome).not.toBe('launch_pending_budget_exceeded');
    expect(['reconcile', 'skip']).toContain(decision.action);
  });

  it('completed-reviewer-not-launch-pending-budget', () => {
    const fixture = loadFixture('completed-reviewer-beats-budget.json');
    const binding = evaluateLaunchPendingRunBinding({
      claim: fixture.claim,
      reviewRuns: fixture.reviewRuns,
      reviewerEvidence: fixture.reviewerEvidence,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(binding.reconcile).toBe(true);
    expect(binding.outcome).toBe('covered_by_run');
    expect(binding.reviewer && (binding.reviewer as { completed?: boolean }).completed).toBe(true);

    const budget = evaluateLaunchPendingBudgetDecision({
      claim: fixture.claim,
      reviewRuns: fixture.reviewRuns,
      reviewerEvidence: fixture.reviewerEvidence,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(budget.action).toBe('reconcile');
    expect(budget.outcome).not.toBe('launch_pending_budget_exceeded');
  });

  it('visible-terminal-run-not-launch-pending-budget', () => {
    const fixture = loadFixture('visible-terminal-run-beats-budget.json');
    const budget = evaluateLaunchPendingBudgetDecision({
      claim: fixture.claim,
      reviewRuns: fixture.reviewRuns,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(budget.action).toBe('reconcile');
    expect(budget.outcome).toBe('released_after_run_terminalized');
    expect(budget.outcome).not.toBe('launch_pending_budget_exceeded');
  });

  it('no-live-claim-worktree-denial-preserved', () => {
    const boundary = evaluateAutonomousReviewRunBoundary({
      commandLine: 'git worktree add /tmp/opk-rev workspaces/opk-rev a7f0e4d190556d2a61082878e82c6e5164f6a31e',
      autonomousSurface: true,
      claimedBypass: false,
    });
    expect(boundary.allowed).toBe(true);
    expect(boundary.reason).toBe('not_review_run');

    const noClaim = diagnoseMissingClaimForReviewRun({
      run: {
        prNumber: 519,
        targetSha: 'a7f0e4d190556d2a61082878e82c6e5164f6a31e',
        startReason: 'completion_wake',
        surface: 'review-wake-trigger',
        packOwnedAutomated: true,
      },
      claims: [],
      detectionPoint: 'worktree_gate',
    });
    expect(noClaim.emit).toBe(true);
    expect(diagnosticOf(noClaim)?.kind).toBe(MISSING_CLAIM_FOR_REVIEW_RUN);
    expect(diagnosticOf(noClaim)?.detectionPoint).toBe('worktree_gate');
  });

  it('cursor-guard-off-surface-covered', () => {
    const cursorRun = {
      prNumber: 519,
      targetSha: 'a7f0e4d190556d2a61082878e82c6e5164f6a31e',
      surface: 'cursor-worker',
      startReason: 'completion_wake',
      packOwnedAutomated: true,
      reviewerSessionId: 'opk-rev-cursor-1',
      id: 'review-run-cursor-1',
    };
    expect(isPackOwnedAutomatedProvenance({ run: cursorRun, surface: 'cursor-worker' })).toBe(true);

    const launchGate = evaluateAutomatedLaunchClaimGate({
      claims: [],
      prNumber: 519,
      headSha: 'a7f0e4d190556d2a61082878e82c6e5164f6a31e',
    });
    expect(launchGate.launch).toBe(false);

    const diagnostic = diagnoseMissingClaimForReviewRun({
      run: cursorRun,
      claims: [],
      detectionPoint: 'cursor_guard_off',
      surface: 'cursor-worker',
    });
    expect(diagnostic.emit).toBe(true);
    expect(diagnosticOf(diagnostic)?.kind).toBe(MISSING_CLAIM_FOR_REVIEW_RUN);
    expect(diagnosticOf(diagnostic)?.surface).toBe('cursor-worker');

    const rawDenied = evaluateAutonomousReviewRunBoundary({
      commandLine: 'ao review run opk-orch --execute --command echo',
      autonomousSurface: true,
      claimedBypass: false,
    });
    expect(rawDenied.allowed).toBe(false);
    expect(rawDenied.reason).toBe('autonomous_raw_review_run_denied');
  });

  it('provenance-and-namespace-isolation', () => {
    const manualRun = {
      prNumber: 519,
      targetSha: 'a7f0e4d190556d2a61082878e82c6e5164f6a31e',
      provenance: 'manual-operator',
      startReason: 'operator_manual',
    };
    expect(isManualOperatorProvenance({ run: manualRun })).toBe(true);
    const manualDiag = diagnoseMissingClaimForReviewRun({ run: manualRun, claims: [] });
    expect(manualDiag.emit).toBe(false);
    expect(manualDiag.reason).toBe('not_pack_owned_automated');

    expect(
      runMatchesBindingKey(
        { prNumber: 519, targetSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', project: 'orchestrator-pack' },
        519,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toBe(false);

    expect(
      runMatchesBindingKey(
        { prNumber: 519, targetSha: 'a7f0e4d190556d2a61082878e82c6e5164f6a31e', project: 'other-pack' },
        519,
        'a7f0e4d190556d2a61082878e82c6e5164f6a31e',
        'orchestrator-pack',
      ),
    ).toBe(false);

    const binding = evaluateClaimRunBinding({
      claim: {
        state: 'active',
        prNumber: 519,
        headSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
        launchPending: { atUtc: '2026-06-28T15:44:30.000Z' },
      },
      reviewRuns: [
        {
          id: 'review-run-other-head',
          prNumber: 519,
          targetSha: 'a7f0e4d190556d2a61082878e82c6e5164f6a31e',
          status: 'running',
        },
      ],
      projectNamespace: 'orchestrator-pack',
    });
    expect(binding.direction).toBe('none');

    const foreignProjectBinding = evaluateLaunchPendingBudgetDecision({
      claim: {
        state: 'active',
        prNumber: 519,
        headSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
        projectId: 'orchestrator-pack',
        launchPending: { atUtc: '2026-06-28T15:44:30.000Z' },
        launchPendingInvokedAtUtc: '2026-06-28T15:44:30Z',
      },
      reviewRuns: [
        {
          id: 'review-run-foreign-project',
          prNumber: 519,
          targetSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
          project: 'other-pack',
          status: 'running',
        },
      ],
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(foreignProjectBinding.action).toBe('terminalize');
    expect(foreignProjectBinding.outcome).toBe('launch_pending_budget_exceeded');
  });

  it('pscustomobject-run-diagnostic-binding', () => {
    const bindingLib = path.join(repoRoot, 'scripts/lib/Review-StartClaimRunBinding.ps1');
    const result = JSON.parse(
      runPwsh(`
        . ${psString(bindingLib)}
        $run = @{
          prNumber = 519
          targetSha = 'a7f0e4d190556d2a61082878e82c6e5164f6a31e'
          startReason = 'completion_wake'
          surface = 'review-wake-trigger'
          reviewerSessionId = 'opk-rev-1092'
          id = 'review-run-test'
        } | ConvertTo-Json | ConvertFrom-Json
        $diag = Get-MissingClaimForReviewRunDiagnostic -Run $run -Claims @() -DetectionPoint 'worktree_gate'
        [pscustomobject]@{
          emit = [bool]$diag.emit
          kind = [string]$diag.diagnostic.kind
        } | ConvertTo-Json -Compress
      `),
    );
    expect(result.emit).toBe(true);
    expect(result.kind).toBe(MISSING_CLAIM_FOR_REVIEW_RUN);
  });

  it('terminal-reconciled-claim-suppresses-missing-diagnostic', () => {
    const run = {
      prNumber: 519,
      targetSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
      startReason: 'completion_wake',
      surface: 'review-wake-trigger',
      packOwnedAutomated: true,
      reviewerSessionId: 'opk-rev-1072',
      id: 'review-run-fa05d810-85e6-4f1c-8f06-57d50790c6b5',
    };
    const terminalClaim = {
      state: 'terminal',
      prNumber: 519,
      headSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
      projectId: 'orchestrator-pack',
      terminalOutcome: 'run_started',
      boundRunId: 'review-run-fa05d810-85e6-4f1c-8f06-57d50790c6b5',
    };
    const result = diagnoseMissingClaimForReviewRun({
      run,
      claims: [terminalClaim],
      detectionPoint: 'worktree_gate',
    });
    expect(result.emit).toBe(false);
    expect(result.reason).toBe('matching_claim_present');
    expect(result.lineage).toBe('reconciled');
  });

  it('prefers-covered-run-before-non-covering-match', () => {
    const claim = {
      state: 'active',
      prNumber: 519,
      headSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
      projectId: 'orchestrator-pack',
      launchPending: { atUtc: '2026-06-28T15:44:30.000Z' },
      launchPendingInvokedAtUtc: '2026-06-28T15:44:30Z',
    };
    const reviewRuns = [
      {
        id: 'review-run-old-failed',
        prNumber: 519,
        targetSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
        project: 'orchestrator-pack',
        status: 'failed',
      },
      {
        id: 'review-run-current-running',
        prNumber: 519,
        targetSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
        project: 'orchestrator-pack',
        status: 'running',
      },
    ];
    const binding = evaluateLaunchPendingRunBinding({
      claim,
      reviewRuns,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(binding.reconcile).toBe(true);
    expect(binding.runId).toBe('review-run-current-running');
    expect(binding.outcome).not.toBe('released_after_run_terminalized');

    const budget = evaluateLaunchPendingBudgetDecision({
      claim,
      reviewRuns,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(budget.action).toBe('reconcile');
    expect(budget.runId).toBe('review-run-current-running');
    expect(budget.outcome).not.toBe('released_after_run_terminalized');
  });

  it('namespace-scoped-claim-without-projectId-reconciles-visible-run', () => {
    const claim = {
      state: 'active',
      prNumber: 519,
      headSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
      launchPending: { atUtc: '2026-06-28T15:44:30.000Z' },
      launchPendingInvokedAtUtc: '2026-06-28T15:44:30Z',
    };
    const reviewRuns = [
      {
        id: 'review-run-other-pack',
        prNumber: 519,
        targetSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
        project: 'other-pack',
        status: 'running',
      },
    ];
    const withoutNamespace = evaluateLaunchPendingBudgetDecision({
      claim,
      reviewRuns,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(withoutNamespace.action).toBe('terminalize');
    expect(withoutNamespace.outcome).toBe('launch_pending_budget_exceeded');

    const withNamespace = evaluateLaunchPendingBudgetDecision({
      claim,
      reviewRuns,
      projectNamespace: 'other-pack',
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(withNamespace.action).toBe('reconcile');
    expect(withNamespace.outcome).not.toBe('launch_pending_budget_exceeded');
    expect(resolveBindingProjectNamespace({ claim, projectNamespace: 'other-pack' })).toBe('other-pack');
  });

  it('evaluateReclaimDecision ignores foreign-project in-flight runs when namespace supplied', () => {
    const claim = {
      state: 'active',
      prNumber: 519,
      headSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
      launchPending: { atUtc: '2026-06-28T15:44:30.000Z' },
      launchPendingInvokedAtUtc: '2026-06-28T15:44:30Z',
    };
    const reviewRuns = [
      {
        id: 'review-run-other-pack',
        prNumber: 519,
        targetSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
        project: 'other-pack',
        status: 'running',
      },
    ];
    const withoutNamespace = evaluateReclaimDecision({
      claim,
      holderLiveness: { outcome: 'provably_not_alive', reason: 'dead' },
      reviewRuns,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(withoutNamespace.action).toBe('skip');
    expect(withoutNamespace.reason).toBe('in_flight_covering_run');

    const withNamespace = evaluateReclaimDecision({
      claim,
      holderLiveness: { outcome: 'provably_not_alive', reason: 'dead' },
      reviewRuns,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
      projectNamespace: 'orchestrator-pack',
    });
    expect(withNamespace.action).toBe('terminalize');
    expect(withNamespace.outcome).toBe('launch_pending_budget_exceeded');
    expect(withNamespace.reason).not.toBe('in_flight_covering_run');
  });

  it('evaluateClaimRunBinding passes projectNamespace for claim-to-run reconciliation', () => {
    const claim = {
      state: 'active',
      prNumber: 519,
      headSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
      launchPending: { atUtc: '2026-06-28T15:44:30.000Z' },
      launchPendingInvokedAtUtc: '2026-06-28T15:44:30Z',
    };
    const reviewRuns = [
      {
        id: 'review-run-other-pack',
        prNumber: 519,
        targetSha: '5a20a5d5c3d590ce6ec041e57a390ea63e39158a',
        project: 'other-pack',
        status: 'running',
      },
    ];

    const withNamespace = evaluateClaimRunBinding({
      claim,
      reviewRuns,
      projectNamespace: 'other-pack',
    });
    expect(withNamespace.direction).toBe('claim_to_run');
    expect((withNamespace.reconcile as { reconcile?: boolean } | undefined)?.reconcile).toBe(true);

    const wrongNamespace = evaluateClaimRunBinding({
      claim,
      reviewRuns,
      projectNamespace: 'orchestrator-pack',
    });
    expect(wrongNamespace.direction).toBe('none');
  });

  it('no-live-claim-worktree-denial-survives-ao-list-failure', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-worktree-gate-'));
    const projectId = 'orchestrator-pack';
    const headSha = 'a7f0e4d190556d2a61082878e82c6e5164f6a31e';
    const gateLib = path.join(repoRoot, 'scripts/lib/Autonomous-ReviewWorktreeGate.ps1');
    const claimLib = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
    const target = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces', 'opk-rev-test');
    try {
      const result = JSON.parse(
        runPwsh(`
          function Get-AoReviewRuns { param([string]$Project) throw 'ao review list unavailable' }
          $env:AO_BASE_DIR = ${psString(aoBase)}
          $env:AO_PROJECT_ID = ${psString(projectId)}
          . ${psString(claimLib)}
          $ns = Get-ReviewStartClaimProjectNamespace -ProjectId ${psString(projectId)}
          Initialize-ReviewStartClaimNamespace -Namespace $ns
          . ${psString(gateLib)}
          $gate = Test-AutonomousReviewWorktreeClaimBoundAllow -Argv @('worktree','add','--detach',${psString(target)},${psString(headSha)})
          [pscustomobject]@{
            allowed = [bool]$gate.allowed
            reason = [string]$gate.reason
            hasDiagnostic = $null -ne $gate.diagnostic
          } | ConvertTo-Json -Compress
        `),
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('no_live_claim');
      expect(result.hasDiagnostic).toBe(false);
    } finally {
      rmSync(aoBase, { recursive: true, force: true });
    }
  });

  it('worktree-gate-imports-ao-review-list-helper', () => {
    const gateLib = path.join(repoRoot, 'scripts/lib/Autonomous-ReviewWorktreeGate.ps1');
    const result = JSON.parse(
      runPwsh(`
        . ${psString(gateLib)}
        [pscustomobject]@{ hasHelper = [bool](Get-Command Get-AoReviewRuns -ErrorAction SilentlyContinue) } | ConvertTo-Json -Compress
      `),
    );
    expect(result.hasHelper).toBe(true);
  });

  it('positive-outcome: visible AO run reconciles launch-pending claim instead of budget terminalization', () => {
    const fixture = loadFixture('pr519-launch-pending-visible-run.json');
    const binding = evaluateLaunchPendingRunBinding({
      claim: fixture.claim,
      reviewRuns: fixture.reviewRuns,
      nowMs: Date.parse('2026-06-28T15:48:14.000Z'),
    });
    expect(binding.reconcile).toBe(true);
    expect(binding.outcome).toBe('run_started');
    expect(binding.runId).toBe('review-run-fa05d810-85e6-4f1c-8f06-57d50790c6b5');
  });
});
