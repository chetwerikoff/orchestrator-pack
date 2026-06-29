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
  it('cross-attempt-failure-count-persists across claim terminals', () => {
    const dir = tempClaimDir();
    try {
      const first = terminalizeCountedFailure(dir, 'review-trigger-reconcile', 'hold_budget_exceeded');
      const second = terminalizeCountedFailure(dir, 'review-wake-trigger', 'readiness_envelope_exceeded');
      const third = terminalizeCountedFailure(dir, 'orchestrator-turn', 'readiness_attempt_ceiling_exceeded');
      expect(first.consecutiveFailureCount).toBe(1);
      expect(second.consecutiveFailureCount).toBe(2);
      expect(third.consecutiveFailureCount).toBe(3);
      expect(third.surfaces).toEqual([
        'review-trigger-reconcile',
        'review-wake-trigger',
        'orchestrator-turn',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('consecutive-failure-notify-at-three emits operator-visible escalation', () => {
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
  });

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
  });
});
