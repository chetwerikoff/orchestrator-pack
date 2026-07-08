#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #669 scripted review confirmed-delivery gate.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$gatePath = Join-Path $Root 'scripts/scripted-review-confirmed-delivery-gate.ps1'
$seamPath = Join-Path $Root 'scripts/invoke-scripted-review-post-submit-delivery.ps1'
$mjsPath = Join-Path $Root 'docs/scripted-review-confirmed-delivery-gate.mjs'
$matrixPath = Join-Path $Root 'docs/issues_drafts/231-scripted-review-confirmed-delivery-scenario-matrix.md'
$runbook = Join-Path $Root 'docs/orchestrator-recovery-runbook.md'

foreach ($path in @($gatePath, $seamPath, $mjsPath, $matrixPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $path"
        exit 1
    }
}

$mjs = Get-Content -LiteralPath $mjsPath -Raw
if ($mjs -notmatch 'DEFAULT_POLL_WINDOW_MS = 45 \* 1000') {
    Write-Host 'scripted-review-confirmed-delivery-gate.mjs must default poll window to 45s'
    exit 1
}
if ($mjs -notmatch 'MAX_POLL_WINDOW_MS = 120 \* 1000') {
    Write-Host 'scripted-review-confirmed-delivery-gate.mjs must hard-cap poll window at 120s'
    exit 1
}
if ($mjs -notmatch "=== 'delivered'") {
    Write-Host 'scripted-review-confirmed-delivery-gate.mjs must confirm only latestRun.status=delivered'
    exit 1
}

$ps1 = Get-Content -LiteralPath $gatePath -Raw
if ($ps1 -notmatch 'Get-AoSessionReviewsJson') {
    Write-Host 'scripted-review-confirmed-delivery-gate.ps1 must poll via Get-AoSessionReviewsJson'
    exit 1
}
if ($ps1 -match '(?:Read-|Open-|sqlite3|SELECT\s+).{0,20}ao\.db') {
    Write-Host 'scripted-review-confirmed-delivery-gate.ps1 must not read ao.db directly'
    exit 1
}
if ($ps1 -notmatch 'journaled-worker-send\.ps1') {
    Write-Host 'scripted-review-confirmed-delivery-gate.ps1 must use journaled-worker-send for explicit send'
    exit 1
}
if ($ps1 -notmatch 'Write-OrchestratorSideProcessProgress') {
    Write-Host 'scripted-review-confirmed-delivery-gate.ps1 must report supervised side-process progress'
    exit 1
}

$runbookText = Get-Content -LiteralPath $runbook -Raw
$invokePackReview = Join-Path $Root 'scripts/invoke-pack-review.ps1'
$postSubmitLib = Join-Path $Root 'scripts/lib/Invoke-ScriptedReviewPostSubmitDelivery.ps1'
$postSubmitMjs = Join-Path $Root 'docs/scripted-review-post-submit-delivery.mjs'
foreach ($path in @($invokePackReview, $postSubmitLib, $postSubmitMjs)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required post-submit wiring file: $path"
        exit 1
    }
}

$invokeText = Get-Content -LiteralPath $invokePackReview -Raw
$postSubmitLibText = Get-Content -LiteralPath $postSubmitLib -Raw
$postSubmitMjsText = Get-Content -LiteralPath $postSubmitMjs -Raw
if ($invokeText -notmatch 'Invoke-ScriptedReviewPostSubmitDelivery\.ps1') {
    Write-Host 'invoke-pack-review.ps1 must dot-source Invoke-ScriptedReviewPostSubmitDelivery.ps1'
    exit 1
}
$postSubmitCallCount = ([regex]::Matches($invokeText, 'Invoke-ScriptedReviewPostSubmitDeliveryFromPackReview')).Count
if ($postSubmitCallCount -lt 2) {
    Write-Host 'invoke-pack-review.ps1 must invoke post-submit delivery on both successful wrapper branches'
    exit 1
}
if ($invokeText -notmatch 'invoke-scripted-review-post-submit-delivery\.ps1' -and $invokeText -notmatch 'Invoke-ScriptedReviewPostSubmitDeliveryFromPackReview') {
    Write-Host 'invoke-pack-review.ps1 must route through invoke-scripted-review-post-submit-delivery seam'
    exit 1
}
if ($postSubmitLibText -notmatch 'Invoke-ScriptedReviewDeliveryGateProcess') {
    Write-Host 'Invoke-ScriptedReviewPostSubmitDelivery.ps1 must run delivery gate as a supervised child'
    exit 1
}
if ($postSubmitLibText -notmatch 'Start-OrchestratorWakeSupervisorChild') {
    Write-Host 'Invoke-ScriptedReviewPostSubmitDelivery.ps1 must launch delivery gate via wake supervisor (AC#10)'
    exit 1
}
if ($postSubmitLibText -match 'Get-PackReviewWrapperProcessStartInfo') {
    Write-Host 'Invoke-ScriptedReviewPostSubmitDelivery.ps1 must not bypass wake supervisor with raw Process.Start'
    exit 1
}
if ($postSubmitLibText -match '\[string\]\$message\.message \| pwsh') {
    Write-Host 'Invoke-ScriptedReviewPostSubmitDelivery.ps1 must not pipe gate output to inherited stdout'
    exit 1
}
if ($postSubmitMjsText -notmatch 'resolveSubmittedRunTerminalStatus') {
    Write-Host 'scripted-review-post-submit-delivery.mjs must prefer latestRunStatus for terminal run lookup'
    exit 1
}
if ($postSubmitLibText -notmatch 'Invoke-ScriptedReviewPostSubmitDeliveryEscalation') {
    Write-Host 'Invoke-ScriptedReviewPostSubmitDelivery.ps1 must escalate unattributed submit failures'
    exit 1
}
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$gateChild = @($registry.children | Where-Object { $_.id -eq 'scripted-review-confirmed-delivery-gate' })
if ($gateChild.Count -ne 1) {
    Write-Host 'orchestrator-side-process-registry.json must register scripted-review-confirmed-delivery-gate child (AC#10)'
    exit 1
}

$required = @(
    'scripted-review-confirmed-delivery-gate',
    'AO_SCRIPTED_REVIEW_DELIVERY_POLL_WINDOW_SECONDS',
    'AO_SCRIPTED_REVIEW_DELIVERY_POLL_INTERVAL_SECONDS',
    'Operator remedy'
)
$missing = @($required | Where-Object { $runbookText -notlike "*$_*" })
if ($missing.Count -gt 0) {
    Write-Host ("orchestrator-recovery-runbook.md missing: {0}" -f ($missing -join ', '))
    exit 1
}

Write-Host '[PASS] scripted review confirmed-delivery gate wiring (Issue #669)'
exit 0
