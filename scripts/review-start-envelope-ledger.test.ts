import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  applyLedgerReset,
  applyLedgerTerminal,
  emptyEnvelopeLedger,
  evaluateLedgerEscalation,
  isCountedTerminal,
  ledgerKeyForPrHead,
} from '../docs/review-start-envelope-ledger.mjs';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const fullSha = '943b6cefbc6071f785d99b0eaf745bd579644d85';
const claimHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
const lifecycleHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaimLifecycle.ps1');
const ledgerHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartEnvelopeLedger.ps1');
const guardPath = path.join(repoRoot, 'scripts/check-review-start-envelope-ledger-starter-surfaces.ps1');
const snapshotHelperPath = path.join(repoRoot, 'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1');

function tempClaimDir() {
  return mkdtempSync(path.join(tmpdir(), 'envelope-ledger-'));
}

function terminalizeCountedFailure(
  dir: string,
  surface: string,
  outcome: string,
  extra: Record<string, unknown> = {},
  prNumber = 516,
) {
  const script = `
    . ${psString(claimHelperPath)}
    . ${psString(lifecycleHelperPath)}
    . ${psString(ledgerHelperPath)}
    $ns = ${psString(dir)}
    $sha = ${psString(fullSha)}
    $claim = Acquire-ReviewStartClaim -PrNumber ${prNumber} -HeadSha $sha -Surface '${surface}' -Namespace $ns -ReviewRuns @()
    $extra = @{}
    $extraJson = ${psString(JSON.stringify(extra))}
    if ($extraJson) { $extra = ($extraJson | ConvertFrom-Json -AsHashtable) }
    $path = Move-ReviewStartClaimToTerminal -Namespace $ns -ActivePath $claim.path -Record $claim.claim -Outcome '${outcome}' -Extra $extra
    $entry = Read-ReviewStartEnvelopeLedgerEntry -Namespace $ns -PrNumber ${prNumber} -HeadSha $sha
    [pscustomobject]@{
      terminalPath = $path
      consecutiveFailureCount = if ($entry) { [int]$entry.consecutiveFailureCount } else { 0 }
      surfaces = @($entry.surfaces)
    } | ConvertTo-Json -Compress -Depth 6
  `;
  return JSON.parse(runPwsh(script));
}

