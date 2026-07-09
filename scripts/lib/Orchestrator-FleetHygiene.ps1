#requires -Version 5.1
<#
  Fleet hygiene assertions H1–H7 (Issue #711).
  External observer — not a supervised registry child.
#>

. (Join-Path $PSScriptRoot 'Get-ProcessCommandLine.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-WakeSupervisor.ps1')

$Script:FleetHygieneAssertionIds = @('H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7')

function Test-FleetHygieneLinuxProcEnvironSupported {
    if ($env:AO_FLEET_HYGIENE_FORCE_UNSUPPORTED_PLATFORM -eq '1') {
        return $false
    }
    if (-not $IsLinux) { return $false }
    return Test-Path -LiteralPath '/proc/self/environ'
}

function Get-FleetHygieneUnsupportedPlatformMessage {
    return 'fleet-hygiene: unsupported platform — H1–H4 require Linux /proc environment reads'
}

function Get-FleetHygieneProcessEnvironmentValue {
    param(
        [int]$ProcessId,
        [string]$Name
    )

    $fixturePath = $env:AO_FLEET_HYGIENE_PROCESS_ENV_FIXTURE
    if ($fixturePath -and (Test-Path -LiteralPath $fixturePath -PathType Leaf)) {
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
            # fall through to live read
        }
    }

    return Get-ProcessEnvironmentValue -ProcessId $ProcessId -Name $Name
}

function Get-FleetHygieneConfig {
    param(
        [string]$ProjectId = '',
        [string]$StateDir = '',
        [string]$PackRoot = '',
        [switch]$KillEnable
    )

    $project = if ($ProjectId) { $ProjectId } else { Get-OrchestratorWakeSupervisorDefaultProjectId }
    $stateRoot = Get-OrchestratorWakeSupervisorStateRoot -CliOverride $StateDir
    $pack = if ($PackRoot) {
        Normalize-OrchestratorWakeSupervisorPath -PathValue $PackRoot
    }
    else {
        Normalize-OrchestratorWakeSupervisorPath -PathValue $Script:OrchestratorSideProcessPackRoot
    }

    $kill = $KillEnable.IsPresent
    if (-not $kill -and $env:AO_FLEET_HYGIENE_KILL_ENABLE -eq '1') {
        $kill = $true
    }

    $maxPwsh = 200
    if ($env:AO_FLEET_HYGIENE_MAX_PWSH_COUNT -and [int]::TryParse($env:AO_FLEET_HYGIENE_MAX_PWSH_COUNT, [ref]$null)) {
        $maxPwsh = [int]$env:AO_FLEET_HYGIENE_MAX_PWSH_COUNT
    }

    $maxSupervisorRssKb = 1048576
    if ($env:AO_FLEET_HYGIENE_MAX_SUPERVISOR_RSS_KB -and [int]::TryParse($env:AO_FLEET_HYGIENE_MAX_SUPERVISOR_RSS_KB, [ref]$null)) {
        $maxSupervisorRssKb = [int]$env:AO_FLEET_HYGIENE_MAX_SUPERVISOR_RSS_KB
    }

    $maxLogBytes = 52428800
    if ($env:AO_FLEET_HYGIENE_MAX_SUPERVISOR_LOG_BYTES -and [int]::TryParse($env:AO_FLEET_HYGIENE_MAX_SUPERVISOR_LOG_BYTES, [ref]$null)) {
        $maxLogBytes = [int]$env:AO_FLEET_HYGIENE_MAX_SUPERVISOR_LOG_BYTES
    }

    $duplicateStormMin = 5
    if ($env:AO_FLEET_HYGIENE_DUPLICATE_LOG_STORM_MIN -and [int]::TryParse($env:AO_FLEET_HYGIENE_DUPLICATE_LOG_STORM_MIN, [ref]$null)) {
        $duplicateStormMin = [int]$env:AO_FLEET_HYGIENE_DUPLICATE_LOG_STORM_MIN
    }

    return @{
        ProjectId              = $project
        StateRoot              = $stateRoot
        PackRoot               = $pack
        Paths                  = Get-OrchestratorWakeSupervisorPaths -StateRoot $stateRoot
        KillEnable             = $kill
        MaxPwshCount           = $maxPwsh
        MaxSupervisorRssKb     = $maxSupervisorRssKb
        MaxSupervisorLogBytes  = $maxLogBytes
        DuplicateLogStormMin   = $duplicateStormMin
        AlertDestination       = if ($env:AO_FLEET_HYGIENE_ALERT_FILE) { $env:AO_FLEET_HYGIENE_ALERT_FILE } else { '' }
        SentinelLogPath        = Join-Path $stateRoot 'fleet-hygiene-sentinel.log'
        SentinelLockPath       = Join-Path $stateRoot 'fleet-hygiene-sentinel.lock'
        SupervisorLockPath     = Join-Path $stateRoot 'supervisor.lock'
    }
}

