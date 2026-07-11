#requires -Version 5.1
<#
  Registry-driven orchestrator side-process supervisor (Issue #205).
  Loaded by Orchestrator-WakeSupervisor.ps1 for backward-compatible entrypoint paths.
#>

. (Join-Path $PSScriptRoot 'Orchestrator-ProcessAlive.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessHealth.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessProgressEvidence.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessCrashBackoff.ps1')
. (Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessDegradedBackoff.ps1')
. (Join-Path $PSScriptRoot 'Get-ProcessCommandLine.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-WakeSupervisorLease.ps1')
. (Join-Path $PSScriptRoot 'TestMode-FleetLease.ps1')

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
        AO_SIDE_PROCESS_CHILD_ID     = $ChildId
        GH_FLEET_CACHE_AUDIT         = '1'
        GH_WRAPPER_AUDIT             = '1'
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
        Root           = $StateRoot
        SupervisorPid  = Join-Path $StateRoot 'supervisor.pid'
        SupervisorLock = Join-Path $StateRoot 'supervisor.lock'
        StateJson      = Join-Path $StateRoot 'state.json'
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
    try { [Console]::Out.Flush() } catch { }
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

function Get-OrchestratorWakeSupervisorOrchestratorListFixture {
    param([string]$FixturePath = '')

    if (-not $FixturePath) { return $null }
    $resolved = (Resolve-Path -LiteralPath $FixturePath).Path
    return Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json
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

    $fixturePayload = Get-OrchestratorWakeSupervisorOrchestratorListFixture -FixturePath $FixturePath
    $ao = if ($AoCommand) { $AoCommand } else { 'ao' }
    try {
        $resolved = Resolve-AoOrchestratorSessionId -Project $ProjectId `
            -OrchestratorListPayload $fixturePayload -AoCommand $ao
    }
    catch {
        return $null
    }
    if ($resolved) {
        return $resolved
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

function Get-OrchestratorWakeSupervisorScriptPath {
    return (Resolve-Path -LiteralPath (Join-Path $Script:OrchestratorSideProcessPackRoot 'scripts/orchestrator-wake-supervisor.ps1')).Path
}

function Normalize-OrchestratorWakeSupervisorPath {
    param([string]$PathValue)

    if ([string]::IsNullOrWhiteSpace($PathValue)) { return '' }
    try {
        return (Resolve-Path -LiteralPath $PathValue -ErrorAction Stop).Path
    }
    catch {
        try {
            return [System.IO.Path]::GetFullPath($PathValue)
        }
        catch {
            return $PathValue.Trim()
        }
    }
}

function Get-OrchestratorWakeSupervisorCommandLineSwitchValue {
    param(
        [string[]]$Tokens,
        [string]$SwitchName
    )

    for ($index = 0; $index -lt $Tokens.Count; $index++) {
        $token = $Tokens[$index]
        if ($token -eq $SwitchName) {
            if ($index + 1 -lt $Tokens.Count -and -not $Tokens[$index + 1].StartsWith('-')) {
                return $Tokens[$index + 1]
            }
            return 'true'
        }
        if ($token.StartsWith("$SwitchName=") -and $token.Length -gt ($SwitchName.Length + 1)) {
            return $token.Substring($SwitchName.Length + 1)
        }
    }
    return $null
}

function Test-OrchestratorWakeSupervisorCommandLineHasSwitch {
    param(
        [string[]]$Tokens,
        [string]$SwitchName
    )

    return $null -ne (Get-OrchestratorWakeSupervisorCommandLineSwitchValue -Tokens $Tokens -SwitchName $SwitchName)
}

function Get-OrchestratorWakeSupervisorCommandLineScriptPath {
    param([string[]]$Tokens)

    for ($index = 0; $index -lt $Tokens.Count; $index++) {
        if ($Tokens[$index] -in @('-File', '-f') -and $index + 1 -lt $Tokens.Count) {
            return $Tokens[$index + 1]
        }
    }
    return ''
}

function Test-OrchestratorWakeSupervisorSupervisorCommandLineIdentity {
    param(
        [string]$CommandLine = '',
        [string[]]$Tokens = @(),
        [string]$ProjectId,
        [string]$StateRoot
    )
    return Test-OrchestratorWakeSupervisorSupervisorStateRootIdentity -CommandLine $CommandLine `
        -Tokens $Tokens -ProjectId $ProjectId -StateRoot $StateRoot
}

function Test-OrchestratorWakeSupervisorSupervisorIdentity {
    param(
        [int]$ProcessId,
        [string]$ProjectId,
        [string]$StateRoot
    )
    return Test-OrchestratorWakeSupervisorSupervisorStateRootProcessIdentity -ProcessId $ProcessId `
        -ProjectId $ProjectId -StateRoot $StateRoot
}


function Get-ProcessEnvironmentValueFromBytes {
    param(
        [byte[]]$Raw,
        [string]$Name
    )

    if (-not $Raw -or $Raw.Length -eq 0) { return '' }

    $prefix = [System.Text.Encoding]::UTF8.GetBytes("$Name=")
    $start = -1
    for ($index = 0; $index -le ($Raw.Length - $prefix.Length); $index++) {
        $matched = $true
        for ($offset = 0; $offset -lt $prefix.Length; $offset++) {
            if ($Raw[$index + $offset] -ne $prefix[$offset]) {
                $matched = $false
                break
            }
        }
        if ($matched) {
            $start = $index + $prefix.Length
            break
        }
    }
    if ($start -lt 0) { return '' }

    $valueBytes = New-Object System.Collections.Generic.List[byte]
    for ($index = $start; $index -lt $Raw.Length; $index++) {
        if ($Raw[$index] -eq 0) { break }
        $valueBytes.Add($Raw[$index]) | Out-Null
    }
    return [System.Text.Encoding]::UTF8.GetString($valueBytes.ToArray())
}

function Get-ProcessEnvironmentValueFromFixture {
    param(
        [int]$ProcessId,
        [string]$Name
    )

    $fixturePath = $env:AO_PROCESS_ENV_FIXTURE
    if (-not $fixturePath) { return $null }
    if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) { return $null }

    try {
        $map = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json
        $pidKey = [string]$ProcessId
        if ($map.PSObject.Properties.Name -contains $pidKey) {
            $entry = $map.$pidKey
            if ($entry.PSObject.Properties.Name -contains $Name) {
                return [string]$entry.$Name
            }
        }
    }
    catch {
        return $null
    }

    return $null
}

function Initialize-ProcessEnvironmentReader {
    if ($script:ProcessEnvironmentReaderInitialized) { return }
    $script:ProcessEnvironmentReaderInitialized = $true
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        if (-not ('OrchestratorPack.ProcessEnvironmentReader' -as [type])) {
            $typeDefinition = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace OrchestratorPack
{
    public static class ProcessEnvironmentReader
    {
        [StructLayout(LayoutKind.Sequential)]
        struct ProcessBasicInformation
        {
            public IntPtr Reserved1;
            public IntPtr PebBaseAddress;
            public IntPtr Reserved2_0;
            public IntPtr Reserved2_1;
            public IntPtr UniqueProcessId;
            public IntPtr Reserved3;
        }

        const int ProcessBasicInformationClass = 0;
        const uint ProcessQueryAccess = 0x0410;

        [DllImport("ntdll.dll")]
        static extern int NtQueryInformationProcess(
            IntPtr processHandle,
            int processInformationClass,
            ref ProcessBasicInformation processInformation,
            int processInformationLength,
            out int returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadProcessMemory(
            IntPtr hProcess,
            IntPtr lpBaseAddress,
            byte[] lpBuffer,
            int dwSize,
            out int lpNumberOfBytesRead);

        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr hProcess);

        static bool TryReadPointer(IntPtr hProcess, IntPtr address, out IntPtr value)
        {
            value = IntPtr.Zero;
            var buffer = new byte[IntPtr.Size];
            int read;
            if (!ReadProcessMemory(hProcess, address, buffer, buffer.Length, out read) || read != buffer.Length)
            {
                return false;
            }
            value = IntPtr.Size == 8 ? new IntPtr(BitConverter.ToInt64(buffer, 0)) : new IntPtr(BitConverter.ToInt32(buffer, 0));
            return value != IntPtr.Zero;
        }

        static bool TryReadBytes(IntPtr hProcess, IntPtr address, int length, out byte[] buffer)
        {
            buffer = null;
            if (length <= 0) { return false; }
            buffer = new byte[length];
            int read;
            return ReadProcessMemory(hProcess, address, buffer, length, out read) && read == length;
        }

        static bool TryReadEnvironmentBytes(IntPtr hProcess, IntPtr address, out byte[] buffer)
        {
            buffer = null;
            const int maxLength = 65536;
            var raw = new byte[maxLength];
            int read;
            if (!ReadProcessMemory(hProcess, address, raw, maxLength, out read) || read <= 0)
            {
                return false;
            }

            var end = read;
            for (var index = 0; index + 1 < read; index += 2)
            {
                if (raw[index] == 0 && raw[index + 1] == 0)
                {
                    end = index + 2;
                    break;
                }
            }

            buffer = new byte[end];
            Array.Copy(raw, buffer, end);
            return true;
        }

        public static string GetEnvironmentVariable(int processId, string name)
        {
            if (processId <= 0 || string.IsNullOrEmpty(name)) { return string.Empty; }

            var hProcess = OpenProcess(ProcessQueryAccess, false, processId);
            if (hProcess == IntPtr.Zero) { return string.Empty; }

            try
            {
                var pbi = new ProcessBasicInformation();
                int returnLength;
                if (NtQueryInformationProcess(hProcess, ProcessBasicInformationClass, ref pbi, Marshal.SizeOf(typeof(ProcessBasicInformation)), out returnLength) != 0)
                {
                    return string.Empty;
                }

                IntPtr processParameters;
                if (!TryReadPointer(hProcess, IntPtr.Add(pbi.PebBaseAddress, IntPtr.Size == 8 ? 0x20 : 0x10), out processParameters))
                {
                    return string.Empty;
                }

                IntPtr environmentBuffer;
                if (!TryReadPointer(hProcess, IntPtr.Add(processParameters, IntPtr.Size == 8 ? 0x80 : 0x48), out environmentBuffer))
                {
                    return string.Empty;
                }

                byte[] environmentBytes;
                if (!TryReadEnvironmentBytes(hProcess, environmentBuffer, out environmentBytes))
                {
                    return string.Empty;
                }

                var environmentBlock = Encoding.Unicode.GetString(environmentBytes);
                var prefix = name + "=";
                foreach (var entry in environmentBlock.Split('\0'))
                {
                    if (entry.StartsWith(prefix, StringComparison.Ordinal))
                    {
                        return entry.Substring(prefix.Length);
                    }
                }
            }
            finally
            {
                CloseHandle(hProcess);
            }

            return string.Empty;
        }
    }
}
'@
            Add-Type -TypeDefinition $typeDefinition -ErrorAction Stop
        }
    }
}

function Get-ProcessEnvironmentValue {
    param(
        [int]$ProcessId,
        [string]$Name
    )

    if ($ProcessId -le 0) { return '' }

    $fixtureValue = Get-ProcessEnvironmentValueFromFixture -ProcessId $ProcessId -Name $Name
    if ($null -ne $fixtureValue) { return $fixtureValue }

    if ($IsLinux) {
        $environPath = "/proc/$ProcessId/environ"
        if (-not (Test-Path -LiteralPath $environPath)) { return '' }

        try {
            $raw = [System.IO.File]::ReadAllBytes($environPath)
        }
        catch {
            return ''
        }

        return Get-ProcessEnvironmentValueFromBytes -Raw $raw -Name $Name
    }

    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        try {
            Initialize-ProcessEnvironmentReader
            if ('OrchestratorPack.ProcessEnvironmentReader' -as [type]) {
                return [OrchestratorPack.ProcessEnvironmentReader]::GetEnvironmentVariable($ProcessId, $Name)
            }
        }
        catch {
            return ''
        }
    }

    return ''
}

function Test-OrchestratorWakeSupervisorManagedChildForState {
    param(
        [int]$ProcessId,
        [string]$Role,
        [string]$StateRoot
    )

    if (-not (Test-OrchestratorWakeSupervisorManagedProcess -ProcessId $ProcessId -Role $Role)) {
        return $false
    }

    $normalizedExpected = Normalize-OrchestratorWakeSupervisorPath -PathValue $StateRoot
    $envState = Get-ProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_SIDE_PROCESS_STATE_DIR'
    if ($envState) {
        return (Normalize-OrchestratorWakeSupervisorPath -PathValue $envState) -eq $normalizedExpected
    }

    $markerDir = Get-ProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_WAKE_SUPERVISOR_TEST_MARKER_DIR'
    if ($markerDir) {
        return (Normalize-OrchestratorWakeSupervisorPath -PathValue $markerDir).StartsWith($normalizedExpected)
    }

    return $false
}

function Test-OrchestratorWakeSupervisorManagedChildProjectIdentity {
    param(
        [int]$ProcessId,
        [string]$Role,
        [string]$ProjectId
    )

    if ($ProcessId -le 0) { return $false }
    $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $Role
    if (-not $entry) { return $false }

    $defaultProject = Get-OrchestratorWakeSupervisorDefaultProjectId
    $expectedProject = if ($ProjectId) { $ProjectId } else { $defaultProject }

    if ($Role -eq 'listener') {
        $envProject = Get-ProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_WAKE_LISTENER_PROJECT_ID'
        if ($envProject) {
            return $envProject -eq $expectedProject
        }
    }

    $tokens = Get-OrchestratorWakeSupervisorProcessCommandLineTokens -ProcessId $ProcessId
    if ($tokens -and $tokens.Count -gt 0) {
        $commandProject = Get-OrchestratorWakeSupervisorCommandLineSwitchValue -Tokens $tokens -SwitchName '-ProjectId'
        if ($commandProject) {
            return $commandProject -eq $expectedProject
        }

        $testChildPath = Normalize-OrchestratorWakeSupervisorPath -PathValue $Script:OrchestratorSideProcessTestChildScript
        $scriptInCommand = Get-OrchestratorWakeSupervisorCommandLineScriptPath -Tokens $tokens
        if ($scriptInCommand) {
            $normalizedScript = Normalize-OrchestratorWakeSupervisorPath -PathValue $scriptInCommand
            if ($normalizedScript -eq $testChildPath) {
                $markerDir = Get-ProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_WAKE_SUPERVISOR_TEST_MARKER_DIR'
                if ($markerDir) {
                    $markerPath = Join-Path $markerDir "$Role.marker.json"
                    if (Test-Path -LiteralPath $markerPath) {
                        try {
                            $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
                            if ($marker.projectId) {
                                return [string]$marker.projectId -eq $expectedProject
                            }
                        }
                        catch {
                            return $false
                        }
                    }
                }
            }
        }
    }

    if ($entry.PassProjectId) {
        return $false
    }

    # Registry children without -ProjectId (e.g. heartbeat) are fleet-scoped by state root only.
    return $true
}

function Remove-OrchestratorWakeSupervisorSupervisorPidFileIfOwned {
    param(
        [hashtable]$Paths,
        [int]$OwnerPid,
        [string]$LogPath = ''
    )

    $recorded = Read-OrchestratorWakeSupervisorPidFile -Path $Paths.SupervisorPid
    if ($recorded -le 0 -or $recorded -eq $OwnerPid) {
        Remove-OrchestratorWakeSupervisorPidFile -Path $Paths.SupervisorPid
        return
    }
    if ($LogPath) {
        Write-OrchestratorWakeSupervisorLog -Message "skipping supervisor.pid cleanup; file pid=$recorded is not owner pid=$OwnerPid" -LogPath $LogPath
    }
}

function Find-OrchestratorWakeSupervisorManagedSupervisorCandidates {
    param(
        [string]$ProjectId,
        [string]$StateRoot
    )

    $candidates = [System.Collections.Generic.List[int]]::new()
    $processes = @(Get-Process -Name 'pwsh', 'powershell' -ErrorAction SilentlyContinue)
    foreach ($proc in $processes) {
        if (Test-OrchestratorWakeSupervisorSupervisorIdentity -ProcessId $proc.Id -ProjectId $ProjectId -StateRoot $StateRoot) {
            $candidates.Add($proc.Id)
        }
    }
    return @($candidates | Sort-Object -Unique)
}

function Resolve-OrchestratorWakeSupervisorSupervisorPid {
    param(
        [hashtable]$Paths,
        [string]$ProjectId,
        [string]$LogPath = ''
    )

    $recordedPid = Read-OrchestratorWakeSupervisorPidFile -Path $Paths.SupervisorPid
    $diagnostics = [System.Collections.Generic.List[string]]::new()
    $recordedValid = $false
    if ($recordedPid -gt 0) {
        $recordedValid = Test-OrchestratorWakeSupervisorSupervisorIdentity -ProcessId $recordedPid `
            -ProjectId $ProjectId -StateRoot $Paths.Root
    }

    $scannedCandidates = Find-OrchestratorWakeSupervisorManagedSupervisorCandidates -ProjectId $ProjectId -StateRoot $Paths.Root
    $candidateSet = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($candidatePid in @($scannedCandidates)) {
        [void]$candidateSet.Add([int]$candidatePid)
    }
    if ($recordedValid) {
        [void]$candidateSet.Add([int]$recordedPid)
    }
    $candidates = @($candidateSet | Sort-Object)

    $ambiguous = ($candidates.Count -gt 1)
    $resolvedPid = 0
    $discoverySource = 'none'

    if ($ambiguous) {
        $diagnostics.Add("ambiguous managed supervisor candidates: $($candidates -join ',')") | Out-Null
        if ($recordedValid) {
            $diagnostics.Add("supervisor.pid pid=$recordedPid valid but additional managed supervisor candidates were discovered") | Out-Null
        }
    }
    elseif ($candidates.Count -eq 1) {
        $resolvedPid = $candidates[0]
        $discoverySource = if ($recordedValid -and $resolvedPid -eq $recordedPid) { 'pid-file' } else { 'process-scan' }
        if (-not $recordedValid) {
            if ($recordedPid -gt 0) {
                if (Test-ProcessAlive -ProcessId $recordedPid) {
                    $diagnostics.Add("supervisor.pid pid=$recordedPid unrelated to managed supervisor") | Out-Null
                }
                else {
                    $diagnostics.Add("supervisor.pid pid=$recordedPid stale (exited)") | Out-Null
                }
            }
            elseif (Test-Path -LiteralPath $Paths.SupervisorPid) {
                $diagnostics.Add('supervisor.pid missing or empty; discovered managed supervisor by process scan') | Out-Null
            }
            else {
                $diagnostics.Add('supervisor.pid missing; discovered managed supervisor by process scan') | Out-Null
            }
        }
    }
    elseif ($recordedPid -gt 0 -and (Test-ProcessAlive -ProcessId $recordedPid)) {
        $diagnostics.Add("supervisor.pid pid=$recordedPid unrelated to managed supervisor") | Out-Null
    }

    if ($ambiguous) {
        $resolvedPid = 0
        $discoverySource = 'none'
    }

    $resolvedAlive = ($resolvedPid -gt 0) -and
        (Test-OrchestratorWakeSupervisorSupervisorIdentity -ProcessId $resolvedPid -ProjectId $ProjectId -StateRoot $Paths.Root)

    foreach ($diag in $diagnostics) {
        Write-OrchestratorWakeSupervisorLog -Message $diag -LogPath $LogPath
    }

    return @{
        RecordedPid     = $recordedPid
        ResolvedPid     = $resolvedPid
        ResolvedAlive   = $resolvedAlive
        Ambiguous       = $ambiguous
        CandidatePids   = $candidates
        Diagnostics     = $diagnostics.ToArray()
        DiscoverySource = $discoverySource
    }
}

function Test-OrchestratorWakeSupervisorManagedProcess {
    param(
        [int]$ProcessId,
        [string]$Role,
        [string]$ProjectId = '',
        [string]$StateRoot = ''
    )

    if ($ProcessId -le 0) { return $false }
    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return $false }

    if ($Role -eq 'supervisor') {
        if (-not $ProjectId) {
            $ProjectId = Get-OrchestratorWakeSupervisorDefaultProjectId
        }
        if (-not $StateRoot) {
            $StateRoot = Get-OrchestratorWakeSupervisorStateRoot
        }
        return Test-OrchestratorWakeSupervisorSupervisorIdentity -ProcessId $ProcessId `
            -ProjectId $ProjectId -StateRoot $StateRoot
    }

    $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $Role
    if ($entry) {
        $marker = $entry.ScriptMarker
    }
    else {
        return $false
    }

    $tokens = Get-OrchestratorWakeSupervisorProcessCommandLineTokens -ProcessId $ProcessId
    if (-not $tokens -or $tokens.Count -eq 0) { return $false }

    $testChildPath = Normalize-OrchestratorWakeSupervisorPath -PathValue $Script:OrchestratorSideProcessTestChildScript
    $scriptInCommand = Get-OrchestratorWakeSupervisorCommandLineScriptPath -Tokens $tokens
    if ($scriptInCommand) {
        $normalizedScript = Normalize-OrchestratorWakeSupervisorPath -PathValue $scriptInCommand
        if ($normalizedScript -eq $testChildPath) {
            $roleValue = Get-OrchestratorWakeSupervisorCommandLineSwitchValue -Tokens $tokens -SwitchName '-Role'
            return $roleValue -eq $Role
        }

        $scriptPath = Normalize-OrchestratorWakeSupervisorPath -PathValue $entry.ScriptPath
        return $normalizedScript -eq $scriptPath
    }

    $joinedCommand = $tokens -join ' '
    return $joinedCommand -like "*$marker*"
}

function Test-OrchestratorWakeSupervisorDaemonRunning {
    param(
        [int]$ProcessId,
        [string]$Role,
        [string]$ProjectId = '',
        [string]$StateRoot = ''
    )

    return (Test-ProcessAlive -ProcessId $ProcessId) -and
    (Test-OrchestratorWakeSupervisorManagedProcess -ProcessId $ProcessId -Role $Role `
            -ProjectId $ProjectId -StateRoot $StateRoot)
}

function Clear-OrchestratorWakeSupervisorStalePidIfNeeded {
    param(
        [int]$ProcessId,
        [string]$PidFile,
        [string]$Role,
        [string]$LogPath = '',
        [string]$ProjectId = '',
        [string]$StateRoot = ''
    )

    if ($ProcessId -le 0) {
        if ($PidFile -and (Test-Path -LiteralPath $PidFile)) {
            Remove-OrchestratorWakeSupervisorPidFile -Path $PidFile
        }
        return
    }

    if (Test-OrchestratorWakeSupervisorDaemonRunning -ProcessId $ProcessId -Role $Role `
            -ProjectId $ProjectId -StateRoot $StateRoot) {
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

    $effectiveTimeout = $TimeoutSeconds
    if ($env:AO_WAKE_SUPERVISOR_TEST_FAST_STOP -eq '1') {
        $effectiveTimeout = [Math]::Min($TimeoutSeconds, 1)
    }
    $deadline = (Get-Date).AddSeconds($effectiveTimeout)
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
        [string]$LogPath = '',
        [string]$ProjectId = '',
        [string]$StateRoot = ''
    )

    if ($ProcessId -le 0) { return }

    if ($ManagedRole) {
        if (-not (Test-OrchestratorWakeSupervisorManagedProcess -ProcessId $ProcessId -Role $ManagedRole `
                    -ProjectId $ProjectId -StateRoot $StateRoot)) {
            Write-OrchestratorWakeSupervisorLog -Message "skipping kill for pid=$ProcessId (stale or unrelated $ManagedRole)" -LogPath $LogPath
            if ($PidFile) {
                Remove-OrchestratorWakeSupervisorPidFile -Path $PidFile
            }
            return
        }
    }

    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return }

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


