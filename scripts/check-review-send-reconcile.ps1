#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #202/#625 — review-send reconcile REMOVED on AO 0.10.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$wakeScript = Join-Path $Root 'scripts/review-send-reconcile.ps1'
$wakeMjs = Join-Path $Root 'docs/review-send-reconcile.mjs'
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'

if (-not (Test-Path -LiteralPath $wakeScript -PathType Leaf)) {
    Write-Host 'Missing scripts/review-send-reconcile.ps1'
    exit 1
}

if (-not (Test-Path -LiteralPath $wakeMjs -PathType Leaf)) {
    Write-Host 'Missing docs/review-send-reconcile.mjs'
    exit 1
}

$ps1 = Get-Content -LiteralPath $wakeScript -Raw
if ($ps1 -notmatch 'REMOVED on AO 0\.10') {
    Write-Host 'review-send-reconcile.ps1 must be a REMOVED stub (AO 0.10 auto-delivery)'
    exit 1
}
if ($ps1 -notmatch 'exit\s+2') {
    Write-Host 'review-send-reconcile.ps1 REMOVED stub must exit 2'
    exit 1
}

$mjs = Get-Content -LiteralPath $wakeMjs -Raw
if ($mjs -notmatch 'REVIEW_SEND_RECONCILE_REMOVED\s*=\s*true') {
    Write-Host 'docs/review-send-reconcile.mjs must export REVIEW_SEND_RECONCILE_REMOVED'
    exit 1
}
if ($mjs -notmatch 'actions:\s*\[\]') {
    Write-Host 'docs/review-send-reconcile.mjs planReviewSendActions must return empty actions'
    exit 1
}
$deadSendPhrase = 'ao review ' + 'send'
if ($mjs -like "*$deadSendPhrase*") {
    Write-Host 'docs/review-send-reconcile.mjs must not reference dead ao review send CLI'
    exit 1
}

if (-not (Test-Path -LiteralPath $registryPath)) {
    Write-Host "Missing registry: $registryPath"
    exit 1
}
$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$sendChild = $registry.children | Where-Object { $_.id -eq 'review-send-reconcile' } | Select-Object -First 1
if ($sendChild) {
    Write-Host 'orchestrator-side-process-registry.json must not register review-send-reconcile (REMOVED on AO 0.10)'
    exit 1
}

Write-Host '[PASS] review-send reconcile REMOVED stub and registry guard (Issues #202, #625)'
exit 0
