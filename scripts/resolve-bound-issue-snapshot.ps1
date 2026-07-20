#requires -Version 5.1
<#
.SYNOPSIS
  Resolve the persisted PR-bound immutable issue snapshot for checkpoint-2 (Issue #376).
#>
param(
    [string]$ProjectId,
    [Parameter(Mandatory)]
    [int]$PrNumber,
    [Parameter(Mandatory)]
    [string]$PrHeadSha,
    [Parameter(Mandatory)]
    [int]$IssueNumber,
    [switch]$Require
)

$ErrorActionPreference = 'Stop'
$packRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'bound-issue-snapshot-cli.ts'

if (-not (Test-Path -LiteralPath $runner)) {
    Write-Error "missing $runner"
}

$args = @(
    $runner,
    'resolve',
    '--pr-number', [string]$PrNumber,
    '--pr-head-sha', $PrHeadSha,
    '--issue-number', [string]$IssueNumber,
    '--path-only'
)
if ($ProjectId) { $args += @('--project-id', $ProjectId) }
if ($Require) { $args += '--require' }

Push-Location $packRoot
try {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
    $resolvedVersion = ((& $nodeCommand.Source '--version' 2>&1 | Out-String).Trim())
    if ($LASTEXITCODE -ne 0 -or $resolvedVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $resolvedVersion. Install/use Node 22 and run npm run check:node-major." }
    $launcherPath = Join-Path $packRoot 'scripts/lib/Invoke-TypeScriptCli.ts'
    $forwarded = @($args | Select-Object -Skip 1)
    & $nodeCommand.Source '--experimental-strip-types' $launcherPath '--script' $runner '--' @forwarded
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
