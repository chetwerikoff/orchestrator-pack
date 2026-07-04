#requires -Version 7.0
<#
.SYNOPSIS
  Finding-disposition ledger guard (Issue #575).
#>
[CmdletBinding()]
param(
    [string]$CapturePath,
    [string]$CapturesDir,
    [Parameter(Mandatory = $true)]
    [string]$LedgerPath
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$GuardScript = Join-Path $PSScriptRoot 'finding-ledger-guard.mjs'

if (-not $CapturePath -and -not $CapturesDir) {
    Write-Error 'Provide -CapturePath for one capture or -CapturesDir for all *.capture.txt files.'
    exit 2
}

$args = @('--ledger', (Resolve-Path $LedgerPath).Path)
if ($CapturesDir) {
    $args += '--captures-dir', (Resolve-Path $CapturesDir).Path
}
if ($CapturePath) {
    $args += '--capture', (Resolve-Path $CapturePath).Path
}

Push-Location $Root
try {
    & node $GuardScript @args
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