function New-FleetHygieneAssertionResult {
    param(
        [string]$Id,
        [string]$Code,
        [bool]$Pass,
        [string]$Reason
    )

    return @{
        Id     = $Id
        Code   = $Code
        Pass   = $Pass
        Reason = $Reason
    }
}

function Read-FleetHygieneSupervisorLockHolderPid {
    param([string]$LockPath)

    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        return 0
    }

    try {
        $raw = Get-Content -LiteralPath $LockPath -Raw -ErrorAction Stop
    }
    catch {
        return 0
    }

    if (-not $raw) { return 0 }

    $trimmed = $raw.Trim()
    if ($trimmed.StartsWith('{')) {
        try {
            $doc = $trimmed | ConvertFrom-Json
            if ($doc.pid) { return [int]$doc.pid }
            if ($doc.holderPid) { return [int]$doc.holderPid }
        }
        catch {
            return 0
        }
    }

    $firstLine = ($trimmed -split "`n")[0].Trim()
    if ([int]::TryParse($firstLine, [ref]$null)) {
        return [int]$firstLine
    }

    return 0
}

function Resolve-FleetHygieneCanonicalSupervisorPid {
    param(
        [hashtable]$Config
    )

    $lockPid = Read-FleetHygieneSupervisorLockHolderPid -LockPath $Config.SupervisorLockPath
    if ($lockPid -gt 0 -and (Test-FleetHygieneProcessAlive -ProcessId $lockPid) `
            -and (Test-FleetHygieneSupervisorIdentity -ProcessId $lockPid `
                -ProjectId $Config.ProjectId -StateRoot $Config.StateRoot)) {
        return @{
            Pid    = $lockPid
            Source = 'supervisor.lock'
        }
    }

    $resolution = Resolve-OrchestratorWakeSupervisorSupervisorPid -Paths $Config.Paths `
        -ProjectId $Config.ProjectId -LogPath $Config.Paths.SupervisorLog
    if ($resolution.ResolvedAlive -and -not $resolution.Ambiguous) {
        return @{
            Pid    = [int]$resolution.ResolvedPid
            Source = 'process-scan'
        }
    }

    return @{
        Pid    = 0
        Source = 'none'
    }
}

function Test-FleetHygieneProcessAlive {
    param([int]$ProcessId)

    if ($ProcessId -le 0) { return $false }
    if ($env:AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE) {
        try {
            $alive = @($env:AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE | ConvertFrom-Json | ForEach-Object { [int]$_ })
            return $alive -contains $ProcessId
        }
        catch {
            return $false
        }
    }
    return Test-ProcessAlive -ProcessId $ProcessId
}

function Test-FleetHygieneManagedProcess {
    param(
        [int]$ProcessId,
        [string]$Role,
        [string]$ProjectId = '',
        [string]$StateRoot = ''
    )

    if ($ProcessId -le 0) { return $false }
    if (-not (Test-FleetHygieneProcessAlive -ProcessId $ProcessId)) { return $false }

    if ($Role -eq 'supervisor') {
        if (-not $ProjectId) { $ProjectId = Get-OrchestratorWakeSupervisorDefaultProjectId }
        if (-not $StateRoot) { $StateRoot = Get-OrchestratorWakeSupervisorStateRoot }
        return Test-FleetHygieneSupervisorIdentity -ProcessId $ProcessId -ProjectId $ProjectId -StateRoot $StateRoot
    }

    $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $Role
    if (-not $entry) { return $false }

    $commandLine = Get-OrchestratorWakeSupervisorProcessCommandLine -ProcessId $ProcessId
    if (-not $commandLine) { return $false }
    $Tokens = Split-ProcessCommandLineTokens -CommandLine $commandLine
    if (-not $Tokens -or $Tokens.Count -eq 0) { return $false }

    $testChildPath = Normalize-OrchestratorWakeSupervisorPath -PathValue $Script:OrchestratorSideProcessTestChildScript
    $scriptInCommand = Get-OrchestratorWakeSupervisorCommandLineScriptPath -Tokens $Tokens
    if ($scriptInCommand) {
        $normalizedScript = Normalize-OrchestratorWakeSupervisorPath -PathValue $scriptInCommand
        if ($normalizedScript -eq $testChildPath) {
            $roleValue = Get-OrchestratorWakeSupervisorCommandLineSwitchValue -Tokens $Tokens -SwitchName '-Role'
            return $roleValue -eq $Role
        }

        $scriptPath = Normalize-OrchestratorWakeSupervisorPath -PathValue $entry.ScriptPath
        return $normalizedScript -eq $scriptPath
    }

    $joinedCommand = $Tokens -join ' '
    return $joinedCommand -like "*$($entry.ScriptMarker)*"
}

function Test-FleetHygieneVitestTestModeProcess {
    param([int]$ProcessId)

    if (Get-Command Test-OrchestratorWakeSupervisorVitestTestModeProcess -ErrorAction SilentlyContinue) {
        return Test-OrchestratorWakeSupervisorVitestTestModeProcess -ProcessId $ProcessId
    }

    $markerDir = Get-FleetHygieneProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_WAKE_SUPERVISOR_TEST_MARKER_DIR'
    if ($markerDir) { return $true }

    $tokens = Get-OrchestratorWakeSupervisorProcessCommandLineTokens -ProcessId $ProcessId
    if ($tokens -and (Test-OrchestratorWakeSupervisorCommandLineHasSwitch -Tokens $tokens -SwitchName '-TestMode')) {
        return $true
    }

    return $false
}

function Get-FleetHygienePwshProcessIds {
    if ($env:AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE) {
        try {
            $fixture = $env:AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE | ConvertFrom-Json
            return @($fixture | ForEach-Object { [int]$_ })
        }
        catch {
            return @()
        }
    }

    return @(
        Get-Process -Name 'pwsh', 'powershell' -ErrorAction SilentlyContinue |
            ForEach-Object { [int]$_.Id }
    )
}

function Test-FleetHygieneSupervisorIdentity {
    param(
        [int]$ProcessId,
        [string]$ProjectId,
        [string]$StateRoot
    )

    if ($ProcessId -le 0) { return $false }
    $commandLine = Get-OrchestratorWakeSupervisorProcessCommandLine -ProcessId $ProcessId
    if (-not $commandLine) { return $false }
    return Test-OrchestratorWakeSupervisorSupervisorCommandLineIdentity -CommandLine $commandLine `
        -ProjectId $ProjectId -StateRoot $StateRoot
}

