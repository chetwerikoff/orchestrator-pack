#requires -Version 5.1
<#
.SYNOPSIS
  Offline behavioral verification for cursor-agent TUI shim (Issue #725).
#>
[CmdletBinding()]
param(
    [switch]$SkipTrustWatcherCheck,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Cursor-Agent-TuiShim.ps1')

$report = Invoke-CursorAgentTuiShimOfflineVerification -PackRoot $PackRoot -SkipTrustWatcherCheck:$SkipTrustWatcherCheck -Quiet:$Quiet
if (-not $report.Pass) {
    if (-not $Quiet) {
        Write-Host '[FAIL] cursor-agent TUI shim offline verification failed'
    }
    exit 1
}

if (-not $Quiet) {
    Write-Host '[PASS] cursor-agent TUI shim offline verification'
}
exit 0
