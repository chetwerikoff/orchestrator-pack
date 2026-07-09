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
    [switch]$SkipInitialWait,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Orchestrator-WakeSupervisor.ps1')

$project = if ($ProjectId) { $ProjectId } else { Get-OrchestratorWakeSupervisorDefaultProjectId }
$waitSec = Get-OrchestratorWakeSupervisorWaitSeconds -CliValue $WaitSeconds
$pollSec = Get-OrchestratorWakeSupervisorPollSeconds -CliValue $PollSeconds
$stateRoot = Get-OrchestratorWakeSupervisorStateRoot -CliOverride $StateDir
$paths = Get-OrchestratorWakeSupervisorPaths -StateRoot $stateRoot
$checkoutScript = (Resolve-Path -LiteralPath $PSCommandPath).Path

if (-not (Test-Path -LiteralPath $paths.Root)) {
    New-Item -ItemType Directory -Path $paths.Root -Force | Out-Null
}

switch ($Action) {
    'Status' {
        if (-not (Test-OrchestratorWakeSupervisorLeasePlatformSupported)) {
            Write-Error 'wake-supervisor lease unsupported on this platform; use Linux/WSL2'
            exit 2
        }
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
        if (-not (Test-OrchestratorWakeSupervisorLeasePlatformSupported)) {
            Write-Error 'wake-supervisor lease unsupported on this platform; use Linux/WSL2'
            exit 2
        }

        if ($Force) {
            $forceResult = Invoke-OrchestratorWakeSupervisorForceStop -Paths $paths -ProjectId $project -LogPath $paths.SupervisorLog
            if ($forceResult.stillLive.Count -gt 0) {
                Write-Error "force stop completed with still-live processes: $($forceResult.stillLive -join ',')"
                exit 1
            }
            Write-OrchestratorWakeSupervisorLog -Message 'force stopped' -LogPath $paths.SupervisorLog
            exit 0
        }

        $resolution = Resolve-OrchestratorWakeSupervisorSupervisorPid -Paths $paths -ProjectId $project -LogPath $paths.SupervisorLog
        if ($resolution.Ambiguous) {
            $message = "stop blocked: ambiguous managed supervisor candidates ($($resolution.CandidatePids -join ',')); use -Force or manual remediation"
            Write-OrchestratorWakeSupervisorLog -Message $message -LogPath $paths.SupervisorLog
            Write-Error $message
            exit 1
        }

        Set-OrchestratorWakeSupervisorStoppingFlag -Paths $paths
        try {
            $supervisorPid = $resolution.ResolvedPid
            Write-OrchestratorWakeSupervisorLog -Message 'stopping wake supervisor and children' -LogPath $paths.SupervisorLog
            Stop-OrchestratorWakeSupervisorProcess -ProcessId $supervisorPid -PidFile $paths.SupervisorPid `
                -ManagedRole 'supervisor' -LogPath $paths.SupervisorLog -ProjectId $project -StateRoot $stateRoot
            Wait-OrchestratorWakeSupervisorProcessExit -ProcessId $supervisorPid -TimeoutSeconds 5
            Stop-OrchestratorWakeSupervisorChildren -Paths $paths -LogPath $paths.SupervisorLog `
                -ProjectId $project -StateRoot $stateRoot
            if (Test-Path -LiteralPath $paths.StateJson) {
                Remove-Item -LiteralPath $paths.StateJson -Force -ErrorAction SilentlyContinue
            }
            $leaseRecord = Read-OrchestratorWakeSupervisorLeaseRecord -LockPath (Get-OrchestratorWakeSupervisorLeasePath -Paths $paths)
            if ($leaseRecord -and -not (Test-ProcessAlive -ProcessId ([int]$leaseRecord.pid))) {
                $lockPath = Get-OrchestratorWakeSupervisorLeasePath -Paths $paths
                if (Test-Path -LiteralPath $lockPath) {
                    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
                }
            }
            Write-OrchestratorWakeSupervisorLog -Message 'stopped' -LogPath $paths.SupervisorLog
        }
        finally {
            Clear-OrchestratorWakeSupervisorStoppingFlag -Paths $paths
        }
        exit 0
    }

    'Start' {
        if (-not (Test-OrchestratorWakeSupervisorLeasePlatformSupported)) {
            Write-Error 'wake-supervisor lease unsupported on this platform; use Linux/WSL2'
            exit 2
        }

        if (-not (Test-Path -LiteralPath $paths.ProgressDir)) {
            New-Item -ItemType Directory -Path $paths.ProgressDir -Force | Out-Null
        }

        if ($SupervisorLoop) {
            Write-OrchestratorWakeSupervisorLog -Message 'supervisor loop started' -LogPath $paths.SupervisorLog
            Invoke-OrchestratorWakeSupervisorLoop -Paths $paths -ProjectId $project -PollSeconds $pollSec `
                -SessionOverride $OrchestratorSessionId -FixturePath $FixturePath -AoCommand $AoCommand `
                -TestMode:$TestMode -TestChildScript $TestChildScript -MaxLoopSeconds $MaxLoopSeconds
            Write-OrchestratorWakeSupervisorLog -Message 'supervisor loop ended' -LogPath $paths.SupervisorLog
            exit 0
        }

        $gate = Resolve-OrchestratorWakeSupervisorStartLeaseGate -Paths $paths -ProjectId $project `
            -PollSeconds $pollSec -CheckoutScript $checkoutScript -LogPath $paths.SupervisorLog
        if ($gate.action -eq 'fail') {
            Write-Error ([string]$gate.message)
            exit [int]$gate.exitCode
        }
        if ($gate.action -eq 'already_running') {
            if ($gate.holderPid -gt 0) {
                Write-OrchestratorWakeSupervisorPidFile -Path $paths.SupervisorPid -ProcessId $gate.holderPid
            }
            if ($gate.message) {
                Write-OrchestratorWakeSupervisorLog -Message ([string]$gate.message) -LogPath $paths.SupervisorLog
                Write-Host ([string]$gate.message)
            }
            $report = Get-OrchestratorWakeSupervisorStatusReport -Paths $paths -ProjectId $project
            Write-OrchestratorWakeSupervisorStatusOutput -Report $report
            exit 0
        }

        $registryErrors = @()
        if (-not (Test-OrchestratorSideProcessRegistry -OutErrors ([ref]$registryErrors))) {
            $message = "Supervisor registry validation failed: $($registryErrors -join '; ')"
            Write-OrchestratorWakeSupervisorLog -Message $message -LogPath $paths.SupervisorLog
            Write-Error $message
            exit 2
        }

        if ($Foreground) {
            if ($gate.handoff -and $gate.handoff.MainLock) {
                Release-OrchestratorWakeSupervisorHeldLock -Context $gate.handoff.MainLock
                $gate.handoff.MainLock = $null
            }
            Write-OrchestratorWakeSupervisorLog -Message 'supervisor foreground started' -LogPath $paths.SupervisorLog
            try {
                Invoke-OrchestratorWakeSupervisorLoop -Paths $paths -ProjectId $project -PollSeconds $pollSec `
                    -SessionOverride $OrchestratorSessionId -FixturePath $FixturePath -AoCommand $AoCommand `
                    -TestMode:$TestMode -TestChildScript $TestChildScript -MaxLoopSeconds $MaxLoopSeconds
            }
            finally {
                Write-OrchestratorWakeSupervisorLog -Message 'supervisor foreground ended; stopping managed children' -LogPath $paths.SupervisorLog
                Stop-OrchestratorWakeSupervisorChildren -Paths $paths -LogPath $paths.SupervisorLog `
                    -ProjectId $project -StateRoot $stateRoot
                if (Test-Path -LiteralPath $paths.StateJson) {
                    Remove-Item -LiteralPath $paths.StateJson -Force -ErrorAction SilentlyContinue
                }
            }
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

        $loopArgs = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $checkoutScript,
            '-Action', 'Start', '-SupervisorLoop',
            '-ProjectId', $project,
            '-PollSeconds', $pollSec
        )
        if ($OrchestratorSessionId) {
            $loopArgs += @('-OrchestratorSessionId', $OrchestratorSessionId)
        }
        $loopArgs += @('-StateDir', $stateRoot)
        if ($FixturePath) { $loopArgs += @('-FixturePath', $FixturePath) }
        if ($AoCommand) { $loopArgs += @('-AoCommand', $AoCommand) }
        if ($TestMode) { $loopArgs += @('-TestMode') }

        $supervisorPid = Start-OrchestratorWakeSupervisorDaemon -LoopArguments $loopArgs `
            -WorkingDirectory $Script:OrchestratorWakeSupervisorPackRoot -LogPath $paths.SupervisorLog
        if ($gate.handoff) {
            $handoffOk = Complete-OrchestratorWakeSupervisorStartLeaseHandoff -Handoff $gate.handoff `
                -SpawnedPid $supervisorPid -LogPath $paths.SupervisorLog
            if (-not $handoffOk) {
                $message = "start lease handoff failed for spawned supervisor pid=$supervisorPid"
                Write-OrchestratorWakeSupervisorLog -Message $message -LogPath $paths.SupervisorLog
                Write-Error $message
                exit 2
            }
        }
        Write-OrchestratorWakeSupervisorPidFile -Path $paths.SupervisorPid -ProcessId $supervisorPid
        Start-Sleep -Seconds 1
        $report = Get-OrchestratorWakeSupervisorStatusReport -Paths $paths -ProjectId $project
        Write-OrchestratorWakeSupervisorLog -Message "supervisor detached (pid=$supervisorPid)" -LogPath $paths.SupervisorLog
        Write-OrchestratorWakeSupervisorStatusOutput -Report $report
        exit 0
    }
}