function Find-FleetHygieneManagedSupervisorCandidates {
    param(
        [string]$ProjectId,
        [string]$StateRoot
    )

    $candidates = [System.Collections.Generic.List[int]]::new()
    foreach ($procId in Get-FleetHygienePwshProcessIds) {
        if (Test-FleetHygieneSupervisorIdentity -ProcessId $procId -ProjectId $ProjectId -StateRoot $StateRoot) {
            $candidates.Add($procId) | Out-Null
        }
    }
    return @($candidates | Sort-Object -Unique)
}

function Get-FleetHygieneProcessRssKb {
    param([int]$ProcessId)

    if ($env:AO_FLEET_HYGIENE_PROCESS_RSS_FIXTURE) {
        try {
            $map = $env:AO_FLEET_HYGIENE_PROCESS_RSS_FIXTURE | ConvertFrom-Json
            $key = [string]$ProcessId
            if ($map.PSObject.Properties.Name -contains $key) {
                return [long]$map.$key
            }
        }
        catch {
            return 0
        }
    }

    if (-not $IsLinux) { return 0 }
    $statusPath = "/proc/$ProcessId/status"
    if (-not (Test-Path -LiteralPath $statusPath)) { return 0 }

    foreach ($line in Get-Content -LiteralPath $statusPath -ErrorAction SilentlyContinue) {
        if ($line -match '^VmRSS:\s+(\d+)\s+kB') {
            return [long]$Matches[1]
        }
    }
    return 0
}

function Test-FleetHygieneProcessRoleTaggedForState {
    param(
        [int]$ProcessId,
        [string]$StateRoot
    )

    $childId = Get-FleetHygieneProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_SIDE_PROCESS_CHILD_ID'
    if ($childId) { return $true }

    $envState = Get-FleetHygieneProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_SIDE_PROCESS_STATE_DIR'
    if ($envState) {
        $normalizedExpected = Normalize-OrchestratorWakeSupervisorPath -PathValue $StateRoot
        return (Normalize-OrchestratorWakeSupervisorPath -PathValue $envState) -eq $normalizedExpected
    }

    return $false
}

