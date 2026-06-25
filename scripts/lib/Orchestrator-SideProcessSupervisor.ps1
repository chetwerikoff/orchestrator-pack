#requires -Version 5.1
<#
  Registry-driven orchestrator side-process supervisor (Issue #205).
  Loaded by Orchestrator-WakeSupervisor.ps1 for backward-compatible entrypoint paths.
#>

. (Join-Path $PSScriptRoot 'Orchestrator-ProcessAlive.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessHealth.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessCrashBackoff.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessDegradedBackoff.ps1')
. (Join-Path $PSScriptRoot 'Get-ProcessCommandLine.ps1')

$Script:OrchestratorSideProcessPackRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
$Script:OrchestratorSideProcessRegistryPath = Join-Path $Script:OrchestratorSideProcessPackRoot 'scripts/orchestrator-side-process-registry.json'
$Script:OrchestratorSideProcessTestChildScript = Join-Path $Script:OrchestratorSideProcessPackRoot 'scripts/orchestrator-wake-supervisor-test-child.ps1'

function Get-OrchestratorSideProcessPackScriptsDir {
    return (Resolve-Path -LiteralPath (Join-Path $Script:OrchestratorSideProcessPackRoot 'scripts')).Path
}

function Merge-OrchestratorSideProcessPackScriptsPath {
    param([string]$PathValue = $env:PATH)

    $packScripts = Get-OrchestratorSideProcessPackScriptsDir
    $sep = [IO.Path]::PathSeparator
    $parts = @()
    if ($PathValue) {
        $parts = @($PathValue -split [regex]::Escape($sep) | Where-Object { $_ })
    }
    $filtered = @($parts | Where-Object { $_ -and $_ -ne $packScripts })
    if ($filtered.Count -eq 0) {
        return $packScripts
    }
    return (@($packScripts) + $filtered) -join $sep
}

function New-OrchestratorWakeSupervisorChildEnvironment {
    param(
        [hashtable]$Paths,
        [object]$Entry,
        [string]$ChildId,
        [string]$OrchestratorSessionId,
        [string]$ProjectId,
        [switch]$TestMode
    )

    $childEnv = @{
        AO_SIDE_PROCESS_STATE_DIR    = $Paths.Root
        AO_SIDE_PROCESS_PROGRESS_DIR = $Paths.ProgressDir
        PATH                         = (Merge-OrchestratorSideProcessPackScriptsPath)
    }
    if ($Entry.RequiresOrchestratorSession) {
        $childEnv['AO_ORCHESTRATOR_SESSION_ID'] = $OrchestratorSessionId
    }
    if ($ChildId -eq 'listener' -and $ProjectId) {
        $childEnv['AO_WAKE_LISTENER_PROJECT_ID'] = $ProjectId
    }
    if ($TestMode) {
        $markerRoot = Join-Path $Paths.Root 'markers'
        if (-not (Test-Path -LiteralPath $markerRoot)) {
            New-Item -ItemType Directory -Path $markerRoot -Force | Out-Null
        }
        $childEnv['AO_WAKE_SUPERVISOR_TEST_MARKER_DIR'] = $markerRoot
    }
    return $childEnv
}


function Get-OrchestratorSideProcessRegistryDocument {
    if (-not (Test-Path -LiteralPath $Script:OrchestratorSideProcessRegistryPath)) {
        throw "Missing side-process registry: $Script:OrchestratorSideProcessRegistryPath"
    }
    return Get-Content -LiteralPath $Script:OrchestratorSideProcessRegistryPath -Raw | ConvertFrom-Json
}

function ConvertTo-OrchestratorSideProcessChildEntry {
    param($Child)

    $scriptPath = Join-Path $Script:OrchestratorSideProcessPackRoot "scripts/$($Child.script)"
    $lockFile = if ($Child.sideEffectLockFile) { [string]$Child.sideEffectLockFile } else { '' }
    return @{
        Id                         = [string]$Child.id
        ScriptPath                 = $scriptPath
        ScriptMarker               = [string]$Child.script
        SideEffecting              = [bool]$Child.sideEffecting
        SideEffectLockFile         = $lockFile
        RequiresOrchestratorSession = [bool]$Child.requiresOrchestratorSession
        PassProjectId              = [bool]$Child.passProjectId
        CadenceSeconds             = [int]$Child.cadenceSeconds
        StallGraceMultiplier       = [int]$Child.stallGraceMultiplier
        ExtraArgs                  = @($Child.extraArgs)
    }
}

function Get-OrchestratorWakeSupervisorChildRegistry {
    $doc = Get-OrchestratorSideProcessRegistryDocument
    return @($doc.children | ForEach-Object { ConvertTo-OrchestratorSideProcessChildEntry -Child $_ })
}

function Test-OrchestratorSideProcessRegistry {
    param([ref]$OutErrors)

    $errors = [System.Collections.Generic.List[string]]::new()
    try {
        $doc = Get-OrchestratorSideProcessRegistryDocument
    }
    catch {
        $errors.Add("registry unreadable: $_")
        if ($OutErrors) { $OutErrors.Value = $errors.ToArray() }
        return $false
    }

    $required = @($doc.requiredChildIds)
    $children = @($doc.children)
    $seenIds = @{}

    foreach ($req in $required) {
        $match = $children | Where-Object { $_.id -eq $req } | Select-Object -First 1
        if (-not $match) {
            $errors.Add("missing required child: $req")
        }
    }

    foreach ($child in $children) {
        $id = [string]$child.id
        if (-not $id) {
            $errors.Add('child entry missing id')
            continue
        }
        if ($seenIds.ContainsKey($id)) {
            $errors.Add("duplicate child id: $id")
            continue
        }
        $seenIds[$id] = $true

        $scriptPath = Join-Path $Script:OrchestratorSideProcessPackRoot "scripts/$($child.script)"
        if (-not (Test-Path -LiteralPath $scriptPath)) {
            $errors.Add("child $id script not found: $scriptPath")
        }
        if ($child.sideEffecting -and -not $child.sideEffectLockFile) {
            $errors.Add("child $id is sideEffecting but has no sideEffectLockFile")
        }
        if (-not $child.sideEffecting -and $child.sideEffectLockFile) {
            $errors.Add("child $id has sideEffectLockFile but sideEffecting=false")
        }
        if ($child.cadenceSeconds -le 0) {
            $errors.Add("child $id cadenceSeconds must be positive")
        }
    }

    if ($OutErrors) {
        $OutErrors.Value = $errors.ToArray()
    }
    return ($errors.Count -eq 0)
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

function Get-OrchestratorWakeSupervisorIdDebouncePolls {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_ID_DEBOUNCE_POLLS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return 2
}

function Get-OrchestratorWakeSupervisorSessionGlitchPolls {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_SESSION_GLITCH_POLLS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return 2
}

function Get-OrchestratorWakeSupervisorRestartStaggerMs {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_RESTART_STAGGER_MS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(0, [int]$fromEnv)
    }
    return 500
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

    $paths = @{
        Root          = $StateRoot
        SupervisorPid = Join-Path $StateRoot 'supervisor.pid'
        StateJson     = Join-Path $StateRoot 'state.json'
        SupervisorLog = Join-Path $StateRoot 'supervisor.log'
        ProgressDir   = Join-Path $StateRoot 'progress'
        StoppingFlag  = Join-Path $StateRoot 'stopping'
    }

    foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
        $paths["$($child.Id)Pid"] = Join-Path $StateRoot "$($child.Id).pid"
        $paths["$($child.Id)Log"] = Join-Path $StateRoot "$($child.Id).log"
        if ($child.SideEffectLockFile) {
            $paths["$($child.Id)Lock"] = Join-Path $StateRoot $child.SideEffectLockFile
        }
    }

    return $paths
}

