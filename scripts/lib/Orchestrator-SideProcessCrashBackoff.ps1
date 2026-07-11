#requires -Version 5.1
<#
  Crash-loop backoff for orchestrator side-process supervisor children (Issue #205).
  Prevents unthrottled respawn when a supervised script fails immediately on every start.
#>

function Get-OrchestratorWakeSupervisorCrashRapidExitThresholdMs {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_CRASH_RAPID_EXIT_THRESHOLD_MS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1000, [int]$fromEnv)
    }
    return 5000
}

function Get-OrchestratorWakeSupervisorCrashMaxRapidExitsBeforeBackoff {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_CRASH_MAX_RAPID_EXITS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return 3
}

function Get-OrchestratorWakeSupervisorCrashTerminalRapidExits {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_CRASH_TERMINAL_RAPID_EXITS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(2, [int]$fromEnv)
    }
    return 12
}

function Get-OrchestratorWakeSupervisorCrashBaseBackoffSeconds {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_CRASH_BASE_BACKOFF_SECONDS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return 30
}

function Get-OrchestratorWakeSupervisorCrashMaxBackoffSeconds {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_CRASH_MAX_BACKOFF_SECONDS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return 600
}

function Get-OrchestratorWakeSupervisorTerminalRearmGraceSeconds {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_TERMINAL_REARM_GRACE_SECONDS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(0, [int]$fromEnv)
    }
    return 5
}

function Get-OrchestratorWakeSupervisorTerminalRearmTtlSeconds {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_TERMINAL_REARM_TTL_SECONDS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(0, [int]$fromEnv)
    }
    return 60
}

function Get-OrchestratorWakeSupervisorTerminalRearmMaxAttempts {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_TERMINAL_REARM_MAX_ATTEMPTS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return Get-OrchestratorSideProcessHealthRecoveryMaxAttempts
}

function Get-OrchestratorWakeSupervisorCurrentBootId {
    $bootPath = '/proc/sys/kernel/random/boot_id'
    try {
        if (Test-Path -LiteralPath $bootPath) {
            return [string](Get-Content -LiteralPath $bootPath -Raw -Encoding UTF8).Trim()
        }
    }
    catch {
        return ''
    }
    return ''
}

function Test-OrchestratorWakeSupervisorOutageClassTerminal {
    param($RecoveryEntry)

    return [string]$RecoveryEntry.terminalDaemonHealthClass -eq 'unhealthy-confirmed'
}

function Resolve-OrchestratorWakeSupervisorDaemonHealthPayloadClass {
    param($Health)

    $state = [string]$Health.state
    $ready = [string]$Health.ready
    $status = [string]$Health.status
    $signal = [string]$Health.health
    $unhealthy = $false

    foreach ($value in @($state, $ready, $status, $signal)) {
        $normalized = $value.Trim().ToLowerInvariant()
        if (-not $normalized) {
            continue
        }
        if ($normalized -in @('ok', 'ready', 'healthy', 'running', 'active', 'up', 'working', 'true')) {
            continue
        }
        $unhealthy = $true
        break
    }

    return @{
        class = if ($unhealthy) { 'unhealthy-confirmed' } else { 'healthy' }
        reason = if ($unhealthy) {
            "ao status reported unhealthy state (state='$state', ready='$ready', status='$status', health='$signal')"
        }
        else {
            "ao status healthy (state='$state', ready='$ready', status='$status', health='$signal')"
        }
    }
}

