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
        [scriptblock]$LogWriter
    )

    $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId
    if ($recovery.terminal) {
        & $LogWriter "crash backoff: $($ChildId) terminal degraded; not restarting ($($recovery.reason))"
        return @{ allowed = $false; reason = 'terminal'; recovery = $recovery }
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
        $terminalReason = "crash-loop circuit breaker: $($updatedCrash.rapidExits) rapid exits within ${rapidThresholdMs}ms lifespan threshold"
        & $LogWriter "$($ChildId) $terminalReason"
        Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates @{
            attempts       = if ($recovery.attempts) { [int]$recovery.attempts } else { 0 }
            terminal       = $true
            reason         = $terminalReason
            rapidExits     = $updatedCrash.rapidExits
            backoffUntilMs = 0
            lastExitMs     = $updatedCrash.lastExitMs
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
