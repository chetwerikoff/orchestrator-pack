#requires -Version 5.1
<#
  Redelivers outstanding llm-orchestrator escalation deliveries (Issue #641).
#>
[CmdletBinding()]
param(
    [string]$OrchestratorSessionId = '',
    [string]$ProjectId = '',
    [int]$PollSeconds = 15,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/Orchestrator-Escalation.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'orchestrator-wake-common.ps1')

$orchId = Get-OrchestratorSessionId -CliValue $OrchestratorSessionId

function Test-EscalationRouterForeignRecord {
    param($Record)
    $correlationKey = [string]$Record.correlationKey
    $sourceProcess = if ($Record.lastPayload) { [string]$Record.lastPayload.source_process } else { '' }
    return $correlationKey -like 'foreign:*' -or $sourceProcess -eq 'vitest-foreign'
}

function Merge-EscalationRouterReplayState {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$DiskState,
        [Parameter(Mandatory = $true)][string]$RecordKey
    )
    $State.schemaVersion = $DiskState.schemaVersion
    $State.wakeWindows = if ($null -ne $DiskState.wakeWindows) { $DiskState.wakeWindows } else { @{} }
    if ($DiskState.records.ContainsKey($RecordKey)) {
        $State.records[$RecordKey] = $DiskState.records[$RecordKey]
    }
}

function Add-EscalationRouterDirtyRecordKey {
    param(
        [Parameter(Mandatory = $true)]$DirtyRecordKeys,
        [Parameter(Mandatory = $true)][string]$RecordKey
    )
    if (-not $DirtyRecordKeys.ContainsKey($RecordKey)) {
        $DirtyRecordKeys[$RecordKey] = $true
    }
}

