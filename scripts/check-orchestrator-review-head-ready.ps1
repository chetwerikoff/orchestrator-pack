#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: head-ready predicate wiring for pack-owned review.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Assert-RequiredPaths.ps1')

$headReadyMjs = Join-Path $Root 'docs/review-head-ready.mjs'
$loopMjs = Join-Path $Root 'docs/review-orchestrator-loop.mjs'
$reconcileMjs = Join-Path $Root 'docs/review-trigger-reconcile.mjs'
Assert-RequiredPathsExist -Paths @($headReadyMjs, $loopMjs, $reconcileMjs)

$headReady = Get-Content -LiteralPath $headReadyMjs -Raw
if ($headReady -notmatch 'export function evaluateHeadReadyForReview' -or
    $headReady -notmatch 'export function preRunHeadReadyRecheck') {
    Write-Host 'review-head-ready.mjs missing canonical predicate exports'
    exit 1
}

$reconcile = Get-Content -LiteralPath $reconcileMjs -Raw
if ($reconcile -notmatch "from '\./review-head-ready\.mjs'" -or
    $reconcile -notmatch 'preRunRecheck') {
    Write-Host 'review-trigger-reconcile.mjs must compose review-head-ready.mjs'
    exit 1
}
if ($reconcile -match '\bao\s+review\s+run\b') {
    Write-Host 'review-trigger-reconcile.mjs must not invoke AO review run'
    exit 1
}

$loop = Get-Content -LiteralPath $loopMjs -Raw
if ($loop -notmatch "from '\./review-head-ready\.mjs'" -or
    $loop -notmatch 'export function shouldStartReviewRun') {
    Write-Host 'review-orchestrator-loop.mjs must export shouldStartReviewRun from the head-ready predicate'
    exit 1
}

Write-Host '[PASS] head-ready predicate is composed by pack-owned starters'
exit 0
