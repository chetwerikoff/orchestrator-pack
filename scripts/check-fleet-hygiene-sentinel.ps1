#requires -Version 5.1
<#
  Static guard for fleet hygiene sentinel (Issue #711 AC#10).
#>
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$sentinelScript = Join-Path $Root 'scripts/orchestrator-fleet-hygiene-sentinel.ps1'
$modulePath = Join-Path $Root 'scripts/lib/Orchestrator-FleetHygiene.ps1'
$wakeSupervisor = Join-Path $Root 'scripts/orchestrator-wake-supervisor.ps1'
$runbook = Join-Path $Root 'docs/fleet-hygiene-sentinel-runbook.md'

foreach ($path in @($sentinelScript, $modulePath, $runbook)) {
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "missing required file: $path"
        exit 1
    }
}

$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
foreach ($child in @($registry.children)) {
    if ($child.script -eq 'orchestrator-fleet-hygiene-sentinel.ps1') {
        Write-Host 'orchestrator-fleet-hygiene-sentinel.ps1 must not appear in orchestrator-side-process-registry.json'
        exit 1
    }
}

$wakeText = Get-Content -LiteralPath $wakeSupervisor -Raw
if ($wakeText -match 'orchestrator-fleet-hygiene-sentinel\.ps1') {
    Write-Host 'orchestrator-wake-supervisor.ps1 must not spawn orchestrator-fleet-hygiene-sentinel.ps1'
    exit 1
}

$sideProcessText = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1') -Raw
if ($sideProcessText -match 'orchestrator-fleet-hygiene-sentinel\.ps1') {
    Write-Host 'Orchestrator-SideProcessSupervisor.ps1 must not reference fleet hygiene sentinel spawn'
    exit 1
}

Write-Host 'fleet-hygiene sentinel static guard passed'
exit 0
