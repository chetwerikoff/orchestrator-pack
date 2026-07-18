#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: worker-message submit reconciler runtime wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $Root 'scripts/worker-message-submit-reconcile.ps1'
$mjsPath = Join-Path $Root 'docs/worker-message-submit-reconcile.mjs'
$observeMjs = Join-Path $Root 'docs/worker-message-dispatch-observe.mjs'
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$busyMarkerPath = Join-Path $Root 'docs/worker-message-submit-busy-dispatch-smoke-markers.json'
$auditPath = Join-Path $Root 'docs/submit-reconcile-delivery-source-audit.json'
$dispatchPs1 = Join-Path $Root 'scripts/lib/Record-WorkerMessageDispatch.ps1'
$reactionGetter = Join-Path $Root 'scripts/lib/Get-ReactionMessagesFromYaml.ps1'
$reviewSendPs1 = Join-Path $Root 'scripts/review-send-reconcile.ps1'

foreach ($path in @(
        $scriptPath,
        $mjsPath,
        $observeMjs,
        $registryPath,
        $busyMarkerPath,
        $auditPath,
        $dispatchPs1,
        $reactionGetter,
        $reviewSendPs1
    )) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required runtime file: $path"
        exit 1
    }
}

$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
if ($registry.requiredChildIds -notcontains 'worker-message-submit-reconcile') {
    Write-Host 'side-process registry must require worker-message-submit-reconcile'
    exit 1
}

$mjs = Get-Content -LiteralPath $mjsPath -Raw
foreach ($marker in @(
        'DEFAULT_SUBMIT_RECONCILE_INTERVAL_MS = 30 * 1000',
        'OPERATOR_ESCALATION_PREFIX',
        'validateBusyDispatchMarker',
        'resolveBusyDispatchCapability',
        'isSubmitEnterAuthorizedByAdoption',
        'ADOPTION_STATUS_WRAPPER_NOT_ADOPTED',
        'DEFAULT_DELIVERY_BACKSTOP_MS',
        'DEFAULT_POST_DISPATCH_LEASE_MS'
    )) {
    if ($mjs -notmatch [regex]::Escape($marker)) {
        Write-Host "worker-message-submit-reconcile.mjs missing runtime marker: $marker"
        exit 1
    }
}

$observe = Get-Content -LiteralPath $observeMjs -Raw
foreach ($marker in @(
        'AO_PASTE_CHAR_THRESHOLD = 200',
        'hasPositiveConsumptionEvidence',
        'consumedAfterFlushObserved',
        'reportCorrelatesToDelivery'
    )) {
    if ($observe -notmatch [regex]::Escape($marker)) {
        Write-Host "worker-message-dispatch-observe.mjs missing runtime marker: $marker"
        exit 1
    }
}

$busyMarkerJson = Get-Content -LiteralPath $busyMarkerPath -Raw | ConvertFrom-Json
if ($null -eq $busyMarkerJson.markers) {
    Write-Host 'busy-dispatch smoke marker file must expose a markers array'
    exit 1
}

$ps1 = Get-Content -LiteralPath $scriptPath -Raw
foreach ($marker in @(
        'Invoke-WorkerInputDraftSubmit',
        'Resolve-OperatorOrchestratorYamlPath',
        'Get-ReactionMessagesFromYaml -PackRoot $PackRoot -YamlPath',
        'worker-message-submit-side-effect.lock',
        'Get-SubmitBusyDispatchConfig',
        'busy-dispatch-smoke-markers.json',
        'Invoke-SubmitAdoptionPreflightObservation',
        'worker-message-submit-reconcile'
    )) {
    if ($ps1 -notmatch [regex]::Escape($marker)) {
        Write-Host "worker-message-submit-reconcile.ps1 missing runtime marker: $marker"
        exit 1
    }
}
if ($ps1 -match "report-stale' = 'Agent report is stale") {
    Write-Host 'worker-message-submit-reconcile.ps1 must not use a hardcoded report-stale stub'
    exit 1
}
if ($ps1 -notmatch 'if \(\$FixturePath\)[\s\S]*-DryRunMode -Fixture \$FixturePath') {
    Write-Host 'fixture ticks must remain dry-run only'
    exit 1
}

$reactionGetterText = Get-Content -LiteralPath $reactionGetter -Raw
if ($reactionGetterText -match 'Resolve-PackOrchestratorYamlPath') {
    Write-Host 'Get-ReactionMessagesFromYaml must not fall back to the tracked example YAML'
    exit 1
}

$dispatchLib = Get-Content -LiteralPath $dispatchPs1 -Raw
if ($dispatchLib -notmatch 'recordHolder\.recorded') {
    Write-Host 'Record-WorkerMessageDispatch.ps1 must preserve fenced journal success'
    exit 1
}

$reviewSend = Get-Content -LiteralPath $reviewSendPs1 -Raw
if ($reviewSend -notmatch 'REMOVED on AO 0\.10') {
    Write-Host 'review-send-reconcile.ps1 must remain a retired compatibility stub'
    exit 1
}

$auditJson = Get-Content -LiteralPath $auditPath -Raw | ConvertFrom-Json
if ($null -eq $auditJson.sources) {
    Write-Host 'submit-reconcile delivery source audit must expose a sources array'
    exit 1
}
foreach ($source in @('review-send', 'reaction-routed', 'ci-failure-nudge', 'ci-green-nudge')) {
    if (@($auditJson.sources | Where-Object { $_.source -eq $source }).Count -ne 1) {
        Write-Host "submit-reconcile delivery source audit missing source=$source"
        exit 1
    }
}

Write-Host '[PASS] worker-message submit reconciler runtime wiring'
exit 0
