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
$runner = Join-Path $PSScriptRoot 'resolve-bound-issue-snapshot.ts'

if (-not (Test-Path -LiteralPath $runner)) {
    Write-Error "missing $runner"
}

$args = @(
    $runner,
    '--pr-number', [string]$PrNumber,
    '--pr-head-sha', $PrHeadSha,
    '--issue-number', [string]$IssueNumber,
    '--path-only'
)
if ($ProjectId) { $args += @('--project-id', $ProjectId) }
if ($Require) { $args += '--require' }

Push-Location $packRoot
try {
    & node --import tsx @args
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
