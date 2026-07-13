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
    [string]$LedgerPath,
    [string]$DraftPath,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$GuardScript = Join-Path $PSScriptRoot 'finding-ledger-guard.mjs'

if (-not $CapturePath -and -not $CapturesDir) {
    Write-Error 'Provide -CapturePath for one capture or -CapturesDir for all *.capture.txt files.'
    exit 2
}

$guardArgs = @('--ledger', (Resolve-Path $LedgerPath).Path)
if ($CapturesDir) {
    $guardArgs += '--captures-dir', (Resolve-Path $CapturesDir).Path
}
if ($CapturePath) {
    $guardArgs += '--capture', (Resolve-Path $CapturePath).Path
}
if ($DraftPath) {
    $guardArgs += '--draft-path', (Resolve-Path $DraftPath).Path
}
if ($RepoRoot) {
    $guardArgs += '--repo-root', (Resolve-Path $RepoRoot).Path
}

Push-Location $Root
try {
    & node $GuardScript @guardArgs
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
        $exitCode = if ($?) { 0 } else { 1 }
    }
    exit $exitCode
}
finally {
    Pop-Location
}
