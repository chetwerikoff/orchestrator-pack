#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #589 AO 0.10.x runnable ao spawn --project/--name shape.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$mjs = Join-Path $Root 'docs/ao-spawn-shape.mjs'
$baseline = Join-Path $Root 'tests/fixtures/ao-spawn-shape/safety-prose-baseline.json'

if (-not (Test-Path -LiteralPath $mjs -PathType Leaf)) {
    Write-Host 'Missing docs/ao-spawn-shape.mjs'
    exit 1
}

if (-not (Test-Path -LiteralPath $baseline -PathType Leaf)) {
    Write-Host 'Missing tests/fixtures/ao-spawn-shape/safety-prose-baseline.json'
    exit 1
}

& node $mjs
exit $LASTEXITCODE
