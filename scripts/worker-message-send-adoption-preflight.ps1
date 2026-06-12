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
    [string[]]$RequiredBranches = @('plain-ao-send:pending-draft','plain-ao-send:self-submitted'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Record-WorkerMessageDispatch.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')

function Get-AdoptionPreflightStatePath {
    param([string]$Path)
    if ($Path) { return $Path }
    if ($env:AO_WORKER_MESSAGE_ADOPTION_STATE) { return $env:AO_WORKER_MESSAGE_ADOPTION_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-worker-message-send-adoption.json'
}
function ConvertTo-SafeHashText {
    param([string]$Value)
    return ConvertTo-WorkerMessageSafeIdComponent -Value $Value
}

$effectiveJournalPath = if ($JournalPath) { $JournalPath } else { Get-WorkerMessageDispatchJournalPath }
$statePath = Get-AdoptionPreflightStatePath -Path $StateFile
if ($DryRun) {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) 'worker-message-send-adoption-dryrun'
    if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
    $statePath = Join-Path $root 'adoption-state.json'
}

$journal = Get-WorkerMessageDispatchJournal -Path $effectiveJournalPath
if (-not (Test-MechanicalJsonStateFencesTrusted -State $journal)) {
    throw 'wrapper_not_adopted: dispatch journal corrupt/untrusted; failing closed'
}
$seen = @{}
foreach ($key in @($journal.Keys)) {
    if (Test-MechanicalJsonReflectionKey -Key ([string]$key)) { continue }
    $record = ConvertTo-MechanicalJsonMap -Value $journal[$key]
    if (-not [bool]$record['adoptionProbe']) { continue }
    $epochOk = (-not $AoEpoch) -or ($record.ContainsKey('aoEpochHash') -and [string]$record['aoEpochHash'] -eq (ConvertTo-SafeHashText $AoEpoch))
    $configOk = (-not $ConfigPath) -or ($record.ContainsKey('configPathHash') -and [string]$record['configPathHash'] -eq (ConvertTo-SafeHashText $ConfigPath))
    if (-not ($epochOk -and $configOk)) { continue }
    $branch = [string]$record['sourceKey']
    if ($branch) { $seen[$branch] = $true }
}

$missing = @()
foreach ($branch in $RequiredBranches) {
    $safe = ConvertTo-SafeHashText $branch
    if (-not $seen.ContainsKey($safe) -and -not $seen.ContainsKey($branch)) { $missing += $branch }
}

if ($missing.Count -gt 0) {
    $state = @{ lastCheckedAt = (Get-Date).ToString('o'); status = 'wrapper_not_adopted'; missingBranchCount = $missing.Count; aoEpochHash = ConvertTo-SafeHashText $AoEpoch; configPathHash = ConvertTo-SafeHashText $ConfigPath }
    Set-MechanicalJsonStateFile -Path $statePath -State $state -DefaultState @{} -JsonDepth 10
    Write-Host "[worker-message-send-adoption-preflight] ESCALATION: wrapper_not_adopted missing branch count=$($missing.Count) under current AO epoch/config"
    exit 46
}

$okState = @{ lastValidatedAt = (Get-Date).ToString('o'); status = 'adopted'; aoEpochHash = ConvertTo-SafeHashText $AoEpoch; configPathHash = ConvertTo-SafeHashText $ConfigPath; branchCount = $RequiredBranches.Count }
Set-MechanicalJsonStateFile -Path $statePath -State $okState -DefaultState @{} -JsonDepth 10
Write-Host '[worker-message-send-adoption-preflight] effective routing adopted'
exit 0
