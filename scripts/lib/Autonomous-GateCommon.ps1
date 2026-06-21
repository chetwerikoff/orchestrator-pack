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