function Get-OrchestratorSideProcessScriptParamBlock {
    param([string]$ScriptPath)

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        throw "Missing side-process child script: $ScriptPath"
    }
    $text = Get-Content -LiteralPath $ScriptPath -Raw
    if ($text -notmatch '(?ms)\bparam\s*\(\s*(.*?)\)\s*\r?\n') {
        return ''
    }
    return $Matches[1]
}

function Get-OrchestratorSideProcessScriptParamDescriptors {
    param([string]$ScriptPath)

    $block = Get-OrchestratorSideProcessScriptParamBlock -ScriptPath $ScriptPath
    if (-not $block) {
        return @()
    }

    $descriptors = [System.Collections.Generic.List[object]]::new()
    $pattern = '(?ms)(?<attrs>(?:\[[^\]]*\]\s*)+)\$(?<name>[A-Za-z_][\w-]*)\s*(?:=\s*(?<default>[^,\r\n\)]+))?'
    foreach ($match in [regex]::Matches($block, $pattern)) {
        $attrs = $match.Groups['attrs'].Value
        $name = $match.Groups['name'].Value
        $defaultText = $match.Groups['default'].Value
        $hasDefault = [bool]($defaultText -and $defaultText.Trim())
        # PowerShell accepts Mandatory shorthand: [Parameter(Mandatory)], [Parameter(Mandatory, ...)], and Mandatory = $true.
        $mandatory = ($attrs -match '(?i)\bMandatory\b') -and -not ($attrs -match '(?i)Mandatory\s*=\s*\$false') -and -not $hasDefault
        $validateSet = @()
        if ($attrs -match 'ValidateSet\((?<vs>[^\)]+)\)') {
            $rawValues = $Matches['vs']
            $validateSet = @($rawValues -split ',' | ForEach-Object {
                $_.Trim().Trim("'").Trim('"')
            } | Where-Object { $_ })
        }
        $descriptors.Add([pscustomobject]@{
            Name        = $name
            Mandatory   = $mandatory
            HasDefault  = $hasDefault
            ValidateSet = $validateSet
        })
    }
    return @($descriptors)
}

