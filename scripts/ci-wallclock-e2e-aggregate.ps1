#requires -Version 5.1
<#
.SYNOPSIS
  Fail-closed aggregate for post-merge wall-clock acceptance stage (Issue #694).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WallclockResult,
    [string]$HeadSha = $env:GITHUB_SHA,
    [string]$RunId = $env:GITHUB_RUN_ID
)

$ErrorActionPreference = 'Stop'

$terminalFailure = @('failure', 'cancelled', 'timed_out')
if ($terminalFailure -contains $WallclockResult) {
    Write-Host "[FAIL] wall-clock acceptance stage result=$WallclockResult (fail-closed)"
    exit 1
}
if ($WallclockResult -ne 'success') {
    Write-Host "[FAIL] wall-clock acceptance stage unexpected result=$WallclockResult"
    exit 1
}
if ([string]::IsNullOrWhiteSpace($HeadSha)) {
    Write-Host '[FAIL] wall-clock aggregate missing GITHUB_SHA head binding'
    exit 1
}
if ([string]::IsNullOrWhiteSpace($RunId)) {
    Write-Host '[FAIL] wall-clock aggregate missing GITHUB_RUN_ID binding'
    exit 1
}

Write-Host "[PASS] wall-clock acceptance aggregate head=$HeadSha run=$RunId"
exit 0
