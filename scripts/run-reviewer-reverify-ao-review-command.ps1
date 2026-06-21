#requires -Version 5.1
<#
.SYNOPSIS
  AO review --command entrypoint for checkpoint-2 e2e (Issue #376 AC#13).
#>
param(
    [string]$RepoRoot,
    [string]$FixtureDir = 'tests/fixtures/contract-evidence-reverify/e2e',
    [string]$ManifestPath = 'tests/fixtures/contract-evidence-reverify/capture-manifest.json',
    [int]$ExplicitIssue = 376
)

$ErrorActionPreference = 'Stop'
$packRoot = if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    Split-Path -Parent $PSScriptRoot
} else {
    $RepoRoot
}

$fixtureRoot = if ([System.IO.Path]::IsPathRooted($FixtureDir)) {
    $FixtureDir
} else {
    Join-Path $packRoot $FixtureDir
}

$invokeScript = Join-Path $PSScriptRoot 'invoke-contract-evidence-reverify.ps1'
if (-not (Test-Path -LiteralPath $invokeScript)) {
    Write-Error "missing $invokeScript"
}

& $invokeScript `
    -RepoRoot $packRoot `
    -ReviewTargetRoot $packRoot `
    -ManifestPath $ManifestPath `
    -SnapshotFile (Join-Path $fixtureRoot 'issue-snapshot.md') `
    -PrBodyFile (Join-Path $fixtureRoot 'pr-body.md') `
    -ExplicitIssue $ExplicitIssue `
    -PrHeadSha 'e2e-fixture-head' `
    -Summary

exit $LASTEXITCODE