function Get-OrchestratorWakeSupervisorDaemonHealthClass {
    param(
        [string]$AoCommand = 'ao'
    )

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    try {
        $health = Get-AoDaemonHealthJson -AoCommand $AoCommand
        $classification = Resolve-OrchestratorWakeSupervisorDaemonHealthPayloadClass -Health $health
        return @{
            class   = [string]$classification.class
            reason  = [string]$classification.reason
            observedAtMs = $nowMs
        }
    }
    catch {
        $message = [string]$_.Exception.Message
        $stubFailure = [string]$env:AO_WAKE_SUPERVISOR_STATUS_FAILURE
        if ($stubFailure -and ((-not $message) -or ($message -match '^ao status failed \(exit ?\):\s*$'))) {
            $message = $stubFailure
        }
        $jsonStart = $message.IndexOf('{')
        if ($jsonStart -ge 0) {
            try {
                $parsed = $message.Substring($jsonStart) | ConvertFrom-Json
                $classification = Resolve-OrchestratorWakeSupervisorDaemonHealthPayloadClass -Health $parsed
                return @{
                    class = [string]$classification.class
                    reason = [string]$classification.reason
                    observedAtMs = $nowMs
                }
            }
            catch {
                # Fall through to textual classification.
            }
        }
        $normalized = $message.ToLowerInvariant()
        $unhealthyPattern = 'connection[ -]refused|econnrefused|connection[ -]reset|econnreset|reset by peer|http 5\d\d| 5\d\d|service unavailable|bad gateway|gateway timeout'
        return @{
            class   = if ($normalized -match $unhealthyPattern) { 'unhealthy-confirmed' } else { 'unknown' }
            reason  = $message
            observedAtMs = $nowMs
        }
    }
}

function New-OrchestratorWakeSupervisorTerminalEpisodeId {
    param(
        [string]$ChildId,
        [long]$NowMs
    )

    $prefix = if ($ChildId) { $ChildId } else { 'child' }
    return "$prefix-outage-$NowMs"
}

function Get-OrchestratorWakeSupervisorChildCrashBackoffFields {
    param($RecoveryEntry)

    if (-not $RecoveryEntry) {
        return @{
            rapidExits     = 0
            backoffUntilMs = 0
            lastExitMs     = 0
        }
    }

    return @{
        rapidExits     = if ($null -ne $RecoveryEntry.rapidExits) { [int]$RecoveryEntry.rapidExits } else { 0 }
        backoffUntilMs = if ($null -ne $RecoveryEntry.backoffUntilMs) { [long]$RecoveryEntry.backoffUntilMs } else { 0 }
        lastExitMs     = if ($null -ne $RecoveryEntry.lastExitMs) { [long]$RecoveryEntry.lastExitMs } else { 0 }
    }
}

function Test-OrchestratorWakeSupervisorChildRapidExit {
    param(
        [long]$ChildStartedMs,
        [long]$NowMs,
        [int]$RapidExitThresholdMs,
        [long]$ExitMs = 0
    )

    if ($ChildStartedMs -le 0) {
        return $true
    }
    $endMs = if ($ExitMs -gt $ChildStartedMs) { $ExitMs } else { $NowMs }
    return (($endMs - $ChildStartedMs) -lt $RapidExitThresholdMs)
}

function Get-OrchestratorWakeSupervisorCrashBackoffSeconds {
    param(
        [int]$RapidExits,
        [int]$MaxRapidExitsBeforeBackoff,
        [int]$BaseBackoffSeconds,
        [int]$MaxBackoffSeconds
    )

    if ($RapidExits -lt $MaxRapidExitsBeforeBackoff) {
        return 0
    }

    $exponent = [Math]::Min(10, $RapidExits - $MaxRapidExitsBeforeBackoff)
    $seconds = $BaseBackoffSeconds * [Math]::Pow(2, $exponent)
    return [int][Math]::Min($MaxBackoffSeconds, [Math]::Ceiling($seconds))
}

