#requires -Version 5.1
<#
  Shared orchestrator wake supervisor helpers (Issue #168).
#>

$Script:OrchestratorWakeSupervisorPackRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
$Script:OrchestratorWakeListenerScript = Join-Path $Script:OrchestratorWakeSupervisorPackRoot 'scripts/orchestrator-wake-listener.ps1'
$Script:OrchestratorWakeHeartbeatScript = Join-Path $Script:OrchestratorWakeSupervisorPackRoot 'scripts/orchestrator-wake-heartbeat.ps1'
$Script:OrchestratorReviewSendReconcileScript = Join-Path $Script:OrchestratorWakeSupervisorPackRoot 'scripts/review-send-reconcile.ps1'
$Script:OrchestratorWakeSupervisorTestChildScript = Join-Path $Script:OrchestratorWakeSupervisorPackRoot 'scripts/orchestrator-wake-supervisor-test-child.ps1'

function Get-OrchestratorWakeSupervisorChildRegistry {
    return @(
        @{
            Id            = 'listener'
            SideEffecting = $true
            SideEffectLock = { param($Paths) Join-Path $Paths.Root 'listener-side-effect.lock' }
        },
        @{
            Id            = 'heartbeat'
            SideEffecting = $false
        },
        @{
            Id            = 'review-send-reconcile'
            SideEffecting = $false
        }
    )
}

function Test-OrchestratorWakeSupervisorSideEffectInFlight {
    param(
        [hashtable]$Paths,
        [ValidateSet('listener', 'review-send-reconcile')]
        [string]$Role
    )

    $entry = Get-OrchestratorWakeSupervisorChildRegistry | Where-Object { $_.Id -eq $Role } | Select-Object -First 1
    if (-not $entry -or -not $entry.SideEffecting -or -not $entry.SideEffectLock) {
        return $false
    }
    $lockPath = & $entry.SideEffectLock $Paths
    return Test-Path -LiteralPath $lockPath -PathType Leaf
}

function Wait-OrchestratorWakeSupervisorSideEffectDrain {
    param(
        [hashtable]$Paths,
        [ValidateSet('listener', 'review-send-reconcile')]
        [string]$Role,
        [int]$TimeoutSeconds = 30,
        [string]$LogPath = ''
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-OrchestratorWakeSupervisorSideEffectInFlight -Paths $Paths -Role $Role)) {
            return $true
        }
        Write-OrchestratorWakeSupervisorLog -Message "draining $Role side-effect (waiting for lock release)" -LogPath $LogPath
        Start-Sleep -Milliseconds 200
    }
    return -not (Test-OrchestratorWakeSupervisorSideEffectInFlight -Paths $Paths -Role $Role)
}

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
        ListenerPid              = Join-Path $StateRoot 'listener.pid'
        HeartbeatPid             = Join-Path $StateRoot 'heartbeat.pid'
        ReviewSendReconcilePid   = Join-Path $StateRoot 'review-send-reconcile.pid'
        ListenerLog              = Join-Path $StateRoot 'listener.log'
        HeartbeatLog             = Join-Path $StateRoot 'heartbeat.log'
        ReviewSendReconcileLog     = Join-Path $StateRoot 'review-send-reconcile.log'
        SupervisorLog            = Join-Path $StateRoot 'supervisor.log'
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

function Test-StartProcessSupportsEnvironmentParameter {
    if ($PSVersionTable.PSVersion.Major -lt 7) {
        return $false
    }
    if ($PSVersionTable.PSVersion.Major -eq 7 -and $PSVersionTable.PSVersion.Minor -lt 4) {
        return $false
    }
    return (Get-Command Start-Process).Parameters.ContainsKey('Environment')
}

function Get-OrchestratorWakeSupervisorStoppingFlagPath {
    param([hashtable]$Paths)
    return Join-Path $Paths.Root 'stopping'
}

function Set-OrchestratorWakeSupervisorStoppingFlag {
    param([hashtable]$Paths)
    $flag = Get-OrchestratorWakeSupervisorStoppingFlagPath -Paths $Paths
    $dir = Split-Path -Parent $flag
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Set-Content -LiteralPath $flag -Value ((Get-Date).ToString('o')) -Encoding ascii
}

