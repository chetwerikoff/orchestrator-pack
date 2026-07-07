#requires -Version 7.0
<#
.SYNOPSIS
  Pack-wide launch-argv contract inventory guard (Issue #661).
#>
[CmdletBinding()]
param(
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
    $Root = Split-Path -Parent $PSScriptRoot
}

$registryCli = Join-Path $Root 'docs/launch-argv-registry.mjs'
if (-not (Test-Path -LiteralPath $registryCli -PathType Leaf)) {
    Write-Host "[FAIL] missing launch-argv registry cli: $registryCli"
    exit 1
}

& node $registryCli audit $Root
if ($LASTEXITCODE -ne 0) {
    Write-Host '[FAIL] launch-argv inventory guard (Issue #661)'
    exit 1
}

Write-Host '[PASS] launch-argv inventory guard (Issue #661)'
exit 0
