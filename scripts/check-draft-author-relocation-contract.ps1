#requires -Version 7.0
<#
.SYNOPSIS
  Guard draft-author relocation contract surfaces and completion-proof shape (Issue #579).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$Root = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$CheckScript = Join-Path $PSScriptRoot 'draft-author-relocation-contract.mjs'

Push-Location $Root
try {
    & node $CheckScript --repo-root $Root
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
