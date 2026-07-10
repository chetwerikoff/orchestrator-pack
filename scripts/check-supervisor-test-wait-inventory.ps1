#requires -Version 7.0
<#
.SYNOPSIS
  Machine-checked wait-site inventory for supervisor/wake heavy-lane tests (Issue #693).
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [ValidateSet('production', 'negative-regression')]
    [string]$Mode = 'production'
)

$ErrorActionPreference = 'Stop'
if (-not $Root) {
    $Root = Split-Path -Parent $PSScriptRoot
}

$cli = Join-Path $Root 'scripts/lib/supervisor-test-wait-inventory.mjs'
if (-not (Test-Path -LiteralPath $cli)) {
    Write-Host "[FAIL] missing guard cli: $cli"
    exit 1
}

& node $cli $Mode
exit $LASTEXITCODE
