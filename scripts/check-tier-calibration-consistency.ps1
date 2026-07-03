#requires -Version 7.0
<#
.SYNOPSIS
  Task complexity tier calibration sample consistency guard (Issue #574).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$Root = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$CheckScript = Join-Path $PSScriptRoot 'tier-calibration-consistency.mjs'

$nodeArgs = @($CheckScript, '--repo-root', $Root)
if ($SelfTest) {
    $nodeArgs += '--self-test'
}

Push-Location $Root
try {
    & node @nodeArgs
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
