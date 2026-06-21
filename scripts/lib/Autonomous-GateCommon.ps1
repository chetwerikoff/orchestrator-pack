#requires -Version 5.1
<#
  Shared helpers for autonomous orchestrator gate surfaces (Issues #318 / #384).
#>

function Resolve-PackGateRepoRoot {
    param(
        [string]$RepoRoot = '',
        [string]$CallerScriptRoot = $PSScriptRoot
    )

    if (-not $RepoRoot) {
        $RepoRoot = Split-Path -Parent $CallerScriptRoot
    }
    return (Resolve-Path -LiteralPath $RepoRoot).Path
}

function Merge-AutonomousSharedCapabilities {
    param(
        [object]$Inventory,
        [string]$SharedPath
    )

    if (-not (Test-Path -LiteralPath $SharedPath)) { return $Inventory }
    $shared = Get-Content -LiteralPath $SharedPath -Raw | ConvertFrom-Json
    $byId = @{}
    foreach ($row in @($shared.capabilities)) { $byId[[string]$row.id] = $row }
    foreach ($row in @($Inventory.capabilities)) { $byId[[string]$row.id] = $row }
    $Inventory.capabilities = @($byId.Values)
    return $Inventory
}

function Get-MergedAutonomousCapabilityInventory {
    param(
        [string]$InventoryPath,
        [string]$PackRoot
    )

    if (-not (Test-Path -LiteralPath $InventoryPath)) {
        throw "missing capability inventory: $InventoryPath"
    }
    $inventory = Get-Content -LiteralPath $InventoryPath -Raw | ConvertFrom-Json
    $sharedPath = Join-Path $PackRoot 'docs/autonomous-shared-capabilities.json'
    return Merge-AutonomousSharedCapabilities -Inventory $inventory -SharedPath $sharedPath
}

function Get-LiveAutonomousGateCapabilities {
    param(
        [object]$Inventory,
        [string]$ConfiguredGateVersion = ''
    )

    $configured = if ($ConfiguredGateVersion) { $ConfiguredGateVersion } else { [string]$Inventory.version }
    return @(
        foreach ($row in @($Inventory.capabilities)) {
            [pscustomobject]@{
                id             = [string]$row.id
                classification = [string]$row.classification
                gateVersion    = $configured
            }
        }
    )
}
