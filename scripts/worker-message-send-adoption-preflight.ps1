#requires -Version 5.1
<#
.SYNOPSIS
  Effective-routing adoption preflight for journaled worker sends (Issues #281 / #373).
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

if ($result.ok) {
    Write-Host '[worker-message-send-adoption-preflight] effective routing adopted'
    exit 0
}

Write-Host $result.diagnosis
exit [int]$result.exitCode