function Get-OrchestratorWakeSupervisorChildPidPath {
    param(
        [hashtable]$Paths,
        [string]$ChildId
    )
    return $Paths["${ChildId}Pid"]
}

function Save-OrchestratorWakeSupervisorPreviousChildLog {
    param(
        [string]$LogPath,
        [int]$Retain = 3
    )
    foreach ($path in @($LogPath, "${LogPath}.err")) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $item = Get-Item -LiteralPath $path
        if ($item.Length -le 0) { continue }
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
        $archive = "$path.previous-$stamp"
        Move-Item -LiteralPath $path -Destination $archive -Force
        $pattern = "$(Split-Path -Leaf $path).previous-*"
        $dir = Split-Path -Parent $path
        @(Get-ChildItem -LiteralPath $dir -Filter $pattern -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip $Retain) |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
}

function Get-OrchestratorWakeSupervisorChildLogPath {
    param(
        [hashtable]$Paths,
        [string]$ChildId
    )
    return $Paths["${ChildId}Log"]
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

function Read-OrchestratorWakeSupervisorPidFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
    $raw = Get-Content -LiteralPath $Path -Raw
    if ($null -eq $raw) { return 0 }
    $text = $raw.Trim()
    if ([string]::IsNullOrWhiteSpace($text)) { return 0 }
    $parsed = 0
    if ([int]::TryParse($text, [ref]$parsed)) { return $parsed }
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
        [hashtable]$State,
        [int]$JsonDepth = 10
    )
    $dir = Split-Path -Parent $StateJsonPath
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $State | ConvertTo-Json -Depth $JsonDepth -Compress | Set-Content -LiteralPath $StateJsonPath -Encoding utf8
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

function Set-OrchestratorWakeSupervisorStoppingFlag {
    param([hashtable]$Paths)
    $flag = $Paths.StoppingFlag
    $dir = Split-Path -Parent $flag
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Set-Content -LiteralPath $flag -Value ((Get-Date).ToString('o')) -Encoding ascii
}

function Test-OrchestratorWakeSupervisorStopping {
    param([hashtable]$Paths)
    return Test-Path -LiteralPath $Paths.StoppingFlag
}

