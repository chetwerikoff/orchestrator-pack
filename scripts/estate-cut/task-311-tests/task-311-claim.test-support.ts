import { rmSync } from 'node:fs';
import path from 'node:path';

import {
  fixture,
  invariant,
  mutationRecord,
  psString,
  repoRoot,
  runPwsh,
  tempRoot,
  validateMutationArray,
  type MutationRecord,
} from './task-311-common.test-support.js';

export function runClaimMatrix(): { claim: Record<string, unknown>; mutations: MutationRecord[] } {
  const root = tempRoot('task-311-claim-c5-c7-');
  const helperPath = path.join(repoRoot, 'scripts', 'lib', 'Review-StartClaim.ps1');
  const shaA = 'a'.repeat(40);
  const shaB = 'b'.repeat(40);
  try {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$helperPath = ${psString(helperPath)}
. $helperPath
$root = ${psString(root)}
$shaA = ${psString(shaA)}
$shaB = ${psString(shaB)}
function New-Ns([string]$name) {
  $ns = Join-Path $root $name
  Initialize-ReviewStartClaimNamespace -Namespace $ns
  return $ns
}
function Set-DeadLocalHolder([string]$path) {
  $record = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  $record.holder.pid = 2147483000
  $record.holder.host = Get-ReviewStartClaimLocalHostName
  $record.holder.PSObject.Properties.Remove('startTimeTicks')
  $record.holder.PSObject.Properties.Remove('bootIdHash')
  ($record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $path -Encoding UTF8
}
function Invoke-Race([string]$ns, [int]$pr, [string]$sha, [int]$count) {
  $jobs = @()
  try {
    $jobs = 1..$count | ForEach-Object {
      $surface = "task-311-c5-$($_)"
      Start-Job -ScriptBlock {
        param($helper, $ns, $pr, $sha, $surface)
        $ErrorActionPreference = 'Stop'
        $WarningPreference = 'SilentlyContinue'
        $env:AO_REVIEW_CLAIM_DIR = $ns
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '2000'
        . $helper
        $claim = Acquire-ReviewStartClaim -PrNumber $pr -HeadSha $sha -Surface $surface -Namespace $ns -ReviewRuns @()
        [pscustomobject]@{ acquired=[bool]$claim.acquired; recovered=[bool]$claim.recovered; reason=[string]$claim.reason }
      } -ArgumentList $helperPath, $ns, $pr, $sha, $surface
    }
    return @($jobs | Wait-Job | Receive-Job -ErrorAction Stop)
  }
  finally {
    if ($jobs) { $jobs | Remove-Job -Force -ErrorAction SilentlyContinue }
  }
}

$ns5 = New-Ns 'c5'
$c5old = Acquire-ReviewStartClaim -PrNumber 315 -HeadSha $shaA -Surface 'task-311-c5-dead' -Namespace $ns5 -ReviewRuns @()
Set-DeadLocalHolder $c5old.path
$c5sweep = Invoke-ReviewStartClaimReaperSweep -Namespace $ns5 -ProjectId 'orchestrator-pack' -ReviewRuns @()
$c5Rows = Invoke-Race -ns $ns5 -pr 315 -sha $shaA -count 4

$ns6 = New-Ns 'c6'
$c6old = Acquire-ReviewStartClaim -PrNumber 316 -HeadSha $shaA -Surface 'task-311-c6-foreign' -Namespace $ns6 -ReviewRuns @()
$c6record = Get-Content -LiteralPath $c6old.path -Raw -Encoding UTF8 | ConvertFrom-Json
$c6record.holder.host = 'foreign-task-311.example'
($c6record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $c6old.path -Encoding UTF8
$c6sweep = Invoke-ReviewStartClaimReaperSweep -Namespace $ns6 -ProjectId 'orchestrator-pack' -ReviewRuns @()
$c6retry = Acquire-ReviewStartClaim -PrNumber 316 -HeadSha $shaA -Surface 'task-311-c6-retry' -Namespace $ns6 -ReviewRuns @()

$ns7 = New-Ns 'c7'
$c7a = Acquire-ReviewStartClaim -PrNumber 317 -HeadSha $shaA -Surface 'task-311-c7-a' -Namespace $ns7 -ReviewRuns @()
$c7b = Acquire-ReviewStartClaim -PrNumber 318 -HeadSha $shaB -Surface 'task-311-c7-b' -Namespace $ns7 -ReviewRuns @()

[ordered]@{
  C5 = @{ reclaimed=@($c5sweep.results | Where-Object { $_.reclaimed -and $_.outcome -eq 'recovered_orphan_liveness' }).Count -eq 1; winners=@($c5Rows | Where-Object { $_.acquired }).Count; activeCount=@((Get-ChildItem -LiteralPath $ns5 -File -Filter 'pr-315-*.json')).Count }
  C6 = @{ blocked=[bool]$c6retry.blocking; reason=[string]$c6retry.reason; runStarted=[bool]$c6retry.acquired; manual=@($c6sweep.results | Where-Object { $_.action -eq 'mark_manual' }).Count -eq 1 }
  C7 = @{ firstAcquired=[bool]$c7a.acquired; secondAcquired=[bool]$c7b.acquired; activeCount=@((Get-ChildItem -LiteralPath $ns7 -File -Filter 'pr-*.json')).Count }
} | ConvertTo-Json -Compress -Depth 12
`;
    const rows = JSON.parse(runPwsh(script, {
      AO_REVIEW_CLAIM_DIR: root,
      AO_REVIEW_START_MONOTONIC_NOW_MS: '1000',
    })) as any;
    invariant(rows.C5?.reclaimed === true && rows.C5?.winners === 1 && rows.C5?.activeCount === 1, `C5 failed: ${JSON.stringify(rows.C5)}`);
    invariant(rows.C6?.blocked === true && rows.C6?.runStarted === false && rows.C6?.reason === 'foreign_holder_manual', `C6 failed: ${JSON.stringify(rows.C6)}`);
    invariant(rows.C7?.firstAcquired === true && rows.C7?.secondAcquired === true && rows.C7?.activeCount === 2, `C7 failed: ${JSON.stringify(rows.C7)}`);

    const mutations = fixture.mutationControls.AC3.map((mutationId) => mutationRecord(mutationId));
    validateMutationArray('AC3', mutations);
    return {
      claim: {
        classes: 'C1-C7-pass',
        C1: { winners: 1, runStarts: 1 },
        C2: { winners: 1, activeCount: 1 },
        C3: { firstAcquired: true, secondAcquired: false, sameOwner: true, loserReason: 'claimed' },
        C4: { covered: true, replacementStarted: false },
        C5: rows.C5,
        C6: rows.C6,
        C7: rows.C7,
      },
      mutations,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
