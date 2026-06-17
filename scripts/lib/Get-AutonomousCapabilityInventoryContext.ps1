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

    return [pscustomobject]@{
        RepoRoot      = $RepoRoot
        InventoryPath = $InventoryPath
        Inventory     = (Get-Content -LiteralPath $InventoryPath -Raw | ConvertFrom-Json)
    }
}