function Invoke-EscalationRouterTick {
    $path = Get-OrchestratorEscalationStatePath
    $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
    $catalog = Get-OrchestratorEscalationCatalog
    $redelivered = 0
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $dirtyRecordKeys = @{}
    foreach ($key in @($state.records.Keys)) {
        $record = Sync-OrchestratorEscalationMutableRecord -State $state -RecordKey $key
        Sync-OrchestratorEscalationRecordDefaults -Record $record | Out-Null
        if ([string]$record.route -ne 'llm-orchestrator') { continue }
        $schemaVersion = if ($null -ne $record.schemaVersion) { [int]$record.schemaVersion } else { 1 }
        if ($schemaVersion -gt $Script:OrchestratorEscalationSupportedSchemaVersion) {
            $record.status = 'deferred'
            $record.updatedAtMs = $now
            Add-EscalationRouterDirtyRecordKey -DirtyRecordKeys $dirtyRecordKeys -RecordKey $key
            continue
        }
        if ($schemaVersion -lt 1) {
            Complete-OrchestratorEscalationQuarantine -Record $record -Now $now -Reason 'invalid_schema_version' | Out-Null
            Add-EscalationRouterDirtyRecordKey -DirtyRecordKeys $dirtyRecordKeys -RecordKey $key
            continue
        }
        if (Test-OrchestratorEscalationTerminalState -TerminalState ([string]$record.terminalState)) { continue }
        try {
            $class = Resolve-OrchestratorEscalationClass -EscalationClassId ([string]$record.escalationClassId) -CatalogPath $Script:OrchestratorEscalationCatalogPath
            if (-not $class) { throw 'unknown_escalation_class' }
        }
        catch {
            Complete-OrchestratorEscalationQuarantine -Record $record -Now $now -Reason 'unknown_escalation_class' | Out-Null
            Add-EscalationRouterDirtyRecordKey -DirtyRecordKeys $dirtyRecordKeys -RecordKey $key
            continue
        }
        if (Test-EscalationRouterForeignRecord -Record $record) {
            Complete-OrchestratorEscalationQuarantine -Record $record -Now $now -Reason 'foreign_record' | Out-Null
            Add-EscalationRouterDirtyRecordKey -DirtyRecordKeys $dirtyRecordKeys -RecordKey $key
            continue
        }
        if (Test-OrchestratorEscalationAcked -Record $record) {
            Resolve-OrchestratorEscalationTerminalState -Record $record -TerminalState 'acked' -Now $now | Out-Null
            Add-EscalationRouterDirtyRecordKey -DirtyRecordKeys $dirtyRecordKeys -RecordKey $key
            continue
        }
        $attempts = if ($null -ne $record.attempts) { [int]$record.attempts } else { 0 }
        $firstAttemptAtMs = if ($null -ne $record.firstAttemptAtMs) { [long]$record.firstAttemptAtMs } else { 0 }
        $lastAttemptAtMs = if ($null -ne $record.lastAttemptAtMs) { [long]$record.lastAttemptAtMs } else { 0 }
        if ($firstAttemptAtMs -le 0 -and $attempts -gt 0) {
            $createdAtMs = if ($null -ne $record.createdAtMs) { [long]$record.createdAtMs } else { 0 }
            $updatedAtMs = if ($null -ne $record.updatedAtMs) { [long]$record.updatedAtMs } else { 0 }
            foreach ($candidate in @($createdAtMs, $lastAttemptAtMs, $updatedAtMs)) {
                if ($candidate -gt 0) {
                    $firstAttemptAtMs = $candidate
                    $record.firstAttemptAtMs = $candidate
                    Add-EscalationRouterDirtyRecordKey -DirtyRecordKeys $dirtyRecordKeys -RecordKey $key
                    break
                }
            }
        }
        if ($attempts -ge $Script:OrchestratorEscalationMaxAttempts -or ($firstAttemptAtMs -gt 0 -and ($now - $firstAttemptAtMs) -ge $Script:OrchestratorEscalationMaxElapsedMs)) {
            Complete-OrchestratorEscalationDeadLetter -State $state -Record $record -Class $class -Now $now | Out-Null
            Add-EscalationRouterDirtyRecordKey -DirtyRecordKeys $dirtyRecordKeys -RecordKey $key
            continue
        }
        if ($attempts -gt 0 -and $lastAttemptAtMs -gt 0 -and ($now - $lastAttemptAtMs) -lt $Script:OrchestratorEscalationMinBackoffMs) {
            $record.status = 'backoff_waiting'
            Add-EscalationRouterDirtyRecordKey -DirtyRecordKeys $dirtyRecordKeys -RecordKey $key
            continue
        }
        $payload = @{}
        if ($record.lastPayload) { $payload = ConvertTo-OrchestratorEscalationHashtable -Value $record.lastPayload }
        $result = Publish-OrchestratorEscalation -EscalationClassId ([string]$record.escalationClassId) `
            -CorrelationKey ([string]$record.correlationKey) -Payload $payload `
            -Message ([string]$record.lastMessage) -OrchestratorSessionId $orchId `
            -StatePath $path -ReplayEscalationId $key -SkipWakeSuppression -NowMs $now
        $diskState = Get-MechanicalJsonStateFile -Path $path -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        Merge-EscalationRouterReplayState -State $state -DiskState $diskState -RecordKey $key
        if ($result.delivered) { $redelivered++ }
    }
    $latestState = Get-MechanicalJsonStateFile -Path $path -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
    $writebackState = Merge-OrchestratorEscalationRouterWritebackState -State $state -DiskState $latestState -DirtyRecordKeys @($dirtyRecordKeys.Keys)
    Set-MechanicalJsonStateFile -Path $path -State $writebackState -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
    return $redelivered
}

Write-Host "[orchestrator-escalation-router] starting orchestrator=$orchId once=$Once"
try {
    do {
        Write-OrchestratorSideProcessProgress -ChildId 'escalation-router' -Phase 'poll'
        try {
            $count = Invoke-EscalationRouterTick
            Write-Host "[orchestrator-escalation-router] tick complete redelivered=$count"
            Write-OrchestratorSideProcessTickSuccess -ChildId 'escalation-router'
        }
        catch {
            Write-Host "[orchestrator-escalation-router] tick error: $_"
            Write-OrchestratorSideProcessTickError -ChildId 'escalation-router' -ErrorMessage "$_"
        }
        if ($Once) { break }
        Start-Sleep -Seconds ([Math]::Max(5, $PollSeconds))
    } while ($true)
}
finally {
    Write-Host '[orchestrator-escalation-router] stopped'
}
