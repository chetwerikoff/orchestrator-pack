#requires -Version 5.1
<#
  Marker-scoped TestMode fleet reaper with stale-predicate gating (Issue #710).
#>

function Get-TestModeFleetLiveOperatorStateRoot {
    return Normalize-OrchestratorWakeSupervisorPath -PathValue (Get-OrchestratorWakeSupervisorStateRoot)
}

function Test-TestModeFleetProcessIdentityReadable {
    param([int]$ProcessId)

    if ($ProcessId -le 0) { return $false }

    $tokens = Get-OrchestratorWakeSupervisorProcessCommandLineTokens -ProcessId $ProcessId
    if ($tokens -and $tokens.Count -gt 0) {
        return $true
    }

    if ($IsLinux) {
        $stateDir = Get-ProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_SIDE_PROCESS_STATE_DIR'
        if ($stateDir) { return $true }
        $markerDir = Get-ProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_WAKE_SUPERVISOR_TEST_MARKER_DIR'
        if ($markerDir) { return $true }
    }

    return $false
}

function Get-TestModeFleetProcessClassification {
    param([int]$ProcessId)

    $liveRoot = Get-TestModeFleetLiveOperatorStateRoot
    $stateDir = ''
    $markerDir = ''

    if ($IsLinux) {
        $stateDir = Get-ProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_SIDE_PROCESS_STATE_DIR'
        $markerDir = Get-ProcessEnvironmentValue -ProcessId $ProcessId -Name 'AO_WAKE_SUPERVISOR_TEST_MARKER_DIR'
    }

    $tokens = @(Get-OrchestratorWakeSupervisorProcessCommandLineTokens -ProcessId $ProcessId)
    $joined = if ($tokens.Count -gt 0) { $tokens -join ' ' } else { '' }
    $isTestModeSupervisor = $false
    if ($tokens.Count -gt 0) {
        $identityStateRoot = if ($stateDir) { $stateDir } else { '' }
        $isTestModeSupervisor = Test-OrchestratorWakeSupervisorSupervisorCommandLineIdentity -Tokens $tokens `
            -ProjectId (Get-OrchestratorWakeSupervisorDefaultProjectId) -StateRoot $identityStateRoot
        if (-not $isTestModeSupervisor) {
            $isTestModeSupervisor = Test-OrchestratorWakeSupervisorCommandLineHasSwitch -Tokens $tokens -SwitchName '-TestMode'
        }
    }

    $normalizedState = if ($stateDir) { Normalize-OrchestratorWakeSupervisorPath -PathValue $stateDir } else { '' }
    $normalizedMarker = if ($markerDir) { Normalize-OrchestratorWakeSupervisorPath -PathValue $markerDir } else { '' }

    if ($normalizedState -and $normalizedState -eq $liveRoot -and -not $markerDir -and -not $isTestModeSupervisor) {
        return @{
            kind        = 'live_fleet'
            stateRoot   = $normalizedState
            markerDir   = ''
            leaseId     = ''
            readable    = $true
        }
    }

    if (-not $markerDir -and -not $isTestModeSupervisor -and -not $normalizedState) {
        return @{
            kind        = 'unmarked'
            stateRoot   = ''
            markerDir   = ''
            leaseId     = ''
            readable    = ($joined.Length -gt 0)
        }
    }

    if (-not $markerDir -and -not $isTestModeSupervisor -and $normalizedState -and $normalizedState -ne $liveRoot) {
        # child linked by state root only
    }
    elseif (-not $markerDir -and -not $isTestModeSupervisor) {
        return @{
            kind        = 'unmarked'
            stateRoot   = $normalizedState
            markerDir   = ''
            leaseId     = ''
            readable    = ($joined.Length -gt 0 -or [bool]$normalizedState)
        }
    }

    $leaseId = ''
    if ($normalizedState) {
        $leaseId = Get-TestModeFleetLaneLeaseIdFromStateRoot -StateRoot $normalizedState
    }

    return @{
        kind        = if ($isTestModeSupervisor) { 'testmode_supervisor' } else { 'testmode_managed' }
        stateRoot   = $normalizedState
        markerDir   = $normalizedMarker
        leaseId     = $leaseId
        readable    = (Test-TestModeFleetProcessIdentityReadable -ProcessId $ProcessId)
        cmdline     = $joined
    }
}

function Resolve-TestModeFleetLeaseForStateRoot {
    param(
        [string]$StateRoot,
        [object[]]$LeaseRecords
    )

    if (-not $StateRoot) { return $null }
    $normalized = Normalize-OrchestratorWakeSupervisorPath -PathValue $StateRoot
    foreach ($record in @($LeaseRecords)) {
        foreach ($root in @($record.stateRoots)) {
            if ((Normalize-OrchestratorWakeSupervisorPath -PathValue ([string]$root)) -eq $normalized) {
                return $record
            }
        }
        $linkId = Get-TestModeFleetLaneLeaseIdFromStateRoot -StateRoot $normalized
        if ($linkId -and [string]$record.leaseId -eq $linkId) {
            return $record
        }
    }
    return $null
}

function Get-TestModeFleetReaperCandidateProcesses {
    $candidates = [System.Collections.Generic.List[int]]::new()
    foreach ($proc in @(Get-Process -Name 'pwsh', 'powershell' -ErrorAction SilentlyContinue)) {
        if ($IsLinux) {
            $marker = Get-ProcessEnvironmentValue -ProcessId $proc.Id -Name 'AO_WAKE_SUPERVISOR_TEST_MARKER_DIR'
            $state = Get-ProcessEnvironmentValue -ProcessId $proc.Id -Name 'AO_SIDE_PROCESS_STATE_DIR'
            if (-not $marker -and -not $state) { continue }
        }
        $candidates.Add($proc.Id) | Out-Null
    }
    return @($candidates)
}

function Get-TestModeFleetStaleLeaseRecords {
    param(
        [object[]]$LeaseRecords,
        [string]$CurrentLeaseId = ''
    )

    $stale = [System.Collections.Generic.List[object]]::new()
    foreach ($record in @($LeaseRecords)) {
        $decision = Test-TestModeFleetLeaseStale -Record $record -CurrentLeaseId $CurrentLeaseId -TreatCorruptAsStale
        if ($decision.stale -and (-not $CurrentLeaseId -or [string]$record.leaseId -ne $CurrentLeaseId)) {
            $stale.Add($record) | Out-Null
        }
    }
    return @($stale)
}

function Get-TestModeFleetReaperCandidatesForStateRoots {
    param([string[]]$StateRoots)

    if (-not $StateRoots -or $StateRoots.Count -eq 0) { return @() }
    $targets = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($root in @($StateRoots)) {
        if ($root) {
            [void]$targets.Add((Normalize-OrchestratorWakeSupervisorPath -PathValue $root))
        }
    }
    if ($targets.Count -eq 0) { return @() }

    $candidates = [System.Collections.Generic.List[int]]::new()
    foreach ($proc in @(Get-Process -Name 'pwsh', 'powershell' -ErrorAction SilentlyContinue)) {
        if ($IsLinux) {
            $state = Get-ProcessEnvironmentValue -ProcessId $proc.Id -Name 'AO_SIDE_PROCESS_STATE_DIR'
            if (-not $state) { continue }
            $normalized = Normalize-OrchestratorWakeSupervisorPath -PathValue $state
            if ($targets.Contains($normalized)) {
                $candidates.Add($proc.Id) | Out-Null
            }
            continue
        }
        $classification = Get-TestModeFleetProcessClassification -ProcessId $proc.Id
        if ($classification.stateRoot -and $targets.Contains($classification.stateRoot)) {
            $candidates.Add($proc.Id) | Out-Null
        }
    }
    return @($candidates)
}

function Get-TestModeFleetLeaseScopedStateRoots {
    param(
        [object[]]$LeaseRecords,
        [string]$LeaseId
    )

    if (-not $LeaseId) { return @() }
    $record = $LeaseRecords | Where-Object { [string]$_.leaseId -eq $LeaseId } | Select-Object -First 1
    if (-not $record) { return @() }
    return @($record.stateRoots | ForEach-Object { [string]$_ } | Where-Object { $_ })
}

function Test-TestModeFleetReaperTargetStale {
    param(
        [hashtable]$Classification,
        [object[]]$LeaseRecords,
        [string]$CurrentLeaseId,
        [string]$ScopeMode
    )

    if ($Classification.kind -in @('live_fleet', 'unmarked')) {
        return @{ allowKill = $false; reason = $Classification.kind }
    }

    if (-not $Classification.readable) {
        return @{ allowKill = $false; reason = 'unreadable_identity' }
    }

    $lease = $null
    if ($Classification.leaseId) {
        $lease = $LeaseRecords | Where-Object { [string]$_.leaseId -eq [string]$Classification.leaseId } | Select-Object -First 1
    }
    if (-not $lease -and $Classification.stateRoot) {
        $lease = Resolve-TestModeFleetLeaseForStateRoot -StateRoot $Classification.stateRoot -LeaseRecords $LeaseRecords
    }

    if (-not $lease) {
        if ($Classification.leaseId) {
            $linked = Read-TestModeFleetLeaseRecord -LeaseId ([string]$Classification.leaseId)
            if (-not $linked) {
                if ($ScopeMode -eq 'bootstrap') {
                    return @{ allowKill = $true; reason = 'corrupt_record'; leaseId = [string]$Classification.leaseId }
                }
                return @{ allowKill = $false; reason = 'corrupt_record' }
            }
            $lease = $linked
        }
        else {
            return @{ allowKill = $false; reason = 'no_lease_record' }
        }
    }

    if ($ScopeMode -in @('teardown', 'observe', 'cleanup') -and [string]$lease.leaseId -ne $CurrentLeaseId) {
        return @{ allowKill = $false; reason = 'other_lane_scope' }
    }

    if ($ScopeMode -eq 'teardown') {
        return @{ allowKill = $true; reason = 'teardown_current_lane'; leaseId = [string]$lease.leaseId }
    }

    $stale = Test-TestModeFleetLeaseStale -Record $lease -CurrentLeaseId $CurrentLeaseId -TreatCorruptAsStale
    if (-not $stale.stale) {
        return @{ allowKill = $false; reason = [string]$stale.reason }
    }

    if ($ScopeMode -eq 'bootstrap' -and [string]$lease.leaseId -eq $CurrentLeaseId) {
        return @{ allowKill = $false; reason = 'current_lane_live' }
    }

    return @{ allowKill = $true; reason = [string]$stale.reason; leaseId = [string]$lease.leaseId }
}

function Stop-TestModeFleetProcessWithToctou {
    param(
        [int]$ProcessId,
        [string]$ExpectedStartTime,
        [hashtable]$ClassificationSnapshot,
        [string]$LogPrefix = 'testmode-reaper'
    )

    if ($ProcessId -le 0) { return @{ ok = $false; reason = 'invalid_pid' } }
    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return @{ ok = $true; reason = 'already_dead' } }

    $currentStart = Get-ProcessStartTimeIdentity -ProcessId $ProcessId
    if (-not $currentStart -or $currentStart -ne $ExpectedStartTime) {
        return @{ ok = $false; reason = 'pid_reuse_drift' }
    }

    $currentClass = Get-TestModeFleetProcessClassification -ProcessId $ProcessId
    if ($currentClass.kind -ne $ClassificationSnapshot.kind) {
        return @{ ok = $false; reason = 'classification_drift' }
    }
    if ($currentClass.stateRoot -and $ClassificationSnapshot.stateRoot -and
        $currentClass.stateRoot -ne $ClassificationSnapshot.stateRoot) {
        return @{ ok = $false; reason = 'state_root_drift' }
    }

    try {
        if ($IsLinux -or $IsMacOS) {
            & kill $ProcessId 2>$null
            Start-Sleep -Milliseconds 200
            if (Test-ProcessAlive -ProcessId $ProcessId) {
                & kill -9 $ProcessId 2>$null
            }
        }
        else {
            Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        }
    }
    catch {
        return @{ ok = $false; reason = "kill_failed: $_" }
    }

  if (Test-ProcessAlive -ProcessId $ProcessId) {
        return @{ ok = $false; reason = 'still_alive' }
    }

    return @{ ok = $true; reason = 'killed' }
}

function Invoke-TestModeFleetReaper {
    param(
        [ValidateSet('bootstrap', 'teardown', 'observe', 'cleanup')]
        [string]$ScopeMode,
        [string]$CurrentLeaseId = '',
        [switch]$AllowKill
    )

    $stats = @{
        scope           = $ScopeMode
        currentLeaseId  = $CurrentLeaseId
        matched         = 0
        skipped         = 0
        killed          = 0
        failed          = 0
        skipReasons     = @{}
        killReasons     = @{}
        survivors       = @()
    }

    $leaseRecords = @(Get-TestModeFleetLeaseRecordsFromIndex)
    $candidatePids = @()
    if ($ScopeMode -eq 'bootstrap') {
        $staleLeases = @(Get-TestModeFleetStaleLeaseRecords -LeaseRecords $leaseRecords -CurrentLeaseId $CurrentLeaseId)
        $stateRoots = [System.Collections.Generic.List[string]]::new()
        foreach ($lease in $staleLeases) {
            foreach ($root in @($lease.stateRoots)) {
                if ($root) { $stateRoots.Add([string]$root) | Out-Null }
            }
        }
        $candidatePids = @(Get-TestModeFleetReaperCandidatesForStateRoots -StateRoots @($stateRoots | Select-Object -Unique))
    }
    elseif ($ScopeMode -in @('teardown', 'observe', 'cleanup') -and $CurrentLeaseId) {
        $candidatePids = @(Get-TestModeFleetReaperCandidatesForStateRoots -StateRoots (Get-TestModeFleetLeaseScopedStateRoots -LeaseRecords $leaseRecords -LeaseId $CurrentLeaseId))
        if ($candidatePids.Count -eq 0) {
            $candidatePids = @(Get-TestModeFleetReaperCandidateProcesses)
        }
    }
    else {
        $candidatePids = @(Get-TestModeFleetReaperCandidateProcesses)
    }

    foreach ($candidatePid in @($candidatePids)) {
        if ($candidatePid -eq $PID) { continue }

        $classification = Get-TestModeFleetProcessClassification -ProcessId $candidatePid
        if ($classification.kind -in @('live_fleet', 'unmarked')) {
            continue
        }

        if ($classification.kind -notin @('testmode_supervisor', 'testmode_managed')) {
            continue
        }

        $stats.matched++

        $staleDecision = Test-TestModeFleetReaperTargetStale -Classification $classification `
            -LeaseRecords $leaseRecords -CurrentLeaseId $CurrentLeaseId -ScopeMode $ScopeMode

        if ($ScopeMode -eq 'observe') {
            $linkedLeaseId = [string]$staleDecision.leaseId
            if (-not $linkedLeaseId) { $linkedLeaseId = [string]$classification.leaseId }
            if ($linkedLeaseId -eq $CurrentLeaseId -and $classification.readable) {
                $stats.survivors += $candidatePid
            }
            continue
        }

        if (-not $staleDecision.allowKill) {
            $stats.skipped++
            $reason = [string]$staleDecision.reason
            if (-not $stats.skipReasons.ContainsKey($reason)) {
                $stats.skipReasons[$reason] = 0
            }
            $stats.skipReasons[$reason]++
            continue
        }

        if (-not $AllowKill) {
            $stats.skipped++
            $reason = 'kill_disabled'
            if (-not $stats.skipReasons.ContainsKey($reason)) {
                $stats.skipReasons[$reason] = 0
            }
            $stats.skipReasons[$reason]++
            continue
        }

        $startTime = Get-ProcessStartTimeIdentity -ProcessId $candidatePid
        if (-not $startTime) {
            $stats.skipped++
            $reason = 'unreadable_identity'
            if (-not $stats.skipReasons.ContainsKey($reason)) {
                $stats.skipReasons[$reason] = 0
            }
            $stats.skipReasons[$reason]++
            continue
        }

        $killResult = Stop-TestModeFleetProcessWithToctou -ProcessId $candidatePid `
            -ExpectedStartTime $startTime -ClassificationSnapshot $classification
        if ($killResult.ok) {
            $stats.killed++
            $killReason = [string]$staleDecision.reason
            if (-not $stats.killReasons.ContainsKey($killReason)) {
                $stats.killReasons[$killReason] = 0
            }
            $stats.killReasons[$killReason]++
        }
        else {
            $stats.failed++
            $reason = [string]$killResult.reason
            if (-not $stats.skipReasons.ContainsKey($reason)) {
                $stats.skipReasons[$reason] = 0
            }
            $stats.skipReasons[$reason]++
        }
    }

    $survivorCount = @($stats.survivors).Count
    [Console]::Error.WriteLine(('[testmode-reaper] scope={0} matched={1} skipped={2} killed={3} failed={4} survivors={5}' -f $ScopeMode, $stats.matched, $stats.skipped, $stats.killed, $stats.failed, $survivorCount))
    foreach ($entry in $stats.skipReasons.GetEnumerator() | Sort-Object Name) {
        [Console]::Error.WriteLine(('[testmode-reaper] skip {0}={1}' -f [string]$entry.Key, [string]$entry.Value))
    }

    return $stats
}

function Test-TestModeFleetHeavyLaneHygiene {
    param([string]$CurrentLeaseId)

    $stats = Invoke-TestModeFleetReaper -ScopeMode 'observe' -CurrentLeaseId $CurrentLeaseId
    $survivors = @($stats.survivors)
    return @{
        ok        = ($survivors.Count -eq 0)
        survivors = $survivors
        matched   = [int]$stats.matched
        skipped   = [int]$stats.skipped
        scope     = 'observe'
        leaseId   = $CurrentLeaseId
    }
}
