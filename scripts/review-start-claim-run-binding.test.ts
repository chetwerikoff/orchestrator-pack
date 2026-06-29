import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MISSING_CLAIM_FOR_REVIEW_RUN,
  diagnoseMissingClaimForReviewRun,
  evaluateAutomatedLaunchClaimGate,
  evaluateClaimRunBinding,
  evaluateLaunchPendingBudgetDecision,
  evaluateLaunchPendingRunBinding,
  isManualOperatorProvenance,
  isPackOwnedAutomatedProvenance,
  runMatchesBindingKey,
} from '../docs/review-start-claim-run-binding.mjs';
import {
  evaluateLaunchPending,
  evaluateReclaimDecision,
} from '../docs/review-start-claim-lifecycle.mjs';
import { evaluateAutonomousReviewRunBoundary } from '../docs/orchestrator-claimed-review-run.mjs';
import { repoRoot } from './_test-pwsh-helpers.js';

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