function Test-FleetHygieneManagedChildForState {
    param(
        [int]$ProcessId,
        [string]$Role,
        [string]$StateRoot
    )

    if (-not (Test-FleetHygieneManagedProcess -ProcessId $ProcessId -Role $Role)) {
        return $false
    }

    $normalizedExpected = Normalize-OrchestratorWakeSupervisorPath -PathValue $StateRoot
    $envState = Get-FleetHygieneProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_SIDE_PROCESS_STATE_DIR'
    if ($envState) {
        return (Normalize-OrchestratorWakeSupervisorPath -PathValue $envState) -eq $normalizedExpected
    }

    $markerDir = Get-FleetHygieneProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_WAKE_SUPERVISOR_TEST_MARKER_DIR'
    if ($markerDir) {
        return (Normalize-OrchestratorWakeSupervisorPath -PathValue $markerDir).StartsWith($normalizedExpected)
    }

    return $false
}

function Test-FleetHygieneProcessManagedForState {
    param(
        [int]$ProcessId,
        [hashtable]$Config
    )

    if (Test-FleetHygieneSupervisorIdentity -ProcessId $ProcessId `
            -ProjectId $Config.ProjectId -StateRoot $Config.StateRoot) {
        return $true
    }

    foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
        if (Test-FleetHygieneManagedChildForState -ProcessId $ProcessId `
                -Role $child.Id -StateRoot $Config.StateRoot) {
            return $true
        }
    }

    return $false
}

function Invoke-FleetHygieneAssertionH1 {
    param([hashtable]$Config)

    $candidates = Find-FleetHygieneManagedSupervisorCandidates `
        -ProjectId $Config.ProjectId -StateRoot $Config.StateRoot
    if ($candidates.Count -eq 1) {
        return New-FleetHygieneAssertionResult -Id 'H1' -Code 'H1_OK' -Pass $true `
            -Reason "exactly one supervisor (pid=$($candidates[0]))"
    }
    if ($candidates.Count -eq 0) {
        return New-FleetHygieneAssertionResult -Id 'H1' -Code 'H1_NO_SUPERVISOR' -Pass $false `
            -Reason 'no managed supervisor process for state root'
    }
    return New-FleetHygieneAssertionResult -Id 'H1' -Code 'H1_DUPLICATE_SUPERVISOR' -Pass $false `
        -Reason "duplicate supervisors: $($candidates -join ',')"
}

