import { rmSync } from 'node:fs';
import path from 'node:path';

import {
  fixture,
  invariant,
  psString,
  repoRoot,
  runEvidenceMutationControls,
  runPwsh,
  tempRoot,
  type MutationRecord,
} from './task-311-common.test-support.js';

function validateClaimMatrix(candidate: Record<string, unknown>): void {
  const matrix = candidate as any;
  invariant(matrix.classes === 'C1-C7-pass', 'claim class marker missing');
  invariant(matrix.C1?.winners === 1 && matrix.C1?.runStarts === 1, 'C1 failed');
  invariant(matrix.C2?.winners === 1 && matrix.C2?.activeCount === 1, 'C2 failed');
  invariant(matrix.C3?.firstAcquired === true && matrix.C3?.secondAcquired === false, 'C3 duplicate was not suppressed');
  invariant(matrix.C3?.sameOwner === true && matrix.C3?.loserReason === 'claimed', 'C3 live ownership drifted');
  invariant(matrix.C4?.covered === true && matrix.C4?.replacementStarted === false, 'C4 covering run did not suppress replacement');
  invariant(matrix.C5?.reclaimed === true && matrix.C5?.winners === 1 && matrix.C5?.activeCount === 1, 'C5 dead-owner recovery failed');
  invariant(matrix.C6?.blocked === true && matrix.C6?.runStarted === false && matrix.C6?.reason === 'foreign_holder_manual', 'C6 ambiguous/foreign ownership did not fail closed');
  invariant(matrix.C7?.firstAcquired === true && matrix.C7?.secondAcquired === true && matrix.C7?.activeCount === 2, 'C7 cross-key isolation failed');
}

