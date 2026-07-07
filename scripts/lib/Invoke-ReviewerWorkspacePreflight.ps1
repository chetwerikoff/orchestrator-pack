#requires -Version 5.1
<#
.SYNOPSIS
  Run reviewer-workspace-preflight.ps1 before ao-review run (Issue #98).
#>

function Invoke-ReviewerWorkspacePreflight {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $packRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $preflight = Join-Path $packRoot 'scripts/reviewer-workspace-preflight.ps1'
    if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) {
        return
    }

    & $preflight -RepoRoot $RepoRoot
    if ($LASTEXITCODE -ne 0) {
        throw "reviewer-workspace-preflight failed (exit $LASTEXITCODE)"
    }
}