function Invoke-FleetHygieneAssertionH2 {
    param([hashtable]$Config)

    $adoptable = Find-FleetHygieneAdoptableProcesses -Paths $Config.Paths
    $failures = [System.Collections.Generic.List[string]]::new()

    foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
        $matches = [System.Collections.Generic.List[int]]::new()
        foreach ($procId in Get-FleetHygienePwshProcessIds) {
            if (Test-FleetHygieneManagedChildForState -ProcessId $procId `
                    -Role $child.Id -StateRoot $Config.StateRoot) {
                $matches.Add($procId) | Out-Null
            }
        }
        $unique = @($matches | Sort-Object -Unique)
        if ($unique.Count -gt 1) {
            $failures.Add("$($child.Id): $($unique -join ',')") | Out-Null
        }
    }

    if ($failures.Count -eq 0) {
        return New-FleetHygieneAssertionResult -Id 'H2' -Code 'H2_OK' -Pass $true `
            -Reason 'exactly one managed process per registry role'
    }
    return New-FleetHygieneAssertionResult -Id 'H2' -Code 'H2_DUPLICATE_ROLE' -Pass $false `
        -Reason ("duplicate role processes: {0}" -f ($failures -join '; '))
}

function Invoke-FleetHygieneAssertionH3 {
    param([hashtable]$Config)

    $unmanaged = [System.Collections.Generic.List[int]]::new()
    foreach ($procId in Get-FleetHygienePwshProcessIds) {
        if (Test-FleetHygieneVitestTestModeProcess -ProcessId $procId) {
            continue
        }
        if (-not (Test-FleetHygieneProcessRoleTaggedForState -ProcessId $procId -StateRoot $Config.StateRoot)) {
            continue
        }
        if (-not (Test-FleetHygieneProcessManagedForState -ProcessId $procId -Config $Config)) {
            $unmanaged.Add($procId) | Out-Null
        }
    }

    if ($unmanaged.Count -eq 0) {
        return New-FleetHygieneAssertionResult -Id 'H3' -Code 'H3_OK' -Pass $true `
            -Reason 'no unmanaged role-tagged pwsh for state root'
    }
    return New-FleetHygieneAssertionResult -Id 'H3' -Code 'H3_UNMANAGED_TAGGED_PWSH' -Pass $false `
        -Reason "unmanaged role-tagged pwsh: $($unmanaged -join ',')"
}

function Test-FleetHygieneSupervisorBoundToState {
    param(
        [int]$ProcessId,
        [string]$ProjectId,
        [string]$StateRoot
    )

    if ($ProcessId -le 0) { return $false }
    $tokens = Get-OrchestratorWakeSupervisorProcessCommandLineTokens -ProcessId $ProcessId
    if (-not $tokens -or $tokens.Count -eq 0) { return $false }

    $scriptInCommand = Get-OrchestratorWakeSupervisorCommandLineScriptPath -Tokens $tokens
    if (-not $scriptInCommand) { return $false }
    if ($scriptInCommand -notlike '*orchestrator-wake-supervisor.ps1') { return $false }

    $action = Get-OrchestratorWakeSupervisorCommandLineSwitchValue -Tokens $tokens -SwitchName '-Action'
    if ($action -ne 'Start') { return $false }

    $hasSupervisorLoop = Test-OrchestratorWakeSupervisorCommandLineHasSwitch -Tokens $tokens -SwitchName '-SupervisorLoop'
    $hasForeground = Test-OrchestratorWakeSupervisorCommandLineHasSwitch -Tokens $tokens -SwitchName '-Foreground'
    if (-not $hasSupervisorLoop -and -not $hasForeground) { return $false }

    $defaultProject = Get-OrchestratorWakeSupervisorDefaultProjectId
    $commandProject = Get-OrchestratorWakeSupervisorCommandLineSwitchValue -Tokens $tokens -SwitchName '-ProjectId'
    if ($commandProject) {
        if ($commandProject -ne $ProjectId) { return $false }
    }
    elseif ($ProjectId -ne $defaultProject) {
        return $false
    }

    $normalizedExpectedState = Normalize-OrchestratorWakeSupervisorPath -PathValue $StateRoot
    $commandStateDir = Get-OrchestratorWakeSupervisorCommandLineSwitchValue -Tokens $tokens -SwitchName '-StateDir'
    if ($commandStateDir) {
        $normalizedCommandState = Normalize-OrchestratorWakeSupervisorPath -PathValue $commandStateDir
        if ($normalizedCommandState -ne $normalizedExpectedState) { return $false }
    }
    else {
        $defaultStateRoot = Normalize-OrchestratorWakeSupervisorPath -PathValue (Get-OrchestratorWakeSupervisorStateRoot)
        if ($normalizedExpectedState -ne $defaultStateRoot) { return $false }
    }

    return $true
}

function Invoke-FleetHygieneAssertionH4 {
    param([hashtable]$Config)

    $foreign = [System.Collections.Generic.List[int]]::new()
    $candidates = @(
        Get-FleetHygienePwshProcessIds | Where-Object {
            Test-FleetHygieneSupervisorBoundToState -ProcessId $_ -ProjectId $Config.ProjectId -StateRoot $Config.StateRoot
        }
    )

    foreach ($procId in $candidates) {
        $tokens = Get-OrchestratorWakeSupervisorProcessCommandLineTokens -ProcessId $procId
        $scriptPath = Get-OrchestratorWakeSupervisorCommandLineScriptPath -Tokens $tokens
        if (-not $scriptPath) { continue }
        $normalizedScript = Normalize-OrchestratorWakeSupervisorPath -PathValue $scriptPath
        if (-not $normalizedScript.StartsWith($Config.PackRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $foreign.Add($procId) | Out-Null
        }
    }

    if ($foreign.Count -eq 0) {
        return New-FleetHygieneAssertionResult -Id 'H4' -Code 'H4_OK' -Pass $true `
            -Reason 'all supervisor -File paths resolve inside live pack checkout'
    }
    return New-FleetHygieneAssertionResult -Id 'H4' -Code 'H4_FOREIGN_CHECKOUT_SUPERVISOR' -Pass $false `
        -Reason "supervisor -File outside checkout: $($foreign -join ',')"
}

function Invoke-FleetHygieneAssertionH5 {
    param([hashtable]$Config)

    if ($null -ne $env:AO_FLEET_HYGIENE_STATUS_EXIT_CODE) {
        $exitCode = [int]$env:AO_FLEET_HYGIENE_STATUS_EXIT_CODE
        if ($exitCode -eq 0) {
            return New-FleetHygieneAssertionResult -Id 'H5' -Code 'H5_OK' -Pass $true `
                -Reason 'wake-supervisor Status exit 0 (fixture)'
        }
        return New-FleetHygieneAssertionResult -Id 'H5' -Code 'H5_STATUS_UNHEALTHY' -Pass $false `
            -Reason "wake-supervisor Status exit $exitCode (fixture)"
    }

    $statusScript = Join-Path $Config.PackRoot 'scripts/orchestrator-wake-supervisor.ps1'
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $statusScript `
        -Action Status -ProjectId $Config.ProjectId -StateDir $Config.StateRoot *> $null
    $exitCode = $LASTEXITCODE

    if ($exitCode -eq 0) {
        return New-FleetHygieneAssertionResult -Id 'H5' -Code 'H5_OK' -Pass $true `
            -Reason 'wake-supervisor Status exit 0'
    }
    return New-FleetHygieneAssertionResult -Id 'H5' -Code 'H5_STATUS_UNHEALTHY' -Pass $false `
        -Reason "wake-supervisor Status exit $exitCode"
}

