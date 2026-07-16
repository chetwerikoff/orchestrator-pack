#requires -Version 7.0
<#
.SYNOPSIS
  External-tool output fixture shape guard (Issue #223).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$Root = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$CheckScript = Join-Path $PSScriptRoot 'external-output-shape-guard.mjs'

Push-Location $Root
try {
    & node $CheckScript --repo-root $Root
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
