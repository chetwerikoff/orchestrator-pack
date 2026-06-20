#requires -Version 5.1
<#
.SYNOPSIS
  Verifies the local ao send CLI exposes --file ingestion (Issue #373).
#>
$ErrorActionPreference = 'Stop'

$aoPath = if ($env:AO_CLI_PATH) { $env:AO_CLI_PATH } else { 'ao' }
$help = (& $aoPath send --help 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
if ($help -notmatch '(?im)(--file|\-f,\s*--file)') {
    Write-Host '[FAIL] ao send --file contract missing from local ao send --help'
    exit 1
}

$evidencePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'docs/ao-send-transport-contract.txt'
$stamp = (Get-Date).ToString('o')
$lines = @(
    '# Captured ao send transport contract (Issue #373)',
    "capturedAt=$stamp",
    "aoPath=$aoPath",
    '',
    $help
)
Set-Content -LiteralPath $evidencePath -Value $lines -Encoding utf8

Write-Host '[PASS] ao send --file transport contract verified'
exit 0
