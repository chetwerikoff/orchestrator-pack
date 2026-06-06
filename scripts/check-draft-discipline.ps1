#requires -Version 7.0
<#
.SYNOPSIS
  Draft discipline guards for positive-outcome acceptance and parked roots (Issue #221).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('positive-outcome', 'parked-root', 'surfaces')]
    [string]$Command,

    [string]$DraftPath,
    [string]$MockIssuesPath,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$Root = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$CheckScript = Join-Path $PSScriptRoot 'draft-discipline.ts'

$args = @($Command)
if ($DraftPath) {
    $args += '--draft', (Resolve-Path $DraftPath).Path
}
if ($MockIssuesPath) {
    $args += '--mock-issues', (Resolve-Path $MockIssuesPath).Path
}
if ($RepoRoot) {
    $args += '--repo-root', $Root
}

Push-Location $Root
try {
    & node --import tsx $CheckScript @args
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