function Update-OrchestratorWakeSupervisorChildCrashBackoffState {
    param(
        [hashtable]$Recovery,
        [bool]$RapidExit,
        [long]$NowMs
    )

    $rapidExits = if ($Recovery.rapidExits) { [int]$Recovery.rapidExits } else { 0 }
    if ($RapidExit) {
        $rapidExits++
    }
    else {
        $rapidExits = 0
    }

    $maxBeforeBackoff = Get-OrchestratorWakeSupervisorCrashMaxRapidExitsBeforeBackoff
    $baseBackoff = Get-OrchestratorWakeSupervisorCrashBaseBackoffSeconds
    $maxBackoff = Get-OrchestratorWakeSupervisorCrashMaxBackoffSeconds
    $backoffSeconds = Get-OrchestratorWakeSupervisorCrashBackoffSeconds `
        -RapidExits $rapidExits `
        -MaxRapidExitsBeforeBackoff $maxBeforeBackoff `
        -BaseBackoffSeconds $baseBackoff `
        -MaxBackoffSeconds $maxBackoff

    $backoffUntilMs = if ($backoffSeconds -gt 0) {
        $NowMs + ($backoffSeconds * 1000)
    }
    else {
        0
    }

    return @{
        rapidExits     = $rapidExits
        backoffUntilMs = $backoffUntilMs
        lastExitMs     = $NowMs
        backoffSeconds = $backoffSeconds
    }
}

