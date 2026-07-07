#requires -Version 5.1
<#
.SYNOPSIS
  Supervise orchestrator wake listener, heartbeat, and review-send-reconcile as managed children.

.DESCRIPTION
  Single operator entry point to start, monitor, and stop
  orchestrator-wake-listener.ps1 and orchestrator-wake-heartbeat.ps1.
  Resolves AO_ORCHESTRATOR_SESSION_ID (override or orchestrator-list adapter), restarts children
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
        Clear-OrchestratorWakeSupervisorStalePidIfNeeded -ProcessId (Read-OrchestratorWakeSupervisorPidFile -Path $paths.SupervisorPid) `
            -PidFile $paths.SupervisorPid -Role 'supervisor' -LogPath $paths.SupervisorLog `
            -ProjectId $project -StateRoot $stateRoot
        foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
            $pidPath = Get-OrchestratorWakeSupervisorChildPidPath -Paths $paths -ChildId $child.Id
            Clear-OrchestratorWakeSupervisorStalePidIfNeeded -ProcessId (Read-OrchestratorWakeSupervisorPidFile -Path $pidPath) `
                -PidFile $pidPath -Role $child.Id -LogPath $paths.SupervisorLog
        }
        $report = Get-OrchestratorWakeSupervisorStatusReport -Paths $paths -ProjectId $project
        Write-OrchestratorWakeSupervisorStatusOutput -Report $report
        if ($report.SupervisorAmbiguous) {
            exit 1
        }
        if (Test-OrchestratorWakeSupervisorAllChildrenHealthy -Report $report) {
            exit 0
        }
        exit 1
    }

    'Stop' {
        $resolution = Resolve-OrchestratorWakeSupervisorSupervisorPid -Paths $paths -ProjectId $project -LogPath $paths.SupervisorLog
        if ($resolution.Ambiguous) {
            $message = "stop blocked: ambiguous managed supervisor candidates ($($resolution.CandidatePids -join ',')); manual remediation required"
            Write-OrchestratorWakeSupervisorLog -Message $message -LogPath $paths.SupervisorLog
            Write-Error $message
            exit 1
        }

        $supervisorPid = $resolution.ResolvedPid
        Write-OrchestratorWakeSupervisorLog -Message 'stopping wake supervisor and children'
        Set-OrchestratorWakeSupervisorStoppingFlag -Paths $paths
        Stop-OrchestratorWakeSupervisorProcess -ProcessId $supervisorPid -PidFile $paths.SupervisorPid `
            -ManagedRole 'supervisor' -LogPath $paths.SupervisorLog -ProjectId $project -StateRoot $stateRoot
        Wait-OrchestratorWakeSupervisorProcessExit -ProcessId $supervisorPid -TimeoutSeconds 5
        Stop-OrchestratorWakeSupervisorChildren -Paths $paths -LogPath $paths.SupervisorLog `
            -ProjectId $project -StateRoot $stateRoot
        if (Test-Path -LiteralPath $paths.StateJson) {
            Remove-Item -LiteralPath $paths.StateJson -Force -ErrorAction SilentlyContinue
        }
        Clear-OrchestratorWakeSupervisorStoppingFlag -Paths $paths
        Write-OrchestratorWakeSupervisorLog -Message 'stopped'
        exit 0
    }

    'Start' {
        $registryErrors = @()
        if (-not (Test-OrchestratorSideProcessRegistry -OutErrors ([ref]$registryErrors))) {
            $message = "Supervisor registry validation failed: $($registryErrors -join '; ')"
            Write-OrchestratorWakeSupervisorLog -Message $message -LogPath $paths.SupervisorLog
            Write-Error $message
            exit 2
        }

        if (-not (Test-Path -LiteralPath $paths.ProgressDir)) {
            New-Item -ItemType Directory -Path $paths.ProgressDir -Force | Out-Null
        }

        $existingPid = Read-OrchestratorWakeSupervisorPidFile -Path $paths.SupervisorPid
        Clear-OrchestratorWakeSupervisorStalePidIfNeeded -ProcessId $existingPid -PidFile $paths.SupervisorPid `
            -Role 'supervisor' -LogPath $paths.SupervisorLog -ProjectId $project -StateRoot $stateRoot
        $resolution = Resolve-OrchestratorWakeSupervisorSupervisorPid -Paths $paths -ProjectId $project -LogPath $paths.SupervisorLog
        if ($resolution.Ambiguous -and -not $Foreground -and -not $SupervisorLoop) {
            $message = "ambiguous managed supervisor candidates ($($resolution.CandidatePids -join ',')); manual remediation required"
            Write-OrchestratorWakeSupervisorLog -Message $message -LogPath $paths.SupervisorLog
            Write-Error $message
            exit 2
        }
        if ($resolution.ResolvedAlive -and -not $Foreground -and -not $SupervisorLoop) {
            if ($resolution.ResolvedPid -ne $existingPid -or $resolution.DiscoverySource -eq 'process-scan') {
                Write-OrchestratorWakeSupervisorPidFile -Path $paths.SupervisorPid -ProcessId $resolution.ResolvedPid
            }
            Write-OrchestratorWakeSupervisorLog -Message "supervisor already running (pid=$($resolution.ResolvedPid))"
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
