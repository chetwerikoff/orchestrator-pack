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

function New-AdoptionProbePayload {
    param(
        [string]$Branch,
        [string]$EpochHash,
        [string]$ConfigHash,
        [string]$RunIdHash = ''
    )

    if ($Branch -match ':self-submitted$') {
        return "AO_WORKER_MESSAGE_ADOPTION_PROBE_V1 b=$Branch e=$EpochHash c=$ConfigHash r=$RunIdHash"
    }

    $filler = 'x' * 240
    return "AO_WORKER_MESSAGE_ADOPTION_PROBE_V1`nbranch=$Branch`naoEpochHash=$EpochHash`nconfigPathHash=$ConfigHash`nadoptionProbeRunIdHash=$RunIdHash`n$filler"
}

$probeRunIdHash = ''
$effectiveJournalPath = if ($JournalPath) { $JournalPath } else { Get-WorkerMessageDispatchJournalPath }
$statePath = Get-AdoptionPreflightStatePath -Path $StateFile
if ($DryRun) {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) 'worker-message-send-adoption-dryrun'
    if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
    $statePath = Join-Path $root 'adoption-state.json'
    $effectiveJournalPath = Join-Path $root 'dispatch-journal.json'
}


if ($WriteProbeEntries) {
    $probeRunIdHash = ConvertTo-SafeHashText ([guid]::NewGuid().ToString('n'))
    foreach ($branch in $RequiredBranches) {
        $savedEnv = @{}
        foreach ($name in @(
            'AO_WORKER_MESSAGE_ADOPTION_PROBE',
            'AO_WORKER_MESSAGE_ADOPTION_BRANCH',
            'AO_WORKER_MESSAGE_ADOPTION_EPOCH_HASH',
            'AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH_HASH',
            'AO_WORKER_MESSAGE_ADOPTION_RUN_ID_HASH',
            'AO_WORKER_MESSAGE_DISPATCH_JOURNAL'
        )) {
            $savedEnv[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
        }
        $probeOutput = @()
        $probeExit = 1
        try {
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_ADOPTION_PROBE', '1', 'Process')
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_ADOPTION_BRANCH', $branch, 'Process')
            $epochHash = ConvertTo-SafeHashText $AoEpoch
            $configHash = ConvertTo-SafeHashText $ConfigPath
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_ADOPTION_EPOCH_HASH', $epochHash, 'Process')
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH_HASH', $configHash, 'Process')
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_ADOPTION_RUN_ID_HASH', $probeRunIdHash, 'Process')
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_DISPATCH_JOURNAL', $effectiveJournalPath, 'Process')
            $probePayload = New-AdoptionProbePayload -Branch $branch -EpochHash $epochHash -ConfigHash $configHash -RunIdHash $probeRunIdHash
            $probeOutput = $probePayload | & $AoPath send synthetic-adoption-probe --stdin --no-wait 2>&1
            $probeExit = $LASTEXITCODE
            if ($null -eq $probeExit) { $probeExit = 0 }
        }
        catch {
            $probeOutput = @($_.Exception.Message)
            $probeExit = 1
        }
        finally {
            foreach ($entry in $savedEnv.GetEnumerator()) {
                [System.Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, 'Process')
            }
        }
        if ($probeExit -ne 0) {
            $diagnostic = ($probeOutput | ForEach-Object { $_.ToString() }) -join ' '
            Write-Host "[worker-message-send-adoption-preflight] ESCALATION: wrapper_not_adopted probe_route_failed branch=$branch exit=$probeExit diagnostic=$diagnostic"
            exit 46
        }
    }
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
    $runOk = (-not $WriteProbeEntries) -or ($record.ContainsKey('adoptionProbeRunIdHash') -and [string]$record['adoptionProbeRunIdHash'] -eq $probeRunIdHash)
    $outcomeOk = $record.ContainsKey('dispatchOutcome') -and [string]$record['dispatchOutcome'] -eq 'dispatched'
    if (-not ($epochOk -and $configOk -and $runOk -and $outcomeOk)) { continue }
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