function Invoke-FleetHygieneAssertionH6 {
    param([hashtable]$Config)

    $pwshIds = Get-FleetHygienePwshProcessIds
    $totalPwsh = if ($env:AO_FLEET_HYGIENE_PWSH_COUNT_FIXTURE -and [int]::TryParse($env:AO_FLEET_HYGIENE_PWSH_COUNT_FIXTURE, [ref]$null)) {
        [int]$env:AO_FLEET_HYGIENE_PWSH_COUNT_FIXTURE
    }
    else {
        $pwshIds.Count
    }

    $supervisorRssKb = 0L
    foreach ($procId in $pwshIds) {
        if (Test-FleetHygieneSupervisorIdentity -ProcessId $procId `
                -ProjectId $Config.ProjectId -StateRoot $Config.StateRoot) {
            $supervisorRssKb += Get-FleetHygieneProcessRssKb -ProcessId $procId
        }
    }

    $pwshOver = $totalPwsh -gt $Config.MaxPwshCount
    $rssOver = $supervisorRssKb -gt $Config.MaxSupervisorRssKb
    if (-not $pwshOver -and -not $rssOver) {
        return New-FleetHygieneAssertionResult -Id 'H6' -Code 'H6_OK' -Pass $true `
            -Reason "pwsh count=$totalPwsh supervisorRssKb=$supervisorRssKb within caps"
    }

    $parts = @()
    if ($pwshOver) { $parts += "pwsh count $totalPwsh > $($Config.MaxPwshCount)" }
    if ($rssOver) { $parts += "supervisor RSS ${supervisorRssKb}kB > $($Config.MaxSupervisorRssKb)kB" }
    return New-FleetHygieneAssertionResult -Id 'H6' -Code 'H6_CEILING_BREACH' -Pass $false `
        -Reason ($parts -join '; ')
}

function Invoke-FleetHygieneAssertionH7 {
    param([hashtable]$Config)

    $logPath = $Config.Paths.SupervisorLog
    if (-not (Test-Path -LiteralPath $logPath)) {
        return New-FleetHygieneAssertionResult -Id 'H7' -Code 'H7_OK' -Pass $true `
            -Reason 'supervisor.log absent (within cap)'
    }

    $length = (Get-Item -LiteralPath $logPath).Length
    if ($length -gt $Config.MaxSupervisorLogBytes) {
        return New-FleetHygieneAssertionResult -Id 'H7' -Code 'H7_LOG_OVERSIZE' -Pass $false `
            -Reason "supervisor.log size $length > $($Config.MaxSupervisorLogBytes) bytes"
    }

    $duplicateCount = 0
    try {
        $tail = Get-Content -LiteralPath $logPath -Tail 500 -ErrorAction Stop
        foreach ($line in $tail) {
            if ($line -match 'terminating duplicate') {
                $duplicateCount++
            }
        }
    }
    catch {
        return New-FleetHygieneAssertionResult -Id 'H7' -Code 'H7_OK' -Pass $true `
            -Reason 'supervisor.log unreadable; skipping storm check'
    }

    if ($duplicateCount -ge $Config.DuplicateLogStormMin) {
        return New-FleetHygieneAssertionResult -Id 'H7' -Code 'H7_DUPLICATE_LOG_STORM' -Pass $false `
            -Reason "supervisor.log has $duplicateCount terminating-duplicate lines in tail"
    }

    return New-FleetHygieneAssertionResult -Id 'H7' -Code 'H7_OK' -Pass $true `
        -Reason 'supervisor.log within size cap and no duplicate storm'
}

function Invoke-FleetHygieneEvaluation {
    param(
        [hashtable]$Config,
        [switch]$IncludeProcessScan
    )

    if (-not (Test-FleetHygieneLinuxProcEnvironSupported)) {
        return @{
            PlatformSupported = $false
            PlatformMessage   = Get-FleetHygieneUnsupportedPlatformMessage
            Assertions        = @()
            AllPass           = $false
        }
    }

    $assertions = @(
        Invoke-FleetHygieneAssertionH1 -Config $Config
        Invoke-FleetHygieneAssertionH2 -Config $Config
        Invoke-FleetHygieneAssertionH3 -Config $Config
        Invoke-FleetHygieneAssertionH4 -Config $Config
        Invoke-FleetHygieneAssertionH5 -Config $Config
        Invoke-FleetHygieneAssertionH6 -Config $Config
        Invoke-FleetHygieneAssertionH7 -Config $Config
    )

    $allPass = -not @($assertions | Where-Object { -not $_.Pass }).Count
    return @{
        PlatformSupported = $true
        PlatformMessage   = ''
        Assertions        = $assertions
        AllPass           = $allPass
    }
}

function Write-FleetHygieneSentinelLog {
    param(
        [string]$Message,
        [string]$LogPath
    )

    if (-not $LogPath) { return }
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
}

function Write-FleetHygieneAlert {
    param(
        [hashtable]$Config,
        [hashtable]$Evaluation
    )

    $breaches = @($Evaluation.Assertions | Where-Object { -not $_.Pass })
    if ($breaches.Count -eq 0) { return }

    $payload = @{
        timestamp = (Get-Date).ToUniversalTime().ToString('o')
        stateRoot = $Config.StateRoot
        breaches  = @($breaches | ForEach-Object {
                @{
                    id     = $_.Id
                    code   = $_.Code
                    reason = $_.Reason
                }
            })
    } | ConvertTo-Json -Compress -Depth 5

    if ($Config.AlertDestination) {
        Add-Content -LiteralPath $Config.AlertDestination -Value $payload -Encoding utf8
    }
    else {
        Write-Error $payload
    }
}

function Enter-FleetHygieneSentinelSingleton {
    param([string]$LockPath)

    if ($env:AO_FLEET_HYGIENE_SKIP_SINGLETON -eq '1') {
        return @{
            Acquired = $true
            Release  = { }
        }
    }

    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
            $stream = [System.IO.File]::Open(
                $LockPath,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
            $writer = New-Object System.IO.StreamWriter($stream)
            $writer.Write([string]$PID)
            $writer.Flush()
            $stream.Close()
            return @{
                Acquired = $true
                Release  = {
                    param($Path)
                    if (Test-Path -LiteralPath $Path) {
                        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
                    }
                }
            }
        }
        catch [System.IO.IOException] {
            if (-not (Test-Path -LiteralPath $LockPath)) { continue }
            $existingPid = 0
            try {
                $existingPid = [int](Get-Content -LiteralPath $LockPath -ErrorAction Stop | Select-Object -First 1)
            }
            catch {
                Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
                continue
            }
            if ($existingPid -gt 0 -and (Test-ProcessAlive -ProcessId $existingPid)) {
                return @{
                    Acquired = $false
                    Release  = { }
                }
            }
            Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
        }
    }

    return @{
        Acquired = $false
        Release  = { }
    }
}

