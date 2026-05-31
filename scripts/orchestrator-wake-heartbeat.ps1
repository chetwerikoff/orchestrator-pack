#requires -Version 5.1
<#
.SYNOPSIS
  Low-frequency orchestrator heartbeat: periodic ao send independent of the webhook listener.

.DESCRIPTION
  Separate process from orchestrator-wake-listener.ps1. Emits a labelled heartbeat wake on a
  fixed interval (default 15 minutes) even when AO sends no notifications, so the orchestrator
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

$Script:DefaultIntervalMinutes = 15
$Script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Script:FilterCli = Join-Path $Script:RepoRoot 'docs/orchestrator-wake-filter.mjs'

function Get-OrchestratorSessionId {
    param([string]$CliValue)
    if ($CliValue) { return $CliValue.Trim() }
    $fromEnv = $env:AO_ORCHESTRATOR_SESSION_ID
    if ($fromEnv) { return $fromEnv.Trim() }
    throw 'Orchestrator session id required: -OrchestratorSessionId or AO_ORCHESTRATOR_SESSION_ID'
}

function Get-HeartbeatIntervalMinutes {
    if ($IntervalMinutes -gt 0) { return $IntervalMinutes }
    $envMinutes = $env:AO_WAKE_HEARTBEAT_INTERVAL_MINUTES
    if ($envMinutes -and [int]::TryParse($envMinutes, [ref]$null)) {
        return [int]$envMinutes
    }
    return $Script:DefaultIntervalMinutes
}

function Get-DedupStatePath {
    $fromEnv = $env:AO_WAKE_DEDUP_STATE
    if ($fromEnv) { return $fromEnv }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-wake-dedup.json'
}

function Write-HeartbeatLog {
    param([string]$Message)
    $ts = (Get-Date).ToString('o')
    Write-Host "[$ts] $Message"
}

function Invoke-HeartbeatTick {
    param(
        [string]$DedupFile,
        [int]$IntervalMs,
        [int]$WindowMs
    )

    Push-Location $Script:RepoRoot
    try {
        $output = & node $Script:FilterCli heartbeat tick --file $DedupFile --interval-ms $IntervalMs --window-ms $WindowMs 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "heartbeat tick exited ${LASTEXITCODE}: $output"
        }
        return ($output | Out-String).Trim() | ConvertFrom-Json
    }
    finally {
        Pop-Location
    }
}

function Send-HeartbeatWake {
    param(
        [string]$OrchestratorId,
        [string]$Message
    )

    if ($DryRun) {
        Write-HeartbeatLog "dry-run: ao send $OrchestratorId $Message"
        return
    }

    & ao send $OrchestratorId $Message
    if ($LASTEXITCODE -ne 0) {
        throw "ao send failed with exit code $LASTEXITCODE"
    }
    Write-HeartbeatLog "forwarded heartbeat: ao send $OrchestratorId"
}

$orchestratorId = Get-OrchestratorSessionId -CliValue $OrchestratorSessionId
$intervalMinutes = Get-HeartbeatIntervalMinutes
$intervalMs = [Math]::Max(1, $intervalMinutes) * 60 * 1000
$dedupWindowMs = [Math]::Max(1, $DedupWindowSeconds) * 1000
$pollMs = [Math]::Max(5, $PollSeconds) * 1000
$dedupFile = Get-DedupStatePath

Write-HeartbeatLog "orchestrator-wake-heartbeat starting (orchestrator=$orchestratorId, interval=${intervalMinutes}m, dedup=${DedupWindowSeconds}s, dedupFile=$dedupFile, dryRun=$DryRun, once=$Once)"

$cancelled = $false
$onCancel = [ConsoleCancelEventHandler]{
    param($sender, $eventArgs)
    $script:cancelled = $true
    $eventArgs.Cancel = $true
}
[Console]::add_CancelKeyPress($onCancel)

try {
    do {
        if ($cancelled) { break }

        try {
            $tick = Invoke-HeartbeatTick -DedupFile $dedupFile -IntervalMs $intervalMs -WindowMs $dedupWindowMs
            if ($tick.ok) {
                Send-HeartbeatWake -OrchestratorId $orchestratorId -Message $tick.wakeMessage
                Write-HeartbeatLog "heartbeat accepted: $($tick.wakeKind)"
            }
            else {
                Write-HeartbeatLog "heartbeat skipped: $($tick.reason)"
            }
        }
        catch {
            Write-HeartbeatLog "heartbeat tick error: $_"
        }

        if ($Once) { break }
        if ($cancelled) { break }

        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    [Console]::remove_CancelKeyPress($onCancel)
    Write-HeartbeatLog 'stopped'
}