describe('review-start-envelope-ledger unit', () => {
  it('cross-attempt-failure-count-persists', () => {
    let ledger = emptyEnvelopeLedger();
    for (const surface of ['review-trigger-reconcile', 'review-wake-trigger', 'orchestrator-turn']) {
      const result = applyLedgerTerminal({
        ledger,
        prNumber: 516,
        headSha: fullSha,
        outcome: 'readiness_envelope_exceeded',
        surface,
      });
      ledger = result.ledger as ReturnType<typeof emptyEnvelopeLedger>;
    }
    const key = ledgerKeyForPrHead(516, fullSha);
    expect(ledger.entries[key]?.consecutiveFailureCount).toBe(3);
    expect(ledger.entries[key]?.surfaces).toEqual([
      'review-trigger-reconcile',
      'review-wake-trigger',
      'orchestrator-turn',
    ]);
  });

  it('counts infra_transport released_for_retry only', () => {
    expect(
      isCountedTerminal({
        outcome: 'released_for_retry',
        extra: { failureClass: 'infra_transport' },
      }).counted,
    ).toBe(true);
    expect(
      isCountedTerminal({
        outcome: 'released_for_retry',
        extra: { reason: 'side_effect_in_flight' },
      }).counted,
    ).toBe(false);
  });

  it('counts run_not_visible_fenced when decisionReason is readiness_envelope_exceeded', () => {
    const counted = isCountedTerminal({
      outcome: 'run_not_visible_fenced',
      extra: { decisionReason: 'readiness_envelope_exceeded' },
    });
    expect(counted.counted).toBe(true);
    expect(counted.failureClass).toBe('readiness_envelope_exceeded');

    expect(
      isCountedTerminal({
        outcome: 'run_not_visible_fenced',
        extra: { decisionReason: 'visibility_budget_exceeded' },
      }).counted,
    ).toBe(false);
  });

  it('pre-run-recheck-snapshot-forwards-transport-failure', () => {
    const reconcileSrc = readFileSync(path.join(repoRoot, 'scripts/review-trigger-reconcile.ps1'), 'utf8');
    expect(reconcileSrc).toMatch(/transportFailure\s*=\s*\$claimed\.transportFailure/);
    expect(reconcileSrc).toMatch(/Get-ReviewStartSupervisedGhInfraTransportRecheckDenial/);
    expect(reconcileSrc).toMatch(/Complete-ReviewStartClaimPreRunRecheckDenied/);
  });

  it('claimed-snapshot-transport-failure-skips-live-ao-reads', () => {
    const src = readFileSync(snapshotHelperPath, 'utf8');
    const transportBlock = src.match(/if \(-not \$transport\.ok\) \{([\s\S]*?)\n        \}/);
    expect(transportBlock).not.toBeNull();
    const block = transportBlock![1];
    expect(block).not.toMatch(/@\(Get-AoReviewRuns\)/);
    expect(block).not.toMatch(/@\(Get-AoStatusSessions\)/);
    expect(block).toMatch(/reviewRuns\s*=\s*@\(\)/);
    expect(block).toMatch(/sessions\s*=\s*@\(\)/);
  });

  it('claimed-snapshot-transport-failure-survives-ao-read-throw', () => {
    const dir = tempClaimDir();
    const fakeGhPath = path.join(
      repoRoot,
      'scripts/fixtures/review-start-envelope-external-io/fake-gh-scenario.ps1',
    );
    const supervisedGhPath = path.join(repoRoot, 'scripts/lib/Review-StartSupervisedGh.ps1');
    try {
      const script = `
        $env:AO_REVIEW_START_SUPERVISED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_GH_SCENARIO = 'dns_timeout'
        function Get-AoReviewRuns { throw 'ao unavailable without agent-orchestrator.yaml' }
        function Get-AoStatusSessions { throw 'ao unavailable without agent-orchestrator.yaml' }
        . ${psString(claimHelperPath)}
        . ${psString(supervisedGhPath)}
        . ${psString(snapshotHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 516 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $snap = Get-ClaimedReviewStartSnapshot -PrNumber 516 -Project 'orchestrator-pack' -RepoRoot ${psString(repoRoot)} -ClaimResult $claim -ResolveChecksBundle {
          param($openPrs, $prNumber, $repoRoot)
          @{ ciChecksByPr = @{}; requiredCheckNamesByPr = @{}; requiredCheckLookupFailedByPr = @{} }
        }
        [pscustomobject]@{
          transportOk = [bool]$snap.transportFailure.ok
          reviewRunCount = @($snap.reviewRuns).Count
          sessionCount = @($snap.sessions).Count
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.transportOk).toBe(false);
      expect(result.reviewRunCount).toBe(0);
      expect(result.sessionCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('pre-run-recheck-supervised-gh-transport-failure-counts-ledger', () => {
    const dir = tempClaimDir();
    const fakeGhPath = path.join(
      repoRoot,
      'scripts/fixtures/review-start-envelope-external-io/fake-gh-scenario.ps1',
    );
    const supervisedGhPath = path.join(repoRoot, 'scripts/lib/Review-StartSupervisedGh.ps1');
    const orchestratorClaimedPath = path.join(repoRoot, 'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1');
    try {
      const script = `
        $env:AO_REVIEW_START_SUPERVISED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_GH_SCENARIO = 'dns_timeout'
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        . ${psString(ledgerHelperPath)}
        . ${psString(supervisedGhPath)}
        . ${psString(orchestratorClaimedPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 516 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $snap = Get-OrchestratorClaimedReviewSnapshot -PrNumber 516 -Project 'orchestrator-pack' -RepoRoot ${psString(repoRoot)} -ClaimResult $claim
        $denial = Get-ReviewStartSupervisedGhInfraTransportRecheckDenial -Snapshot $snap
        $null = Complete-ReviewStartClaimPreRunRecheckDenied -ClaimResult $claim -Recheck $denial -ReviewRuns @()
        $entry = Read-ReviewStartEnvelopeLedgerEntry -Namespace $ns -PrNumber 516 -HeadSha $sha
        [pscustomobject]@{
          denialReason = [string]$denial.reason
          counted = [int]$entry.consecutiveFailureCount
          supervised = [bool]$denial.supervisedGhInfraTransport
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.denialReason).toBe('supervised_gh_transport_failure');
      expect(result.supervised).toBe(true);
      expect(result.counted).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('reeval-fresh-snapshot-allows-pre-claim', () => {
    const src = readFileSync(snapshotHelperPath, 'utf8');
    expect(src).not.toContain('requires an acquired claim');

    const script = `
      function Invoke-GhOpenPrList { param([string]$RepoRoot); return @(@{ number = 516; headRefOid = ${psString(fullSha)}; baseRefName = 'main' }) }
      function Get-AoReviewRuns { param([string]$Project); return @(@{ prNumber = 516; targetSha = ${psString(fullSha)}; status = 'failed' }) }
      function Get-AoStatusSessions { return @() }
      function Add-GhPrHeadCommittedAtFromFleetMemo { param([string]$RepoRoot, $Pr) }
      . ${psString(snapshotHelperPath)}
      $snapshot = Get-ClaimedReviewStartSnapshot -PrNumber 516 -Project 'orchestrator-pack' -RepoRoot ${psString(repoRoot)} -ClaimResult $null -ResolveChecksBundle {
        param($openPrs, $prNumber, $repoRoot)
        @{
          ciChecksByPr = @{ '516' = @() }
          requiredCheckNamesByPr = @{ '516' = @('Verify orchestrator-pack structure') }
          requiredCheckLookupFailedByPr = @{ '516' = $false }
        }
      }
      [pscustomobject]@{ reviewRunCount = @($snapshot.reviewRuns).Count } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.reviewRunCount).toBeGreaterThanOrEqual(1);
  });

  it('pre-claim snapshot loads post-run retry ledger from claim namespace', () => {
    const src = readFileSync(snapshotHelperPath, 'utf8');
    expect(src).toMatch(/Resolve-ReviewStartClaimNamespace/);

    const dir = tempClaimDir();
    const headSha = 'abc53900000000000000000000000000000000000';
    const postRunRetryPath = path.join(repoRoot, 'scripts/lib/Review-PostRunRetry.ps1');
    try {
      const script = `
        $env:AO_REVIEW_CLAIM_DIR = ${psString(dir)}
        $sha = ${psString(headSha)}
        function Invoke-GhOpenPrList { param([string]$RepoRoot); return @(@{ number = 539; headRefOid = $sha; baseRefName = 'main' }) }
        function Get-AoReviewRuns { param([string]$Project); return @(@{
          id = 'timeout-1'
          prNumber = 539
          targetSha = $sha
          status = 'failed'
          findingCount = 0
          terminationReason = 'reviewer-evidence:{"reviewer":{"failureClass":"timeout_no_verdict"}}'
        }) }
        function Get-AoStatusSessions { return @() }
        function Add-GhPrHeadCommittedAtFromFleetMemo { param([string]$RepoRoot, $Pr) }
        . ${psString(postRunRetryPath)}
        Register-PostRunAutonomousRetryAttempt -Namespace $env:AO_REVIEW_CLAIM_DIR -PrNumber 539 -HeadSha $sha -FailureClass 'timeout_no_verdict' -RunId 'timeout-1' | Out-Null
        . ${psString(snapshotHelperPath)}
        $snapshot = Get-ClaimedReviewStartSnapshot -PrNumber 539 -Project 'orchestrator-pack' -RepoRoot ${psString(repoRoot)} -ClaimResult $null -ResolveChecksBundle {
          param($openPrs, $prNumber, $repoRoot)
          @{
            ciChecksByPr = @{ '539' = @() }
            requiredCheckNamesByPr = @{ '539' = @('Verify orchestrator-pack structure') }
            requiredCheckLookupFailedByPr = @{ '539' = $false }
          }
        }
        $run = @($snapshot.reviewRuns)[0]
        [pscustomobject]@{
          retryEligible = [bool]$run.retryEligible
          autonomousAttemptCount = [int]$run.autonomousAttemptCount
          effectiveFailureCount = [int]$run.effectiveFailureCount
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.autonomousAttemptCount).toBe(1);
      expect(result.effectiveFailureCount).toBe(2);
      expect(result.retryEligible).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claim ledger registration tolerates failed runs with startedAt only', () => {
    const dir = tempClaimDir();
    const headSha = 'abc53900000000000000000000000000000000000';
    const postRunRetryPath = path.join(repoRoot, 'scripts/lib/Review-PostRunRetry.ps1');
    try {
      const script = `
        $env:AO_REVIEW_CLAIM_DIR = ${psString(dir)}
        $sha = ${psString(headSha)}
        . ${psString(postRunRetryPath)}
        $claim = @{ acquired = $true; namespace = $env:AO_REVIEW_CLAIM_DIR; claim = @{ prNumber = 539; headSha = $sha } }
        $runs = @(@{
          id = 'timeout-started-at-only'
          prNumber = 539
          targetSha = $sha
          status = 'failed'
          failureClass = 'timeout_no_verdict'
          startedAt = '2026-06-30T01:00:00.000Z'
        })
        $result = Register-PostRunAutonomousRetryAttemptFromClaim -ClaimResult $claim -ReviewRuns $runs
        [pscustomobject]@{ changed = [bool]$result.changed; reason = [string]$result.reason } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.changed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reeval-fresh-snapshot-scopes-checks-to-planned-pr', () => {
    const src = readFileSync(snapshotHelperPath, 'utf8');
    expect(src).toMatch(
      /Get-ReconcileChecksByPr[\s\S]*Where-Object\s*\{\s*\[int\]\$_.number\s*-eq\s*\$prNumber\s*\}/,
    );
  });

  it('report-state-seed-fresh-snapshot-preserves-terminated-sessions', () => {
    const seedPath = path.join(repoRoot, 'scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1');
    const src = readFileSync(seedPath, 'utf8');
    expect(src).toMatch(/Invoke-GhOpenPrListForNumbers/);
    expect(src).toMatch(/Get-AoStatusSessionsIncludingTerminated/);
    expect(src).toMatch(/Invoke-ReviewStartSupervisedGh/);
    expect(src).not.toMatch(/Get-ClaimedReviewStartReevalFreshSnapshot/);
    expect(src).toMatch(/transportFailure\s*=\s*\$transport/);
    expect(src).toMatch(/\$freshSnapshot\.transportFailure\s*=\s*\$transportFailure/);
  });

  it('consecutive-failure-notify-at-three', () => {
    let ledger = emptyEnvelopeLedger();
    for (let i = 0; i < 2; i += 1) {
      const result = applyLedgerTerminal({
        ledger,
        prNumber: 510,
        headSha: fullSha,
        outcome: 'hold_budget_exceeded',
        surface: 'review-trigger-reconcile',
      });
      ledger = result.ledger as ReturnType<typeof emptyEnvelopeLedger>;
      expect(result.shouldEscalate).toBe(false);
    }
    const third = applyLedgerTerminal({
      ledger,
      prNumber: 510,
      headSha: fullSha,
      outcome: 'hold_budget_exceeded',
      surface: 'review-trigger-reconcile',
    });
    expect(third.shouldEscalate).toBe(true);
    expect(evaluateLedgerEscalation({ ledger: third.ledger, prNumber: 510, headSha: fullSha }).shouldNotify).toBe(
      true,
    );

    const reset = applyLedgerReset({
      ledger: third.ledger,
      prNumber: 510,
      headSha: fullSha,
      reason: 'covered_head',
    });
    expect(reset.changed).toBe(true);
    expect(
      evaluateLedgerEscalation({ ledger: reset.ledger, prNumber: 510, headSha: fullSha }).consecutiveFailureCount,
    ).toBe(0);
  });
});

describe('review-start-envelope-ledger integration', () => {
  it(
    'cross-attempt-failure-count-persists across claim terminals',
    () => {
    const dir = tempClaimDir();
    try {
      const first = terminalizeCountedFailure(dir, 'review-trigger-reconcile', 'hold_budget_exceeded');
      const second = terminalizeCountedFailure(dir, 'review-wake-trigger', 'readiness_envelope_exceeded');
      const fenced = terminalizeCountedFailure(dir, 'orchestrator-turn', 'run_not_visible_fenced', {
        decisionReason: 'readiness_envelope_exceeded',
      });
      expect(first.consecutiveFailureCount).toBe(1);
      expect(second.consecutiveFailureCount).toBe(2);
      expect(fenced.consecutiveFailureCount).toBe(3);
      expect(fenced.surfaces).toEqual([
        'review-trigger-reconcile',
        'review-wake-trigger',
        'orchestrator-turn',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it(
    'consecutive-failure-notify-at-three emits operator-visible escalation',
    () => {
    const dir = tempClaimDir();
    const logPath = path.join(dir, 'escalate.log');
    try {
      terminalizeCountedFailure(dir, 'review-trigger-reconcile', 'hold_budget_exceeded', {}, 510);
      terminalizeCountedFailure(dir, 'review-wake-trigger', 'hold_budget_exceeded', {}, 510);
      const script = `
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        . ${psString(ledgerHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $null = Move-ReviewStartClaimToTerminal -Namespace $ns -ActivePath $claim.path -Record $claim.claim -Outcome 'released_for_retry' -Extra @{
          failureClass = 'infra_transport'
        }
        $entry = Read-ReviewStartEnvelopeLedgerEntry -Namespace $ns -PrNumber 510 -HeadSha $sha
        $auditDir = Join-Path $ns 'envelope-ledger-escalations'
        $auditCount = @((Get-ChildItem -LiteralPath $auditDir -File -ErrorAction SilentlyContinue).Name).Count
        [pscustomobject]@{
          count = [int]$entry.consecutiveFailureCount
          auditCount = $auditCount
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script, { AO_REVIEW_START_LEDGER_LOG: logPath }));
      expect(result.count).toBe(3);
      expect(result.auditCount).toBeGreaterThanOrEqual(1);

      const fewerDir = tempClaimDir();
      try {
        terminalizeCountedFailure(fewerDir, 'review-trigger-reconcile', 'hold_budget_exceeded');
        const fewer = terminalizeCountedFailure(fewerDir, 'review-wake-trigger', 'hold_budget_exceeded');
        expect(fewer.consecutiveFailureCount).toBe(2);
        const auditDir = path.join(fewerDir, 'envelope-ledger-escalations');
        let auditCount = 0;
        try {
          auditCount = readdirSync(auditDir, { withFileTypes: true }).filter((d) => d.isFile()).length;
        } catch {
          auditCount = 0;
        }
        expect(auditCount).toBe(0);
      } finally {
        rmSync(fewerDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('all-starter-surfaces-supervised-gh', () => {
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath, '-RepoRoot', repoRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'scripts/review-start-envelope-ledger-starter-surfaces.json'), 'utf8'),
    );
    expect(manifest.surfaces.length).toBeGreaterThanOrEqual(5);
  });

  it('concurrent-surfaces-single-ledger-lineage', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(ledgerHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        foreach ($surface in @('review-trigger-reconcile', 'review-wake-trigger')) {
          $record = @{ prNumber = 516; headSha = $sha; holder = @{ surface = $surface } }
          Record-ReviewStartEnvelopeLedgerTerminal -Namespace $ns -Record $record -Outcome 'hold_budget_exceeded' -Extra @{} | Out-Null
        }
        $entry = Read-ReviewStartEnvelopeLedgerEntry -Namespace $ns -PrNumber 516 -HeadSha $sha
        [pscustomobject]@{
          count = [int]$entry.consecutiveFailureCount
          surfaces = @($entry.surfaces)
        } | ConvertTo-Json -Compress -Depth 6
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.count).toBe(2);
      expect(result.surfaces.sort()).toEqual(['review-trigger-reconcile', 'review-wake-trigger'].sort());

      const raceScript = `
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $first = Acquire-ReviewStartClaim -PrNumber 516 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $second = Acquire-ReviewStartClaim -PrNumber 516 -HeadSha $sha -Surface 'review-wake-trigger' -Namespace $ns -ReviewRuns @()
        $winners = @([bool]$first.acquired, [bool]$second.acquired) | Where-Object { $_ } | Measure-Object | Select-Object -ExpandProperty Count
        $winner = if ($first.acquired) { $first } elseif ($second.acquired) { $second } else { $null }
        if ($winner) {
          $null = Complete-ReviewStartClaim -ClaimResult $winner -Outcome 'run_started' -ReviewRuns @(@{
            prNumber = 516; targetSha = $sha; status = 'queued'; id = 'run-concurrent'
          })
        }
        [pscustomobject]@{ winners = $winners } | ConvertTo-Json -Compress
      `;
      const race = JSON.parse(runPwsh(raceScript));
      expect(race.winners).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
