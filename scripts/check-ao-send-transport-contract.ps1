#requires -Version 5.1
<#
.SYNOPSIS
  Verifies the local ao send CLI exposes AO 0.10.2 inline message transport (Issues #373 / #640).
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
    if ($text -notmatch 'Issue #640') {
        Write-Host '[FAIL] committed transport evidence missing Issue #640 marker'
        return $false
    }
    if ($text -notmatch '(?im)--message') {
        Write-Host '[FAIL] committed transport evidence missing --message flag'
        return $false
    }
    if ($text -notmatch '(?im)--session') {
        Write-Host '[FAIL] committed transport evidence missing --session flag'
        return $false
    }
    if ($text -notmatch '(?im)ao send \[flags\]') {
        Write-Host '[FAIL] committed transport evidence missing ao send [flags] usage line'
        return $false
    }
    return $true
}

if ($ValidateCommitted) {
    if (Test-CommittedAoSendTransportEvidence -Path $evidencePath) {
        Write-Host '[PASS] committed ao send inline transport contract evidence verified'
        exit 0
    }
    exit 1
}

$aoPath = if ($env:AO_CLI_PATH) { $env:AO_CLI_PATH } else { 'ao' }
$help = (& $aoPath send --help 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
if ($help -notmatch '(?im)--message') {
    Write-Host '[FAIL] ao send --message contract missing from local ao send --help'
    exit 1
}
if ($help -notmatch '(?im)--session') {
    Write-Host '[FAIL] ao send --session contract missing from local ao send --help'
    exit 1
}
if ($help -notmatch '(?im)ao send \[flags\]') {
    Write-Host '[FAIL] ao send [flags] usage line missing from local ao send --help'
    exit 1
}

$stamp = (Get-Date).ToString('o')
$lines = @(
    '# Captured ao send transport contract (Issue #373 / Issue #640)',
    "capturedAt=$stamp",
    "aoPath=$aoPath",
    '',
    $help
)
Set-Content -LiteralPath $evidencePath -Value $lines -Encoding utf8

Write-Host '[PASS] ao send inline transport contract verified'
exit 0