function Clear-OrchestratorWakeSupervisorStoppingFlag {
    param([hashtable]$Paths)
    if (Test-Path -LiteralPath $Paths.StoppingFlag) {
        Remove-Item -LiteralPath $Paths.StoppingFlag -Force -ErrorAction SilentlyContinue
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

function Get-OrchestratorWakeSupervisorChildEntry {
    param([string]$ChildId)
    return Get-OrchestratorWakeSupervisorChildRegistry | Where-Object { $_.Id -eq $ChildId } | Select-Object -First 1
}

function Test-OrchestratorWakeSupervisorManagedProcess {
    param(
        [int]$ProcessId,
        [string]$Role
    )

    if ($ProcessId -le 0) { return $false }
    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return $false }

    $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $Role
  if ($Role -eq 'supervisor') {
        $marker = 'orchestrator-wake-supervisor.ps1'
    }
    elseif ($entry) {
        $marker = $entry.ScriptMarker
    }
    else {
        return $false
    }

    $commandLine = Get-OrchestratorWakeSupervisorProcessCommandLine -ProcessId $ProcessId
    if (-not $commandLine) { return $false }

    if ($commandLine -like '*orchestrator-wake-supervisor-test-child.ps1*') {
        return $commandLine -match "-Role\s+$([regex]::Escape($Role))"
    }

    return $commandLine -like "*$marker*"
}

function Test-OrchestratorWakeSupervisorDaemonRunning {
    param(
        [int]$ProcessId,
        [string]$Role
    )

    return (Test-ProcessAlive -ProcessId $ProcessId) -and
    (Test-OrchestratorWakeSupervisorManagedProcess -ProcessId $ProcessId -Role $Role)
}

function Clear-OrchestratorWakeSupervisorStalePidIfNeeded {
    param(
        [int]$ProcessId,
        [string]$PidFile,
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

function Test-OrchestratorWakeSupervisorSideEffectInFlight {
    param(
        [hashtable]$Paths,
        [string]$ChildId
    )

    $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $ChildId
    if (-not $entry -or -not $entry.SideEffecting -or -not $entry.SideEffectLockFile) {
        return $false
    }
    $lockPath = $Paths["${ChildId}Lock"]
    if (-not $lockPath) {
        $lockPath = Join-Path $Paths.Root $entry.SideEffectLockFile
    }
    return Test-OrchestratorSideEffectInFlight -LockPath $lockPath
}

function Wait-OrchestratorWakeSupervisorSideEffectDrain {
    param(
        [hashtable]$Paths,
        [string]$ChildId,
        [int]$TimeoutSeconds = 30,
        [string]$LogPath = ''
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-OrchestratorWakeSupervisorSideEffectInFlight -Paths $Paths -ChildId $ChildId)) {
            return $true
        }
        Write-OrchestratorWakeSupervisorLog -Message "draining $ChildId side-effect (waiting for lock release)" -LogPath $LogPath
        Start-Sleep -Milliseconds 200
    }
    return -not (Test-OrchestratorWakeSupervisorSideEffectInFlight -Paths $Paths -ChildId $ChildId)
}

function Stop-OrchestratorWakeSupervisorProcess {
    param(
        [int]$ProcessId,
        [string]$PidFile = '',
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

function Expand-OrchestratorWakeSupervisorChildExtraArgs {
    param(
        [string[]]$ExtraArgs,
        [hashtable]$Paths
    )

    $expanded = @()
    foreach ($arg in @($ExtraArgs)) {
        if ($arg -eq '{stateRoot}') {
            $expanded += $Paths.Root
        }
        else {
            $expanded += $arg
        }
    }
    return $expanded
}

function Start-OrchestratorWakeSupervisorChild {
    param(
        [string]$ChildId,
        [string]$OrchestratorSessionId,
        [hashtable]$Paths,
        [string]$ProjectId = '',
        [switch]$TestMode,
        [string]$TestChildScript = '',
        [string[]]$ExtraChildArgs = @()
    )

    $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $ChildId
    if (-not $entry) {
        throw "Unknown child id: $ChildId"
    }

    $scriptPath = if ($TestMode) {
        if ($TestChildScript) { $TestChildScript } else { $Script:OrchestratorSideProcessTestChildScript }
    }
    else {
        $entry.ScriptPath
    }

    if (-not (Test-Path -LiteralPath $scriptPath)) {
        throw "Missing child script: $scriptPath"
    }

    $logPath = Get-OrchestratorWakeSupervisorChildLogPath -Paths $Paths -ChildId $ChildId
    $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $ChildId
    $logDir = Split-Path -Parent $logPath
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    Save-OrchestratorWakeSupervisorPreviousChildLog -LogPath $logPath

    $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath)
    if ($TestMode) {
        $childArgs += @('-Role', $ChildId)
        if ($entry.RequiresOrchestratorSession) {
            $childArgs += @('-OrchestratorSessionId', $OrchestratorSessionId)
        }
        $modeEnvKey = "AO_WAKE_SUPERVISOR_TEST_MODE_$($ChildId -replace '-', '_')"
        $modeFromEnv = [Environment]::GetEnvironmentVariable($modeEnvKey, 'Process')
        if ($modeFromEnv) {
            $childArgs += @('-Mode', $modeFromEnv)
        }
    }
    elseif ($entry.RequiresOrchestratorSession) {
        $childArgs += @('-OrchestratorSessionId', $OrchestratorSessionId)
    }
    if ($entry.PassProjectId -and $ProjectId) {
        $childArgs += @('-ProjectId', $ProjectId)
    }
    if ($ExtraChildArgs -and -not $TestMode) {
        $childArgs += $ExtraChildArgs
    }
    if (-not $TestMode -and $entry.ExtraArgs) {
        $childArgs += Expand-OrchestratorWakeSupervisorChildExtraArgs -ExtraArgs $entry.ExtraArgs -Paths $Paths
    }

    $childEnv = New-OrchestratorWakeSupervisorChildEnvironment -Paths $Paths -Entry $entry `
        -ChildId $ChildId -OrchestratorSessionId $OrchestratorSessionId -ProjectId $ProjectId -TestMode:$TestMode

    $psi = @{
        FilePath         = 'pwsh'
        ArgumentList     = $childArgs
        WorkingDirectory = $Script:OrchestratorSideProcessPackRoot
        PassThru         = $true
    }
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        $psi['WindowStyle'] = 'Hidden'
    }
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        $psi['RedirectStandardOutput'] = $logPath
        $psi['RedirectStandardError'] = "${logPath}.err"
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
    Write-OrchestratorWakeSupervisorPidFile -Path $pidFile -ProcessId $proc.Id
    return $proc.Id
}

function Stop-OrchestratorWakeSupervisorChildById {
    param(
        [hashtable]$Paths,
        [string]$ChildId,
        [string]$LogPath = ''
    )

    $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $ChildId
    if ($entry -and $entry.SideEffecting) {
        $drained = Wait-OrchestratorWakeSupervisorSideEffectDrain -Paths $Paths -ChildId $ChildId -LogPath $LogPath
        if (-not $drained) {
            Write-OrchestratorWakeSupervisorLog -Message "stop: $ChildId side-effect still in flight after drain window" -LogPath $LogPath
        }
    }
    $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $ChildId
    $pidVal = Read-OrchestratorWakeSupervisorPidFile -Path $pidFile
    Stop-OrchestratorWakeSupervisorProcess -ProcessId $pidVal -PidFile $pidFile -ManagedRole $ChildId -LogPath $LogPath
}

function Stop-OrchestratorWakeSupervisorChildren {
    param(
        $Paths,
        [string]$LogPath = '',
        [string[]]$ChildIds = @()
    )

    $targets = if ($ChildIds -and $ChildIds.Count -gt 0) {
        $ChildIds
    }
    else {
        @(Get-OrchestratorWakeSupervisorChildRegistry | ForEach-Object { $_.Id })
    }

    foreach ($childId in $targets) {
        Stop-OrchestratorWakeSupervisorChildById -Paths $Paths -ChildId $childId -LogPath $LogPath
    }
}

function Get-OrchestratorWakeSupervisorChildRecoveryState {
    param(
        [hashtable]$Paths,
        [string]$ChildId
    )

    $state = Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson
    if (-not $state -or -not $state.childRecovery) {
        $emptyDegraded = Get-OrchestratorWakeSupervisorChildDegradedBackoffFields -RecoveryEntry $null
        return @{
            attempts       = 0
            terminal       = $false
            reason         = ''
            rapidExits     = 0
            backoffUntilMs = 0
            lastExitMs     = 0
        } + $emptyDegraded
    }
    $entry = $state.childRecovery.$ChildId
    if (-not $entry) {
        $emptyDegraded = Get-OrchestratorWakeSupervisorChildDegradedBackoffFields -RecoveryEntry $null
        return @{
            attempts       = 0
            terminal       = $false
            reason         = ''
            rapidExits     = 0
            backoffUntilMs = 0
            lastExitMs     = 0
        } + $emptyDegraded
    }
    $crashFields = Get-OrchestratorWakeSupervisorChildCrashBackoffFields -RecoveryEntry $entry
    $degradedFields = Get-OrchestratorWakeSupervisorChildDegradedBackoffFields -RecoveryEntry $entry
    return @{
        attempts       = if ($entry.attempts) { [int]$entry.attempts } else { 0 }
        terminal       = [bool]$entry.terminal
        reason         = if ($entry.reason) { [string]$entry.reason } else { '' }
        rapidExits     = $crashFields.rapidExits
        backoffUntilMs = $crashFields.backoffUntilMs
        lastExitMs     = $crashFields.lastExitMs
    } + $degradedFields
}

function Set-OrchestratorWakeSupervisorChildRecoveryState {
    param(
        [hashtable]$Paths,
        [string]$ChildId,
        [hashtable]$RecoveryEntry,
        [string]$SupervisorPhase = 'running',
        [string]$SessionId = '',
        [string]$SessionSource = '',
        [string]$ProjectId = ''
    )

    $existing = Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson
    $childRecovery = @{}
    if ($existing -and $existing.childRecovery) {
        foreach ($prop in $existing.childRecovery.PSObject.Properties) {
            $childRecovery[$prop.Name] = $prop.Value
        }
    }
    $childRecovery[$ChildId] = $RecoveryEntry
    Write-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson -State @{
        phase                 = if ($existing -and $existing.phase) { [string]$existing.phase } else { $SupervisorPhase }
        orchestratorSessionId = if ($SessionId) { $SessionId } elseif ($existing) { [string]$existing.orchestratorSessionId } else { '' }
        sessionSource         = if ($SessionSource) { $SessionSource } elseif ($existing) { [string]$existing.sessionSource } else { '' }
        projectId             = if ($ProjectId) { $ProjectId } elseif ($existing) { [string]$existing.projectId } else { '' }
        childRecovery         = $childRecovery
    }
}

function Reset-OrchestratorWakeSupervisorChildCrashRecoveryState {
    param(
        [hashtable]$Paths,
        [string]$ChildId
    )

    $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId
    if ($recovery.rapidExits -eq 0 -and $recovery.backoffUntilMs -eq 0 -and $recovery.lastExitMs -eq 0) {
        return
    }
    Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates @{
            rapidExits     = 0
            backoffUntilMs = 0
            lastExitMs     = 0
        })
}

function Reset-OrchestratorWakeSupervisorChildRecoveryState {
    param(
        [hashtable]$Paths,
        [string]$ChildId
    )

    $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId
    $degradedFields = Get-OrchestratorWakeSupervisorChildDegradedBackoffFields -RecoveryEntry $recovery
    if ($recovery.attempts -eq 0 -and -not $recovery.terminal -and $recovery.rapidExits -eq 0 -and $recovery.backoffUntilMs -eq 0 `
            -and $degradedFields.degradedAttempts -eq 0 -and $degradedFields.degradedBackoffUntilMs -eq 0 `
            -and -not $degradedFields.lastDegradedReason -and $degradedFields.repeatedReasonCount -eq 0 `
            -and $degradedFields.stableWorkingPolls -eq 0 -and $degradedFields.deterministicReasonStreak -eq 0 `
            -and -not $degradedFields.failureClass) {
        return
    }
    Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry @{
        attempts                    = 0
        terminal                    = $false
        reason                      = ''
        rapidExits                  = 0
        backoffUntilMs              = 0
        lastExitMs                  = 0
        degradedAttempts            = 0
        degradedBackoffUntilMs      = 0
        lastDegradedReason          = ''
        repeatedReasonCount         = 0
        repeatedReasonWindowStartMs = 0
        stableWorkingPolls          = 0
        deterministicReasonStreak   = 0
        failureClass                = ''
    }
}

function Get-OrchestratorWakeSupervisorChildStatusEntry {
    param(
        [hashtable]$Paths,
        [string]$ChildId,
        [string]$SupervisorPhase = 'running'
    )

    $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $ChildId
    $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $ChildId
    $pidVal = Read-OrchestratorWakeSupervisorPidFile -Path $pidFile
    $alive = Test-OrchestratorWakeSupervisorDaemonRunning -ProcessId $pidVal -Role $ChildId
    $progress = Read-OrchestratorWakeSupervisorChildProgress -Paths $Paths -ChildId $ChildId
    $stallThreshold = if ($entry) {
        Get-OrchestratorWakeSupervisorChildStallThresholdMs -ChildEntry $entry
    }
    else {
        0
    }
    $childStartedMs = 0
    if (Test-Path -LiteralPath $pidFile) {
        $childStartedMs = [long]([System.IO.File]::GetCreationTimeUtc($pidFile)).Subtract([datetime]'1970-01-01').TotalMilliseconds
    }
    $health = Get-OrchestratorSideProcessHealthVerdict -ChildEntry $entry -Paths $Paths `
        -SupervisorPhase $SupervisorPhase -ChildAlive $alive -Progress $progress -ChildPid $pidVal `
        -StallThresholdMs $stallThreshold -ChildStartedMs $childStartedMs
    if ($health.Status -eq 'stalled' -and (Test-OrchestratorWakeSupervisorSideEffectInFlight -Paths $Paths -ChildId $ChildId)) {
        $health.Status = 'working'
        $health.Reason = ''
    }
    $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId
    if ($recovery.terminal -and $health.Status -in @('degraded', 'stalled')) {
        $health.Status = 'degraded'
        if ($recovery.reason) {
            $health.Reason = $recovery.reason
        }
    }

    return @{
        Id        = $ChildId
        Pid       = $pidVal
        Alive     = $alive
        Health    = $health.Status
        Reason    = $health.Reason
        LastError = $health.LastError
        Terminal  = [bool]$recovery.terminal
    }
}

function Get-OrchestratorWakeSupervisorChildStatus {
    param(
        $Paths,
        [string]$SupervisorPhase = 'running'
    )

    $entries = @()
    foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
        $entries += Get-OrchestratorWakeSupervisorChildStatusEntry -Paths $Paths -ChildId $child.Id `
            -SupervisorPhase $SupervisorPhase
    }
    return $entries
}

function Get-OrchestratorWakeSupervisorChildStallThresholdMs {
    param($ChildEntry)
    $childId = [string]$ChildEntry.Id
    if ($childId) {
        $perChildKey = "AO_WAKE_SUPERVISOR_TEST_STALL_SECONDS_$($childId -replace '-', '_')"
        $perChildSec = [Environment]::GetEnvironmentVariable($perChildKey, 'Process')
        if ($perChildSec -and [int]::TryParse($perChildSec, [ref]$null)) {
            return [Math]::Max(1, [int]$perChildSec) * 1000
        }
    }
    $testSec = $env:AO_WAKE_SUPERVISOR_TEST_STALL_SECONDS
    if ($testSec -and [int]::TryParse($testSec, [ref]$null)) {
        return [Math]::Max(1, [int]$testSec) * 1000
    }
    $cadence = [Math]::Max(1, $ChildEntry.CadenceSeconds)
    $mult = [Math]::Max(2, $ChildEntry.StallGraceMultiplier)
    return $cadence * $mult * 1000
}

function Read-OrchestratorWakeSupervisorChildProgress {
    param(
        [hashtable]$Paths,
        [string]$ChildId
    )

    if (-not $Paths.ProgressDir) { return $null }
    $path = Join-Path $Paths.ProgressDir "$ChildId.progress.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Test-OrchestratorWakeSupervisorChildStalled {
    param(
        [hashtable]$Paths,
        $ChildEntry
    )

    if (-not $ChildEntry) {
        return $false
    }

    $status = Get-OrchestratorWakeSupervisorChildStatusEntry -Paths $Paths -ChildId $ChildEntry.Id
    if (-not $status.Alive) {
        return $false
    }
    if (Test-OrchestratorWakeSupervisorSideEffectInFlight -Paths $Paths -ChildId $ChildEntry.Id) {
        return $false
    }

    $progress = Read-OrchestratorWakeSupervisorChildProgress -Paths $Paths -ChildId $ChildEntry.Id
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $threshold = Get-OrchestratorWakeSupervisorChildStallThresholdMs -ChildEntry $ChildEntry

    if (-not $progress -or -not $progress.lastProgressMs) {
        $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $ChildEntry.Id
        if (Test-Path -LiteralPath $pidFile) {
            $startedMs = ([System.IO.File]::GetCreationTimeUtc($pidFile)).Subtract([datetime]'1970-01-01').TotalMilliseconds
            if (($nowMs - $startedMs) -lt $threshold) {
                return $false
            }
        }
        return $true
    }

    $lastMs = [long]$progress.lastProgressMs
    return (($nowMs - $lastMs) -ge $threshold)
}

function Find-OrchestratorWakeSupervisorAdoptableProcesses {
    param([hashtable]$Paths)

    $found = @{}
    foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
        $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $child.Id
        $recorded = Read-OrchestratorWakeSupervisorPidFile -Path $pidFile
        if ($recorded -gt 0 -and (Test-OrchestratorWakeSupervisorDaemonRunning -ProcessId $recorded -Role $child.Id)) {
            $found[$child.Id] = $recorded
            continue
        }

        $candidates = Get-Process -Name 'pwsh' -ErrorAction SilentlyContinue |
            Where-Object { Test-OrchestratorWakeSupervisorManagedProcess -ProcessId $_.Id -Role $child.Id }
        if ($candidates) {
            $found[$child.Id] = @($candidates | Select-Object -First 1).Id
        }
    }
    return $found
}

