#requires -Version 5.1
<#
.SYNOPSIS
  Low-frequency orchestrator heartbeat: periodic ao send independent of the webhook listener.

.DESCRIPTION
  Separate process from orchestrator-wake-listener.ps1. Emits a labelled heartbeat wake on a
  fixed interval (default 4 hours) even when AO sends no notifications, so the orchestrator
  can run turn-opening reconciliation during event silence.

  Shares file-based single-flight state with the listener (AO_WAKE_DEDUP_STATE or
  %TEMP%\orchestrator-wake-dedup.json) so heartbeat and event wakes do not double-send within
  the dedup window (default 30s).

  See docs/orchestrator-wake-runbook.md.
#>
[CmdletBinding()]
param(
    [string]$OrchestratorSessionId = '',
    [int]$IntervalMinutes = 0,
    [int]$DedupWindowSeconds = 30,
    [int]$PollSeconds = 60,
    [switch]$DryRun,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'orchestrator-wake-common.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')

$Script:DefaultIntervalMinutes = 240

function Get-HeartbeatIntervalMinutes {
    if ($IntervalMinutes -gt 0) { return $IntervalMinutes }
    $envMinutes = $env:AO_WAKE_HEARTBEAT_INTERVAL_MINUTES
    if ($envMinutes -and [int]::TryParse($envMinutes, [ref]$null)) {
        return [int]$envMinutes
    }
    return $Script:DefaultIntervalMinutes
}

function Write-HeartbeatLog {
    param([string]$Message)
    Write-OrchestratorWakeLog -Message $Message
}

function Invoke-HeartbeatTick {
    param(
        [string]$DedupFile,
        [int]$IntervalMs,
        [int]$WindowMs
    )

    return Invoke-OrchestratorWakeFilterCli -NodeArguments @(
        'heartbeat', 'tick', '--file', $DedupFile, '--interval-ms', $IntervalMs, '--window-ms', $WindowMs
    )
}

$orchestratorId = Get-OrchestratorSessionId -CliValue $OrchestratorSessionId
$intervalMinutes = Get-HeartbeatIntervalMinutes
$intervalMs = [Math]::Max(1, $intervalMinutes) * 60 * 1000
$dedupWindowMs = [Math]::Max(1, $DedupWindowSeconds) * 1000
$pollMs = [Math]::Max(5, $PollSeconds) * 1000
$dedupFile = Get-OrchestratorWakeDedupStatePath

Write-HeartbeatLog "orchestrator-wake-heartbeat starting (orchestrator=$orchestratorId, interval=${intervalMinutes}m, dedup=${DedupWindowSeconds}s, dedupFile=$dedupFile, dryRun=$DryRun, once=$Once)"

Register-OrchestratorWakeCancelHandler

try {
    do {
        if (Test-OrchestratorWakeCancelled) { break }

        try {
            Write-OrchestratorSideProcessProgress -ChildId 'heartbeat' -Phase 'poll'
            $tick = Invoke-HeartbeatTick -DedupFile $dedupFile -IntervalMs $intervalMs -WindowMs $dedupWindowMs
            if ($tick.ok) {
                Send-OrchestratorWakeMessage -OrchestratorId $orchestratorId -Message $tick.wakeMessage -DryRun:$DryRun -LogSuffix 'heartbeat'
                Write-HeartbeatLog "heartbeat accepted: $($tick.wakeKind)"
            }
            else {
                Write-HeartbeatLog "heartbeat skipped: $($tick.reason)"
            }
            Write-OrchestratorSideProcessProgress -ChildId 'heartbeat' -Phase 'tick_complete'
        }
        catch {
            Write-HeartbeatLog "heartbeat tick error: $_"
        }

        if ($Once) { break }
        if (Test-OrchestratorWakeCancelled) { break }

        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Unregister-OrchestratorWakeCancelHandler
    Write-HeartbeatLog 'stopped'
}
