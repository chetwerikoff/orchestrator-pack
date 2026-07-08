#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #195 head-ready-for-review predicate wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Assert-RequiredPaths.ps1')
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$scriptOwnedDoc = Join-Path $Root 'docs/script-owned-review-pipeline.md'
$headReadyMjs = Join-Path $Root 'docs/review-head-ready.mjs'
$loopMjs = Join-Path $Root 'docs/review-orchestrator-loop.mjs'
$reconcileMjs = Join-Path $Root 'docs/review-trigger-reconcile.mjs'

Assert-RequiredPathsExist -Paths @($example, $scriptOwnedDoc, $headReadyMjs, $loopMjs, $reconcileMjs)

$exampleText = Get-Content -LiteralPath $example -Raw
$rulesText = Get-Content -LiteralPath $scriptOwnedDoc -Raw

$requiredExample = @(
    'HEAD READY FOR REVIEW',
    'Issue #195',
    'ready_for_review',
    'uncovered-but-not-ready',
    'PRE-RUN HEAD-READY RE-CHECK',
    'degraded-CI orchestrator branch',
    'ROUND PROGRESSION',
    'only when the new head is ready for review',
    'SCRIPT-OWNED ROUTINE REVIEW',
    'review-trigger-reconcile.ps1',
    'review-trigger-reeval.ps1',
    'orchestrator-wake-listener.ps1'
)

$missingExample = @($requiredExample | Where-Object { $exampleText -notlike "*$_*" })
if ($missingExample.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing Issue #195 phrases: {0}" -f ($missingExample -join ', '))
    exit 1
}

$requiredRules = @(
    'Head ready for review',
    'Issue #195',
    'review-head-ready.mjs',
    'uncovered-but-not-ready',
    'PRE-RUN HEAD-READY RE-CHECK',
    'review-trigger-reconcile.ps1',
    'review-trigger-reeval.ps1',
    'orchestrator-wake-listener.ps1',
    'does **not** apply this gate for routine rounds',
    'issue #641'
)

$missingRules = @($requiredRules | Where-Object { $rulesText -notlike "*$_*" })
if ($missingRules.Count -gt 0) {
    Write-Host ("docs/script-owned-review-pipeline.md missing Issue #195 mirror phrases: {0}" -f ($missingRules -join ', '))
    exit 1
}

$headReady = Get-Content -LiteralPath $headReadyMjs -Raw
if ($headReady -notmatch 'export function evaluateHeadReadyForReview' -or
    $headReady -notmatch 'export function preRunHeadReadyRecheck') {
    Write-Host 'docs/review-head-ready.mjs missing canonical predicate exports'
    exit 1
}

$reconcile = Get-Content -LiteralPath $reconcileMjs -Raw
if ($reconcile -notmatch "from '\./review-head-ready\.mjs'" -or
    $reconcile -notmatch "preRunRecheck") {
    Write-Host 'docs/review-trigger-reconcile.mjs must compose review-head-ready.mjs'
    exit 1
}

$loop = Get-Content -LiteralPath $loopMjs -Raw
if ($loop -notmatch "from '\./review-head-ready\.mjs'" -or
    $loop -notmatch 'export function shouldStartReviewRun') {
    Write-Host 'docs/review-orchestrator-loop.mjs must export shouldStartReviewRun from head-ready predicate'
    exit 1
}

Write-Host '[PASS] head-ready-for-review predicate wiring (Issue #195)'
exit 0
