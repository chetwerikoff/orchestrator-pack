import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateHoldBudget,
  evaluateLaunchPending,
  evaluateReclaimDecision,
  resolveClaimLifecycleConfig,
  resolveHoldBudgetStartMs,
} from '../docs/review-start-claim-lifecycle.mjs';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const fullSha = '943b6cefbc6071f785d99b0eaf745bd579644d85';
const claimHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
const lifecycleHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaimLifecycle.ps1');

function fakeHolder(overrides: Record<string, unknown> = {}) {
  return {
    surface: 'orchestrator-claimed-review-run',
    pid: 424242,
    host: 'test-host',
    processGuid: 'guid-1',
    startTimeTicks: '100',
    bootIdHash: 'boot-a',
    ...overrides,
  };
}

function pr479ShapedClaim() {
  const acquired = '2026-06-26T07:58:02.4816307Z';
  const holdStarted = '2026-06-26T07:58:02.4816934Z';
  const terminalMs = Date.parse('2026-06-26T07:58:19.1010510Z');
  return {
    claim: {
      schemaVersion: 1,
      key: `pr-479-${fullSha}`,
      state: 'active',
      prNumber: 479,
      headSha: fullSha,
      holder: fakeHolder(),
      acquiredAtUtc: acquired,
      holdStartedAtUtc: holdStarted,
    },
    nowMs: terminalMs,
    inFlightCount: 0,
  };
}

