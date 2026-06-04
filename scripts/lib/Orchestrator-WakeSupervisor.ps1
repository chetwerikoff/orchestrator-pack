#requires -Version 5.1
<#
  Shared orchestrator wake supervisor helpers (Issue #168).
#>

$Script:OrchestratorWakeSupervisorPackRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
$Script:OrchestratorWakeListenerScript = Join-Path $Script:OrchestratorWakeSupervisorPackRoot 'scripts/orchestrator-wake-listener.ps1'
$Script:OrchestratorWakeHeartbeatScript = Join-Path $Script:OrchestratorWakeSupervisorPackRoot 'scripts/orchestrator-wake-heartbeat.ps1'
$Script:OrchestratorWakeSupervisorTestChildScript = Join-Path $Script:OrchestratorWakeSupervisorPackRoot 'scripts/orchestrator-wake-supervisor-test-child.ps1'

function Get-OrchestratorWakeSupervisorDefaultProjectId {
    if ($env:AO_WAKE_SUPERVISOR_PROJECT_ID) {
        return $env:AO_WAKE_SUPERVISOR_PROJECT_ID.Trim()
    }
    return 'orchestrator-pack'
}

function Get-OrchestratorWakeSupervisorWaitSeconds {
    param([int]$CliValue = 0)
    if ($CliValue -gt 0) { return $CliValue }
    $fromEnv = $env:AO_WAKE_SUPERVISOR_WAIT_SECONDS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return 120
}

function Get-OrchestratorWakeSupervisorPollSeconds {
    param([int]$CliValue = 0)
    if ($CliValue -gt 0) { return $CliValue }
    $fromEnv = $env:AO_WAKE_SUPERVISOR_POLL_SECONDS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return 5
}

function Get-OrchestratorWakeSupervisorStateRoot {
    param([string]$CliOverride = '')
    if ($CliOverride) { return $CliOverride }
    if ($env:AO_WAKE_SUPERVISOR_STATE_DIR) {
        return $env:AO_WAKE_SUPERVISOR_STATE_DIR.Trim()
    }
    $userHome = if (-not [string]::IsNullOrWhiteSpace($env:HOME)) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
    $stateBase = if (-not [string]::IsNullOrWhiteSpace($env:XDG_STATE_HOME)) {
        $env:XDG_STATE_HOME
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $env:LOCALAPPDATA
    }
    else {
        Join-Path $userHome '.local' 'state'
    }
    return Join-Path $stateBase 'orchestrator-pack-wake-supervisor'
}

function Get-OrchestratorWakeSupervisorPaths {
    param([string]$StateRoot)

    return @{
        Root           = $StateRoot
        SupervisorPid  = Join-Path $StateRoot 'supervisor.pid'
        StateJson      = Join-Path $StateRoot 'state.json'
        ListenerPid    = Join-Path $StateRoot 'listener.pid'
        HeartbeatPid   = Join-Path $StateRoot 'heartbeat.pid'
        ListenerLog    = Join-Path $StateRoot 'listener.log'
        HeartbeatLog   = Join-Path $StateRoot 'heartbeat.log'
        SupervisorLog  = Join-Path $StateRoot 'supervisor.log'
    }
}

function Write-OrchestratorWakeSupervisorLog {
    param(
        [string]$Message,
        [string]$LogPath = ''
    )
    $line = "[{0}] orchestrator-wake-supervisor {1}" -f (Get-Date).ToString('o'), $Message
    Write-Host $line
    if ($LogPath) {
        Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
    }
}

function Get-OrchestratorWakeSupervisorSessionOverride {
  param([string]$CliValue = '')
  if ($CliValue) { return $CliValue.Trim() }
  $fromEnv = $env:AO_ORCHESTRATOR_SESSION_ID
  if ($fromEnv) { return $fromEnv.Trim() }
  return ''
}

function Invoke-OrchestratorWakeSupervisorAoStatus {
    param(
        [string]$ProjectId,
        [string]$FixturePath = '',
        [string]$AoCommand = ''
    )

    if ($FixturePath) {
        $resolved = (Resolve-Path -LiteralPath $FixturePath).Path
        return Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json
    }

    $ao = if ($AoCommand) { $AoCommand } else { 'ao' }
    $args = @('status', '--json')
    if ($ProjectId) { $args += @('-p', $ProjectId) }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & $ao @args 2>&1
        if ($LASTEXITCODE -ne 0) {
            return $null
        }
        $text = ($raw | ForEach-Object {
                if ($_ -is [string]) { $_ }
                elseif ($null -ne $_) { $_.ToString() }
            }) -join "`n"
        $start = $text.IndexOf('{')
        if ($start -lt 0) { return $null }
        return $text.Substring($start) | ConvertFrom-Json
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
}

function Get-OrchestratorSessionFromStatusPayload {
    param($Payload)

    if (-not $Payload) { return $null }
    $sessions = @($Payload.data)
    if (-not $sessions -and $Payload.sessions) {
        $sessions = @($Payload.sessions)
    }
    $orch = $sessions | Where-Object { $_.role -eq 'orchestrator' } | Select-Object -First 1
    if (-not $orch) { return $null }
    if ($orch.sessionId) { return [string]$orch.sessionId }
    if ($orch.name) { return [string]$orch.name }
    return $null
}

function Resolve-OrchestratorWakeSupervisorSessionId {
    param(
        [string]$Override = '',
        [string]$ProjectId = '',
        [string]$FixturePath = '',
        [string]$AoCommand = ''
    )

    $explicit = Get-OrchestratorWakeSupervisorSessionOverride -CliValue $Override
    if ($explicit) {
        return @{ Id = $explicit; Source = 'override' }
    }

    $payload = Invoke-OrchestratorWakeSupervisorAoStatus -ProjectId $ProjectId -FixturePath $FixturePath -AoCommand $AoCommand
    $resolved = Get-OrchestratorSessionFromStatusPayload -Payload $payload
    if ($resolved) {
        return @{ Id = $resolved; Source = 'ao_status' }
    }
    return $null
}

function Test-ProcessAlive {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return $false }
    try {
        $proc = Get-Process -Id $ProcessId -ErrorAction Stop
        return -not $proc.HasExited
    }
    catch {
        return $false
    }
}

function Read-OrchestratorWakeSupervisorPidFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
    $text = (Get-Content -LiteralPath $Path -Raw).Trim()
    if ([int]::TryParse($text, [ref]$null)) { return [int]$text }
    return 0
}

function Write-OrchestratorWakeSupervisorPidFile {
    param(
        [string]$Path,
        [int]$ProcessId
    )
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Set-Content -LiteralPath $Path -Value $ProcessId -Encoding ascii -NoNewline
}

function Remove-OrchestratorWakeSupervisorPidFile {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
}

function Read-OrchestratorWakeSupervisorState {
    param([string]$StateJsonPath)
    if (-not (Test-Path -LiteralPath $StateJsonPath)) { return $null }
    try {
        return Get-Content -LiteralPath $StateJsonPath -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Write-OrchestratorWakeSupervisorState {
    param(
        [string]$StateJsonPath,
        [hashtable]$State
    )
    $dir = Split-Path -Parent $StateJsonPath
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $State | ConvertTo-Json -Compress | Set-Content -LiteralPath $StateJsonPath -Encoding utf8
}

function Stop-OrchestratorWakeSupervisorProcess {
    param(
        [int]$ProcessId,
        [string]$PidFile = ''
    )

    if ($ProcessId -le 0) { return }
    try {
        $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($proc -and -not $proc.HasExited) {
            if ($IsLinux -or $IsMacOS) {
                & kill $ProcessId 2>$null
                Start-Sleep -Milliseconds 200
                if (Test-ProcessAlive -ProcessId $ProcessId) {
                    & kill -9 $ProcessId 2>$null
                }
            }
            else {
                Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }
    catch {
        # ignore
    }
    if ($PidFile) {
        Remove-OrchestratorWakeSupervisorPidFile -Path $PidFile
    }
}

function Start-OrchestratorWakeSupervisorChild {
    param(
        [ValidateSet('listener', 'heartbeat')]
        [string]$Role,
        [string]$OrchestratorSessionId,
        [string]$LogPath,
        [string]$PidFile,
        [switch]$TestMode,
        [string]$TestChildScript = '',
        [string[]]$ExtraChildArgs = @()
    )

    $scriptPath = switch ($Role) {
        'listener' { $Script:OrchestratorWakeListenerScript }
        'heartbeat' { $Script:OrchestratorWakeHeartbeatScript }
    }
    if ($TestMode) {
        $scriptPath = if ($TestChildScript) { $TestChildScript } else { $Script:OrchestratorWakeSupervisorTestChildScript }
    }

    if (-not (Test-Path -LiteralPath $scriptPath)) {
        throw "Missing child script: $scriptPath"
    }

    $logDir = Split-Path -Parent $LogPath
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    $childArgs = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $scriptPath
    )
    if ($TestMode) {
        $childArgs += @('-Role', $Role, '-OrchestratorSessionId', $OrchestratorSessionId)
    }
    else {
        $childArgs += @('-OrchestratorSessionId', $OrchestratorSessionId)
    }
    if ($ExtraChildArgs) {
        $childArgs += $ExtraChildArgs
    }

    $childEnv = @{
        AO_ORCHESTRATOR_SESSION_ID = $OrchestratorSessionId
    }
    if ($TestMode) {
        $markerRoot = Join-Path (Split-Path -Parent $PidFile) 'markers'
        if (-not (Test-Path -LiteralPath $markerRoot)) {
            New-Item -ItemType Directory -Path $markerRoot -Force | Out-Null
        }
        $childEnv['AO_WAKE_SUPERVISOR_TEST_MARKER_DIR'] = $markerRoot
    }

    $psi = @{
        FilePath         = 'pwsh'
        ArgumentList     = $childArgs
        WorkingDirectory = $Script:OrchestratorWakeSupervisorPackRoot
        PassThru         = $true
    }
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        $psi['WindowStyle'] = 'Hidden'
    }
    if ($PSVersionTable.PSVersion.Major -ge 7) {
        $psi['Environment'] = $childEnv
        $psi['RedirectStandardOutput'] = $LogPath
        $psi['RedirectStandardError'] = "${LogPath}.err"
    }

    if ($PSVersionTable.PSVersion.Major -ge 7) {
        $proc = Start-Process @psi
    }
    else {
        $savedEnv = @{}
        foreach ($key in $childEnv.Keys) {
            $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            Set-Item -Path "Env:$key" -Value $childEnv[$key]
        }
        try {
            $proc = Start-Process @psi
        }
        finally {
            foreach ($key in $childEnv.Keys) {
                if ([string]::IsNullOrEmpty($savedEnv[$key])) {
                    Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue
                }
                else {
                    Set-Item -Path "Env:$key" -Value $savedEnv[$key]
                }
            }
        }
    }
    Write-OrchestratorWakeSupervisorPidFile -Path $PidFile -ProcessId $proc.Id
    return $proc.Id
}

function Stop-OrchestratorWakeSupervisorChildren {
    param($Paths)

    foreach ($pair in @(
            @{ Pid = $Paths.ListenerPid; Label = 'listener' },
            @{ Pid = $Paths.HeartbeatPid; Label = 'heartbeat' }
        )) {
        $pidVal = Read-OrchestratorWakeSupervisorPidFile -Path $pair.Pid
        Stop-OrchestratorWakeSupervisorProcess -ProcessId $pidVal -PidFile $pair.Pid
    }
}

function Get-OrchestratorWakeSupervisorChildStatus {
    param($Paths)

    $listenerPid = Read-OrchestratorWakeSupervisorPidFile -Path $Paths.ListenerPid
    $heartbeatPid = Read-OrchestratorWakeSupervisorPidFile -Path $Paths.HeartbeatPid
    return @{
        ListenerPid    = $listenerPid
        HeartbeatPid   = $heartbeatPid
        ListenerAlive  = Test-ProcessAlive -ProcessId $listenerPid
        HeartbeatAlive = Test-ProcessAlive -ProcessId $heartbeatPid
    }
}

function Wait-OrchestratorWakeSupervisorSession {
    param(
        [string]$ProjectId,
        [int]$WaitSeconds,
        [int]$PollSeconds,
        [string]$FixturePath = '',
        [string]$AoCommand = '',
        [string]$LogPath = ''
    )

    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline) {
        $resolved = Resolve-OrchestratorWakeSupervisorSessionId -ProjectId $ProjectId -FixturePath $FixturePath -AoCommand $AoCommand
        if ($resolved) {
            return $resolved
        }
        Write-OrchestratorWakeSupervisorLog -Message "waiting for orchestrator session (project=$ProjectId)..." -LogPath $LogPath
        Start-Sleep -Seconds $PollSeconds
    }
    return $null
}

function Format-OrchestratorWakeSupervisorNoSessionMessage {
    param([string]$ProjectId)
    return "No orchestrator session for project '$ProjectId' within the wait window. Start AO first: ao start $ProjectId"
}

function Invoke-OrchestratorWakeSupervisorLoop {
    param(
        [hashtable]$Paths,
        [string]$ProjectId,
        [int]$PollSeconds,
        [string]$SessionOverride = '',
        [string]$FixturePath = '',
        [string]$AoCommand = '',
        [switch]$TestMode,
        [string]$TestChildScript = '',
        [int]$MaxLoopSeconds = 0
    )

    $loopStart = Get-Date
    $phase = 'waiting'
    $currentSessionId = ''
    $currentSource = ''

    while ($true) {
        if ($MaxLoopSeconds -gt 0 -and (((Get-Date) - $loopStart).TotalSeconds -ge $MaxLoopSeconds)) {
            break
        }

        $resolved = Resolve-OrchestratorWakeSupervisorSessionId -Override $SessionOverride -ProjectId $ProjectId -FixturePath $FixturePath -AoCommand $AoCommand

        if ($env:AO_WAKE_SUPERVISOR_DEBUG -eq '1') {
            $resolvedLabel = if ($resolved) { $resolved.Id } else { '(none)' }
            $fixtureHint = ''
            if ($FixturePath) {
                $fixtureResolved = (Resolve-Path -LiteralPath $FixturePath).Path
                $onDisk = (Get-Content -LiteralPath $fixtureResolved -Raw | ConvertFrom-Json).data[0].name
                $fixtureHint = " fixture=$fixtureResolved onDisk=$onDisk"
            }
            Write-OrchestratorWakeSupervisorLog -Message "poll phase=$phase current=$currentSessionId resolved=$resolvedLabel$fixtureHint" -LogPath $Paths.SupervisorLog
        }

        if (-not $resolved) {
            if ($phase -eq 'running') {
                Write-OrchestratorWakeSupervisorLog -Message 'orchestrator session disappeared; stopping children' -LogPath $Paths.SupervisorLog
                Stop-OrchestratorWakeSupervisorChildren -Paths $Paths
                $phase = 'waiting'
                $currentSessionId = ''
            }
            Start-Sleep -Seconds $PollSeconds
            continue
        }

        $sessionId = $resolved.Id
        if ($phase -eq 'waiting') {
            Write-OrchestratorWakeSupervisorLog -Message "orchestrator session available: $sessionId (source=$($resolved.Source))" -LogPath $Paths.SupervisorLog
            $phase = 'running'
            $currentSessionId = $sessionId
            $currentSource = $resolved.Source
            Start-OrchestratorWakeSupervisorChild -Role 'listener' -OrchestratorSessionId $sessionId -LogPath $Paths.ListenerLog -PidFile $Paths.ListenerPid -TestMode:$TestMode -TestChildScript $TestChildScript
            Start-OrchestratorWakeSupervisorChild -Role 'heartbeat' -OrchestratorSessionId $sessionId -LogPath $Paths.HeartbeatLog -PidFile $Paths.HeartbeatPid -TestMode:$TestMode -TestChildScript $TestChildScript
            Write-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson -State @{
                phase                  = 'running'
                orchestratorSessionId = $sessionId
                sessionSource        = $currentSource
                projectId            = $ProjectId
            }
        }
        elseif ($sessionId -ne $currentSessionId) {
            Write-OrchestratorWakeSupervisorLog -Message "orchestrator session id changed ($currentSessionId -> $sessionId); restarting both children" -LogPath $Paths.SupervisorLog
            Stop-OrchestratorWakeSupervisorChildren -Paths $Paths
            $currentSessionId = $sessionId
            $currentSource = $resolved.Source
            Start-OrchestratorWakeSupervisorChild -Role 'listener' -OrchestratorSessionId $sessionId -LogPath $Paths.ListenerLog -PidFile $Paths.ListenerPid -TestMode:$TestMode -TestChildScript $TestChildScript
            Start-OrchestratorWakeSupervisorChild -Role 'heartbeat' -OrchestratorSessionId $sessionId -LogPath $Paths.HeartbeatLog -PidFile $Paths.HeartbeatPid -TestMode:$TestMode -TestChildScript $TestChildScript
            Write-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson -State @{
                phase                  = 'running'
                orchestratorSessionId = $sessionId
                sessionSource        = $currentSource
                projectId            = $ProjectId
            }
        }
        else {
            $children = Get-OrchestratorWakeSupervisorChildStatus -Paths $Paths
            if (-not $children.ListenerAlive) {
                Write-OrchestratorWakeSupervisorLog -Message 'listener exited; restarting' -LogPath $Paths.SupervisorLog
                Start-OrchestratorWakeSupervisorChild -Role 'listener' -OrchestratorSessionId $sessionId -LogPath $Paths.ListenerLog -PidFile $Paths.ListenerPid -TestMode:$TestMode -TestChildScript $TestChildScript
            }
            if (-not $children.HeartbeatAlive) {
                Write-OrchestratorWakeSupervisorLog -Message 'heartbeat exited; restarting' -LogPath $Paths.SupervisorLog
                Start-OrchestratorWakeSupervisorChild -Role 'heartbeat' -OrchestratorSessionId $sessionId -LogPath $Paths.HeartbeatLog -PidFile $Paths.HeartbeatPid -TestMode:$TestMode -TestChildScript $TestChildScript
            }
        }

        Start-Sleep -Seconds $PollSeconds
    }
}

function Get-OrchestratorWakeSupervisorStatusReport {
    param(
        [hashtable]$Paths,
        [string]$ProjectId
    )

    $supervisorPid = Read-OrchestratorWakeSupervisorPidFile -Path $Paths.SupervisorPid
    $supervisorAlive = Test-ProcessAlive -ProcessId $supervisorPid
    $children = Get-OrchestratorWakeSupervisorChildStatus -Paths $Paths
    $state = Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson
    $sessionId = if ($state) { [string]$state.orchestratorSessionId } else { '' }

    return @{
        ProjectId         = $ProjectId
        SupervisorPid     = $supervisorPid
        SupervisorAlive   = $supervisorAlive
        ListenerPid       = $children.ListenerPid
        HeartbeatPid      = $children.HeartbeatPid
        ListenerAlive     = $children.ListenerAlive
        HeartbeatAlive    = $children.HeartbeatAlive
        OrchestratorSessionId = $sessionId
        StateRoot         = $Paths.Root
        ListenerLog       = $Paths.ListenerLog
        HeartbeatLog      = $Paths.HeartbeatLog
    }
}

function Start-OrchestratorWakeSupervisorDaemon {
    param(
        [string[]]$LoopArguments,
        [string]$WorkingDirectory,
        [string]$LogPath
    )

    if ($IsLinux -or $IsMacOS) {
        $stateRoot = Split-Path -Parent $LogPath
        $launcher = Join-Path $stateRoot 'launch-supervisor.sh'
        $quotedArgs = ($LoopArguments | ForEach-Object {
                if ($_ -match "[\s'`"$]") {
                    "'" + ($_ -replace "'", "'\\''") + "'"
                }
                else {
                    $_
                }
            }) -join ' '
        $launcherContent = @(
            '#!/usr/bin/env bash'
            'set -euo pipefail'
            "cd '$($WorkingDirectory -replace "'", "'\\''")'"
            "nohup pwsh $quotedArgs >> '$($LogPath -replace "'", "'\\''")' 2>&1 &"
            'echo $!'
        ) -join "`n"
        Set-Content -LiteralPath $launcher -Value $launcherContent -Encoding utf8 -NoNewline
        & chmod +x $launcher
        $pidLine = & bash $launcher
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to start detached wake supervisor via launch-supervisor.sh"
        }
        return [int]$pidLine.Trim()
    }

    $startArgs = @{
        FilePath         = 'pwsh'
        ArgumentList     = $LoopArguments
        WorkingDirectory = $WorkingDirectory
        PassThru         = $true
    }
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        $startArgs['WindowStyle'] = 'Hidden'
    }
    $proc = Start-Process @startArgs
    return $proc.Id
}

function Write-OrchestratorWakeSupervisorStatusOutput {
    param($Report)

    Write-Host ("supervisor: {0} (pid={1})" -f $(if ($Report.SupervisorAlive) { 'running' } else { 'stopped' }), $Report.SupervisorPid)
    Write-Host ("listener:   {0} (pid={1})" -f $(if ($Report.ListenerAlive) { 'running' } else { 'stopped' }), $Report.ListenerPid)
    Write-Host ("heartbeat:  {0} (pid={1})" -f $(if ($Report.HeartbeatAlive) { 'running' } else { 'stopped' }), $Report.HeartbeatPid)
    if ($Report.OrchestratorSessionId) {
        Write-Host ("session:    {0}" -f $Report.OrchestratorSessionId)
    }
    Write-Host ("state:      {0}" -f $Report.StateRoot)
}
