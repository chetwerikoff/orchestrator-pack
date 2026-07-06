#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: orchestratorRules covered-head idempotency (Issue #189, #625).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Assert-RequiredPaths.ps1')
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$agentRules = Join-Path $Root 'prompts/agent_rules.md'
$loopMjs = Join-Path $Root 'docs/review-orchestrator-loop.mjs'
$reconcileMjs = Join-Path $Root 'docs/review-trigger-reconcile.mjs'

Assert-RequiredPathsExist -Paths @($example, $agentRules, $loopMjs, $reconcileMjs)

$exampleText = Get-Content -LiteralPath $example -Raw
$rulesText = Get-Content -LiteralPath $agentRules -Raw

$requiredExample = @(
    'REVIEW RUN IDEMPOTENCY',
    'Issue #189',
    'covered terminal',
    'up_to_date',
    'changes_requested',
    'SAME prNumber linkage',
    'normalized head SHA',
    'different PR does NOT count',
    'different targetSha does NOT count',
    'FAILED / CANCELLED ON CURRENT HEAD',
    'not plain uncovered',
    'PRE-RUN COVERAGE RE-CHECK',
    'Runs with no prNumber',
    'linkedSessionId',
    'fail closed to inaction',
    'SCRIPT-OWNED ROUTINE REVIEW',
    'review-trigger-reconcile.ps1',
    'review-trigger-reeval.ps1',
    'orchestrator-wake-listener.ps1',
    'issue #641'
)

$missingExample = @($requiredExample | Where-Object { $exampleText -notlike "*$_*" })
if ($exampleText -notlike '*re-read Get-AoReviewRuns*' -and $exampleText -notlike '*Get-AoReviewRuns fan-out*') {
    $missingExample += 're-read Get-AoReviewRuns'
}
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
    'fail closed to',
    'Orchestrator LLM role vs script-owned review',
    'review-trigger-reconcile.ps1',
    'review-trigger-reeval.ps1',
    'orchestrator-wake-listener.ps1',
    'does **not** start or drive routine',
    'issue #641',
    'Script-owned procedure'
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

$reconcile = Get-Content -LiteralPath $reconcileMjs -Raw
if ($reconcile -notmatch 'COVERED_TERMINAL_REVIEW_STATUSES') {
    Write-Host 'docs/review-trigger-reconcile.mjs must export COVERED_TERMINAL_REVIEW_STATUSES'
    exit 1
}

Write-Host '[PASS] orchestratorRules covered-head idempotency and no-drift wiring (Issue #189)'
exit 0