function Test-OrchestratorWakeSupervisorStopping {
    param([hashtable]$Paths)
    return Test-Path -LiteralPath (Get-OrchestratorWakeSupervisorStoppingFlagPath -Paths $Paths)
}

function Clear-OrchestratorWakeSupervisorStoppingFlag {
    param([hashtable]$Paths)
    $flag = Get-OrchestratorWakeSupervisorStoppingFlagPath -Paths $Paths
    if (Test-Path -LiteralPath $flag) {
        Remove-Item -LiteralPath $flag -Force -ErrorAction SilentlyContinue
    }
}

function Wait-OrchestratorWakeSupervisorProcessExit {
    param(
        [int]$ProcessId,
        [int]$TimeoutSeconds = 5
    )
    if ($ProcessId -le 0) { return }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-ProcessAlive -ProcessId $ProcessId)) {
            return
        }
        Start-Sleep -Milliseconds 100
    }
}

function Get-OrchestratorWakeSupervisorProcessCommandLine {
    param([int]$ProcessId)

    if ($ProcessId -le 0) { return '' }

    if ($IsLinux) {
        $procPath = "/proc/$ProcessId/cmdline"
        if (Test-Path -LiteralPath $procPath) {
            $raw = [System.IO.File]::ReadAllBytes($procPath)
            if ($raw.Length -eq 0) { return '' }
            $parts = New-Object System.Collections.Generic.List[string]
            $current = New-Object System.Text.StringBuilder
            foreach ($byte in $raw) {
                if ($byte -eq 0) {
                    if ($current.Length -gt 0) {
                        $parts.Add($current.ToString())
                        $current.Clear() | Out-Null
                    }
                }
                else {
                    [void]$current.Append([char]$byte)
                }
            }
            if ($current.Length -gt 0) {
                $parts.Add($current.ToString())
            }
            return ($parts -join ' ')
        }
    }

    if ($IsMacOS) {
        $out = & ps -p $ProcessId -o command= 2>$null
        return (($out | ForEach-Object { $_.ToString() }) -join ' ').Trim()
    }

    try {
        $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        return [string]$cim.CommandLine
    }
    catch {
        return ''
    }
}

function Test-OrchestratorWakeSupervisorManagedProcess {
    param(
        [int]$ProcessId,
        [ValidateSet('supervisor', 'listener', 'heartbeat', 'review-send-reconcile')]
        [string]$Role
    )

    if ($ProcessId -le 0) { return $false }
    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return $false }

    $commandLine = Get-OrchestratorWakeSupervisorProcessCommandLine -ProcessId $ProcessId
    if (-not $commandLine) { return $false }

    $scriptMarkers = switch ($Role) {
        'supervisor' { @('orchestrator-wake-supervisor.ps1') }
        'listener' { @('orchestrator-wake-listener.ps1') }
        'heartbeat' { @('orchestrator-wake-heartbeat.ps1') }
        'review-send-reconcile' { @('review-send-reconcile.ps1') }
    }

    $matchedScript = $false
    foreach ($marker in $scriptMarkers) {
        if ($commandLine -like "*$marker*") {
            $matchedScript = $true
            break
        }
    }

    if ($commandLine -like '*orchestrator-wake-supervisor-test-child.ps1*') {
        if ($Role -eq 'listener' -and $commandLine -match '-Role\s+listener') {
            return $true
        }
        if ($Role -eq 'heartbeat' -and $commandLine -match '-Role\s+heartbeat') {
            return $true
        }
        if ($Role -eq 'review-send-reconcile' -and $commandLine -match '-Role\s+review-send-reconcile') {
            return $true
        }
        return $false
    }

    return $matchedScript
}

function Test-OrchestratorWakeSupervisorDaemonRunning {
    param(
        [int]$ProcessId,
        [ValidateSet('supervisor', 'listener', 'heartbeat', 'review-send-reconcile')]
        [string]$Role
    )

    return (Test-ProcessAlive -ProcessId $ProcessId) -and
    (Test-OrchestratorWakeSupervisorManagedProcess -ProcessId $ProcessId -Role $Role)
}

