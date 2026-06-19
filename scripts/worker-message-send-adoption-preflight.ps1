#requires -Version 5.1
<#
.SYNOPSIS
  Effective-routing adoption preflight for journaled worker sends (Issue #281).
.DESCRIPTION
  Validates that the running AO epoch/config path has been observed through the
  journaled wrapper by checking for side-effect-isolated adoption probe entries in
  the metadata-only outbox. This checks outbox observation, not merely a config
  line. Missing branches fail closed as wrapper_not_adopted.
#>
[CmdletBinding()]
param(
    [string]$JournalPath = '',
    [string]$StateFile = '',
    [string]$AoEpoch = '',
    [string]$ConfigPath = '',
    [switch]$WriteProbeEntries,
    [string]$AoPath = 'ao',
    [string[]]$RequiredBranches = @('plain-ao-send:pending-draft','plain-ao-send:self-submitted'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1')

$result = Test-WorkerMessageSendAdoptionPreflight `
    -JournalPath $JournalPath `
    -StateFile $StateFile `
    -AoEpoch $AoEpoch `
    -ConfigPath $ConfigPath `
    -WriteProbeEntries:$WriteProbeEntries `
    -AoPath $AoPath `
    -RequiredBranches $RequiredBranches `
    -DryRun:$DryRun `
    -PersistState

if ($result.diagnosis) {
    Write-Host $result.diagnosis
}
elseif ($result.ok) {
    Write-Host '[worker-message-send-adoption-preflight] effective routing adopted'
}

exit [int]$result.exitCode