export function runClaimMatrix(): { claim: Record<string, unknown>; mutations: MutationRecord[] } {
  const root = tempRoot('task-311-claim-');
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
function New-Task311Namespace([string]$name) {
  $ns = Join-Path $root $name
  Initialize-ReviewStartClaimNamespace -Namespace $ns
  return $ns
}

$ns1 = New-Task311Namespace 'c1'
$c1 = Acquire-ReviewStartClaim -PrNumber 311 -HeadSha $shaA -Surface 'task-311-c1' -Namespace $ns1 -ReviewRuns @()
$c1Run = @{ id='task-311-c1-run'; prNumber=311; targetSha=$shaA; status='running' }
$c1Complete = Complete-ReviewStartClaim -ClaimResult $c1 -Outcome 'run_started' -ReviewRuns @($c1Run)

$ns2 = New-Task311Namespace 'c2'
$c2Rows = 1..6 | ForEach-Object -Parallel {
  $env:AO_REVIEW_CLAIM_DIR = $using:ns2
  $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '1000'
  . $using:helperPath
  $claim = Acquire-ReviewStartClaim -PrNumber 312 -HeadSha $using:shaA -Surface "task-311-c2-$($_)" -Namespace $using:ns2 -ReviewRuns @()
  [pscustomobject]@{ acquired=[bool]$claim.acquired; reason=[string]$claim.reason }
} -ThrottleLimit 6

$ns3 = New-Task311Namespace 'c3'
$c3a = Acquire-ReviewStartClaim -PrNumber 313 -HeadSha $shaA -Surface 'task-311-c3-a' -Namespace $ns3 -ReviewRuns @()
$c3b = Acquire-ReviewStartClaim -PrNumber 313 -HeadSha $shaA -Surface 'task-311-c3-b' -Namespace $ns3 -ReviewRuns @()

$ns4 = New-Task311Namespace 'c4'
$c4a = Acquire-ReviewStartClaim -PrNumber 314 -HeadSha $shaA -Surface 'task-311-c4-a' -Namespace $ns4 -ReviewRuns @()
$c4Run = @{ id='task-311-c4-run'; prNumber=314; targetSha=$shaA; status='running' }
$c4b = Acquire-ReviewStartClaim -PrNumber 314 -HeadSha $shaA -Surface 'task-311-c4-b' -Namespace $ns4 -ReviewRuns @($c4Run)

$ns5 = New-Task311Namespace 'c5'
$c5old = Acquire-ReviewStartClaim -PrNumber 315 -HeadSha $shaA -Surface 'task-311-c5-dead' -Namespace $ns5 -ReviewRuns @()
$c5record = Get-Content -LiteralPath $c5old.path -Raw -Encoding UTF8 | ConvertFrom-Json
$c5record.holder.pid = 2147483000
$c5record.holder.host = Get-ReviewStartClaimLocalHostName
$c5record.holder.PSObject.Properties.Remove('startTimeTicks')
$c5record.holder.PSObject.Properties.Remove('bootIdHash')
($c5record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $c5old.path -Encoding UTF8
$c5sweep = Invoke-ReviewStartClaimReaperSweep -Namespace $ns5 -ProjectId 'orchestrator-pack' -ReviewRuns @()
$c5Rows = 1..4 | ForEach-Object -Parallel {
  $env:AO_REVIEW_CLAIM_DIR = $using:ns5
  $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '2000'
  . $using:helperPath
  $claim = Acquire-ReviewStartClaim -PrNumber 315 -HeadSha $using:shaA -Surface "task-311-c5-$($_)" -Namespace $using:ns5 -ReviewRuns @()
  [pscustomobject]@{ acquired=[bool]$claim.acquired; recovered=[bool]$claim.recovered; reason=[string]$claim.reason }
} -ThrottleLimit 4

$ns6 = New-Task311Namespace 'c6'
$c6old = Acquire-ReviewStartClaim -PrNumber 316 -HeadSha $shaA -Surface 'task-311-c6-foreign' -Namespace $ns6 -ReviewRuns @()
$c6record = Get-Content -LiteralPath $c6old.path -Raw -Encoding UTF8 | ConvertFrom-Json
$c6record.holder.host = 'foreign-task-311.example'
($c6record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $c6old.path -Encoding UTF8
$c6sweep = Invoke-ReviewStartClaimReaperSweep -Namespace $ns6 -ProjectId 'orchestrator-pack' -ReviewRuns @()
$c6retry = Acquire-ReviewStartClaim -PrNumber 316 -HeadSha $shaA -Surface 'task-311-c6-retry' -Namespace $ns6 -ReviewRuns @()

$ns7 = New-Task311Namespace 'c7'
$c7a = Acquire-ReviewStartClaim -PrNumber 317 -HeadSha $shaA -Surface 'task-311-c7-a' -Namespace $ns7 -ReviewRuns @()
$c7b = Acquire-ReviewStartClaim -PrNumber 318 -HeadSha $shaB -Surface 'task-311-c7-b' -Namespace $ns7 -ReviewRuns @()

[ordered]@{
  classes = 'C1-C7-pass'
  C1 = @{ winners = @([bool]$c1.acquired | Where-Object { $_ }).Count; runStarts = @([bool]$c1Complete.ok | Where-Object { $_ }).Count; outcome=[string]$c1Complete.outcome }
  C2 = @{ winners = @($c2Rows | Where-Object { $_.acquired }).Count; activeCount = @((Get-ChildItem -LiteralPath $ns2 -File -Filter 'pr-312-*.json')).Count }
  C3 = @{ firstAcquired=[bool]$c3a.acquired; secondAcquired=[bool]$c3b.acquired; loserReason=[string]$c3b.reason; sameOwner=([string]$c3a.claim.holder.processGuid -eq [string]$c3b.holder.processGuid) }
  C4 = @{ covered=([string]$c4b.reason -eq 'covered_by_run'); replacementStarted=[bool]$c4b.acquired; activeCount=@((Get-ChildItem -LiteralPath $ns4 -File -Filter 'pr-314-*.json')).Count }
  C5 = @{ reclaimed=@($c5sweep.results | Where-Object { $_.reclaimed -and $_.outcome -eq 'recovered_orphan_liveness' }).Count -eq 1; winners=@($c5Rows | Where-Object { $_.acquired }).Count; activeCount=@((Get-ChildItem -LiteralPath $ns5 -File -Filter 'pr-315-*.json')).Count }
  C6 = @{ blocked=[bool]$c6retry.blocking; reason=[string]$c6retry.reason; runStarted=[bool]$c6retry.acquired; manual=@($c6sweep.results | Where-Object { $_.action -eq 'mark_manual' }).Count -eq 1 }
  C7 = @{ firstAcquired=[bool]$c7a.acquired; secondAcquired=[bool]$c7b.acquired; activeCount=@((Get-ChildItem -LiteralPath $ns7 -File -Filter 'pr-*.json')).Count }
} | ConvertTo-Json -Compress -Depth 12
`;
    const claim = JSON.parse(runPwsh(script, {
      AO_REVIEW_CLAIM_DIR: root,
      AO_REVIEW_START_MONOTONIC_NOW_MS: '1000',
    })) as Record<string, unknown>;
    validateClaimMatrix(claim);
    const mutations = runEvidenceMutationControls('AC3', claim, validateClaimMatrix, {
      'double-acquisition': (value: any) => { value.C2.winners = 2; },
      'live-claim-theft': (value: any) => { value.C3.sameOwner = false; value.C3.secondAcquired = true; },
      'cross-key-interference': (value: any) => { value.C7.secondAcquired = false; value.C7.activeCount = 1; },
      'stale-claim-not-recovered': (value: any) => { value.C5.reclaimed = false; },
      'ambiguous-ownership-recovered': (value: any) => { value.C6.blocked = false; value.C6.runStarted = true; },
      'duplicate-start-with-visible-run': (value: any) => { value.C4.replacementStarted = true; },
    });
    return { claim, mutations };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void fixture;
