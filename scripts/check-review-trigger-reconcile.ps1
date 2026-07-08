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
    'HEAD READY FOR REVIEW',
    'Issue #195',
    'review-trigger-reconcile.ps1',
    'gh pr list --state open',
    'Get-AoReviewRuns',
    'gh pr checks',
    'never ao spawn',
    'AO_REVIEW_TRIGGER_RECONCILE_INTERVAL_MINUTES'
)

$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing reconciliation phrases: {0}" -f ($missing -join ', '))
    exit 1
}

$mjs = Get-Content -LiteralPath $reconcileMjs -Raw
if ($mjs -notmatch 'DEFAULT_RECONCILE_INTERVAL_MS = 10 \* 60 \* 1000') {
    Write-Host 'docs/review-trigger-reconcile.mjs must default to 10-minute interval'
    exit 1
}

if ($mjs -notmatch "from '\./review-head-ready\.mjs'") {
    Write-Host 'docs/review-trigger-reconcile.mjs must import review-head-ready.mjs (Issue #195)'
    exit 1
}

$reconcilePs1 = Get-Content -LiteralPath $reconcileScript -Raw
if ($reconcilePs1 -notmatch 'Test-ReconcileReactionConfigDefer') {
    Write-Host 'scripts/review-trigger-reconcile.ps1 must defer when reaction config is unavailable (Issue #402)'
    exit 1
}

if ($reconcilePs1 -notmatch 'Resolve-OperatorOrchestratorYamlPath') {
    Write-Host 'scripts/review-trigger-reconcile.ps1 must resolve operator YAML from AO runtime binding (Issue #402)'
    exit 1
}
if ($reconcilePs1 -match "Join-Path \$PackRoot 'agent-orchestrator\.yaml\.example'") {
    Write-Host 'scripts/review-trigger-reconcile.ps1 must not fall back to agent-orchestrator.yaml.example for runtime config (Issue #402)'
    exit 1
}

if ($mjs -notmatch 'resolveReconcileEvaluationSession\([\s\S]{0,240}sessionDetailsById') {
    Write-Host 'docs/review-trigger-reconcile.mjs must pass sessionDetailsById into resolveReconcileEvaluationSession'
    exit 1
}
if ($reconcilePs1 -notlike '*sessionDetailsById*') {
    Write-Host 'scripts/review-trigger-reconcile.ps1 must thread session-get displayName into reconcile snapshots'
    exit 1
}

Write-Host '[PASS] review-trigger reconciliation entrypoint and example wiring (Issue #163)'
exit 0