function Test-OrchestratorWakeSupervisorChildCrashRestartAllowed {
    param(
        [hashtable]$Paths,
        [string]$ChildId,
        [long]$ChildStartedMs,
        [int]$ChildPid = 0,
        [string]$AoCommand = 'ao',
        [scriptblock]$LogWriter
    )

    $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId
    if ($recovery.terminal) {
        $terminalDecision = Test-OrchestratorWakeSupervisorTerminalRearmAllowed `
            -Paths $Paths -ChildId $ChildId -AoCommand $AoCommand -LogWriter $LogWriter
        if ($terminalDecision.allowed) {
            return @{
                allowed = $true
                reason = 'terminal_rearm'
                recovery = $terminalDecision.recovery
                rearmReason = $terminalDecision.rearmReason
            }
        }
        & $LogWriter "crash backoff: $($ChildId) terminal degraded; not restarting ($($terminalDecision.reasonDetail))"
        return @{ allowed = $false; reason = 'terminal'; recovery = $terminalDecision.recovery }
    }

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $crashFields = Get-OrchestratorWakeSupervisorChildCrashBackoffFields -RecoveryEntry $recovery
    if ($crashFields.backoffUntilMs -gt $nowMs) {
        $waitSeconds = [Math]::Ceiling(($crashFields.backoffUntilMs - $nowMs) / 1000.0)
        & $LogWriter "crash backoff: $($ChildId) waiting ${waitSeconds}s before restart (rapidExits=$($crashFields.rapidExits))"
        # Stamp the first observed exit for this child generation once; do not slide lastExitMs on
        # every poll or rapid-exit math treats backoff end as the exit and resets rapidExits.
        $needsExitStamp = $false
        if ($ChildStartedMs -gt 0) {
            $needsExitStamp = ($crashFields.lastExitMs -lt $ChildStartedMs)
        }
        elseif ($crashFields.lastExitMs -eq 0) {
            $needsExitStamp = $true
        }
        if ($needsExitStamp) {
            Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates @{
                lastExitMs = $nowMs
            })
        }
        return @{ allowed = $false; reason = 'backoff'; recovery = $recovery; waitSeconds = $waitSeconds }
    }

    $rapidThresholdMs = Get-OrchestratorWakeSupervisorCrashRapidExitThresholdMs
    $exitMs = $nowMs
    if ($crashFields.lastExitMs -gt $ChildStartedMs) {
        $exitMs = $crashFields.lastExitMs
    }
    $rapidExit = Test-OrchestratorWakeSupervisorChildRapidExit `
        -ChildStartedMs $ChildStartedMs -NowMs $nowMs -RapidExitThresholdMs $rapidThresholdMs -ExitMs $exitMs
    if (-not $rapidExit -and $Paths -and $ChildId) {
        $progress = Read-OrchestratorWakeSupervisorChildProgress -Paths $Paths -ChildId $ChildId
        $hasCurrentProgress = Test-OrchestratorSideProcessProgressBelongsToChildGeneration `
            -Progress $progress -ChildPid $ChildPid -ChildStartedMs $ChildStartedMs
        if (-not $hasCurrentProgress) {
            $rapidExit = $true
        }
    }
    $updatedCrash = Update-OrchestratorWakeSupervisorChildCrashBackoffState `
        -Recovery $crashFields -RapidExit $rapidExit -NowMs $nowMs

    $terminalRapidExits = Get-OrchestratorWakeSupervisorCrashTerminalRapidExits
    if ($updatedCrash.rapidExits -ge $terminalRapidExits) {
        $probe = Get-OrchestratorWakeSupervisorDaemonHealthClass -AoCommand $AoCommand
        $priorEpisodeId = [string]$recovery.terminalEpisodeId
        $priorAttempts = if ($null -ne $recovery.terminalRearmAttempts) { [int]$recovery.terminalRearmAttempts } else { 0 }
        $episodeId = ''
        if ($probe.class -eq 'unhealthy-confirmed') {
            if ($priorEpisodeId) {
                $episodeId = $priorEpisodeId
            }
            else {
                $episodeId = New-OrchestratorWakeSupervisorTerminalEpisodeId -ChildId $ChildId -NowMs $nowMs
            }
        }
        $terminalReason = "crash-loop circuit breaker: $($updatedCrash.rapidExits) rapid exits within ${rapidThresholdMs}ms lifespan threshold"
        & $LogWriter "$($ChildId) $terminalReason"
        Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates @{
            attempts       = if ($recovery.attempts) { [int]$recovery.attempts } else { 0 }
            terminal       = $true
            reason         = $terminalReason
            rapidExits     = $updatedCrash.rapidExits
            backoffUntilMs = 0
            lastExitMs     = $updatedCrash.lastExitMs
            terminalDaemonHealthClass = [string]$probe.class
            terminalAtMs = $nowMs
            terminalBootId = Get-OrchestratorWakeSupervisorCurrentBootId
            terminalEpisodeId = $episodeId
            terminalRearmAttempts = $priorAttempts
            lastDaemonHealthClass = [string]$probe.class
            lastDaemonHealthObservedAtMs = [long]$probe.observedAtMs
            lastTerminalRearmMs = if ($null -ne $recovery.lastTerminalRearmMs) { [long]$recovery.lastTerminalRearmMs } else { 0 }
        })
        return @{ allowed = $false; reason = 'circuit_breaker'; recovery = $recovery }
    }

    if ($updatedCrash.backoffSeconds -gt 0) {
        & $LogWriter "crash backoff: $($ChildId) rapidExits=$($updatedCrash.rapidExits); next restart in $($updatedCrash.backoffSeconds)s"
        Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates @{
            attempts       = if ($recovery.attempts) { [int]$recovery.attempts } else { 0 }
            terminal       = $false
            reason         = if ($recovery.reason) { [string]$recovery.reason } else { '' }
            rapidExits     = $updatedCrash.rapidExits
            backoffUntilMs = $updatedCrash.backoffUntilMs
            lastExitMs     = $updatedCrash.lastExitMs
        })
        return @{
            allowed    = $false
            reason     = 'backoff_scheduled'
            recovery   = $recovery
            rapidExits = $updatedCrash.rapidExits
        }
    }

    Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates @{
        attempts       = if ($recovery.attempts) { [int]$recovery.attempts } else { 0 }
        terminal       = $false
        reason         = if ($recovery.reason) { [string]$recovery.reason } else { '' }
        rapidExits     = $updatedCrash.rapidExits
        backoffUntilMs = $updatedCrash.backoffUntilMs
        lastExitMs     = $updatedCrash.lastExitMs
    })

    return @{ allowed = $true; reason = 'restart'; rapidExit = $rapidExit; rapidExits = $updatedCrash.rapidExits }
}

