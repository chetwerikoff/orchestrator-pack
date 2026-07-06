#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #609 seed snapshot failure bounded read economy.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$economyLib = Join-Path $Root 'scripts/lib/Gh-FleetSeedSnapshotReadEconomy.ps1'
$seedInvokeLib = Join-Path $Root 'scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1'
$fleetCacheLib = Join-Path $Root 'scripts/lib/Gh-FleetInventoryCache.ps1'
$economyTest = Join-Path $Root 'scripts/seed-snapshot-failure-bounded-read-economy.test.ts'
$fixture95 = Join-Path $Root 'scripts/fixtures/seed-snapshot-failure/open-pr-list-95.json'

foreach ($path in @($economyLib, $seedInvokeLib, $fleetCacheLib, $economyTest, $fixture95)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $path"
        exit 1
    }
}

$economyText = Get-Content -LiteralPath $economyLib -Raw
foreach ($needle in @(
        'function Get-ReviewReadyReportStateSeedFleetSnapshotClassification',
        'function Resolve-ReviewReadyReportStateSeedOpenPrs',
        'function Invoke-GhOpenPrListForTrackedNumbersListShaped',
        'function Test-GhFleetSeedSnapshotRepairAllowed',
        'function Reserve-GhFleetSeedSnapshotRepairRead',
        'repair-state.reserve.lock',
        'function Repair-ReviewReadyReportStateSeedOpenPrListSnapshot',
        'BoundedListOnly',
        'function Read-GhFleetOpenPrListEnvelopeWithStaleServe',
        'seed_snapshot_degraded_serve',
        'seed_snapshot_state'
    )) {
    if ($economyText -notmatch [regex]::Escape($needle)) {
        Write-Host "Gh-FleetSeedSnapshotReadEconomy.ps1 missing: $needle"
        exit 1
    }
}

$seedText = Get-Content -LiteralPath $seedInvokeLib -Raw
if ($seedText -notmatch 'Gh-FleetSeedSnapshotReadEconomy\.ps1') {
    Write-Host 'Invoke-ReviewReadyReportStateSeed.ps1 must import Gh-FleetSeedSnapshotReadEconomy.ps1'
    exit 1
}
if ($seedText -notmatch 'Resolve-ReviewReadyReportStateSeedOpenPrs') {
    Write-Host 'Invoke-ReviewReadyReportStateSeed.ps1 must resolve open PRs via bounded read economy'
    exit 1
}
if ($seedText -match 'New-ReviewReadyReportStateSeedGitHubSnapshot[\s\S]{0,500}Invoke-GhOpenPrListForNumbers') {
    Write-Host 'seed GitHub snapshot refresh must not use per-head Invoke-GhOpenPrListForNumbers fan-out'
    exit 1
}
if ($seedText -notmatch 'seed_snapshot_degraded_refresh_skipped') {
    Write-Host 'Invoke-ReviewReadyReportStateSeed.ps1 must keep cached snapshot on degraded refresh failure'
    exit 1
}
if ($seedText -notmatch 'Resolve-ReviewReadyReportStateSeedGitHubSnapshot') {
    Write-Host 'Invoke-ReviewReadyReportStateSeed.ps1 must preserve cached GitHub snapshot between poll ticks'
    exit 1
}
if ($seedText -notmatch 'freshSnapshot') {
    Write-Host 'Invoke-ReviewReadyReportStateSeed.ps1 must preserve pre-side-effect revalidation support'
    exit 1
}

$fleetText = Get-Content -LiteralPath $fleetCacheLib -Raw
if ($fleetText -notmatch 'function Invoke-GhFleetFetchOpenPrListUpstream[\s\S]*ConvertFrom-GhFleetMixedJsonOutput') {
    Write-Host 'Invoke-GhFleetFetchOpenPrListUpstream must tolerate mixed stderr via ConvertFrom-GhFleetMixedJsonOutput'
    exit 1
}

$repoTickCoveragePath = Join-Path $Root 'scripts/check-github-fleet-repo-tick-coverage.ps1'
$submitReconcilePath = Join-Path $Root 'scripts/worker-message-submit-reconcile.ps1'
foreach ($path in @($repoTickCoveragePath, $submitReconcilePath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $path"
        exit 1
    }
}

$repoTickCoverageText = Get-Content -LiteralPath $repoTickCoveragePath -Raw
if ($repoTickCoverageText -notmatch "id\s*=\s*'worker-message-submit-reconcile'[\s\S]{0,120}classification\s*=\s*'out of coverage'") {
    Write-Host 'check-github-fleet-repo-tick-coverage.ps1 must classify worker-message-submit-reconcile as out of coverage (Issue #609 AC#9)'
    exit 1
}

$submitReconcileText = Get-Content -LiteralPath $submitReconcilePath -Raw
if ($submitReconcileText -match 'Invoke-GhOpenPrList|Invoke-GhOpenPrListForNumbers|gh\s+pr\s+list|gh\s+pr\s+view') {
    Write-Host 'worker-message-submit-reconcile.ps1 must not use shared per-head GitHub lookup helpers (Issue #609 AC#9)'
    exit 1
}

$testText = Get-Content -LiteralPath $economyTest -Raw
foreach ($needle in @(
        'fresh shared snapshot',
        'populate-failing',
        'stale snapshot',
        'absent snapshot',
        'negative',
        'rate-limit',
        'non-JSON',
        '95-head',
        'five workers',
        'AC#7',
        'concurrent'
    )) {
    if ($testText -notlike "*$needle*") {
        Write-Host "seed-snapshot-failure-bounded-read-economy.test.ts missing coverage marker: $needle"
        exit 1
    }
}

Write-Host 'check-seed-snapshot-failure-bounded-read-economy: PASS'
