#requires -Version 7.0
<#
.SYNOPSIS
  Finding-disposition ledger guard (Issue #575).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CapturePath,

    [Parameter(Mandatory = $true)]
    [string]$LedgerPath
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$GuardScript = Join-Path $PSScriptRoot 'finding-ledger-guard.mjs'

Push-Location $Root
try {
    & node $GuardScript --capture (Resolve-Path $CapturePath).Path --ledger (Resolve-Path $LedgerPath).Path
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
