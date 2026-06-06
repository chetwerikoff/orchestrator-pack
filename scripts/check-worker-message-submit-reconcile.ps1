#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #232 source-agnostic worker message submit reconciler.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $Root 'scripts/worker-message-submit-reconcile.ps1'
$mjsPath = Join-Path $Root 'docs/worker-message-submit-reconcile.mjs'
$observeMjs = Join-Path $Root 'docs/worker-message-dispatch-observe.mjs'
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$migration = Join-Path $Root 'docs/migration_notes.md'

foreach ($path in @($scriptPath, $mjsPath, $observeMjs, $registryPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $path"
        exit 1
    }
}

$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
if ($registry.requiredChildIds -notcontains 'worker-message-submit-reconcile') {
    Write-Host 'orchestrator-side-process-registry.json must include worker-message-submit-reconcile'
    exit 1
}

$mjs = Get-Content -LiteralPath $mjsPath -Raw
if ($mjs -notmatch 'DEFAULT_SUBMIT_RECONCILE_INTERVAL_MS = 30 \* 1000') {
    Write-Host 'worker-message-submit-reconcile.mjs must default to 30-second interval'
    exit 1
}

if ($mjs -notmatch 'OPERATOR_ESCALATION_PREFIX') {
    Write-Host 'worker-message-submit-reconcile.mjs must define operator escalation prefix'
    exit 1
}

$observe = Get-Content -LiteralPath $observeMjs -Raw
if ($observe -notmatch 'AO_PASTE_CHAR_THRESHOLD = 200') {
    Write-Host 'worker-message-dispatch-observe.mjs must anchor paste threshold at 200 chars'
    exit 1
}

$ps1 = Get-Content -LiteralPath $scriptPath -Raw
if ($ps1 -notmatch 'Invoke-WorkerInputDraftSubmit') {
    Write-Host 'worker-message-submit-reconcile.ps1 must use submit adapter (Enter only)'
    exit 1
}

if ($ps1 -notmatch 'worker-message-submit-side-effect\.lock') {
    Write-Host 'worker-message-submit-reconcile.ps1 must fence Enter with worker-message-submit-side-effect.lock'
    exit 1
}

$reviewSendPs1 = Join-Path $Root 'scripts/review-send-reconcile.ps1'
if (-not (Test-Path -LiteralPath $reviewSendPs1 -PathType Leaf)) {
    Write-Host 'Missing scripts/review-send-reconcile.ps1'
    exit 1
}
$reviewSend = Get-Content -LiteralPath $reviewSendPs1 -Raw
if ($reviewSend -notmatch "Register-WorkerMessageDispatch[\s\S]*-DeliveryPath 'pending-draft'") {
    Write-Host 'review-send-reconcile.ps1 must record review-send dispatch as pending-draft'
    exit 1
}

if ($ps1 -notmatch 'worker-message-submit-reconcile') {
    Write-Host 'worker-message-submit-reconcile.ps1 must register child progress id'
    exit 1
}

if (-not (Test-Path -LiteralPath $migration -PathType Leaf)) {
    Write-Host 'Missing docs/migration_notes.md'
    exit 1
}

$migrationText = Get-Content -LiteralPath $migration -Raw
if ($migrationText -notlike '*worker-message-submit-reconcile*') {
    Write-Host 'docs/migration_notes.md must document worker-message-submit-reconcile operator adoption'
    exit 1
}

Write-Host '[PASS] source-agnostic worker message submit reconciler wiring (Issue #232)'
exit 0