function Invoke-OrchestratorWakeSupervisorAdoptOrTerminate {
    param(
        [hashtable]$Paths,
        [string]$LogPath = '',
        [switch]$TestMode
    )

    if ($TestMode) {
        return
    }

    $adoptable = Find-OrchestratorWakeSupervisorAdoptableProcesses -Paths $Paths
    foreach ($pair in $adoptable.GetEnumerator()) {
        $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $pair.Key
        $existing = Read-OrchestratorWakeSupervisorPidFile -Path $pidFile
        if ($existing -eq $pair.Value) {
            continue
        }
        if ($existing -gt 0 -and (Test-ProcessAlive -ProcessId $existing) -and $existing -ne $pair.Value) {
            Write-OrchestratorWakeSupervisorLog -Message "adoption: terminating duplicate $($pair.Key) pid=$existing" -LogPath $LogPath
            Stop-OrchestratorWakeSupervisorProcess -ProcessId $existing -PidFile $pidFile -ManagedRole $pair.Key -LogPath $LogPath
        }
        Write-OrchestratorWakeSupervisorLog -Message "adoption: $($pair.Key) pid=$($pair.Value)" -LogPath $LogPath
        Write-OrchestratorWakeSupervisorPidFile -Path $pidFile -ProcessId $pair.Value
    }
}

