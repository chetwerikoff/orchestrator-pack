#requires -Version 5.1
<#
  Shared repo/inventory bootstrap for autonomous capability inventory checks.
#>

function Get-AutonomousCapabilityInventoryContext {
    param(
        [string]$RepoRoot = '',
        [string]$InventoryPath = ''
    )

    if (-not $RepoRoot) {
        $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    $RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
    if (-not $InventoryPath) {
        $InventoryPath = Join-Path $RepoRoot 'docs/autonomous-review-start-capabilities.json'
    }

    $inventory = Get-Content -LiteralPath $InventoryPath -Raw | ConvertFrom-Json
    $localCapabilities = @($inventory.capabilities)
    $sharedCapabilities = @()
    if (-not [string]::IsNullOrWhiteSpace([string]$inventory.sharedCapabilitiesPath)) {
        $sharedPath = Join-Path $RepoRoot ([string]$inventory.sharedCapabilitiesPath)
        if (-not (Test-Path -LiteralPath $sharedPath)) {
            throw "shared autonomous capability inventory missing: $sharedPath"
        }
        $shared = Get-Content -LiteralPath $sharedPath -Raw | ConvertFrom-Json
        $sharedCapabilities = @($shared.capabilities)
    }
    $inventory | Add-Member -NotePropertyName capabilities -NotePropertyValue @($sharedCapabilities + $localCapabilities) -Force

    return [pscustomobject]@{
        RepoRoot      = $RepoRoot
        InventoryPath = $InventoryPath
        Inventory     = $inventory
    }
}