function Test-OrchestratorWakeSupervisorTerminalRearmAllowed {
    param(
        [hashtable]$Paths,
        [string]$ChildId,
        [string]$AoCommand = 'ao',
        [scriptblock]$LogWriter
    )

    $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId
    if (-not $recovery.terminal) {
        return @{ allowed = $false; reason = 'not_terminal'; reasonDetail = 'not terminal'; recovery = $recovery }
    }

    $probe = Get-OrchestratorWakeSupervisorDaemonHealthClass -AoCommand $AoCommand
    $updates = @{
        lastDaemonHealthClass = [string]$probe.class
        lastDaemonHealthObservedAtMs = [long]$probe.observedAtMs
    }
    $reasonDetail = [string]$probe.reason

    if (-not (Test-OrchestratorWakeSupervisorOutageClassTerminal -RecoveryEntry $recovery)) {
        Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (
            Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates $updates
        )
        return @{ allowed = $false; reason = 'non_outage_terminal'; reasonDetail = "terminal provenance '$($recovery.terminalDaemonHealthClass)' is not auto-reclaimable"; recovery = $recovery }
    }

    if ($probe.class -ne 'healthy') {
        Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (
            Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates $updates
        )
        return @{ allowed = $false; reason = 'daemon_not_healthy'; reasonDetail = $reasonDetail; recovery = $recovery }
    }

    $nowMs = [long]$probe.observedAtMs
    $graceMs = (Get-OrchestratorWakeSupervisorTerminalRearmGraceSeconds) * 1000
    $ttlMs = (Get-OrchestratorWakeSupervisorTerminalRearmTtlSeconds) * 1000
    $terminalAtMs = if ($null -ne $recovery.terminalAtMs) { [long]$recovery.terminalAtMs } else { 0 }
    $lastHealthClass = if ($recovery.lastDaemonHealthClass) { [string]$recovery.lastDaemonHealthClass } else { [string]$recovery.terminalDaemonHealthClass }
    $currentBootId = Get-OrchestratorWakeSupervisorCurrentBootId
    $bootEligible = $false
    if ($currentBootId -and [string]$recovery.terminalBootId) {
        $bootEligible = ($currentBootId -ne [string]$recovery.terminalBootId)
    }
    $gracePassed = ($terminalAtMs -le 0) -or (($nowMs - $terminalAtMs) -ge $graceMs)
    $ageEligible = $gracePassed -and $ttlMs -gt 0 -and $terminalAtMs -gt 0 -and (($nowMs - $terminalAtMs) -ge $ttlMs)
    $edgeEligible = $gracePassed -and $lastHealthClass -ne 'healthy'

    if (-not ($edgeEligible -or $ageEligible -or $bootEligible)) {
        Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (
            Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates $updates
        )
        return @{ allowed = $false; reason = 'predicate_not_met'; reasonDetail = 'no outage recovery edge, TTL expiry, or boot-id reclaim predicate matched'; recovery = $recovery }
    }

    $attempts = if ($null -ne $recovery.terminalRearmAttempts) { [int]$recovery.terminalRearmAttempts } else { 0 }
    $maxAttempts = Get-OrchestratorWakeSupervisorTerminalRearmMaxAttempts
    if ($attempts -ge $maxAttempts) {
        Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (
            Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates $updates
        )
        return @{ allowed = $false; reason = 'attempt_cap'; reasonDetail = "re-arm attempt cap reached ($attempts/$maxAttempts)"; recovery = $recovery }
    }

    $rearmReason = if ($bootEligible) {
        'boot_id_reclaim'
    }
    elseif ($ageEligible -and -not $edgeEligible) {
        'terminal_ttl_reclaim'
    }
    else {
        'health_recovery'
    }
    $episodeId = if ($recovery.terminalEpisodeId) {
        [string]$recovery.terminalEpisodeId
    }
    else {
        New-OrchestratorWakeSupervisorTerminalEpisodeId -ChildId $ChildId -NowMs $nowMs
    }
    $updates.terminalEpisodeId = $episodeId
    $updates.terminalRearmAttempts = $attempts + 1
    $updates.lastTerminalRearmMs = $nowMs

    Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (
        Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates $updates
    )
    if ($LogWriter) {
        & $LogWriter "terminal re-arm: $ChildId eligible via $rearmReason (attempt $($attempts + 1)/$maxAttempts)"
    }
    return @{
        allowed = $true
        reason = 'terminal_rearm'
        reasonDetail = $rearmReason
        rearmReason = $rearmReason
        recovery = $recovery
    }
}