function Get-OrchestratorSideProcessLaunchShapeProvidedValues {
    param([string[]]$ExpandedExtraArgs = @())

    $providedValues = @{}
    for ($i = 0; $i -lt $ExpandedExtraArgs.Count; $i++) {
        $token = [string]$ExpandedExtraArgs[$i]
        if ($token -match '^-(?<name>[A-Za-z][\w-]*)$') {
            $switchName = $Matches['name']
            if ($i + 1 -lt $ExpandedExtraArgs.Count -and [string]$ExpandedExtraArgs[$i + 1] -notmatch '^-') {
                $providedValues[$switchName] = [string]$ExpandedExtraArgs[$i + 1]
                $i++
            }
        }
    }
    return $providedValues
}

function Get-OrchestratorSideProcessScriptParamNames {
    param([string]$ScriptPath)

    $block = Get-OrchestratorSideProcessScriptParamBlock -ScriptPath $ScriptPath
    if (-not $block) {
        return @()
    }
    return @([regex]::Matches($block, '\[\w+(?:\([^)]*\))?\]\$(?<name>[A-Za-z_][\w-]*)') |
        ForEach-Object { $_.Groups['name'].Value })
}

function Get-OrchestratorWakeSupervisorChildLaunchSwitchNames {
    param(
        [Parameter(Mandatory = $true)]
        $Entry,
        [switch]$ProductionMode
    )

    $switches = [System.Collections.Generic.List[string]]::new()
    if ($Entry.RequiresOrchestratorSession) {
        $switches.Add('OrchestratorSessionId')
    }
    if ($Entry.PassProjectId) {
        $switches.Add('ProjectId')
    }
    if ($Entry.ExtraArgs) {
        foreach ($token in @($Entry.ExtraArgs)) {
            if ([string]$token -match '^-(?<name>[A-Za-z][\w-]*)$') {
                $switches.Add($Matches['name'])
            }
        }
    }
    return @($switches)
}

