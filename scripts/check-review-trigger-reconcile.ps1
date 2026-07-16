#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #163/#839 pack-owned review-trigger reconciliation wiring and default cadence.
#>
# Connector-triggered completion validation.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$text = Get-Content -LiteralPath $example -Raw
$reconcileScript = Join-Path $Root 'scripts/review-trigger-reconcile.ps1'
$reconcileMjs = Join-Path $Root 'docs/review-trigger-reconcile.mjs'
$runner = Join-Path $Root 'scripts/pack-review-runner.ts'

if (-not (Test-Path -LiteralPath $reconcileScript -PathType Leaf)) {
    Write-Host 'Missing scripts/review-trigger-reconcile.ps1'
    exit 1
}
if (-not (Test-Path -LiteralPath $reconcileMjs -PathType Leaf)) {
    Write-Host 'Missing docs/review-trigger-reconcile.mjs'
    exit 1
}
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    Write-Host 'Missing scripts/pack-review-runner.ts'
    exit 1
}

$required = @(
    'STATE-DERIVED REVIEW TRIGGER',
    'HEAD READY FOR REVIEW',
    'Issue #195',
    'review-trigger-reconcile.ps1',
    'gh pr list --state open',
    'Get-AoReviewRuns pack-store view',
    'pack review runner',
    'pack-side run/status store',
    'gh pr checks',
    'never ao spawn',
    'AO_REVIEW_TRIGGER_RECONCILE_INTERVAL_MINUTES'
)

$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($text -like '*scripts/ao-review.ps1*' -or $text -like '*/reviews/trigger*') {
    $missing += 'retired daemon review-trigger wording still present'
}
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing pack-runner reconciliation phrases: {0}" -f ($missing -join ', '))
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
$reconcileDmts = Join-Path $Root 'docs/review-trigger-reconcile.d.mts'
if (-not (Test-Path -LiteralPath $reconcileDmts -PathType Leaf)) {
    Write-Host 'Missing docs/review-trigger-reconcile.d.mts'
    exit 1
}
$dmts = Get-Content -LiteralPath $reconcileDmts -Raw
if ($dmts -notmatch 'listWorkersForPr[\s\S]{0,240}sessionDetailsById') {
    Write-Host 'docs/review-trigger-reconcile.d.mts must declare sessionDetailsById for listWorkersForPr'
    exit 1
}
if ($dmts -notmatch 'PlanReconcileInput[\s\S]{0,240}sessionDetailsById') {
    Write-Host 'docs/review-trigger-reconcile.d.mts must declare sessionDetailsById on PlanReconcileInput'
    exit 1
}

Write-Host '[PASS] review-trigger reconciliation uses the pack-owned runner/store contract (Issue #839)'
exit 0
