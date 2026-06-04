#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #163 review-trigger reconciliation wiring and default cadence.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$text = Get-Content -LiteralPath $example -Raw
$reconcileScript = Join-Path $Root 'scripts/review-trigger-reconcile.ps1'
$reconcileMjs = Join-Path $Root 'docs/review-trigger-reconcile.mjs'

if (-not (Test-Path -LiteralPath $reconcileScript -PathType Leaf)) {
    Write-Host 'Missing scripts/review-trigger-reconcile.ps1'
    exit 1
}

if (-not (Test-Path -LiteralPath $reconcileMjs -PathType Leaf)) {
    Write-Host 'Missing docs/review-trigger-reconcile.mjs'
    exit 1
}

$required = @(
    'STATE-DERIVED REVIEW TRIGGER',
    'review-trigger-reconcile.ps1',
    'gh pr list --state open',
    'ao review list --json',
    'never ao spawn',
    'AO_REVIEW_TRIGGER_RECONCILE_INTERVAL_MINUTES'
)

$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing reconciliation phrases: {0}" -f ($missing -join ', '))
    exit 1
}

$mjs = Get-Content -LiteralPath $reconcileMjs -Raw
if ($mjs -notmatch 'DEFAULT_RECONCILE_INTERVAL_MS = 20 \* 60 \* 1000') {
    Write-Host 'docs/review-trigger-reconcile.mjs must default to 20-minute interval'
    exit 1
}

Write-Host '[PASS] review-trigger reconciliation entrypoint and example wiring (Issue #163)'
exit 0
