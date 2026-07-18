#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: exact-head coverage uses pack review predicates and store data.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Assert-RequiredPaths.ps1')

$loopMjs = Join-Path $Root 'docs/review-orchestrator-loop.mjs'
$reconcileMjs = Join-Path $Root 'docs/review-trigger-reconcile.mjs'
$runStore = Join-Path $Root 'scripts/lib/pack-review-run-store.ts'
Assert-RequiredPathsExist -Paths @($loopMjs, $reconcileMjs, $runStore)

$loop = Get-Content -LiteralPath $loopMjs -Raw
if ($loop -notmatch "from '\./review-trigger-reconcile\.mjs'" -or
    $loop -notmatch 'export function shouldStartReviewRunOnUncoveredPath' -or
    $loop -notmatch 'export function evaluateReviewRunWithRecheck' -or
    $loop -notmatch 'export function evaluatePrNumberLessMergedRun') {
    Write-Host 'review-orchestrator-loop.mjs missing exact-head coverage predicate wiring'
    exit 1
}

$reconcile = Get-Content -LiteralPath $reconcileMjs -Raw
if ($reconcile -notmatch 'COVERED_TERMINAL_REVIEW_STATUSES') {
    Write-Host 'review-trigger-reconcile.mjs must export covered terminal statuses'
    exit 1
}
if ($reconcile -match '\bao\s+review\s+(?:run|list|send|execute)\b') {
    Write-Host 'review-trigger-reconcile.mjs must not use AO Reviews as coverage authority'
    exit 1
}

Write-Host '[PASS] exact-head coverage uses pack predicates and review-run store'
exit 0
