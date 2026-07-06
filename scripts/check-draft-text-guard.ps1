#requires -Version 7.0
<#
.SYNOPSIS
  Run a draft-text guard CLI against a draft path.
.DESCRIPTION
  Shared wrapper for tier-gate (#576) and stage-completeness (#620) guards.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('tier-gate', 'stage-completeness')]
    [string]$Guard,

    [Parameter(Mandatory = $true)]
    [string]$DraftPath,

    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$guardScript = switch ($Guard) {
    'tier-gate' { Join-Path $PSScriptRoot 'tier-gate-guard.ts' }
    'stage-completeness' { Join-Path $PSScriptRoot 'stage-completeness-guard.ts' }
}

. (Join-Path $PSScriptRoot 'lib/Invoke-DraftTextGuard.ps1')
$exitCode = Invoke-DraftTextGuard -GuardScript $guardScript -DraftPath $DraftPath -RepoRoot $RepoRoot
exit $exitCode