function Build-OrchestratorWakeSupervisorChildLaunchArgv {
    param(
        [Parameter(Mandatory = $true)][string]$ChildId,
        [Parameter(Mandatory = $true)]$Entry,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string]$OrchestratorSessionId = '',
        [string]$ProjectId = '',
        [hashtable]$Paths = @{},
        [switch]$TestMode,
        [string[]]$ExtraChildArgs = @()
    )

    $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath)
    if ($TestMode) {
        $childArgs += @('-Role', $ChildId)
        if ($Entry.RequiresOrchestratorSession) {
            $childArgs += @('-OrchestratorSessionId', $OrchestratorSessionId)
        }
        $modeEnvKey = "AO_WAKE_SUPERVISOR_TEST_MODE_$($ChildId -replace '-', '_')"
        $modeFromEnv = [Environment]::GetEnvironmentVariable($modeEnvKey, 'Process')
        if ($modeFromEnv) {
            $childArgs += @('-Mode', $modeFromEnv)
        }
    }
    elseif ($Entry.RequiresOrchestratorSession) {
        $childArgs += @('-OrchestratorSessionId', $OrchestratorSessionId)
    }
    if ($Entry.PassProjectId -and $ProjectId) {
        $childArgs += @('-ProjectId', $ProjectId)
    }
    if ($ExtraChildArgs -and -not $TestMode) {
        $childArgs += $ExtraChildArgs
    }
    if (-not $TestMode -and $Entry.ExtraArgs) {
        $childArgs += Expand-OrchestratorWakeSupervisorChildExtraArgs -ExtraArgs $Entry.ExtraArgs -Paths $Paths
    }
    return $childArgs
}

