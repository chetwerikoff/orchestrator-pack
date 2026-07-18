#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: pack-owned review-trigger reconciliation runtime wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$reconcileScript = Join-Path $Root 'scripts/review-trigger-reconcile.ps1'
$reconcileMjs = Join-Path $Root 'docs/review-trigger-reconcile.mjs'
$reconcileDmts = Join-Path $Root 'docs/review-trigger-reconcile.d.mts'
$runner = Join-Path $Root 'scripts/pack-review-runner.ts'

foreach ($path in @($reconcileScript, $reconcileMjs, $reconcileDmts, $runner)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required path: $path"
        exit 1
    }
}

$mjs = Get-Content -LiteralPath $reconcileMjs -Raw
if ($mjs -notmatch 'DEFAULT_RECONCILE_INTERVAL_MS = 10 \* 60 \* 1000') {
    Write-Host 'review-trigger-reconcile.mjs must default to 10-minute interval'
    exit 1
}
if ($mjs -notmatch "from '\./review-head-ready\.mjs'") {
    Write-Host 'review-trigger-reconcile.mjs must import review-head-ready.mjs'
    exit 1
}
if ($mjs -match '\bao\s+review\s+run\b') {
    Write-Host 'review-trigger-reconcile.mjs must not invoke AO review run'
    exit 1
}

$reconcilePs1 = Get-Content -LiteralPath $reconcileScript -Raw
if ($reconcilePs1 -match 'Join-Path \$PackRoot ''agent-orchestrator\.yaml\.example''') {
    Write-Host 'review-trigger-reconcile.ps1 must not use the tracked example as live policy'
    exit 1
}
if ($reconcilePs1 -notmatch 'Invoke-AoReviewTriggerForWorker') {
    Write-Host 'review-trigger-reconcile.ps1 must route starts through the pack-runner adapter'
    exit 1
}
if ($reconcilePs1 -match "@\('review',\s*'run'" -or $reconcilePs1 -match '&\s+ao\s+@runArgs') {
    Write-Host 'review-trigger-reconcile.ps1 must not invoke AO review run'
    exit 1
}

Write-Host '[PASS] review-trigger reconciliation uses pack-owned runtime wiring'
exit 0