describe('review-start-claim-budget-semantics', () => {
  it('fresh-slow-preflight-not-hold-expired', () => {
    const acquired = '2026-06-26T07:58:02.481Z';
    const nowMs = Date.parse('2026-06-26T07:58:19.101Z');
    const config = resolveClaimLifecycleConfig({ holdBudgetMs: 15_000, readinessEnvelopeMs: 30_000 });

    const hold = evaluateHoldBudget({
      claim: { acquiredAtUtc: acquired },
      nowMs,
      config,
    });
    expect(hold.exceeded).toBe(false);
    expect(hold.phase).toBe('pre_launch');
    expect(hold.preLaunchAgeMs).toBeGreaterThan(15_000);

    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 479,
        headSha: fullSha,
        holder: fakeHolder(),
        acquiredAtUtc: acquired,
      },
      holderLiveness: { outcome: 'alive', reason: 'alive' },
      reviewRuns: [],
      nowMs,
      config,
      localHost: 'test-host',
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('holder_alive');
    expect(decision.outcome).not.toBe('hold_budget_exceeded');
  });

  it('slow-preflight-single-winner-final-recheck', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claim-budget-single-winner-'));
    try {
      const script = `
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $first = Acquire-ReviewStartClaim -PrNumber 481 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $second = Acquire-ReviewStartClaim -PrNumber 481 -HeadSha $sha -Surface 'review-wake-trigger' -Namespace $ns -ReviewRuns @()
        $gateFirst = Confirm-ReviewStartClaimLaunchGate -ClaimResult $first -ReviewRuns @() -DecisionSource 'hold_budget'
        $gateSecond = if ($second.acquired) {
          Confirm-ReviewStartClaimLaunchGate -ClaimResult $second -ReviewRuns @() -DecisionSource 'hold_budget'
        } else {
          @{ ok = $false; reason = [string]$second.reason }
        }
        [pscustomobject]@{
          firstAcquired = [bool]$first.acquired
          secondAcquired = [bool]$second.acquired
          secondReason = [string]$second.reason
          gateFirstOk = [bool]$gateFirst.ok
          gateSecondOk = [bool]$gateSecond.ok
          gateSecondReason = [string]$gateSecond.reason
          activeCount = @((Get-ChildItem -LiteralPath $ns -File -Filter 'pr-481-*.json').Name).Count
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.firstAcquired).toBe(true);
      expect(result.activeCount).toBe(1);
      expect(result.gateFirstOk).toBe(true);
      expect(result.secondAcquired).toBe(false);
      expect(result.gateSecondOk).toBe(false);
      expect(['claimed', 'lost_ownership', 'claim_ownership_lost']).toContain(result.secondReason);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dead-prelaunch-holder-recovered', () => {
    const acquired = '2026-06-24T12:00:00.000Z';
    const nowMs = Date.parse('2026-06-24T12:00:10.000Z');
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 481,
        headSha: fullSha,
        holder: fakeHolder({ host: 'test-host' }),
        acquiredAtUtc: acquired,
      },
      holderLiveness: { outcome: 'provably_not_alive', reason: 'proc_entry_missing' },
      reviewRuns: [],
      nowMs,
      localHost: 'test-host',
    });
    expect(decision.action).toBe('terminalize');
    expect(decision.outcome).toBe('recovered_orphan_liveness');
  });

  it('hold-and-launch-pending-classes-distinct', () => {
    const config = resolveClaimLifecycleConfig({
      holdBudgetMs: 15_000,
      launchPendingBudgetMs: 15_000,
      readinessEnvelopeMs: 30_000,
    });
    const acquired = '2026-06-24T12:00:00.000Z';
    const nowMs = Date.parse('2026-06-24T12:00:20.000Z');

    const preLaunchHold = evaluateHoldBudget({
      claim: { acquiredAtUtc: acquired },
      nowMs,
      config,
    });
    expect(preLaunchHold.exceeded).toBe(false);
    expect(preLaunchHold.phase).toBe('pre_launch');

    const postGateHold = evaluateHoldBudget({
      claim: {
        acquiredAtUtc: acquired,
        holdStartedAtUtc: '2026-06-24T12:00:00.000Z',
        launchPending: { atUtc: '2026-06-24T12:00:00.000Z', budgetMs: 15_000 },
      },
      nowMs,
      config,
    });
    expect(postGateHold.exceeded).toBe(true);
    expect(postGateHold.phase).toBe('post_launch_gate');

    const launchPending = evaluateLaunchPending({
      claim: {
        acquiredAtUtc: acquired,
        launchPending: { atUtc: '2026-06-24T12:00:00.000Z', budgetMs: 15_000 },
        launchPendingInvokedAtUtc: '2026-06-24T12:00:00.000Z',
      },
      nowMs: Date.parse('2026-06-24T12:00:20.000Z'),
      config,
    });
    expect(launchPending.expired).toBe(true);

    const launchDecision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 481,
        headSha: fullSha,
        holder: fakeHolder(),
        acquiredAtUtc: acquired,
        holdStartedAtUtc: acquired,
        launchPending: { atUtc: '2026-06-24T12:00:00.000Z', budgetMs: 15_000 },
        launchPendingInvokedAtUtc: '2026-06-24T12:00:00.000Z',
      },
      holderLiveness: { outcome: 'alive', reason: 'alive' },
      reviewRuns: [],
      nowMs: Date.parse('2026-06-24T12:00:20.000Z'),
      config,
    });
    expect(launchDecision.action).toBe('terminalize');
    expect(launchDecision.outcome).toBe('launch_pending_budget_exceeded');
    expect(launchDecision.outcome).not.toBe('hold_budget_exceeded');
  });

  it('fresh-self-expiry-diagnostic', () => {
    const { claim, nowMs } = pr479ShapedClaim();
    const config = resolveClaimLifecycleConfig({ holdBudgetMs: 15_000, readinessEnvelopeMs: 30_000 });

    const hold = evaluateHoldBudget({ claim, nowMs, config });
    expect(hold.exceeded).toBe(false);
    expect(hold.phase).toBe('pre_launch');
    expect(hold.preLaunchAgeMs).toBeGreaterThan(15_000);
    expect(resolveHoldBudgetStartMs(claim)).toBeNull();

    const decision = evaluateReclaimDecision({
      claim,
      holderLiveness: { outcome: 'alive', reason: 'alive' },
      reviewRuns: [],
      nowMs,
      config,
      localHost: 'test-host',
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('holder_alive');
    expect(decision.outcome).not.toBe('hold_budget_exceeded');

    const envelopeExceeded = evaluateReclaimDecision({
      claim,
      holderLiveness: { outcome: 'alive', reason: 'alive' },
      reviewRuns: [],
      nowMs: Date.parse('2026-06-26T07:58:35.000Z'),
      config,
      localHost: 'test-host',
    });
    expect(envelopeExceeded.action).toBe('terminalize');
    expect(envelopeExceeded.outcome).toBe('readiness_envelope_exceeded');
    expect(envelopeExceeded.reason).toBe('pre_launch_envelope_exceeded');
    expect(envelopeExceeded.outcome).not.toBe('hold_budget_exceeded');
  });

  it('constant-only-bump-insufficient', () => {
    const acquired = '2026-06-26T07:58:02.481Z';
    const nowMs = Date.parse('2026-06-26T07:58:19.101Z');
    const config = resolveClaimLifecycleConfig({ holdBudgetMs: 15_000, readinessEnvelopeMs: 30_000 });
    const legacyAcquireAgeMs = nowMs - Date.parse(acquired);

    const semanticHold = evaluateHoldBudget({
      claim: { acquiredAtUtc: acquired, holdStartedAtUtc: acquired },
      nowMs,
      config,
    });
    expect(semanticHold.exceeded).toBe(false);
    expect(semanticHold.phase).toBe('pre_launch');

    expect(legacyAcquireAgeMs).toBeGreaterThan(config.holdBudgetMs);
    expect(legacyAcquireAgeMs).toBeLessThan(60_000);
    const constantOnlyBumpWouldMaskLegacyFailure = legacyAcquireAgeMs < 60_000;
    expect(constantOnlyBumpWouldMaskLegacyFailure).toBe(true);
    expect(semanticHold.exceeded).toBe(false);
  });

  it('healthy-ready-head-converges', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claim-budget-converge-'));
    try {
      const script = `
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 481 -HeadSha $sha -Surface 'orchestrator-claimed-review-run' -Namespace $ns -ReviewRuns @()
        $record = Get-Content -LiteralPath $claim.path -Raw | ConvertFrom-Json
        $gate = Confirm-ReviewStartClaimLaunchGate -ClaimResult $claim -ReviewRuns @() -DecisionSource 'hold_budget'
        $after = Get-Content -LiteralPath $claim.path -Raw | ConvertFrom-Json
        [pscustomobject]@{
          acquiredHasHoldStart = [bool]$record.holdStartedAtUtc
          gateOk = [bool]$gate.ok
          gateReason = [string]$gate.reason
          afterHasHoldStart = [bool]$after.holdStartedAtUtc
          afterHasLaunchPending = [bool]$after.launchPending
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.acquiredHasHoldStart).toBe(false);
      expect(result.gateOk).toBe(true);
      expect(result.afterHasHoldStart).toBe(true);
      expect(result.afterHasLaunchPending).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('new active records omit acquire-time holdStartedAtUtc', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claim-budget-acquire-shape-'));
    try {
      const script = `
        . ${psString(claimHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 481 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $record = Get-Content -LiteralPath $claim.path -Raw | ConvertFrom-Json
        [pscustomobject]@{ hasHoldStart = [bool]$record.holdStartedAtUtc; hasAcquired = [bool]$record.acquiredAtUtc } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.hasAcquired).toBe(true);
      expect(result.hasHoldStart).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
