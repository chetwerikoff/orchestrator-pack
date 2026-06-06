#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #218 report→head binding must not rely solely on report-stored SHA.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Assert-RequiredPaths.ps1')

$stuckGuard = Join-Path $Root 'docs/review-ready-stuck-guard.mjs'
$reconcile = Join-Path $Root 'docs/review-trigger-reconcile.mjs'
$headReady = Join-Path $Root 'docs/review-head-ready.mjs'
$wake = Join-Path $Root 'docs/review-wake-trigger.mjs'
$ciGreen = Join-Path $Root 'docs/ci-green-wake-reconcile.mjs'
$loop = Join-Path $Root 'docs/review-orchestrator-loop.mjs'

Assert-RequiredPathsExist -Paths @($stuckGuard, $reconcile, $headReady, $wake, $ciGreen, $loop)

$stuckText = Get-Content -LiteralPath $stuckGuard -Raw
if ($stuckText -notmatch 'reportCoversHead') {
    Write-Host 'docs/review-ready-stuck-guard.mjs must bind reports via reportCoversHead (Issue #218)'
    exit 1
}

$reconcileText = Get-Content -LiteralPath $reconcile -Raw
if ($reconcileText -notmatch 'export function reportCoversHead' -or
    $reconcileText -notmatch 'resolveHeadCommittedAtMs') {
    Write-Host 'docs/review-trigger-reconcile.mjs missing Issue #218 binding exports'
    exit 1
}

$wakeText = Get-Content -LiteralPath $wake -Raw
if ($wakeText -notmatch "from '\./review-head-ready\.mjs'") {
    Write-Host 'docs/review-wake-trigger.mjs must compose review-head-ready.mjs (Issue #218 shared predicate)'
    exit 1
}

$loopText = Get-Content -LiteralPath $loop -Raw
if ($loopText -notmatch "from '\./review-head-ready\.mjs'") {
    Write-Host 'docs/review-orchestrator-loop.mjs must compose review-head-ready.mjs (Issue #218 shared predicate)'
    exit 1
}

$ciGreenText = Get-Content -LiteralPath $ciGreen -Raw
if ($ciGreenText -notmatch 'resolveHeadCommittedAtMs' -or $ciGreenText -notmatch 'findLatestReportForHead') {
    Write-Host 'docs/ci-green-wake-reconcile.mjs must thread head commit time into report binding (Issue #218)'
    exit 1
}

Write-Host '[PASS] report→head binding uses observable state (Issue #218)'
exit 0
