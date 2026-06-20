#requires -Version 7.0
<#
.SYNOPSIS
  Draft discipline guards for positive-outcome acceptance and parked roots (Issue #221).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('positive-outcome', 'parked-root', 'contract-evidence', 'surfaces')]
    [string]$Command,

    [string]$DraftPath,
    [string]$MockIssuesPath,
    [string]$ManifestPath,
    [string]$LegacyListPath,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$Root = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$CheckScript = Join-Path $PSScriptRoot 'draft-discipline.mjs'

$args = @($Command)
if ($DraftPath) {
    $args += '--draft', (Resolve-Path $DraftPath).Path
}
if ($MockIssuesPath) {
    $args += '--mock-issues', (Resolve-Path $MockIssuesPath).Path
}
if ($ManifestPath) {
    $args += '--manifest', (Resolve-Path $ManifestPath).Path
}
if ($LegacyListPath) {
    $args += '--legacy-list', (Resolve-Path $LegacyListPath).Path
}
if ($RepoRoot) {
    $args += '--repo-root', $Root
}

Push-Location $Root
try {
    & node $CheckScript @args
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