function Start-OrchestratorWakeSupervisorManagedSet {
    param(
        [hashtable]$Paths,
        [string]$SessionId,
        [string]$ProjectId,
        [switch]$TestMode,
        [string]$TestChildScript = '',
        [string]$LogPath = ''
    )

    $started = @()
    $failures = @()
    foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
        $status = Get-OrchestratorWakeSupervisorChildStatusEntry -Paths $Paths -ChildId $child.Id
        if ($status.Alive) {
            Write-OrchestratorWakeSupervisorLog -Message "reusing adopted $($child.Id) pid=$($status.Pid)" -LogPath $LogPath
            continue
        }

        try {
            Start-OrchestratorWakeSupervisorChild -ChildId $child.Id -OrchestratorSessionId $SessionId `
                -Paths $Paths -ProjectId $ProjectId -TestMode:$TestMode -TestChildScript $TestChildScript
            $started += $child.Id
        }
        catch {
            $failures += "$($child.Id): $_"
            Write-OrchestratorWakeSupervisorLog -Message "failed to start $($child.Id): $_" -LogPath $LogPath
            break
        }
    }

    if ($failures.Count -gt 0) {
        Write-OrchestratorWakeSupervisorLog -Message 'partial start; rolling back newly started children' -LogPath $LogPath
        Stop-OrchestratorWakeSupervisorChildren -Paths $Paths -LogPath $LogPath -ChildIds $started
        throw "Supervisor partial start failed: $($failures -join '; ')"
    }
}

function Restart-OrchestratorWakeSupervisorChildStaggered {
    param(
        [hashtable]$Paths,
        [string]$SessionId,
        [string]$ProjectId,
        [string[]]$ChildIds,
        [switch]$TestMode,
        [string]$TestChildScript = '',
        [string]$LogPath = ''
    )

    $staggerMs = Get-OrchestratorWakeSupervisorRestartStaggerMs
    $index = 0
    foreach ($childId in $ChildIds) {
        if ($index -gt 0 -and $staggerMs -gt 0) {
            $jitter = Get-Random -Minimum 0 -Maximum ([Math]::Max(1, [int]($staggerMs / 2)))
            Start-Sleep -Milliseconds ($staggerMs + $jitter)
        }
        Stop-OrchestratorWakeSupervisorChildById -Paths $Paths -ChildId $childId -LogPath $LogPath
        Start-OrchestratorWakeSupervisorChild -ChildId $childId -OrchestratorSessionId $SessionId `
            -Paths $Paths -ProjectId $ProjectId -TestMode:$TestMode -TestChildScript $TestChildScript
        $index++
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

    if (-not (Test-Path -LiteralPath $Paths.ProgressDir)) {
        New-Item -ItemType Directory -Path $Paths.ProgressDir -Force | Out-Null
    }

    Invoke-OrchestratorWakeSupervisorAdoptOrTerminate -Paths $Paths -LogPath $Paths.SupervisorLog -TestMode:$TestMode

    $loopStart = Get-Date
    $phase = 'waiting'
    $currentSessionId = ''
    $currentSource = ''
    $pendingSessionId = ''
    $pendingSessionPolls = 0
    $sessionMissingPolls = 0
    $idDebouncePolls = Get-OrchestratorWakeSupervisorIdDebouncePolls
    $sessionGlitchPolls = Get-OrchestratorWakeSupervisorSessionGlitchPolls
    $registry = Get-OrchestratorWakeSupervisorChildRegistry

    while ($true) {
        if (Test-OrchestratorWakeSupervisorStopping -Paths $Paths) {
            Write-OrchestratorWakeSupervisorLog -Message 'stop requested; exiting supervisor loop' -LogPath $Paths.SupervisorLog
            break
        }

        if ($MaxLoopSeconds -gt 0 -and (((Get-Date) - $loopStart).TotalSeconds -ge $MaxLoopSeconds)) {
            break
        }

        $resolved = Resolve-OrchestratorWakeSupervisorSessionId -Override $SessionOverride -ProjectId $ProjectId `
            -FixturePath $FixturePath -AoCommand $AoCommand

        if (-not $resolved) {
            $sessionMissingPolls++
            if ($phase -eq 'running' -and $sessionMissingPolls -ge $sessionGlitchPolls) {
                Write-OrchestratorWakeSupervisorLog -Message 'orchestrator session disappeared; stopping children' -LogPath $Paths.SupervisorLog
                Stop-OrchestratorWakeSupervisorChildren -Paths $Paths -LogPath $Paths.SupervisorLog
                $phase = 'waiting'
                $currentSessionId = ''
                $pendingSessionId = ''
                $pendingSessionPolls = 0
                Write-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson -State @{
                    phase                 = 'waiting'
                    orchestratorSessionId = ''
                    sessionSource         = ''
                    projectId             = $ProjectId
                    childRecovery         = @{}
                }
            }
            Start-Sleep -Seconds $PollSeconds
            continue
        }

        $sessionMissingPolls = 0
        $sessionId = $resolved.Id

        if ($phase -eq 'waiting') {
            Write-OrchestratorWakeSupervisorLog -Message "orchestrator session available: $sessionId (source=$($resolved.Source))" -LogPath $Paths.SupervisorLog
            $phase = 'running'
            $currentSessionId = $sessionId
            $currentSource = $resolved.Source
            Start-OrchestratorWakeSupervisorManagedSet -Paths $Paths -SessionId $sessionId -ProjectId $ProjectId `
                -TestMode:$TestMode -TestChildScript $TestChildScript -LogPath $Paths.SupervisorLog
            Write-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson -State @{
                phase                   = 'running'
                orchestratorSessionId   = $sessionId
                sessionSource           = $currentSource
                projectId               = $ProjectId
                childRecovery           = @{}
            }
        }
        elseif ($sessionId -ne $currentSessionId) {
            if ($pendingSessionId -ne $sessionId) {
                $pendingSessionId = $sessionId
                $pendingSessionPolls = 1
            }
            else {
                $pendingSessionPolls++
            }

            if ($pendingSessionPolls -lt $idDebouncePolls) {
                Start-Sleep -Seconds $PollSeconds
                continue
            }

            Write-OrchestratorWakeSupervisorLog -Message "orchestrator session id changed ($currentSessionId -> $sessionId); staggered restart" -LogPath $Paths.SupervisorLog
            $currentSessionId = $sessionId
            $currentSource = $resolved.Source
            $pendingSessionId = ''
            $pendingSessionPolls = 0
            $childIds = @($registry | ForEach-Object { $_.Id })
            Restart-OrchestratorWakeSupervisorChildStaggered -Paths $Paths -SessionId $sessionId -ProjectId $ProjectId `
                -ChildIds $childIds -TestMode:$TestMode -TestChildScript $TestChildScript -LogPath $Paths.SupervisorLog
            Write-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson -State @{
                phase                   = 'running'
                orchestratorSessionId   = $sessionId
                sessionSource           = $currentSource
                projectId               = $ProjectId
                childRecovery           = @{}
            }
        }
        else {
            $pendingSessionId = ''
            $pendingSessionPolls = 0
            if (Test-OrchestratorWakeSupervisorStopping -Paths $Paths) {
                break
            }

            foreach ($child in $registry) {
                if (-not $child -or -not $child.Id) {
                    continue
                }
                try {
                    Invoke-OrchestratorWakeSupervisorTestFaultInjection -ChildId $child.Id
                    $status = Get-OrchestratorWakeSupervisorChildStatusEntry -Paths $Paths -ChildId $child.Id `
                        -SupervisorPhase $phase
                    if ($status.Health -eq 'waiting') {
                        continue
                    }

                    if ($status.Health -eq 'working' -and $status.Alive) {
                        Update-OrchestratorWakeSupervisorChildStableWorkingRecovery -Paths $Paths -ChildId $child.Id
                        if (-not (Test-OrchestratorWakeSupervisorChildStalled -Paths $Paths -ChildEntry $child)) {
                            continue
                        }
                    }

                    if (-not $status.Alive) {
                        if ($child.SideEffecting) {
                            Wait-OrchestratorWakeSupervisorSideEffectDrain -Paths $Paths -ChildId $child.Id -LogPath $Paths.SupervisorLog | Out-Null
                        }
                        $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $child.Id
                        $childStartedMs = 0
                        if (Test-Path -LiteralPath $pidFile) {
                            $childStartedMs = [long]([System.IO.File]::GetCreationTimeUtc($pidFile)).Subtract([datetime]'1970-01-01').TotalMilliseconds
                        }
                        $restartDecision = Test-OrchestratorWakeSupervisorChildCrashRestartAllowed `
                            -Paths $Paths -ChildId $child.Id -ChildStartedMs $childStartedMs `
                            -LogWriter {
                                param([string]$Message)
                                Write-OrchestratorWakeSupervisorLog -Message $Message -LogPath $Paths.SupervisorLog
                            }
                        if (-not $restartDecision.allowed) {
                            continue
                        }
                        Write-OrchestratorWakeSupervisorLog -Message "$($child.Id) exited; restarting" -LogPath $Paths.SupervisorLog
                        Start-OrchestratorWakeSupervisorChild -ChildId $child.Id -OrchestratorSessionId $currentSessionId `
                            -Paths $Paths -ProjectId $ProjectId -TestMode:$TestMode -TestChildScript $TestChildScript
                        continue
                    }

                    $needsRecovery = $status.Health -in @('degraded', 'stalled') -or
                        (Test-OrchestratorWakeSupervisorChildStalled -Paths $Paths -ChildEntry $child)
                    if ($needsRecovery -and (Test-OrchestratorWakeSupervisorSideEffectInFlight -Paths $Paths -ChildId $child.Id)) {
                        continue
                    }
                    if (-not $needsRecovery) {
                        continue
                    }

                    $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $child.Id
                    $reason = if ($status.Reason) { $status.Reason } else { $status.Health }
                    Write-OrchestratorWakeSupervisorLog -Message "$($child.Id) non-working ($($status.Health)): $reason" -LogPath $Paths.SupervisorLog

                    if ($recovery.terminal) {
                        continue
                    }

                    $failureClass = Get-OrchestratorWakeSupervisorChildFailureClassFromProgress -Paths $Paths -ChildId $child.Id
                    $degradedDecision = Test-OrchestratorWakeSupervisorChildDegradedRestartAllowed `
                        -Paths $Paths -ChildId $child.Id -DegradedReason $reason -FailureClass $failureClass `
                        -LogWriter {
                            param([string]$Message)
                            Write-OrchestratorWakeSupervisorLog -Message $Message -LogPath $Paths.SupervisorLog
                        }
                    if (-not $degradedDecision.allowed) {
                        continue
                    }

                    $maxAttempts = Get-OrchestratorSideProcessHealthRecoveryMaxAttempts
                    $attemptLabel = if ($degradedDecision.degradedAttempts) { $degradedDecision.degradedAttempts } else { 1 }
                    Write-OrchestratorWakeSupervisorLog -Message "$($child.Id) recovering (attempt $attemptLabel/$maxAttempts)" -LogPath $Paths.SupervisorLog
                    Invoke-OrchestratorWakeSupervisorTestFaultInjection -ChildId $child.Id -Phase 'recovery-stop'
                    Stop-OrchestratorWakeSupervisorChildById -Paths $Paths -ChildId $child.Id -LogPath $Paths.SupervisorLog
                    Start-OrchestratorWakeSupervisorChild -ChildId $child.Id -OrchestratorSessionId $currentSessionId `
                        -Paths $Paths -ProjectId $ProjectId -TestMode:$TestMode -TestChildScript $TestChildScript
                }
                catch {
                    Write-OrchestratorWakeSupervisorLog -Message "fault boundary: $($child.Id): $_" -LogPath $Paths.SupervisorLog
                }
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
    $state = Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson
    $sessionId = if ($state) { [string]$state.orchestratorSessionId } else { '' }
    $supervisorPhase = if ($state -and $state.phase) { [string]$state.phase } else { 'running' }
    $children = Get-OrchestratorWakeSupervisorChildStatus -Paths $Paths -SupervisorPhase $supervisorPhase

    $report = @{
        ProjectId             = $ProjectId
        SupervisorPid         = $supervisorPid
        SupervisorAlive       = $supervisorAlive
        OrchestratorSessionId = $sessionId
        SupervisorPhase       = $supervisorPhase
        StateRoot             = $Paths.Root
        Children              = $children
    }

    foreach ($child in $children) {
        $report["$($child.Id)Pid"] = $child.Pid
        $report["$($child.Id)Alive"] = $child.Alive
        $report["$($child.Id)Log"] = Get-OrchestratorWakeSupervisorChildLogPath -Paths $Paths -ChildId $child.Id
    }

    # Backward-compatible keys for existing tests/docs
    $listener = $children | Where-Object { $_.Id -eq 'listener' } | Select-Object -First 1
    $heartbeat = $children | Where-Object { $_.Id -eq 'heartbeat' } | Select-Object -First 1
    $reviewSend = $children | Where-Object { $_.Id -eq 'review-send-reconcile' } | Select-Object -First 1
    if ($listener) {
        $report.ListenerPid = $listener.Pid
        $report.ListenerAlive = $listener.Alive
        $report.ListenerLog = Get-OrchestratorWakeSupervisorChildLogPath -Paths $Paths -ChildId 'listener'
    }
    if ($heartbeat) {
        $report.HeartbeatPid = $heartbeat.Pid
        $report.HeartbeatAlive = $heartbeat.Alive
        $report.HeartbeatLog = Get-OrchestratorWakeSupervisorChildLogPath -Paths $Paths -ChildId 'heartbeat'
    }
    if ($reviewSend) {
        $report.ReviewSendReconcilePid = $reviewSend.Pid
        $report.ReviewSendReconcileAlive = $reviewSend.Alive
        $report.ReviewSendReconcileLog = Get-OrchestratorWakeSupervisorChildLogPath -Paths $Paths -ChildId 'review-send-reconcile'
    }

    return $report
}

function Test-OrchestratorWakeSupervisorAllChildrenAlive {
    param($Report)
    if (-not $Report.SupervisorAlive) { return $false }
    foreach ($child in @($Report.Children)) {
        if (-not $child.Alive) { return $false }
    }
    return $true
}

function Test-OrchestratorWakeSupervisorAllChildrenHealthy {
    param($Report)

    if (-not $Report.SupervisorAlive) { return $false }
    foreach ($child in @($Report.Children)) {
        $health = if ($child.Health) { [string]$child.Health } else { 'stopped' }
        if ($health -in @('degraded', 'stalled', 'stopped')) {
            return $false
        }
    }
    return $true
}

function Format-UnixShellSingleQuotedArgument {
    param([string]$Value)
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
        $packScriptsQuoted = Format-UnixShellSingleQuotedArgument -Value (Get-OrchestratorSideProcessPackScriptsDir)
        $launcherContent = @(
            '#!/usr/bin/env bash'
            'set -euo pipefail'
            "cd $(Format-UnixShellSingleQuotedArgument -Value $WorkingDirectory)"
            ('export PATH={0}:${{PATH:-}}' -f $packScriptsQuoted)
            "nohup pwsh $quotedArgs >> $(Format-UnixShellSingleQuotedArgument -Value $LogPath) 2>&1 &"
            'echo $!'
        ) -join "`n"
        Set-Content -LiteralPath $launcher -Value $launcherContent -Encoding utf8 -NoNewline
        & chmod +x $launcher
        $pidLine = & bash $launcher
        if ($LASTEXITCODE -ne 0) {
            throw 'Failed to start detached wake supervisor via launch-supervisor.sh'
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
    foreach ($child in @($Report.Children)) {
        $health = if ($child.Health) {
            Format-OrchestratorSideProcessHealthLabel -Verdict @{
                Status = $child.Health
                Reason = $child.Reason
            }
        }
        elseif ($child.Alive) {
            'running'
        }
        else {
            'stopped'
        }
        $legacyLabel = switch ($child.Id) {
            'listener' { 'listener:  ' }
            'heartbeat' { 'heartbeat: ' }
            'review-send-reconcile' { 'review-send-reconcile:' }
            default { "$($child.Id):" }
        }
        if ($legacyLabel -match 'listener|heartbeat|review-send-reconcile') {
            Write-Host ("{0} {1} (pid={2})" -f $legacyLabel, $health, $child.Pid)
        }
        else {
            $label = $child.Id.PadRight(32)
            Write-Host ("{0} {1} (pid={2})" -f $label, $health, $child.Pid)
        }
    }
    if ($Report.OrchestratorSessionId) {
        Write-Host ("session:    {0}" -f $Report.OrchestratorSessionId)
    }
    Write-Host ("state:      {0}" -f $Report.StateRoot)
}