function Add-FleetHygieneMockKillRecord {
    param([int]$ProcessId)

    $fixturePath = $env:AO_FLEET_HYGIENE_KILL_LOG_FIXTURE
    if (-not $fixturePath) { return }

    $existing = @()
    if (Test-Path -LiteralPath $fixturePath) {
        try {
            $parsed = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json
            if ($parsed.PSObject.Properties.Name -contains 'kills') {
                $existing = @($parsed.kills | ForEach-Object { [int]$_ })
            }
            elseif ($parsed -is [System.Array]) {
                $existing = @($parsed | ForEach-Object { [int]$_ })
            }
            else {
                $existing = @([int]$parsed)
            }
        }
        catch {
            $existing = @()
        }
    }
    $existing = @($existing) + @($ProcessId)
    (@{ kills = @($existing) } | ConvertTo-Json -Compress) | Set-Content -LiteralPath $fixturePath -Encoding utf8
}

function Invoke-FleetHygieneProcessKill {
    param(
        [hashtable]$Config,
        [int]$ProcessId,
        [string]$ManagedRole = '',
        [string]$ProjectId = '',
        [string]$StateRoot = ''
    )

    if ($env:AO_FLEET_HYGIENE_MOCK_KILL -eq '1') {
        Add-FleetHygieneMockKillRecord -ProcessId $ProcessId
        return
    }

    if ($ManagedRole -eq 'supervisor') {
        Stop-OrchestratorWakeSupervisorProcess -ProcessId $ProcessId -ManagedRole 'supervisor' `
            -ProjectId $ProjectId -StateRoot $StateRoot -LogPath $Config.SentinelLogPath
        return
    }

    if ($ManagedRole) {
        Stop-OrchestratorWakeSupervisorProcess -ProcessId $ProcessId -ManagedRole $ManagedRole `
            -LogPath $Config.SentinelLogPath
        return
    }

    if (Test-ProcessAlive -ProcessId $ProcessId) {
        & kill $ProcessId 2>$null
    }
}

