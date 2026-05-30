#requires -Version 5.1
<#
.SYNOPSIS
  Offline PTY fixture check for prompt-delivery launch failure (worker or orchestrator).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$FixturePath,
    [switch]$ExpectMatch,
    [switch]$ExpectNoMatch,
    [Parameter(Mandatory = $true)]
    [string]$RoleLabel
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Invoke-LaunchFailureFixtureCheck.ps1')
exit (Invoke-LaunchFailureFixtureCheck @PSBoundParameters)
