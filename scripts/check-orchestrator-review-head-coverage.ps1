#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: orchestratorRules covered-head idempotency (Issue #189).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$agentRules = Join-Path $Root 'prompts/agent_rules.md'
$loopMjs = Join-Path $Root 'docs/review-orchestrator-loop.mjs'
$reconcileMjs = Join-Path $Root 'docs/review-trigger-reconcile.mjs'

foreach ($path in @($example, $agentRules, $loopMjs, $reconcileMjs)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $path"
        exit 1
    }
}

$exampleText = Get-Content -LiteralPath $example -Raw
$rulesText = Get-Content -LiteralPath $agentRules -Raw

$requiredExample = @(
    'REVIEW RUN IDEMPOTENCY',
    'Issue #189',
    'covered terminal',
    'needs_triage',
    'waiting_update',
    'SAME prNumber linkage',
    'normalized head SHA',
    'different PR does NOT count',
    'different targetSha does NOT count',
    'FAILED / CANCELLED ON CURRENT HEAD',
    'not plain uncovered',
    'PRE-RUN COVERAGE RE-CHECK',
    're-read ao review list --json',
    'Runs with no prNumber',
    'linkedSessionId',
    'fail closed to inaction'
)

$missingExample = @($requiredExample | Where-Object { $exampleText -notlike "*$_*" })
if ($missingExample.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing Issue #189 phrases: {0}" -f ($missingExample -join ', '))
    exit 1
}

$requiredRules = @(
    'Orchestrator review-run coverage',
    'Issue #189',
    'covered terminal',
    'PRE-RUN COVERAGE RE-CHECK',
    'prNumber-less',
    'fail closed to'
)

$missingRules = @($requiredRules | Where-Object { $rulesText -notlike "*$_*" })
if ($missingRules.Count -gt 0) {
    Write-Host ("prompts/agent_rules.md missing Issue #189 mirror phrases: {0}" -f ($missingRules -join ', '))
    exit 1
}

$loop = Get-Content -LiteralPath $loopMjs -Raw
if ($loop -notmatch "from '\./review-trigger-reconcile\.mjs'") {
    Write-Host 'docs/review-orchestrator-loop.mjs must import coverage from review-trigger-reconcile.mjs'
    exit 1
}

if ($loop -notmatch 'export function shouldStartReviewRunOnUncoveredPath' -or
    $loop -notmatch 'export function evaluateReviewRunWithRecheck' -or
    $loop -notmatch 'export function evaluatePrNumberLessMergedRun') {
    Write-Host 'docs/review-orchestrator-loop.mjs missing Issue #189 predicate exports'
    exit 1
}

if ($reconcileMjs -notmatch "COVERED_TERMINAL_REVIEW_STATUSES") {
    Write-Host 'docs/review-trigger-reconcile.mjs must export COVERED_TERMINAL_REVIEW_STATUSES'
    exit 1
}

Write-Host '[PASS] orchestratorRules covered-head idempotency and no-drift wiring (Issue #189)'
exit 0