function Find-FleetHygieneAdoptableProcesses {
    param([hashtable]$Paths)

    $found = @{}
    $needsScan = New-Object System.Collections.Generic.List[string]
    foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
        $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $child.Id
        $recorded = Read-OrchestratorWakeSupervisorPidFile -Path $pidFile
        if ($recorded -gt 0 -and (Test-FleetHygieneManagedProcess -ProcessId $recorded -Role $child.Id)) {
            $found[$child.Id] = $recorded
            continue
        }
        $needsScan.Add($child.Id) | Out-Null
    }

    if ($needsScan.Count -eq 0) {
        return $found
    }

    foreach ($childId in $needsScan) {
        foreach ($procId in Get-FleetHygienePwshProcessIds) {
            if (Test-FleetHygieneManagedChildForState -ProcessId $procId -Role $childId -StateRoot $Paths.Root) {
                $found[$childId] = $procId
                break
            }
        }
    }
    return $found
}

function Invoke-FleetHygieneConservativeKill {
    param(
        [hashtable]$Config,
        [array]$Assertions
    )

    $failedIds = @($Assertions | Where-Object { -not $_.Pass } | ForEach-Object { $_.Id })
    if ($failedIds.Count -eq 0) { return @() }

    $reaped = [System.Collections.Generic.List[int]]::new()
    $canonical = Resolve-FleetHygieneCanonicalSupervisorPid -Config $Config
    $adoptable = Find-FleetHygieneAdoptableProcesses -Paths $Config.Paths

    if ($failedIds -contains 'H1') {
        $candidates = Find-FleetHygieneManagedSupervisorCandidates `
            -ProjectId $Config.ProjectId -StateRoot $Config.StateRoot
        foreach ($procId in $candidates) {
            if ($canonical.Pid -gt 0 -and $procId -eq $canonical.Pid) { continue }
            if (-not (Test-FleetHygieneSupervisorIdentity -ProcessId $procId `
                    -ProjectId $Config.ProjectId -StateRoot $Config.StateRoot)) {
                continue
            }
            Invoke-FleetHygieneProcessKill -Config $Config -ProcessId $procId -ManagedRole 'supervisor' `
                -ProjectId $Config.ProjectId -StateRoot $Config.StateRoot
            $reaped.Add($procId) | Out-Null
        }
    }

    if ($failedIds -contains 'H2') {
        foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
            $matches = @()
            foreach ($procId in Get-FleetHygienePwshProcessIds) {
                if (Test-FleetHygieneManagedChildForState -ProcessId $procId `
                        -Role $child.Id -StateRoot $Config.StateRoot) {
                    $matches += $procId
                }
            }
            $unique = @($matches | Sort-Object -Unique)
            if ($unique.Count -le 1) { continue }
            $keep = if ($adoptable.ContainsKey($child.Id)) { [int]$adoptable[$child.Id] } else { $unique[0] }
            foreach ($procId in $unique) {
                if ($procId -eq $keep) { continue }
                if (-not (Test-FleetHygieneManagedProcess -ProcessId $procId -Role $child.Id)) {
                    continue
                }
                Invoke-FleetHygieneProcessKill -Config $Config -ProcessId $procId -ManagedRole $child.Id
                $reaped.Add($procId) | Out-Null
            }
        }
    }

    if ($failedIds -contains 'H3') {
        foreach ($procId in Get-FleetHygienePwshProcessIds) {
            if (Test-FleetHygieneVitestTestModeProcess -ProcessId $procId) { continue }
            if (-not (Test-FleetHygieneProcessRoleTaggedForState -ProcessId $procId -StateRoot $Config.StateRoot)) {
                continue
            }
            if (Test-FleetHygieneProcessManagedForState -ProcessId $procId -Config $Config) { continue }
            Invoke-FleetHygieneProcessKill -Config $Config -ProcessId $procId
            $reaped.Add($procId) | Out-Null
        }
    }

    return @($reaped)
}

function Format-FleetHygieneHygieneOutput {
    param([array]$Assertions)

    foreach ($assertion in $Assertions) {
        $status = if ($assertion.Pass) { 'PASS' } else { 'FAIL' }
        Write-Output ("{0} {1}: {2}" -f $status, $assertion.Id, $assertion.Reason)
    }
}
