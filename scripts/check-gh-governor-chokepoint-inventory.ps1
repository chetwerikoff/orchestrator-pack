#!/usr/bin/env pwsh
# Validates GitHub fleet governor chokepoint inventory completeness (Issue #585).
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$inventoryPath = Join-Path $Root 'docs/github-fleet-governor-chokepoint-inventory.json'
$wrapperPath = Join-Path $Root 'scripts/lib/gh-wrapper.mjs'
$governorPath = Join-Path $Root 'scripts/lib/gh-governor.mjs'

$failures = @()

if (-not (Test-Path -LiteralPath $inventoryPath)) {
    Write-Error "missing inventory: $inventoryPath"
    exit 1
}
if (-not (Test-Path -LiteralPath $governorPath)) {
    $failures += 'missing scripts/lib/gh-governor.mjs'
}

$inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json
$allowedTransport = @(
    'REST-inventory',
    'REST gh api repos/...',
    'native-passthrough',
    'GraphQL-backed passthrough',
    'non-GitHub'
)
$allowedParticipation = @(
    'wrapper-covered',
    'explicit shared-lease participant',
    'broker-only residual',
    'intentionally-terminal/non-GitHub'
)

if (-not $inventory.rows -or $inventory.rows.Count -lt 1) {
    $failures += 'inventory rows missing'
}

foreach ($row in @($inventory.rows)) {
    if (-not $row.surface) { $failures += 'row missing surface'; continue }
    if ($allowedTransport -notcontains [string]$row.transport) {
        $failures += "$($row.surface): unclassified transport $($row.transport)"
    }
    if ($allowedParticipation -notcontains [string]$row.participation) {
        $failures += "$($row.surface): unclassified participation $($row.participation)"
    }
}

$wrapper = Get-Content -LiteralPath $wrapperPath -Raw
if ($wrapper -notmatch 'acquireGithubGovernorAdmission') {
    $failures += 'gh-wrapper.mjs does not consult github governor admission'
}
if ($wrapper -notmatch 'recordGithubGovernorObservedLimit') {
    $failures += 'gh-wrapper.mjs does not record observed governor limits'
}

$fleetCache = Join-Path $Root 'scripts/lib/Gh-FleetInventoryCache.ps1'
if ((Get-Content -LiteralPath $fleetCache -Raw) -notmatch 'Set-GhGovernorCallerContext') {
    $failures += 'Gh-FleetInventoryCache.ps1 missing Set-GhGovernorCallerContext'
}

$preflight = Join-Path $Root 'scripts/lib/Review-StartPreflightShield.ps1'
if ((Get-Content -LiteralPath $preflight -Raw) -notmatch "GH_GOVERNOR_LANE = 'interactive-preflight'") {
    $failures += 'Review-StartPreflightShield.ps1 missing interactive-preflight governor lane'
}

$brokerResidual = @($inventory.rows | Where-Object { $_.participation -eq 'broker-only residual' })
if ($brokerResidual.Count -gt 0) {
    Write-Host "note: broker-only residual rows present ($($brokerResidual.Count)); broad enablement remains gated"
}

if ($failures.Count -gt 0) {
    foreach ($f in $failures) { Write-Host "FAIL: $f" }
    exit 1
}

Write-Host 'PASS: github fleet governor chokepoint inventory'
exit 0
