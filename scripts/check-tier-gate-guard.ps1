#requires -Version 7.0
<#
.SYNOPSIS
  Tier-gate guard for create-issue-draft (Issue #576).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DraftPath,

    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$Root = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$GuardScript = Join-Path $PSScriptRoot 'tier-gate-guard.ts'

Push-Location $Root
try {
    & node --import tsx $GuardScript --text-file (Resolve-Path $DraftPath).Path --repo-root $Root
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