function Test-OrchestratorSideProcessLaunchContract {
    param(
        [Parameter(Mandatory = $true)][string]$RegistryPath,
        [Parameter(Mandatory = $true)][string]$ScriptsRoot,
        [ref]$OutErrors
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) {
        $errors.Add("missing registry: $RegistryPath")
        $OutErrors.Value = @($errors)
        return $false
    }
    if (-not (Test-Path -LiteralPath $ScriptsRoot -PathType Container)) {
        $errors.Add("missing scripts root: $ScriptsRoot")
        $OutErrors.Value = @($errors)
        return $false
    }

    $doc = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
    $children = @($doc.children)
    if ($children.Count -lt 1) {
        $errors.Add('registry children[] is empty')
        $OutErrors.Value = @($errors)
        return $false
    }

    foreach ($child in $children) {
        $entry = @{
            Id                          = [string]$child.id
            ScriptPath                  = Join-Path $ScriptsRoot ([string]$child.script)
            RequiresOrchestratorSession = [bool]$child.requiresOrchestratorSession
            PassProjectId               = [bool]$child.passProjectId
            ExtraArgs                   = @($child.extraArgs)
        }
        if (-not (Test-Path -LiteralPath $entry.ScriptPath -PathType Leaf)) {
            $errors.Add("$($entry.Id): missing script $($child.script)")
            continue
        }

        $expectedSwitches = Get-OrchestratorWakeSupervisorChildLaunchSwitchNames -Entry $entry -ProductionMode
        $paramNames = Get-OrchestratorSideProcessScriptParamNames -ScriptPath $entry.ScriptPath
        foreach ($switchName in $expectedSwitches) {
            if ($paramNames -notcontains $switchName) {
                $errors.Add("$($entry.Id): supervisor launch switch '-$switchName' is not declared in $($child.script) param block")
            }
        }

        $expandedExtra = Expand-OrchestratorWakeSupervisorChildExtraArgs -ExtraArgs $entry.ExtraArgs `
            -Paths @{ Root = $ScriptsRoot }
        $providedValues = Get-OrchestratorSideProcessLaunchShapeProvidedValues -ExpandedExtraArgs $expandedExtra
        $launchSwitchSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($switchName in @($expectedSwitches)) {
            [void]$launchSwitchSet.Add($switchName)
        }

        foreach ($descriptor in Get-OrchestratorSideProcessScriptParamDescriptors -ScriptPath $entry.ScriptPath) {
            if (-not $descriptor.Mandatory) {
                continue
            }
            if (-not $launchSwitchSet.Contains($descriptor.Name)) {
                $errors.Add("$($entry.Id): mandatory parameter '$($descriptor.Name)' is not satisfiable from supervised launch shape")
                continue
            }
            if ($descriptor.ValidateSet.Count -gt 0 -and $providedValues.ContainsKey($descriptor.Name)) {
                $providedValue = $providedValues[$descriptor.Name]
                if ($descriptor.ValidateSet -notcontains $providedValue) {
                    $errors.Add("$($entry.Id): mandatory parameter '$($descriptor.Name)' ValidateSet does not allow supervised launch value '$providedValue'")
                }
            }
        }
    }

    $OutErrors.Value = @($errors)
    return ($errors.Count -eq 0)
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

    $childArgs = Build-OrchestratorWakeSupervisorChildLaunchArgv -ChildId $ChildId -Entry $entry `
        -ScriptPath $scriptPath -OrchestratorSessionId $OrchestratorSessionId -ProjectId $ProjectId `
        -Paths $Paths -TestMode:$TestMode -ExtraChildArgs $ExtraChildArgs

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

function Get-OrchestratorWakeSupervisorManagedChildCandidatePids {
    param(
        [hashtable]$Paths,
        [string]$ChildId,
        [string]$ProjectId = '',
        [hashtable]$Adoptable = $null
    )

    $candidatePids = [System.Collections.Generic.HashSet[int]]::new()
    $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $ChildId
    $recordedPid = Read-OrchestratorWakeSupervisorPidFile -Path $pidFile
    if ($recordedPid -gt 0) {
        [void]$candidatePids.Add($recordedPid)
    }

    $adoptableMap = if ($Adoptable) { $Adoptable } else { Find-OrchestratorWakeSupervisorAdoptableProcesses -Paths $Paths -ProjectId $ProjectId }
    if ($adoptableMap.ContainsKey($ChildId)) {
        [void]$candidatePids.Add([int]$adoptableMap[$ChildId])
    }

    return @($candidatePids)
}

function Stop-OrchestratorWakeSupervisorChildById {
    param(
        [hashtable]$Paths,
        [string]$ChildId,
        [string]$LogPath = '',
        [string]$ProjectId = '',
        [hashtable]$Adoptable = $null
    )

    $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $ChildId
    $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $ChildId
    $candidatePids = Get-OrchestratorWakeSupervisorManagedChildCandidatePids -Paths $Paths -ChildId $ChildId -ProjectId $ProjectId -Adoptable $Adoptable
    $hasLiveChild = $false
    foreach ($candidatePid in $candidatePids) {
        if (Test-ProcessAlive -ProcessId $candidatePid) {
            $hasLiveChild = $true
            break
        }
    }
    if ($entry -and $entry.SideEffecting -and $hasLiveChild) {
        $drained = Wait-OrchestratorWakeSupervisorSideEffectDrain -Paths $Paths -ChildId $ChildId -LogPath $LogPath
        if (-not $drained) {
            Write-OrchestratorWakeSupervisorLog -Message "stop: $ChildId side-effect still in flight after drain window" -LogPath $LogPath
        }
    }
    foreach ($candidatePid in $candidatePids) {
        Stop-OrchestratorWakeSupervisorProcess -ProcessId $candidatePid -PidFile '' -ManagedRole $ChildId -LogPath $LogPath
    }
    if (Test-Path -LiteralPath $pidFile) {
        Remove-OrchestratorWakeSupervisorPidFile -Path $pidFile
    }
}

function Stop-OrchestratorWakeSupervisorChildren {
    param(
        $Paths,
        [string]$LogPath = '',
        [string[]]$ChildIds = @(),
        [string]$ProjectId = '',
        [string]$StateRoot = ''
    )

    $targets = if ($ChildIds -and $ChildIds.Count -gt 0) {
        $ChildIds
    }
    else {
        @(Get-OrchestratorWakeSupervisorChildRegistry | ForEach-Object { $_.Id })
    }

    $adoptable = Find-OrchestratorWakeSupervisorAdoptableProcesses -Paths $Paths -ProjectId $ProjectId
    foreach ($childId in $targets) {
        Stop-OrchestratorWakeSupervisorChildById -Paths $Paths -ChildId $childId -LogPath $LogPath -ProjectId $ProjectId -Adoptable $adoptable
    }
}
function Get-OrchestratorWakeSupervisorChildRecoveryState {
    param(
        [hashtable]$Paths,
        [string]$ChildId
    )

    $state = Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson
    $emptyDegraded = Get-OrchestratorWakeSupervisorChildDegradedBackoffFields -RecoveryEntry $null
    $base = @{
        attempts                     = 0
        terminal                     = $false
        reason                       = ''
        rapidExits                   = 0
        backoffUntilMs               = 0
        lastExitMs                   = 0
        terminalDaemonHealthClass    = ''
        terminalAtMs                 = 0
        terminalBootId               = ''
        terminalEpisodeId            = ''
        terminalRearmAttempts        = 0
        lastDaemonHealthClass        = ''
        lastDaemonHealthObservedAtMs = 0
        lastTerminalRearmMs          = 0
    } + $emptyDegraded
    if (-not $state -or -not $state.childRecovery) {
        return $base
    }
    $entry = $state.childRecovery.$ChildId
    if (-not $entry) {
        return $base
    }
    $crashFields = Get-OrchestratorWakeSupervisorChildCrashBackoffFields -RecoveryEntry $entry
    $degradedFields = Get-OrchestratorWakeSupervisorChildDegradedBackoffFields -RecoveryEntry $entry
    return @{
        attempts                     = if ($entry.attempts) { [int]$entry.attempts } else { 0 }
        terminal                     = [bool]$entry.terminal
        reason                       = if ($entry.reason) { [string]$entry.reason } else { '' }
        rapidExits                   = $crashFields.rapidExits
        backoffUntilMs               = $crashFields.backoffUntilMs
        lastExitMs                   = $crashFields.lastExitMs
        terminalDaemonHealthClass    = if ($entry.terminalDaemonHealthClass) { [string]$entry.terminalDaemonHealthClass } else { '' }
        terminalAtMs                 = if ($null -ne $entry.terminalAtMs) { [long]$entry.terminalAtMs } else { 0 }
        terminalBootId               = if ($entry.terminalBootId) { [string]$entry.terminalBootId } else { '' }
        terminalEpisodeId            = if ($entry.terminalEpisodeId) { [string]$entry.terminalEpisodeId } else { '' }
        terminalRearmAttempts        = if ($null -ne $entry.terminalRearmAttempts) { [int]$entry.terminalRearmAttempts } else { 0 }
        lastDaemonHealthClass        = if ($entry.lastDaemonHealthClass) { [string]$entry.lastDaemonHealthClass } else { '' }
        lastDaemonHealthObservedAtMs = if ($null -ne $entry.lastDaemonHealthObservedAtMs) { [long]$entry.lastDaemonHealthObservedAtMs } else { 0 }
        lastTerminalRearmMs          = if ($null -ne $entry.lastTerminalRearmMs) { [long]$entry.lastTerminalRearmMs } else { 0 }
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
        [string]$ChildId,
        [switch]$ClearTerminalMetadata,
        [switch]$ClearOutageEpisode
    )

    $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId
    $hasCrashState = ($recovery.rapidExits -ne 0) -or ($recovery.backoffUntilMs -ne 0) -or ($recovery.lastExitMs -ne 0)
    $hasTerminalMetadata = $ClearTerminalMetadata -and (
        $recovery.terminal -or
        [string]$recovery.reason -or
        [string]$recovery.terminalDaemonHealthClass -or
        [long]$recovery.terminalAtMs -ne 0 -or
        [string]$recovery.terminalBootId -or
        [long]$recovery.lastTerminalRearmMs -ne 0
    )
    $hasOutageEpisode = $ClearOutageEpisode -and (
        [string]$recovery.terminalEpisodeId -or
        [int]$recovery.terminalRearmAttempts -ne 0 -or
        [string]$recovery.lastDaemonHealthClass -or
        [long]$recovery.lastDaemonHealthObservedAtMs -ne 0
    )
    if (-not $hasCrashState -and -not $hasTerminalMetadata -and -not $hasOutageEpisode) {
        return
    }

    $updates = @{
        rapidExits     = 0
        backoffUntilMs = 0
        lastExitMs     = 0
    }
    if ($ClearTerminalMetadata) {
        $updates.terminal = $false
        $updates.reason = ''
        $updates.terminalDaemonHealthClass = ''
        $updates.terminalAtMs = 0
        $updates.terminalBootId = ''
        $updates.lastTerminalRearmMs = 0
    }
    if ($ClearOutageEpisode) {
        $updates.terminalEpisodeId = ''
        $updates.terminalRearmAttempts = 0
        $updates.lastDaemonHealthClass = ''
        $updates.lastDaemonHealthObservedAtMs = 0
    }
    Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates $updates)
}

function Get-OrchestratorWakeSupervisorChildStatusEntry {
    param(
        [hashtable]$Paths,
        [string]$ChildId,
        [string]$SupervisorPhase = 'running',
        [string]$ProjectId = ''
    )

    $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $ChildId
    $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $ChildId
    $pidVal = Read-OrchestratorWakeSupervisorPidFile -Path $pidFile
    $alive = $false
    if ($pidVal -gt 0 -and (Test-ProcessAlive -ProcessId $pidVal)) {
        $alive = (Test-OrchestratorWakeSupervisorManagedChildForState -ProcessId $pidVal -Role $ChildId `
            -StateRoot $Paths.Root) -and `
            (Test-OrchestratorWakeSupervisorManagedChildProjectIdentity -ProcessId $pidVal -Role $ChildId -ProjectId $ProjectId)
    }
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
        [string]$SupervisorPhase = 'running',
        [string]$ProjectId = ''
    )

    $entries = @()
    foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
        $entries += Get-OrchestratorWakeSupervisorChildStatusEntry -Paths $Paths -ChildId $child.Id `
            -SupervisorPhase $SupervisorPhase -ProjectId $ProjectId
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
        $ChildEntry,
        [string]$ProjectId = ''
    )

    if (-not $ChildEntry) {
        return $false
    }

    $status = Get-OrchestratorWakeSupervisorChildStatusEntry -Paths $Paths -ChildId $ChildEntry.Id -ProjectId $ProjectId
    if (-not $status.Alive) {
        return $false
    }
    if (Test-OrchestratorWakeSupervisorSideEffectInFlight -Paths $Paths -ChildId $ChildEntry.Id) {
        return $false
    }

    $progress = Read-OrchestratorWakeSupervisorChildProgress -Paths $Paths -ChildId $ChildEntry.Id
    $nowMs = Get-OrchestratorSideProcessNowMs
    $threshold = Get-OrchestratorWakeSupervisorChildStallThresholdMs -ChildEntry $ChildEntry
    $status = Get-OrchestratorWakeSupervisorChildStatusEntry -Paths $Paths -ChildId $ChildEntry.Id -ProjectId $ProjectId
    $childPid = [int]$status.Pid

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

    $freshness = Get-OrchestratorSideProcessProgressFreshnessVerdict -Progress $progress `
        -ChildPid $childPid -StallThresholdMs $threshold -NowMs $nowMs -ChildId ([string]$ChildEntry.Id)
    return -not $freshness.Fresh
}

function Find-OrchestratorWakeSupervisorManagedChildCandidatesForState {
    param(
        [hashtable]$Paths,
        [string]$ProjectId,
        [string]$ChildId
    )

    $matches = [System.Collections.Generic.List[int]]::new()
    $processes = @(Get-Process -Name 'pwsh', 'powershell' -ErrorAction SilentlyContinue)
    foreach ($proc in $processes) {
        $procId = [int]$proc.Id
        if ($procId -le 0) { continue }
        if ((Test-OrchestratorWakeSupervisorManagedChildForState -ProcessId $procId -Role $ChildId -StateRoot $Paths.Root) -and `
                (Test-OrchestratorWakeSupervisorManagedChildProjectIdentity -ProcessId $procId -Role $ChildId -ProjectId $ProjectId)) {
            $matches.Add($procId) | Out-Null
        }
    }
    return @($matches | Sort-Object -Unique)
}