function Clear-OrchestratorWakeSupervisorStalePidIfNeeded {
    param(
        [int]$ProcessId,
        [string]$PidFile,
        [ValidateSet('supervisor', 'listener', 'heartbeat', 'review-send-reconcile')]
        [string]$Role,
        [string]$LogPath = ''
    )

    if ($ProcessId -le 0) {
        if ($PidFile -and (Test-Path -LiteralPath $PidFile)) {
            Remove-OrchestratorWakeSupervisorPidFile -Path $PidFile
        }
        return
    }

    if (Test-OrchestratorWakeSupervisorDaemonRunning -ProcessId $ProcessId -Role $Role) {
        return
    }

    if (Test-ProcessAlive -ProcessId $ProcessId) {
        Write-OrchestratorWakeSupervisorLog -Message "clearing stale $Role pid file (pid=$ProcessId unrelated)" -LogPath $LogPath
    }
    Remove-OrchestratorWakeSupervisorPidFile -Path $PidFile
}

function Stop-OrchestratorWakeSupervisorProcess {
    param(
        [int]$ProcessId,
        [string]$PidFile = '',
        [ValidateSet('supervisor', 'listener', 'heartbeat', 'review-send-reconcile', '')]
        [string]$ManagedRole = '',
        [string]$LogPath = ''
    )

    if ($ProcessId -le 0) { return }

    if ($ManagedRole) {
        if (-not (Test-OrchestratorWakeSupervisorManagedProcess -ProcessId $ProcessId -Role $ManagedRole)) {
            Write-OrchestratorWakeSupervisorLog -Message "skipping kill for pid=$ProcessId (stale or unrelated $ManagedRole)" -LogPath $LogPath
            if ($PidFile) {
                Remove-OrchestratorWakeSupervisorPidFile -Path $PidFile
            }
            return
        }
    }

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
        [ValidateSet('listener', 'heartbeat', 'review-send-reconcile')]
        [string]$Role,
        [string]$OrchestratorSessionId,
        [string]$LogPath,
        [string]$PidFile,
        [string]$ProjectId = '',
        [switch]$TestMode,
        [string]$TestChildScript = '',
        [string[]]$ExtraChildArgs = @()
    )

    $scriptPath = switch ($Role) {
        'listener' { $Script:OrchestratorWakeListenerScript }
        'heartbeat' { $Script:OrchestratorWakeHeartbeatScript }
        'review-send-reconcile' { $Script:OrchestratorReviewSendReconcileScript }
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
        $childArgs += @('-Role', $Role)
        if ($Role -ne 'review-send-reconcile') {
            $childArgs += @('-OrchestratorSessionId', $OrchestratorSessionId)
        }
    }
    elseif ($Role -ne 'review-send-reconcile') {
        $childArgs += @('-OrchestratorSessionId', $OrchestratorSessionId)
    }
    if ($Role -eq 'review-send-reconcile' -and $ProjectId) {
        $childArgs += @('-ProjectId', $ProjectId)
    }
    if ($ExtraChildArgs -and -not $TestMode) {
        $childArgs += $ExtraChildArgs
    }

    $childEnv = @{}
    if ($Role -ne 'review-send-reconcile') {
        $childEnv['AO_ORCHESTRATOR_SESSION_ID'] = $OrchestratorSessionId
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
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        $psi['RedirectStandardOutput'] = $LogPath
        $psi['RedirectStandardError'] = "${LogPath}.err"
    }

    $useStartProcessEnvironment = Test-StartProcessSupportsEnvironmentParameter
    if ($useStartProcessEnvironment) {
        $psi['Environment'] = $childEnv
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
    param(
        $Paths,
        [string]$LogPath = ''
    )

    foreach ($pair in @(
            @{ Pid = $Paths.ListenerPid; Label = 'listener' },
            @{ Pid = $Paths.HeartbeatPid; Label = 'heartbeat' },
            @{ Pid = $Paths.ReviewSendReconcilePid; Label = 'review-send-reconcile' }
        )) {
        if ($pair.Label -eq 'listener') {
            $drained = Wait-OrchestratorWakeSupervisorSideEffectDrain -Paths $Paths -Role $pair.Label -LogPath $LogPath
            if (-not $drained) {
                Write-OrchestratorWakeSupervisorLog -Message "stop: $(${pair.Label}) side-effect still in flight after drain window" -LogPath $LogPath
            }
        }
        $pidVal = Read-OrchestratorWakeSupervisorPidFile -Path $pair.Pid
        Stop-OrchestratorWakeSupervisorProcess -ProcessId $pidVal -PidFile $pair.Pid -ManagedRole $pair.Label -LogPath $LogPath
    }
}

