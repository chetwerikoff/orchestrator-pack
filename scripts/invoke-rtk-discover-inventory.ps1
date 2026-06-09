#requires -Version 7.0
<#
.SYNOPSIS
  Regenerate the RTK missed-savings inventory from local rtk discover output (Issue #199).

.DESCRIPTION
  Operator-local: reads Claude Code / Cursor session history via `rtk discover`.
  Classifies command shapes by risk tier, passthrough match, and sensitivity override.
  Prints a markdown table to stdout and optional JSON artifact.

.PARAMETER SinceDays
  Passed to rtk discover --since (default 30).

.PARAMETER AllProjects
  Scan all projects (rtk discover --all).

.PARAMETER Limit
  Max commands per discover section (default 50).

.PARAMETER OutputJson
  Optional path to write the normalized inventory JSON.

.EXAMPLE
  pwsh -NoProfile -File scripts/invoke-rtk-discover-inventory.ps1
.EXAMPLE
  pwsh -NoProfile -File scripts/invoke-rtk-discover-inventory.ps1 -AllProjects -SinceDays 90 -OutputJson /tmp/rtk-inventory.json
#>
[CmdletBinding()]
param(
    [int]$SinceDays = 30,

    [switch]$AllProjects,

    [int]$Limit = 50,

    [string]$OutputJson
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Get-RtkPassthroughManifest.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-RtkMissedSavingsInventory.ps1')

$rtk = Get-Command rtk -ErrorAction SilentlyContinue
if (-not $rtk) {
    Write-Error 'rtk not on PATH. Install per coworker RTK runbook, then re-run.'
}

$pack = Get-RtkPassthroughManifest -Kind 'pack' -ScriptsRoot $PSScriptRoot
$upstream = Get-RtkPassthroughManifest -Kind 'upstream' -ScriptsRoot $PSScriptRoot
$passthroughPatterns = @($pack.Patterns + $upstream.Patterns)

$discoverArgs = @('discover', '--format', 'json', '--since', "$SinceDays", '--limit', "$Limit")
if ($AllProjects) {
    $discoverArgs += '--all'
}

$discoverJson = rtk @discoverArgs 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Error "rtk discover failed: exit=$LASTEXITCODE"
}

$inventory = ConvertFrom-RtkDiscoverJson -Json $discoverJson -PassthroughPatterns $passthroughPatterns
$killGate = Get-RtkKillGateAssessment -InventoryRows $inventory.Rows

Write-Host "# RTK missed-savings inventory (generated $(Get-Date -Format 'yyyy-MM-dd'))"
Write-Host ''
Write-Host "| Metric | Value |"
Write-Host "|--------|-------|"
Write-Host "| Sessions scanned | $($inventory.SessionsScanned) |"
Write-Host "| Total commands | $($inventory.TotalCommands) |"
Write-Host "| Since (days) | $($inventory.SinceDays) |"
Write-Host "| Source/caller attribution | **not available** (rtk discover has no caller dimension) |"
Write-Host "| Optimisation target | **net saved tokens on low-risk shapes** (adoption % is a non-goal) |"
Write-Host ''
Write-Host '## Kill-gate assessment (high-risk `ao` / inspection families)'
Write-Host ''
Write-Host "| Input | Value |"
Write-Host "|-------|-------|"
Write-Host "| Materiality bar | ≥$($killGate.MaterialityPercent)% of (low-risk quantified missed tokens + conservative high-risk `ao` estimate) |"
Write-Host "| Low-risk quantified missed tokens | $($killGate.LowRiskQuantifiedMissedTokens) |"
Write-Host "| High-risk `ao` invocations | $($killGate.HighRiskAoInvocationCount) |"
Write-Host "| Conservative `ao` tokens saved / invocation | $($killGate.HighRiskAoTokensPerInvocation) |"
Write-Host "| High-risk `ao` estimated missed tokens | $($killGate.HighRiskAoEstimatedMissedTokens) |"
Write-Host "| High-risk share | $($killGate.HighRiskSharePercent)% |"
Write-Host "| Decision | **$($killGate.Decision)** |"
Write-Host ''
Write-Host '## Inventory rows'
Write-Host ''
Write-Host '| Command shape | Count | Est. missed tokens | Passthrough | Risk | Sensitivity override | Recommended action | Field-preservation test? |'
Write-Host '|---------------|------:|-------------------:|:------------|:-----|:---------------------|:-------------------|:-------------------------|'

foreach ($row in $inventory.Rows | Sort-Object { -$_.OccurrenceCount }) {
    $tokens = if ($null -eq $row.EstimatedMissedTokens) { '—' } else { $row.EstimatedMissedTokens }
    $passthrough = if ($row.PassthroughMatch) { "yes ($($row.PassthroughPattern))" } else { 'no' }
    $sensitivity = if ($row.SensitivityExactnessOverride) { 'yes' } else { 'no' }
    $fpt = if ($row.FieldPreservationTestRequired) { 'yes' } else { 'no' }
    $shape = ($row.CommandShape -replace '\|', '\|')
    Write-Host "| $shape | $($row.OccurrenceCount) | $tokens | $passthrough | $($row.RiskTier) | $sensitivity | $($row.RecommendedAction) | $fpt |"
}

if ($OutputJson) {
    $artifact = [pscustomobject]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        discover      = ($discoverJson | ConvertFrom-Json)
        inventoryRows = $inventory.Rows
        killGate      = $killGate
    }
    $artifact | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputJson -Encoding UTF8
    Write-Host ''
    Write-Host "Wrote JSON artifact: $OutputJson"
}
