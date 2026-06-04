#requires -Version 5.1
<#
.SYNOPSIS
  Supervise orchestrator wake listener and heartbeat as two independent processes.

.DESCRIPTION
  Single operator entry point to start, monitor, and stop
  orchestrator-wake-listener.ps1 and orchestrator-wake-heartbeat.ps1.
  Resolves AO_ORCHESTRATOR_SESSION_ID (override or ao status), restarts children
  on exit, and re-targets both when the orchestrator session id changes.

  See docs/orchestrator-wake-runbook.md and docs/orchestrator-autoloop-go-live.md.
#>
[CmdletBinding(DefaultParameterSetName = 'Start')]
param(
    [Parameter(ParameterSetName = 'Start')]
    [Parameter(ParameterSetName = 'Stop')]
    [Parameter(ParameterSetName = 'Status')]
    [ValidateSet('Start', 'Stop', 'Status')]
    [string]$Action = 'Start',

    [string]$ProjectId = '',
    [string]$OrchestratorSessionId = '',
    [string]$StateDir = '',
    [int]$WaitSeconds = 0,
    [int]$PollSeconds = 0,

    [switch]$Foreground,
    [switch]$TestMode,
    [string]$TestChildScript = '',
    [string]$FixturePath = '',
    [string]$AoCommand = '',

    [int]$MaxLoopSeconds = 0,
    [switch]$SupervisorLoop,
    [switch]$SkipInitialWait
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Orchestrator-WakeSupervisor.ps1')

$project = if ($ProjectId) { $ProjectId } else { Get-OrchestratorWakeSupervisorDefaultProjectId }
$waitSec = Get-OrchestratorWakeSupervisorWaitSeconds -CliValue $WaitSeconds
$pollSec = Get-OrchestratorWakeSupervisorPollSeconds -CliValue $PollSeconds
$stateRoot = Get-OrchestratorWakeSupervisorStateRoot -CliOverride $StateDir
$paths = Get-OrchestratorWakeSupervisorPaths -StateRoot $stateRoot

if (-not (Test-Path -LiteralPath $paths.Root)) {
    New-Item -ItemType Directory -Path $paths.Root -Force | Out-Null
}

switch ($Action) {
    'Status' {
        $report = Get-OrchestratorWakeSupervisorStatusReport -Paths $paths -ProjectId $project
        Write-OrchestratorWakeSupervisorStatusOutput -Report $report
        if ($report.ListenerAlive -and $report.HeartbeatAlive) { exit 0 }
        exit 1
    }

    'Stop' {
        $supervisorPid = Read-OrchestratorWakeSupervisorPidFile -Path $paths.SupervisorPid
        Write-OrchestratorWakeSupervisorLog -Message 'stopping wake supervisor and children'
        Stop-OrchestratorWakeSupervisorChildren -Paths $paths
        Stop-OrchestratorWakeSupervisorProcess -ProcessId $supervisorPid -PidFile $paths.SupervisorPid
        if (Test-Path -LiteralPath $paths.StateJson) {
            Remove-Item -LiteralPath $paths.StateJson -Force -ErrorAction SilentlyContinue
        }
        Write-OrchestratorWakeSupervisorLog -Message 'stopped'
        exit 0
    }

    'Start' {
        $existingPid = Read-OrchestratorWakeSupervisorPidFile -Path $paths.SupervisorPid
        if ((Test-ProcessAlive -ProcessId $existingPid) -and -not $Foreground -and -not $SupervisorLoop) {
            Write-OrchestratorWakeSupervisorLog -Message "supervisor already running (pid=$existingPid)"
            $report = Get-OrchestratorWakeSupervisorStatusReport -Paths $paths -ProjectId $project
            Write-OrchestratorWakeSupervisorStatusOutput -Report $report
            exit 0
        }

        if ($SupervisorLoop) {
            Write-OrchestratorWakeSupervisorLog -Message 'supervisor loop started' -LogPath $paths.SupervisorLog
            Invoke-OrchestratorWakeSupervisorLoop -Paths $paths -ProjectId $project -PollSeconds $pollSec `
                -SessionOverride $OrchestratorSessionId -FixturePath $FixturePath -AoCommand $AoCommand `
                -TestMode:$TestMode -TestChildScript $TestChildScript -MaxLoopSeconds $MaxLoopSeconds
            Write-OrchestratorWakeSupervisorLog -Message 'supervisor loop ended' -LogPath $paths.SupervisorLog
            exit 0
        }

        if (-not $SkipInitialWait) {
            $override = Get-OrchestratorWakeSupervisorSessionOverride -CliValue $OrchestratorSessionId
            if (-not $override) {
                $initial = Wait-OrchestratorWakeSupervisorSession -ProjectId $project -WaitSeconds $waitSec `
                    -PollSeconds $pollSec -FixturePath $FixturePath -AoCommand $AoCommand -LogPath $paths.SupervisorLog
                if (-not $initial) {
                    $message = Format-OrchestratorWakeSupervisorNoSessionMessage -ProjectId $project
                    Write-OrchestratorWakeSupervisorLog -Message $message -LogPath $paths.SupervisorLog
                    Write-Error $message
                    exit 2
                }
            }
        }

        if ($Foreground) {
            Write-OrchestratorWakeSupervisorPidFile -Path $paths.SupervisorPid -ProcessId $PID
            try {
                Invoke-OrchestratorWakeSupervisorLoop -Paths $paths -ProjectId $project -PollSeconds $pollSec `
                    -SessionOverride $OrchestratorSessionId -FixturePath $FixturePath -AoCommand $AoCommand `
                    -TestMode:$TestMode -TestChildScript $TestChildScript -MaxLoopSeconds $MaxLoopSeconds
            }
            finally {
                Stop-OrchestratorWakeSupervisorChildren -Paths $paths
                Remove-OrchestratorWakeSupervisorPidFile -Path $paths.SupervisorPid
            }
            exit 0
        }

        $selfScript = (Resolve-Path -LiteralPath $PSCommandPath).Path
        $loopArgs = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $selfScript,
            '-Action', 'Start', '-SupervisorLoop',
            '-ProjectId', $project,
            '-PollSeconds', $pollSec
        )
        if ($OrchestratorSessionId) {
            $loopArgs += @('-OrchestratorSessionId', $OrchestratorSessionId)
        }
        if ($StateDir) { $loopArgs += @('-StateDir', $stateRoot) }
        if ($FixturePath) { $loopArgs += @('-FixturePath', $FixturePath) }
        if ($AoCommand) { $loopArgs += @('-AoCommand', $AoCommand) }
        if ($TestMode) { $loopArgs += @('-TestMode') }

        $supervisorPid = Start-OrchestratorWakeSupervisorDaemon -LoopArguments $loopArgs `
            -WorkingDirectory $Script:OrchestratorWakeSupervisorPackRoot -LogPath $paths.SupervisorLog
        Write-OrchestratorWakeSupervisorPidFile -Path $paths.SupervisorPid -ProcessId $supervisorPid
        Start-Sleep -Seconds 1
        $report = Get-OrchestratorWakeSupervisorStatusReport -Paths $paths -ProjectId $project
        Write-OrchestratorWakeSupervisorLog -Message "supervisor detached (pid=$supervisorPid)"
        Write-OrchestratorWakeSupervisorStatusOutput -Report $report
        exit 0
    }
}