function Get-OrchestratorWakeSupervisorChildStatus {
    param($Paths)

    $listenerPid = Read-OrchestratorWakeSupervisorPidFile -Path $Paths.ListenerPid
    $heartbeatPid = Read-OrchestratorWakeSupervisorPidFile -Path $Paths.HeartbeatPid
    $reviewSendPid = Read-OrchestratorWakeSupervisorPidFile -Path $Paths.ReviewSendReconcilePid
    return @{
        ListenerPid              = $listenerPid
        HeartbeatPid             = $heartbeatPid
        ReviewSendReconcilePid   = $reviewSendPid
        ListenerAlive            = Test-OrchestratorWakeSupervisorDaemonRunning -ProcessId $listenerPid -Role 'listener'
        HeartbeatAlive           = Test-OrchestratorWakeSupervisorDaemonRunning -ProcessId $heartbeatPid -Role 'heartbeat'
        ReviewSendReconcileAlive = Test-OrchestratorWakeSupervisorDaemonRunning -ProcessId $reviewSendPid -Role 'review-send-reconcile'
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
        if (Test-OrchestratorWakeSupervisorStopping -Paths $Paths) {
            Write-OrchestratorWakeSupervisorLog -Message 'stop requested; exiting supervisor loop' -LogPath $Paths.SupervisorLog
            break
        }

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
            Start-OrchestratorWakeSupervisorChild -Role 'listener' -OrchestratorSessionId $sessionId -LogPath $Paths.ListenerLog -PidFile $Paths.ListenerPid -TestMode:$TestMode -TestChildScript $TestChildScript -ExtraChildArgs @('-SideEffectStateDir', $Paths.Root)
            Start-OrchestratorWakeSupervisorChild -Role 'heartbeat' -OrchestratorSessionId $sessionId -LogPath $Paths.HeartbeatLog -PidFile $Paths.HeartbeatPid -TestMode:$TestMode -TestChildScript $TestChildScript
            Start-OrchestratorWakeSupervisorChild -Role 'review-send-reconcile' -OrchestratorSessionId $sessionId -ProjectId $ProjectId -LogPath $Paths.ReviewSendReconcileLog -PidFile $Paths.ReviewSendReconcilePid -TestMode:$TestMode -TestChildScript $TestChildScript
            Write-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson -State @{
                phase                  = 'running'
                orchestratorSessionId = $sessionId
                sessionSource        = $currentSource
                projectId            = $ProjectId
            }
        }
        elseif ($sessionId -ne $currentSessionId) {
            Write-OrchestratorWakeSupervisorLog -Message "orchestrator session id changed ($currentSessionId -> $sessionId); restarting managed children" -LogPath $Paths.SupervisorLog
            Stop-OrchestratorWakeSupervisorChildren -Paths $Paths
            $currentSessionId = $sessionId
            $currentSource = $resolved.Source
            Start-OrchestratorWakeSupervisorChild -Role 'listener' -OrchestratorSessionId $sessionId -LogPath $Paths.ListenerLog -PidFile $Paths.ListenerPid -TestMode:$TestMode -TestChildScript $TestChildScript -ExtraChildArgs @('-SideEffectStateDir', $Paths.Root)
            Start-OrchestratorWakeSupervisorChild -Role 'heartbeat' -OrchestratorSessionId $sessionId -LogPath $Paths.HeartbeatLog -PidFile $Paths.HeartbeatPid -TestMode:$TestMode -TestChildScript $TestChildScript
            Start-OrchestratorWakeSupervisorChild -Role 'review-send-reconcile' -OrchestratorSessionId $sessionId -ProjectId $ProjectId -LogPath $Paths.ReviewSendReconcileLog -PidFile $Paths.ReviewSendReconcilePid -TestMode:$TestMode -TestChildScript $TestChildScript
            Write-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson -State @{
                phase                  = 'running'
                orchestratorSessionId = $sessionId
                sessionSource        = $currentSource
                projectId            = $ProjectId
            }
        }
        else {
            if (Test-OrchestratorWakeSupervisorStopping -Paths $Paths) {
                break
            }
            $children = Get-OrchestratorWakeSupervisorChildStatus -Paths $Paths
            if (-not $children.ListenerAlive) {
                if (Test-OrchestratorWakeSupervisorSideEffectInFlight -Paths $Paths -Role 'listener') {
                    Write-OrchestratorWakeSupervisorLog -Message 'listener exited during side-effect; waiting for drain before restart' -LogPath $Paths.SupervisorLog
                    Wait-OrchestratorWakeSupervisorSideEffectDrain -Paths $Paths -Role 'listener' -LogPath $Paths.SupervisorLog | Out-Null
                }
                Write-OrchestratorWakeSupervisorLog -Message 'listener exited; restarting' -LogPath $Paths.SupervisorLog
                Start-OrchestratorWakeSupervisorChild -Role 'listener' -OrchestratorSessionId $sessionId -LogPath $Paths.ListenerLog -PidFile $Paths.ListenerPid -TestMode:$TestMode -TestChildScript $TestChildScript -ExtraChildArgs @('-SideEffectStateDir', $Paths.Root)
            }
            if (-not $children.HeartbeatAlive) {
                Write-OrchestratorWakeSupervisorLog -Message 'heartbeat exited; restarting' -LogPath $Paths.SupervisorLog
                Start-OrchestratorWakeSupervisorChild -Role 'heartbeat' -OrchestratorSessionId $sessionId -LogPath $Paths.HeartbeatLog -PidFile $Paths.HeartbeatPid -TestMode:$TestMode -TestChildScript $TestChildScript
            }
            if (-not $children.ReviewSendReconcileAlive) {
                Write-OrchestratorWakeSupervisorLog -Message 'review-send-reconcile exited; restarting' -LogPath $Paths.SupervisorLog
                Start-OrchestratorWakeSupervisorChild -Role 'review-send-reconcile' -OrchestratorSessionId $sessionId -ProjectId $ProjectId -LogPath $Paths.ReviewSendReconcileLog -PidFile $Paths.ReviewSendReconcilePid -TestMode:$TestMode -TestChildScript $TestChildScript
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
    $supervisorAlive = Test-OrchestratorWakeSupervisorDaemonRunning -ProcessId $supervisorPid -Role 'supervisor'
    $children = Get-OrchestratorWakeSupervisorChildStatus -Paths $Paths
    $state = Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson
    $sessionId = if ($state) { [string]$state.orchestratorSessionId } else { '' }

    return @{
        ProjectId                = $ProjectId
        SupervisorPid            = $supervisorPid
        SupervisorAlive          = $supervisorAlive
        ListenerPid              = $children.ListenerPid
        HeartbeatPid             = $children.HeartbeatPid
        ReviewSendReconcilePid   = $children.ReviewSendReconcilePid
        ListenerAlive            = $children.ListenerAlive
        HeartbeatAlive           = $children.HeartbeatAlive
        ReviewSendReconcileAlive = $children.ReviewSendReconcileAlive
        OrchestratorSessionId    = $sessionId
        StateRoot                = $Paths.Root
        ListenerLog              = $Paths.ListenerLog
        HeartbeatLog             = $Paths.HeartbeatLog
        ReviewSendReconcileLog   = $Paths.ReviewSendReconcileLog
    }
}

function Format-UnixShellSingleQuotedArgument {
    param([string]$Value)
    # POSIX single-quote wrap: close quote, escaped literal quote, reopen (writes as '\'').
    return "'" + ($Value -replace "'", "'\''") + "'"
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
                Format-UnixShellSingleQuotedArgument -Value $_
            }) -join ' '
        $launcherContent = @(
            '#!/usr/bin/env bash'
            'set -euo pipefail'
            "cd $(Format-UnixShellSingleQuotedArgument -Value $WorkingDirectory)"
            "nohup pwsh $quotedArgs >> $(Format-UnixShellSingleQuotedArgument -Value $LogPath) 2>&1 &"
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
    Write-Host ("review-send-reconcile: {0} (pid={1})" -f $(if ($Report.ReviewSendReconcileAlive) { 'running' } else { 'stopped' }), $Report.ReviewSendReconcilePid)
    if ($Report.OrchestratorSessionId) {
        Write-Host ("session:    {0}" -f $Report.OrchestratorSessionId)
    }
    Write-Host ("state:      {0}" -f $Report.StateRoot)
}
