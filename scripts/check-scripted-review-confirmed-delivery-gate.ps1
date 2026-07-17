#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #669 confirmed-delivery surfaces, updated by Issue #894 journal-first runner ownership.
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
$explicitSendLibPath = Join-Path $Root 'scripts/lib/Invoke-ScriptedReviewDeliveryExplicitSend.ps1'
if (-not (Test-Path -LiteralPath $explicitSendLibPath -PathType Leaf)) {
    Write-Host "Missing required file: $explicitSendLibPath"
    exit 1
}
$explicitSendLib = Get-Content -LiteralPath $explicitSendLibPath -Raw
if ($ps1 -notmatch 'Invoke-ScriptedReviewDeliveryExplicitSend' -or $explicitSendLib -notmatch 'journaled-worker-send\.ps1') {
    Write-Host 'confirmed-delivery gate must route explicit send through shared journaled-worker-send lib'
    exit 1
}
if ($ps1 -notmatch '\[string\]\$DeliveryMessage') {
    Write-Host 'scripted-review-confirmed-delivery-gate.ps1 must declare -DeliveryMessage for supervised launch'
    exit 1
}
if ($ps1 -notmatch 'Write-OrchestratorSideProcessProgress') {
    Write-Host 'scripted-review-confirmed-delivery-gate.ps1 must report supervised side-process progress'
    exit 1
}
if ($ps1 -match 'New-ScriptedReviewDeliveryGatePollStepBase \+ @\{') {
    Write-Host 'scripted-review-confirmed-delivery-gate.ps1 must build poll-step payloads in statement mode'
    exit 1
}
if ($ps1 -notmatch 'New-ScriptedReviewDeliveryGatePollStepPayload') {
    Write-Host 'scripted-review-confirmed-delivery-gate.ps1 must merge poll-step fields via New-ScriptedReviewDeliveryGatePollStepPayload'
    exit 1
}

$runbookText = Get-Content -LiteralPath $runbook -Raw
$invokePackReview = Join-Path $Root 'scripts/invoke-pack-review.ps1'
$runnerPath = Join-Path $Root 'scripts/pack-review-runner.ts'
$deliveryModulePath = Join-Path $Root 'scripts/lib/pack-review-delivery.ts'
$postSubmitLib = Join-Path $Root 'scripts/lib/Invoke-ScriptedReviewPostSubmitDelivery.ps1'
$postSubmitMjs = Join-Path $Root 'docs/scripted-review-post-submit-delivery.mjs'
foreach ($path in @($invokePackReview, $runnerPath, $deliveryModulePath, $postSubmitLib, $postSubmitMjs)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required delivery ownership file: $path"
        exit 1
    }
}

$invokeText = Get-Content -LiteralPath $invokePackReview -Raw
$runnerText = Get-Content -LiteralPath $runnerPath -Raw
$deliveryModuleText = Get-Content -LiteralPath $deliveryModulePath -Raw
$postSubmitLibText = Get-Content -LiteralPath $postSubmitLib -Raw
$postSubmitMjsText = Get-Content -LiteralPath $postSubmitMjs -Raw

if ($invokeText -match 'Invoke-ScriptedReviewPostSubmitDelivery\.ps1' -or
    $invokeText -match 'Invoke-ScriptedReviewPostSubmitDeliveryFromPackReview') {
    Write-Host 'invoke-pack-review.ps1 must not own post-verdict delivery after Issue #894'
    exit 1
}
foreach ($requiredRunnerSymbol in @('deliverPackReviewVerdict', 'recordPackReviewPendingStatus', 'recordMalformedPackReviewStatus')) {
    if ($runnerText -notmatch [regex]::Escape($requiredRunnerSymbol)) {
        Write-Host "pack-review-runner.ts missing journal-first delivery symbol: $requiredRunnerSymbol"
        exit 1
    }
}
$deliveryStart = $deliveryModuleText.IndexOf('export async function deliverPackReviewVerdict')
if ($deliveryStart -lt 0) {
    Write-Host 'pack-review-delivery.ts missing deliverPackReviewVerdict'
    exit 1
}
$deliveryBody = $deliveryModuleText.Substring($deliveryStart)
$journalIndex = $deliveryBody.IndexOf('await journalVerdict')
$commentIndex = $deliveryBody.IndexOf('await options.postGithubComment')
$statusIndex = $deliveryBody.IndexOf('await options.writeRequiredStatus')
$workerIndex = $deliveryBody.IndexOf('await options.notifyWorker')
if ($journalIndex -lt 0 -or $commentIndex -lt 0 -or $statusIndex -lt 0 -or $workerIndex -lt 0) {
    Write-Host 'pack-review-delivery.ts missing one or more journal/delivery channel calls'
    exit 1
}
if ($journalIndex -gt $commentIndex -or $journalIndex -gt $statusIndex -or $journalIndex -gt $workerIndex) {
    Write-Host 'pack-review-delivery.ts must journal before every outbound delivery channel'
    exit 1
}
if ($postSubmitLibText -notmatch 'Invoke-ScriptedReviewStdoutDelivery') {
    Write-Host 'Invoke-ScriptedReviewPostSubmitDelivery.ps1 must retain the isolated stdout-delivery adapter surface'
    exit 1
}
if ($postSubmitLibText -match 'Wait-ScriptedReviewSubmittedRun|submit_visibility_timeout') {
    Write-Host 'Invoke-ScriptedReviewPostSubmitDelivery.ps1 must not poll daemon submit visibility (Issue #718)'
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
if ($postSubmitMjsText -notmatch 'ambiguous_overlapping_submits') {
    Write-Host 'scripted-review-post-submit-delivery.mjs must escalate ambiguous concurrent same-head submits'
    exit 1
}
if ($postSubmitLibText -notmatch 'Invoke-ScriptedReviewPostSubmitDeliveryEscalation') {
    Write-Host 'Invoke-ScriptedReviewPostSubmitDelivery.ps1 must retain escalation for isolated adapter failures'
    exit 1
}
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$gateChild = @($registry.children | Where-Object { $_.id -eq 'scripted-review-confirmed-delivery-gate' })
if ($gateChild.Count -gt 0) {
    Write-Host 'orchestrator-side-process-registry.json must not register scripted-review-confirmed-delivery-gate as supervised polling child (Issue #701)'
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

Write-Host '[PASS] scripted review confirmed-delivery gate wiring (Issue #669, per-review supervisor child #701)'
exit 0