function Select-OrchestratorWakeSupervisorDuplicateSurvivor {
    param(
        [hashtable]$Paths,
        [string]$ChildId,
        [int[]]$CandidatePids,
        [int]$LeaseEpoch = 0
    )

    if (-not $CandidatePids -or $CandidatePids.Count -eq 0) { return 0 }
    if ($CandidatePids.Count -eq 1) { return [int]$CandidatePids[0] }

    $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $ChildId
    $recordedPid = Read-OrchestratorWakeSupervisorPidFile -Path $pidFile

    $currentSession = ''
    if (Test-Path -LiteralPath $Paths.StateJson) {
        try {
            $state = Get-Content -LiteralPath $Paths.StateJson -Raw | ConvertFrom-Json
            $currentSession = [string]$state.orchestratorSessionId
        }
        catch {
            $currentSession = ''
        }
    }

    $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $ChildId
    $bestPid = 0
    $bestScore = [int]::MinValue

    foreach ($procId in @($CandidatePids)) {
        if ($procId -le 0) { continue }
        if (-not (Test-ProcessAlive -ProcessId $procId)) { continue }

        $score = 0
        $tokens = Get-OrchestratorWakeSupervisorProcessCommandLineTokens -ProcessId $procId
        $registryMatch = $false
        if ($entry -and $tokens) {
            $scriptInCommand = Get-OrchestratorWakeSupervisorCommandLineScriptPath -Tokens $tokens
            if ($scriptInCommand) {
                $normalizedScript = Normalize-OrchestratorWakeSupervisorPath -PathValue $scriptInCommand
                $registryPath = Normalize-OrchestratorWakeSupervisorPath -PathValue $entry.ScriptPath
                $registryMatch = ($normalizedScript -eq $registryPath)
            }
        }
        if ($registryMatch) { $score += 400 }

        $markerSession = ''
        $markersDir = Get-ProcessEnvironmentValue -ProcessId $procId -Name 'AO_WAKE_SUPERVISOR_TEST_MARKER_DIR'
        if ($markersDir) {
            $markerPath = Join-Path $markersDir "$ChildId.marker.json"
            if (Test-Path -LiteralPath $markerPath) {
                try {
                    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
                    $markerSession = [string]$marker.orchestratorSessionId
                }
                catch {
                    $markerSession = ''
                }
            }
        }
        if ($currentSession -and $markerSession -eq $currentSession) { $score += 300 }

        if ($procId -eq $recordedPid) { $score += 100 }

        $startMs = Get-OrchestratorWakeSupervisorProcessStartTimeMs -ProcessId $procId
        if ($startMs -gt 0) {
            $score += [int]($startMs / 1000000)
        }

        if ($score -gt $bestScore -or ($score -eq $bestScore -and $procId -gt $bestPid)) {
            $bestScore = $score
            $bestPid = $procId
        }
    }

    return $bestPid
}

function Find-OrchestratorWakeSupervisorAdoptableProcesses {
    param(
        [hashtable]$Paths,
        [ref]$DuplicatePidsByRole,
        [string]$ProjectId = ''
    )

    $found = @{}
    $duplicates = @{}
    $leaseEpoch = Get-OrchestratorWakeSupervisorLeaseEpoch -Paths $Paths
    $processes = @(Get-Process -Name 'pwsh', 'powershell' -ErrorAction SilentlyContinue)

    foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
        $childId = $child.Id
        $matches = [System.Collections.Generic.List[int]]::new()
        foreach ($proc in $processes) {
            $procId = [int]$proc.Id
            if ($procId -le 0) { continue }
            if ((Test-OrchestratorWakeSupervisorManagedChildForState -ProcessId $procId -Role $childId -StateRoot $Paths.Root) -and `
                    (Test-OrchestratorWakeSupervisorManagedChildProjectIdentity -ProcessId $procId -Role $childId -ProjectId $ProjectId)) {
                $matches.Add($procId) | Out-Null
            }
        }
        $matchArr = @($matches | Sort-Object -Unique)
        if ($matchArr.Count -eq 0) {
            $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $childId
            $recorded = Read-OrchestratorWakeSupervisorPidFile -Path $pidFile
            if ($recorded -gt 0 -and (Test-OrchestratorWakeSupervisorManagedChildForState -ProcessId $recorded `
                    -Role $childId -StateRoot $Paths.Root) -and `
                    (Test-OrchestratorWakeSupervisorManagedChildProjectIdentity -ProcessId $recorded -Role $childId -ProjectId $ProjectId)) {
                $found[$childId] = $recorded
            }
            continue
        }

        $survivor = Select-OrchestratorWakeSupervisorDuplicateSurvivor -Paths $Paths -ChildId $childId `
            -CandidatePids $matchArr -LeaseEpoch $leaseEpoch
        if ($survivor -le 0) { continue }
        $found[$childId] = $survivor
        $dup = @($matchArr | Where-Object { $_ -ne $survivor })
        if ($dup.Count -gt 0) { $duplicates[$childId] = $dup }
    }

    if ($DuplicatePidsByRole) { $DuplicatePidsByRole.Value = $duplicates }
    return $found
}

function Invoke-OrchestratorWakeSupervisorAdoptOrTerminate {
    param(
        [hashtable]$Paths,
        [string]$LogPath = '',
        [switch]$TestMode,
        [string]$ProjectId = ''
    )

    if ($TestMode) { return }
    if (-not (Test-OrchestratorWakeSupervisorLeaseEpochCurrent -Paths $Paths)) { return }

    $duplicateMap = $null
    $adoptable = Find-OrchestratorWakeSupervisorAdoptableProcesses -Paths $Paths -DuplicatePidsByRole ([ref]$duplicateMap) -ProjectId $ProjectId
    foreach ($pair in $adoptable.GetEnumerator()) {
        $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $pair.Key
        $existing = Read-OrchestratorWakeSupervisorPidFile -Path $pidFile
        if ($existing -eq $pair.Value) { continue }
        if ($existing -gt 0 -and (Test-ProcessAlive -ProcessId $existing) -and $existing -ne $pair.Value) {
            Write-OrchestratorWakeSupervisorLog -Message "adoption: terminating duplicate $($pair.Key) pid=$existing" -LogPath $LogPath
            Stop-OrchestratorWakeSupervisorProcess -ProcessId $existing -PidFile $pidFile -ManagedRole '' -LogPath $LogPath
        }
        Write-OrchestratorWakeSupervisorLog -Message "adoption: $($pair.Key) pid=$($pair.Value)" -LogPath $LogPath
        Assert-OrchestratorWakeSupervisorLeaseMutationAllowed -Paths $Paths | Out-Null
        Write-OrchestratorWakeSupervisorPidFile -Path $pidFile -ProcessId $pair.Value
    }

    if ($duplicateMap) {
        foreach ($pair in $duplicateMap.GetEnumerator()) {
            $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $pair.Key
            foreach ($dupPid in @($pair.Value)) {
                if ($dupPid -le 0) { continue }
                Write-OrchestratorWakeSupervisorLog -Message "adoption: terminating enumerate-all duplicate $($pair.Key) pid=$dupPid" -LogPath $LogPath
                Stop-OrchestratorWakeSupervisorProcess -ProcessId $dupPid -PidFile $pidFile -ManagedRole '' -LogPath $LogPath
            }
        }
    }
}

