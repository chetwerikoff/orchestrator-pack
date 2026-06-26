#requires -Version 5.1
<#
  Shared bootstrap for pack gate inventory scripts.
#>

function Initialize-PackGateCheck {
    param(
        [string]$RepoRoot = '',
        [string]$CallerScriptRoot
    )

    $ErrorActionPreference = 'Stop'
    . (Join-Path $PSScriptRoot 'Autonomous-GateCommon.ps1')

    $resolvedRoot = Resolve-PackGateRepoRoot -RepoRoot $RepoRoot -CallerScriptRoot $CallerScriptRoot
    $violations = [System.Collections.Generic.List[string]]::new()

    return [pscustomobject]@{
        RepoRoot = $resolvedRoot
        Violations = $violations
    }
}

function Write-PackGateCheckResult {
    param(
        [string]$Label,
        [System.Collections.Generic.List[string]]$Violations
    )

    if ($Violations.Count -gt 0) {
        Write-Host "$Label failed:"
        $Violations | ForEach-Object { Write-Host " - $_" }
        exit 1
    }

    Write-Host "[PASS] $Label"
    exit 0
}
