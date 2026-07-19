#requires -Version 5.1
<#
.SYNOPSIS
  Validate the surviving Vitest CI topology after the Issue #906 estate cut.

.DESCRIPTION
  The historical pipeline-split core and its runtime-history, wall-clock, and
  supervisor fixture contracts were retired with their owners by Issue #906.
  The protected scope-guard workflow still invokes this stable entrypoint, so it
  now validates the surviving topology through the TypeScript planner itself.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [switch]$SkipLiveCoverage
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$planner = Join-Path $RepoRoot 'scripts/emit-vitest-heavy-topology.mjs'
$config = Join-Path $RepoRoot 'scripts/vitest-ci-lanes.config.json'

foreach ($required in @($planner, $config)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing surviving CI topology prerequisite: $required"
    }
}

$previousOutput = $env:GITHUB_OUTPUT
$outputFile = New-TemporaryFile
try {
    $env:GITHUB_OUTPUT = $outputFile.FullName
    Push-Location $RepoRoot
    try {
        & node $planner --gha-output --skip-oversized-guard
    }
    finally {
        Pop-Location
    }
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    if ($null -eq $previousOutput) {
        Remove-Item Env:GITHUB_OUTPUT -ErrorAction SilentlyContinue
    }
    else {
        $env:GITHUB_OUTPUT = $previousOutput
    }
    Remove-Item -LiteralPath $outputFile.FullName -Force -ErrorAction SilentlyContinue
}

Write-Host 'CI pipeline split compatibility guard passed (Issue #906 surviving topology).'
exit 0