function Start-OrchestratorWakeSupervisorManagedSet {
    param(
        [hashtable]$Paths,
        [string]$SessionId,
        [string]$ProjectId,
        [switch]$TestMode,
        [string]$TestChildScript = '',
        [string]$LogPath = '',
        [string]$AoCommand = ''
    )

    $started = @()
    $failures = @()
    foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
        $status = Get-OrchestratorWakeSupervisorChildStatusEntry -Paths $Paths -ChildId $child.Id -ProjectId $ProjectId
        if ($status.Alive) {
            Write-OrchestratorWakeSupervisorLog -Message "reusing adopted $($child.Id) pid=$($status.Pid)" -LogPath $LogPath
            continue
        }

        $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $child.Id
        if ($recovery.terminal) {
            $terminalDecision = Test-OrchestratorWakeSupervisorTerminalRearmAllowed `
                -Paths $Paths -ChildId $child.Id -AoCommand $(if ($AoCommand) { $AoCommand } else { 'ao' }) `
                -LogWriter {
                    param([string]$Message)
                    Write-OrchestratorWakeSupervisorLog -Message $Message -LogPath $LogPath
                }
            if (-not $terminalDecision.allowed) {
                Write-OrchestratorWakeSupervisorLog -Message "startup terminal gate: $($child.Id) remains terminal ($($terminalDecision.reasonDetail))" -LogPath $LogPath
                continue
            }
            Reset-OrchestratorWakeSupervisorChildCrashRecoveryState `
                -Paths $Paths -ChildId $child.Id -ClearTerminalMetadata
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
        $status = Get-OrchestratorWakeSupervisorChildStatusEntry -Paths $Paths -ChildId $childId -ProjectId $ProjectId
        if (-not $status.Alive) {
            $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $childId
            $recorded = Read-OrchestratorWakeSupervisorPidFile -Path $pidFile
            if ($recorded -le 0 -or -not ((Test-OrchestratorWakeSupervisorManagedChildForState -ProcessId $recorded `
                        -Role $childId -StateRoot $Paths.Root) -and `
                        (Test-OrchestratorWakeSupervisorManagedChildProjectIdentity -ProcessId $recorded -Role $childId -ProjectId $ProjectId))) {
                continue
            }
        }

        if ($index -gt 0 -and $staggerMs -gt 0) {
            $jitter = Get-Random -Minimum 0 -Maximum ([Math]::Max(1, [int]($staggerMs / 2)))
            Start-Sleep -Milliseconds ($staggerMs + $jitter)
        }
        Stop-OrchestratorWakeSupervisorChildById -Paths $Paths -ChildId $childId -LogPath $LogPath -ProjectId $ProjectId
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
    return "No orchestrator session for project '$ProjectId' within the wait window. Ensure the AO desktop daemon is running and an orchestrator session exists (ao orchestrator ls --json)."
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

    $checkoutScript = (Get-OrchestratorWakeSupervisorScriptPath)
    $lease = Enter-OrchestratorWakeSupervisorHeldLease -Paths $Paths -ProjectId $ProjectId -PollSeconds $PollSeconds `
        -CheckoutScript $checkoutScript -AllowReclaim
    if (-not $lease.ok) {
        $reason = [string]$lease.reason
        Write-OrchestratorWakeSupervisorLog -Message "supervisor loop exiting: lease not acquired ($reason)" -LogPath $Paths.SupervisorLog
        return
    }
    Write-OrchestratorWakeSupervisorPidFile -Path $Paths.SupervisorPid -ProcessId $PID
    try {
        Invoke-OrchestratorWakeSupervisorAdoptOrTerminate -Paths $Paths -LogPath $Paths.SupervisorLog -TestMode:$TestMode -ProjectId $ProjectId
    }
    catch {
        Write-OrchestratorWakeSupervisorLog -Message "adopt/reap skipped: $_" -LogPath $Paths.SupervisorLog
    }

    if ($TestMode) {
        Register-TestModeFleetSupervisorStart -StateRoot $Paths.Root
    }

    $loopStart = Get-Date
    try {
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
        if ($TestMode) {
            $leaseTtl = Test-TestModeFleetSupervisorLeaseExpired -Paths $Paths
            if ($leaseTtl.expired) {
                Write-OrchestratorWakeSupervisorLog -Message "testmode lease TTL self-exit ($($leaseTtl.reason))" -LogPath $Paths.SupervisorLog
                Set-OrchestratorWakeSupervisorStoppingFlag -Paths $Paths
                Stop-OrchestratorWakeSupervisorChildren -Paths $Paths -LogPath $Paths.SupervisorLog -ProjectId $ProjectId -StateRoot $Paths.Root
                break
            }
        }

        if (-not (Test-OrchestratorWakeSupervisorLeaseStillHeld -Paths $Paths -PollSeconds $PollSeconds)) {
            Write-OrchestratorWakeSupervisorLog -Message 'lease lost; exiting supervisor loop' -LogPath $Paths.SupervisorLog
            break
        }
        $null = Invoke-OrchestratorWakeSupervisorLeaseHeartbeat -Paths $Paths -PollSeconds $PollSeconds `
            -LogPath $Paths.SupervisorLog
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
            if ($phase -eq 'waiting') {
                Write-OrchestratorWakeSupervisorLog -Message "waiting for orchestrator session (project=$ProjectId)..." -LogPath $Paths.SupervisorLog
            }
            if ($phase -eq 'running' -and $sessionMissingPolls -ge $sessionGlitchPolls) {
                Write-OrchestratorWakeSupervisorLog -Message 'orchestrator session disappeared; stopping children' -LogPath $Paths.SupervisorLog
                Stop-OrchestratorWakeSupervisorChildren -Paths $Paths -LogPath $Paths.SupervisorLog -ProjectId $ProjectId
                $phase = 'waiting'
                $currentSessionId = ''
                $pendingSessionId = ''
                $pendingSessionPolls = 0
                Write-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson -State @{
                    phase                 = 'waiting'
                    orchestratorSessionId = ''
                    sessionSource         = ''
                    projectId             = $ProjectId
                    childRecovery         = if ((Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson).childRecovery) { (Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson).childRecovery } else { @{} }
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
                -TestMode:$TestMode -TestChildScript $TestChildScript -LogPath $Paths.SupervisorLog `
                -AoCommand $AoCommand
            Write-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson -State @{
                phase                   = 'running'
                orchestratorSessionId   = $sessionId
                sessionSource           = $currentSource
                projectId               = $ProjectId
                childRecovery           = if ((Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson).childRecovery) { (Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson).childRecovery } else { @{} }
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
            try {
                Invoke-OrchestratorWakeSupervisorAdoptOrTerminate -Paths $Paths -LogPath $Paths.SupervisorLog -TestMode:$TestMode -ProjectId $ProjectId
            }
            catch {
                Write-OrchestratorWakeSupervisorLog -Message "adopt/reap skipped after session restart: $_" -LogPath $Paths.SupervisorLog
            }
            Write-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson -State @{
                phase                   = 'running'
                orchestratorSessionId   = $sessionId
                sessionSource           = $currentSource
                projectId               = $ProjectId
                childRecovery           = if ((Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson).childRecovery) { (Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson).childRecovery } else { @{} }
            }
        }
        else {
            $pendingSessionId = ''
            $pendingSessionPolls = 0
            if (Test-OrchestratorWakeSupervisorStopping -Paths $Paths) {
                break
            }

            if ($phase -eq 'running') {
                try {
                    Invoke-OrchestratorWakeSupervisorAdoptOrTerminate -Paths $Paths -LogPath $Paths.SupervisorLog -TestMode:$TestMode -ProjectId $ProjectId
                }
                catch {
                    Write-OrchestratorWakeSupervisorLog -Message "adopt/reap skipped: $_" -LogPath $Paths.SupervisorLog
                }
            }

            foreach ($child in $registry) {
                if (-not $child -or -not $child.Id) {
                    continue
                }
                try {
                    Invoke-OrchestratorWakeSupervisorTestFaultInjection -ChildId $child.Id
                    $status = Get-OrchestratorWakeSupervisorChildStatusEntry -Paths $Paths -ChildId $child.Id `
                        -SupervisorPhase $phase -ProjectId $ProjectId
                    if ($status.Health -eq 'waiting') {
                        continue
                    }

                    if ($status.Health -eq 'working' -and $status.Alive) {
                        Update-OrchestratorWakeSupervisorChildStableWorkingRecovery -Paths $Paths -ChildId $child.Id
                        if (-not (Test-OrchestratorWakeSupervisorChildStalled -Paths $Paths -ChildEntry $child -ProjectId $ProjectId)) {
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
                            -Paths $Paths -ChildId $child.Id -ChildStartedMs $childStartedMs -ChildPid $status.Pid `
                            -AoCommand $(if ($AoCommand) { $AoCommand } else { 'ao' }) `
                            -LogWriter {
                                param([string]$Message)
                                Write-OrchestratorWakeSupervisorLog -Message $Message -LogPath $Paths.SupervisorLog
                            }
                        if (-not $restartDecision.allowed) {
                            continue
                        }
                        if ($restartDecision.reason -eq 'terminal_rearm') {
                            Reset-OrchestratorWakeSupervisorChildCrashRecoveryState `
                                -Paths $Paths -ChildId $child.Id -ClearTerminalMetadata
                        }
                        Write-OrchestratorWakeSupervisorLog -Message "$($child.Id) exited; restarting" -LogPath $Paths.SupervisorLog
                        Start-OrchestratorWakeSupervisorChild -ChildId $child.Id -OrchestratorSessionId $currentSessionId `
                            -Paths $Paths -ProjectId $ProjectId -TestMode:$TestMode -TestChildScript $TestChildScript
                        continue
                    }

                    $needsRecovery = $status.Terminal -or
                        $status.Health -in @('degraded', 'stalled') -or
                        (Test-OrchestratorWakeSupervisorChildStalled -Paths $Paths -ChildEntry $child -ProjectId $ProjectId)
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
                        $terminalDecision = Test-OrchestratorWakeSupervisorTerminalRearmAllowed `
                            -Paths $Paths -ChildId $child.Id -AoCommand $(if ($AoCommand) { $AoCommand } else { 'ao' }) `
                            -LogWriter {
                                param([string]$Message)
                                Write-OrchestratorWakeSupervisorLog -Message $Message -LogPath $Paths.SupervisorLog
                            }
                        if ($terminalDecision.allowed) {
                            if ($status.Alive) {
                                Stop-OrchestratorWakeSupervisorChildById -Paths $Paths -ChildId $child.Id -LogPath $Paths.SupervisorLog -ProjectId $ProjectId
                            }
                            Reset-OrchestratorWakeSupervisorChildCrashRecoveryState `
                                -Paths $Paths -ChildId $child.Id -ClearTerminalMetadata
                            Start-OrchestratorWakeSupervisorChild -ChildId $child.Id -OrchestratorSessionId $currentSessionId `
                                -Paths $Paths -ProjectId $ProjectId -MaxLoopSeconds $child.MaxLoopSeconds `
                                -TestMode:$TestMode -LogPath $Paths.SupervisorLog
                            continue
                        }
                        if ($status.Alive) {
                            Invoke-OrchestratorWakeSupervisorTestFaultInjection -ChildId $child.Id -Phase 'recovery-stop'
                            Stop-OrchestratorWakeSupervisorChildById -Paths $Paths -ChildId $child.Id -LogPath $Paths.SupervisorLog -ProjectId $ProjectId
                        }
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
                        $recoveryAfterDecision = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $child.Id
                        if ($recoveryAfterDecision.terminal -and $status.Alive) {
                            Invoke-OrchestratorWakeSupervisorTestFaultInjection -ChildId $child.Id -Phase 'recovery-stop'
                            Stop-OrchestratorWakeSupervisorChildById -Paths $Paths -ChildId $child.Id -LogPath $Paths.SupervisorLog -ProjectId $ProjectId
                        }
                        continue
                    }

                    $attemptLabel = if ($degradedDecision.degradedAttempts) { $degradedDecision.degradedAttempts } else { 1 }
                    Write-OrchestratorWakeSupervisorLog -Message "$($child.Id) recovering (degraded attempt $attemptLabel)" -LogPath $Paths.SupervisorLog
                    Invoke-OrchestratorWakeSupervisorTestFaultInjection -ChildId $child.Id -Phase 'recovery-stop'
                    Stop-OrchestratorWakeSupervisorChildById -Paths $Paths -ChildId $child.Id -LogPath $Paths.SupervisorLog -ProjectId $ProjectId
                    Start-OrchestratorWakeSupervisorChild -ChildId $child.Id -OrchestratorSessionId $currentSessionId `
                        -Paths $Paths -ProjectId $ProjectId -TestMode:$TestMode -TestChildScript $TestChildScript
                }
                catch {
                    $faultMsg = [string]$_
                    Write-OrchestratorWakeSupervisorLog -Message "fault boundary: $($child.Id): $faultMsg" -LogPath $Paths.SupervisorLog
                    $null = Test-OrchestratorWakeSupervisorChildDegradedRestartAllowed `
                        -Paths $Paths -ChildId $child.Id -DegradedReason $faultMsg -FailureClass 'deterministic' `
                        -LogWriter {
                            param([string]$Message)
                            Write-OrchestratorWakeSupervisorLog -Message $Message -LogPath $Paths.SupervisorLog
                        }
                }
            }
        }

        Start-Sleep -Seconds $PollSeconds
    }
    }
    finally {
        Release-OrchestratorWakeSupervisorLease
        Remove-OrchestratorWakeSupervisorSupervisorPidFileIfOwned -Paths $Paths -OwnerPid $PID -LogPath $Paths.SupervisorLog
    }
}

function Get-OrchestratorWakeSupervisorStatusReport {
    param(
        [hashtable]$Paths,
        [string]$ProjectId
    )

    $resolution = Resolve-OrchestratorWakeSupervisorSupervisorPid -Paths $Paths -ProjectId $ProjectId `
        -LogPath $Paths.SupervisorLog
    $supervisorPid = if ($resolution.Ambiguous -and -not $resolution.ResolvedAlive) {
        0
    }
    else {
        $resolution.ResolvedPid
    }
    $candidateCount = @($resolution.CandidatePids).Count
    $supervisorAlive = $resolution.ResolvedAlive -and -not ($resolution.Ambiguous -and $candidateCount -gt 1)
    $state = Read-OrchestratorWakeSupervisorState -StateJsonPath $Paths.StateJson
    $sessionId = if ($state) { [string]$state.orchestratorSessionId } else { '' }
    $supervisorPhase = if ($state -and $state.phase) { [string]$state.phase } else { 'running' }
    $children = Get-OrchestratorWakeSupervisorChildStatus -Paths $Paths -SupervisorPhase $supervisorPhase -ProjectId $ProjectId

    $report = @{
        ProjectId                 = $ProjectId
        SupervisorPid             = $supervisorPid
        SupervisorAlive           = $supervisorAlive
        SupervisorAmbiguous       = $resolution.Ambiguous
        SupervisorCandidatePids   = $resolution.CandidatePids
        SupervisorDiagnostics     = $resolution.Diagnostics
        SupervisorDiscoverySource = $resolution.DiscoverySource
        OrchestratorSessionId     = $sessionId
        SupervisorPhase           = $supervisorPhase
        StateRoot                 = $Paths.Root
        Children                  = $children
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
        $logRedirect = ">> $(Format-UnixShellSingleQuotedArgument -Value $LogPath) 2>&1 < /dev/null &"
        $launcherContent = @(
            '#!/usr/bin/env bash'
            'set -euo pipefail'
            "cd $(Format-UnixShellSingleQuotedArgument -Value $WorkingDirectory)"
            ('export PATH={0}:${{PATH:-}}' -f $packScriptsQuoted)
            'if command -v setsid >/dev/null 2>&1; then'
            "  setsid nohup pwsh $quotedArgs $logRedirect"
            'else'
            "  nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' pwsh $quotedArgs $logRedirect"
            'fi'
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

    if ($Report.SupervisorAmbiguous) {
        $candidateText = if ($Report.SupervisorCandidatePids -and $Report.SupervisorCandidatePids.Count -gt 0) {
            ($Report.SupervisorCandidatePids -join ',')
        }
        else {
            'none'
        }
        Write-Host ("supervisor: ambiguous (pids={0})" -f $candidateText)
    }
    elseif ($Report.SupervisorAlive) {
        Write-Host ("supervisor: running (pid={0})" -f $Report.SupervisorPid)
    }
    else {
        Write-Host ("supervisor: stopped (pid={0})" -f $Report.SupervisorPid)
    }

    foreach ($diag in @($Report.SupervisorDiagnostics)) {
        if ($diag) {
            Write-Host ("supervisor-note: {0}" -f $diag)
        }
    }

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
