#requires -Version 5.1
<#
.SYNOPSIS
  Verifies the local ao send CLI exposes --file ingestion (Issue #373).
#>
param(
    [switch]$ValidateCommitted
)

$ErrorActionPreference = 'Stop'

$evidencePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'docs/ao-send-transport-contract.txt'

function Test-CommittedAoSendTransportEvidence {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Write-Host "[FAIL] missing committed transport evidence: $Path"
        return $false
    }
    $text = Get-Content -LiteralPath $Path -Raw
    if ($text -notmatch 'Issue #373') {
        Write-Host '[FAIL] committed transport evidence missing Issue #373 marker'
        return $false
    }
    if ($text -notmatch '(?im)(--file|\-f,\s*--file)') {
        Write-Host '[FAIL] committed transport evidence missing --file ingestion'
        return $false
    }
    if ($text -notmatch '(?im)ao send \[options\]') {
        Write-Host '[FAIL] committed transport evidence missing ao send usage line'
        return $false
    }
    return $true
}

if ($ValidateCommitted) {
    if (Test-CommittedAoSendTransportEvidence -Path $evidencePath) {
        Write-Host '[PASS] committed ao send --file transport contract evidence verified'
        exit 0
    }
    exit 1
}

$aoPath = if ($env:AO_CLI_PATH) { $env:AO_CLI_PATH } else { 'ao' }
$help = (& $aoPath send --help 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
if ($help -notmatch '(?im)(--file|\-f,\s*--file)') {
    Write-Host '[FAIL] ao send --file contract missing from local ao send --help'
    exit 1
}

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
