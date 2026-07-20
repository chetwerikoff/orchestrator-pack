import { rmSync } from 'node:fs';
import path from 'node:path';

import {
  invariant,
  jsonClone,
  mutationRecord,
  psString,
  repoRoot,
  runPwsh,
  tempRoot,
  validateMutationArray,
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
  invariant(matrix.C6?.blocked === true && matrix.C6?.runStarted === false && matrix.C6?.reason === 'foreign_holder_manual', 'C6 ambiguous ownership did not fail closed');
  invariant(matrix.C7?.firstAcquired === true && matrix.C7?.secondAcquired === true && matrix.C7?.activeCount === 2, 'C7 cross-key isolation failed');
}

function expectActualRowRed(
  baseline: Record<string, unknown>,
  mutationId: string,
  rowName: string,
  actualBadRow: Record<string, unknown>,
): MutationRecord {
  const candidate = jsonClone(baseline) as any;
  candidate[rowName] = actualBadRow;
  let red = false;
  try {
    validateClaimMatrix(candidate);
  } catch {
    red = true;
  }
  invariant(red, `AC3/${mutationId} actual faulty claim scenario stayed green`);
  validateClaimMatrix(baseline);
  return mutationRecord(mutationId);
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
function Set-DeadLocalHolder([string]$path) {
  $record = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  $record.holder.pid = 2147483000
  $record.holder.host = Get-ReviewStartClaimLocalHostName
  $record.holder.PSObject.Properties.Remove('startTimeTicks')
  $record.holder.PSObject.Properties.Remove('bootIdHash')
  ($record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $path -Encoding UTF8
}

# C1-C7 positive matrix.
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
Set-DeadLocalHolder $c5old.path
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

$baseline = [ordered]@{
  classes = 'C1-C7-pass'
  C1 = @{ winners = @([bool]$c1.acquired | Where-Object { $_ }).Count; runStarts = @([bool]$c1Complete.ok | Where-Object { $_ }).Count; outcome=[string]$c1Complete.outcome }
  C2 = @{ winners = @($c2Rows | Where-Object { $_.acquired }).Count; activeCount = @((Get-ChildItem -LiteralPath $ns2 -File -Filter 'pr-312-*.json')).Count }
  C3 = @{ firstAcquired=[bool]$c3a.acquired; secondAcquired=[bool]$c3b.acquired; loserReason=[string]$c3b.reason; sameOwner=([string]$c3a.claim.holder.processGuid -eq [string]$c3b.holder.processGuid) }
  C4 = @{ covered=([string]$c4b.reason -eq 'covered_by_run'); replacementStarted=[bool]$c4b.acquired; activeCount=@((Get-ChildItem -LiteralPath $ns4 -File -Filter 'pr-314-*.json')).Count }
  C5 = @{ reclaimed=@($c5sweep.results | Where-Object { $_.reclaimed -and $_.outcome -eq 'recovered_orphan_liveness' }).Count -eq 1; winners=@($c5Rows | Where-Object { $_.acquired }).Count; activeCount=@((Get-ChildItem -LiteralPath $ns5 -File -Filter 'pr-315-*.json')).Count }
  C6 = @{ blocked=[bool]$c6retry.blocking; reason=[string]$c6retry.reason; runStarted=[bool]$c6retry.acquired; manual=@($c6sweep.results | Where-Object { $_.action -eq 'mark_manual' }).Count -eq 1 }
  C7 = @{ firstAcquired=[bool]$c7a.acquired; secondAcquired=[bool]$c7b.acquired; activeCount=@((Get-ChildItem -LiteralPath $ns7 -File -Filter 'pr-*.json')).Count }
}

# Behavioral fault: split the atomic namespace, producing two real winners.
$md1 = New-Task311Namespace 'm-double-a'
$md2 = New-Task311Namespace 'm-double-b'
$mdA = Acquire-ReviewStartClaim -PrNumber 401 -HeadSha $shaA -Surface 'm-double-a' -Namespace $md1 -ReviewRuns @()
$mdB = Acquire-ReviewStartClaim -PrNumber 401 -HeadSha $shaA -Surface 'm-double-b' -Namespace $md2 -ReviewRuns @()

# Behavioral fault: delete the live durable claim before the second starter.
$ml = New-Task311Namespace 'm-live-theft'
$mlA = Acquire-ReviewStartClaim -PrNumber 402 -HeadSha $shaA -Surface 'm-live-a' -Namespace $ml -ReviewRuns @()
$mlOwner = [string]$mlA.claim.holder.processGuid
Remove-Item -LiteralPath $mlA.path -Force
$mlB = Acquire-ReviewStartClaim -PrNumber 402 -HeadSha $shaA -Surface 'm-live-b' -Namespace $ml -ReviewRuns @()

# Behavioral fault: send the second logical key through the first key.
$mx = New-Task311Namespace 'm-cross-key'
$mxA = Acquire-ReviewStartClaim -PrNumber 403 -HeadSha $shaA -Surface 'm-cross-a' -Namespace $mx -ReviewRuns @()
$mxB = Acquire-ReviewStartClaim -PrNumber 403 -HeadSha $shaA -Surface 'm-cross-b' -Namespace $mx -ReviewRuns @()

# Behavioral fault: dead holder persisted but restart omits the real reaper.
$ms = New-Task311Namespace 'm-stale-not-recovered'
$msOld = Acquire-ReviewStartClaim -PrNumber 404 -HeadSha $shaA -Surface 'm-stale-old' -Namespace $ms -ReviewRuns @()
Set-DeadLocalHolder $msOld.path
$msRows = 1..2 | ForEach-Object {
  Acquire-ReviewStartClaim -PrNumber 404 -HeadSha $shaA -Surface "m-stale-$($_)" -Namespace $ms -ReviewRuns @()
}

# Behavioral fault: ambiguous foreign holder is misclassified as provably dead local.
$ma = New-Task311Namespace 'm-ambiguous-recovered'
$maOld = Acquire-ReviewStartClaim -PrNumber 405 -HeadSha $shaA -Surface 'm-amb-old' -Namespace $ma -ReviewRuns @()
Set-DeadLocalHolder $maOld.path
$maSweep = Invoke-ReviewStartClaimReaperSweep -Namespace $ma -ProjectId 'orchestrator-pack' -ReviewRuns @()
$maRetry = Acquire-ReviewStartClaim -PrNumber 405 -HeadSha $shaA -Surface 'm-amb-retry' -Namespace $ma -ReviewRuns @()

# Behavioral fault: restart drops the visible covering run when reacquiring.
$mv = New-Task311Namespace 'm-visible-run-dropped'
$mvA = Acquire-ReviewStartClaim -PrNumber 406 -HeadSha $shaA -Surface 'm-visible-a' -Namespace $mv -ReviewRuns @()
$mvRun = @{ id='m-visible-run'; prNumber=406; targetSha=$shaA; status='running' }
$mvComplete = Complete-ReviewStartClaim -ClaimResult $mvA -Outcome 'run_started' -ReviewRuns @($mvRun)
$mvB = Acquire-ReviewStartClaim -PrNumber 406 -HeadSha $shaA -Surface 'm-visible-b' -Namespace $mv -ReviewRuns @()

[ordered]@{
  baseline = $baseline
  controls = [ordered]@{
    doubleAcquisition = @{ winners=@([bool]$mdA.acquired, [bool]$mdB.acquired | Where-Object { $_ }).Count; activeCount=2 }
    liveClaimTheft = @{ firstAcquired=[bool]$mlA.acquired; secondAcquired=[bool]$mlB.acquired; loserReason=[string]$mlB.reason; sameOwner=($mlOwner -eq [string]$mlB.claim.holder.processGuid) }
    crossKeyInterference = @{ firstAcquired=[bool]$mxA.acquired; secondAcquired=[bool]$mxB.acquired; activeCount=@((Get-ChildItem -LiteralPath $mx -File -Filter 'pr-*.json')).Count }
    staleNotRecovered = @{ reclaimed=$false; winners=@($msRows | Where-Object { $_.acquired }).Count; activeCount=@((Get-ChildItem -LiteralPath $ms -File -Filter 'pr-404-*.json')).Count }
    ambiguousRecovered = @{ blocked=[bool]$maRetry.blocking; reason=[string]$maRetry.reason; runStarted=[bool]$maRetry.acquired; manual=@($maSweep.results | Where-Object { $_.action -eq 'mark_manual' }).Count -eq 1 }
    duplicateVisibleRun = @{ covered=([string]$mvB.reason -eq 'covered_by_run'); replacementStarted=[bool]$mvB.acquired; activeCount=@((Get-ChildItem -LiteralPath $mv -File -Filter 'pr-406-*.json')).Count }
  }
} | ConvertTo-Json -Compress -Depth 15
`;
    const result = JSON.parse(runPwsh(script, {
      AO_REVIEW_CLAIM_DIR: root,
      AO_REVIEW_START_MONOTONIC_NOW_MS: '1000',
    })) as { baseline: Record<string, unknown>; controls: Record<string, Record<string, unknown>> };
    validateClaimMatrix(result.baseline);
    const mutations = [
      expectActualRowRed(result.baseline, 'double-acquisition', 'C2', result.controls.doubleAcquisition!),
      expectActualRowRed(result.baseline, 'live-claim-theft', 'C3', result.controls.liveClaimTheft!),
      expectActualRowRed(result.baseline, 'cross-key-interference', 'C7', result.controls.crossKeyInterference!),
      expectActualRowRed(result.baseline, 'stale-claim-not-recovered', 'C5', result.controls.staleNotRecovered!),
      expectActualRowRed(result.baseline, 'ambiguous-ownership-recovered', 'C6', result.controls.ambiguousRecovered!),
      expectActualRowRed(result.baseline, 'duplicate-start-with-visible-run', 'C4', result.controls.duplicateVisibleRun!),
    ];
    validateMutationArray('AC3', mutations);
    return { claim: result.baseline, mutations };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
