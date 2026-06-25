#requires -Version 5.1
<#
  Degraded-alive backoff, repeated-reason circuit breaker, and deterministic terminal
  classification for orchestrator side-process supervisor children (Issue #450).
#>

function Get-OrchestratorWakeSupervisorDegradedStableWorkingPolls {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_DEGRADED_STABLE_WORKING_POLLS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return 2
}

function Get-OrchestratorWakeSupervisorDegradedBaseBackoffSeconds {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return Get-OrchestratorWakeSupervisorCrashBaseBackoffSeconds
}

function Get-OrchestratorWakeSupervisorDegradedMaxBackoffSeconds {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_DEGRADED_MAX_BACKOFF_SECONDS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return Get-OrchestratorWakeSupervisorCrashMaxBackoffSeconds
}

function Get-OrchestratorWakeSupervisorDegradedMaxAttemptsBeforeBackoff {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return 1
}

function Get-OrchestratorWakeSupervisorDegradedRepeatedReasonThreshold {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_DEGRADED_REPEATED_REASON_THRESHOLD
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(2, [int]$fromEnv)
    }
    return 3
}

function Get-OrchestratorWakeSupervisorDegradedRepeatedReasonWindowMs {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_DEGRADED_REPEATED_REASON_WINDOW_MS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1000, [int]$fromEnv)
    }
    return 60000
}

function Get-OrchestratorWakeSupervisorDeterministicTerminalAttempts {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_DEGRADED_DETERMINISTIC_TERMINAL_ATTEMPTS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return Get-OrchestratorSideProcessHealthRecoveryMaxAttempts
}

function Get-OrchestratorWakeSupervisorChildDegradedBackoffFields {
    param($RecoveryEntry)

    if (-not $RecoveryEntry) {
        return @{
            degradedAttempts             = 0
            degradedBackoffUntilMs       = 0
            lastDegradedReason             = ''
            repeatedReasonCount            = 0
            repeatedReasonWindowStartMs    = 0
            stableWorkingPolls             = 0
            deterministicReasonStreak      = 0
            failureClass                   = ''
        }
    }

    return @{
        degradedAttempts             = if ($null -ne $RecoveryEntry.degradedAttempts) { [int]$RecoveryEntry.degradedAttempts } else { 0 }
        degradedBackoffUntilMs       = if ($null -ne $RecoveryEntry.degradedBackoffUntilMs) { [long]$RecoveryEntry.degradedBackoffUntilMs } else { 0 }
        lastDegradedReason             = if ($RecoveryEntry.lastDegradedReason) { [string]$RecoveryEntry.lastDegradedReason } else { '' }
        repeatedReasonCount            = if ($null -ne $RecoveryEntry.repeatedReasonCount) { [int]$RecoveryEntry.repeatedReasonCount } else { 0 }
        repeatedReasonWindowStartMs    = if ($null -ne $RecoveryEntry.repeatedReasonWindowStartMs) { [long]$RecoveryEntry.repeatedReasonWindowStartMs } else { 0 }
        stableWorkingPolls             = if ($null -ne $RecoveryEntry.stableWorkingPolls) { [int]$RecoveryEntry.stableWorkingPolls } else { 0 }
        deterministicReasonStreak      = if ($null -ne $RecoveryEntry.deterministicReasonStreak) { [int]$RecoveryEntry.deterministicReasonStreak } else { 0 }
        failureClass                   = if ($RecoveryEntry.failureClass) { [string]$RecoveryEntry.failureClass } else { '' }
    }
}

function Test-OrchestratorWakeSupervisorDegradedReasonIsDependencyLike {
    param([string]$Reason)

    if (-not $Reason) { return $false }
    return $Reason -match '(?i)rate limit|gh pr list|graphql|fence|untrusted|401|403|timeout|exhausted'
}

function Get-OrchestratorWakeSupervisorDegradedBackoffSeconds {
    param(
        [int]$DegradedAttempts,
        [int]$MaxAttemptsBeforeBackoff,
        [int]$BaseBackoffSeconds,
        [int]$MaxBackoffSeconds
    )

    if ($DegradedAttempts -lt $MaxAttemptsBeforeBackoff) {
        return 0
    }

    $exponent = [Math]::Min(10, $DegradedAttempts - $MaxAttemptsBeforeBackoff)
    $seconds = $BaseBackoffSeconds * [Math]::Pow(2, $exponent)
    return [int][Math]::Min($MaxBackoffSeconds, [Math]::Ceiling($seconds))
}

function Merge-OrchestratorWakeSupervisorChildRecoveryEntry {
    param(
        [hashtable]$Recovery,
        [hashtable]$Updates
    )

    $merged = @{}
    foreach ($key in $Recovery.Keys) {
        $merged[$key] = $Recovery[$key]
    }
    foreach ($key in $Updates.Keys) {
        $merged[$key] = $Updates[$key]
    }
    return $merged
}

function Update-OrchestratorWakeSupervisorChildDegradedRepeatedReasonState {
    param(
        [hashtable]$Fields,
        [string]$Reason,
        [long]$NowMs
    )

    $threshold = Get-OrchestratorWakeSupervisorDegradedRepeatedReasonThreshold
    $windowMs = Get-OrchestratorWakeSupervisorDegradedRepeatedReasonWindowMs
    $normalizedReason = if ($Reason) { $Reason } else { 'degraded' }

    if ($Fields.lastDegradedReason -eq $normalizedReason -and $Fields.repeatedReasonWindowStartMs -gt 0) {
        $age = $NowMs - $Fields.repeatedReasonWindowStartMs
        if ($age -le $windowMs) {
            return @{
                lastDegradedReason          = $normalizedReason
                repeatedReasonCount         = $Fields.repeatedReasonCount + 1
                repeatedReasonWindowStartMs = $Fields.repeatedReasonWindowStartMs
                circuitBreakerEngaged       = (($Fields.repeatedReasonCount + 1) -ge $threshold)
            }
        }
    }

    return @{
        lastDegradedReason          = $normalizedReason
        repeatedReasonCount         = 1
        repeatedReasonWindowStartMs = $NowMs
        circuitBreakerEngaged       = $false
    }
}

function Test-OrchestratorWakeSupervisorChildDegradedRestartAllowed {
    param(
        [hashtable]$Paths,
        [string]$ChildId,
        [string]$DegradedReason,
        [string]$FailureClass = '',
        [scriptblock]$LogWriter
    )

    $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId
    if ($recovery.terminal) {
        & $LogWriter "degraded backoff: $($ChildId) terminal degraded; not restarting ($($recovery.reason))"
        return @{ allowed = $false; reason = 'terminal'; recovery = $recovery }
    }

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $fields = Get-OrchestratorWakeSupervisorChildDegradedBackoffFields -RecoveryEntry $recovery
    $normalizedReason = if ($DegradedReason) { $DegradedReason } else { 'degraded' }
    $resolvedFailureClass = if ($FailureClass) { $FailureClass } else { $fields.failureClass }

    if ($fields.degradedBackoffUntilMs -gt $nowMs) {
        $waitSeconds = [Math]::Ceiling(($fields.degradedBackoffUntilMs - $nowMs) / 1000.0)
        & $LogWriter "degraded backoff: $($ChildId) waiting ${waitSeconds}s before restart (degradedAttempts=$($fields.degradedAttempts))"
        return @{ allowed = $false; reason = 'backoff'; recovery = $recovery; waitSeconds = $waitSeconds }
    }

    if ($resolvedFailureClass -eq 'deterministic') {
        $streak = if ($fields.lastDegradedReason -eq $normalizedReason) {
            $fields.deterministicReasonStreak + 1
        }
        else {
            1
        }
        $maxDeterministic = Get-OrchestratorWakeSupervisorDeterministicTerminalAttempts
        if ($streak -gt $maxDeterministic) {
            $terminalReason = "deterministic defect exhausted after $maxDeterministic attempts: $normalizedReason"
            & $LogWriter "$($ChildId) terminal degraded: $terminalReason"
            Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates @{
                    terminal                  = $true
                    reason                    = $terminalReason
                    deterministicReasonStreak = $streak
                    lastDegradedReason        = $normalizedReason
                    failureClass              = 'deterministic'
                })
            return @{ allowed = $false; reason = 'deterministic_terminal'; recovery = $recovery }
        }
    }

    $reasonState = Update-OrchestratorWakeSupervisorChildDegradedRepeatedReasonState `
        -Fields $fields -Reason $normalizedReason -NowMs $nowMs
    if ($reasonState.circuitBreakerEngaged) {
        if (Test-OrchestratorWakeSupervisorDegradedReasonIsDependencyLike -Reason $normalizedReason) {
            & $LogWriter "degraded backoff: $($ChildId) repeated dependency-like reason; circuit breaker engaged"
        }
        else {
            & $LogWriter "degraded backoff: $($ChildId) repeated reason circuit breaker engaged"
        }
    }

    $nextDegradedAttempts = $fields.degradedAttempts + 1
    $maxBeforeBackoff = Get-OrchestratorWakeSupervisorDegradedMaxAttemptsBeforeBackoff
    $baseBackoff = Get-OrchestratorWakeSupervisorDegradedBaseBackoffSeconds
    $maxBackoff = Get-OrchestratorWakeSupervisorDegradedMaxBackoffSeconds
    $backoffSeconds = Get-OrchestratorWakeSupervisorDegradedBackoffSeconds `
        -DegradedAttempts $nextDegradedAttempts `
        -MaxAttemptsBeforeBackoff $maxBeforeBackoff `
        -BaseBackoffSeconds $baseBackoff `
        -MaxBackoffSeconds $maxBackoff
    if ($reasonState.circuitBreakerEngaged -and $backoffSeconds -eq 0) {
        $backoffSeconds = $baseBackoff
    }

    $backoffUntilMs = if ($backoffSeconds -gt 0) {
        $nowMs + ($backoffSeconds * 1000)
    }
    else {
        0
    }

    $deterministicStreak = if ($resolvedFailureClass -eq 'deterministic' -and $fields.lastDegradedReason -eq $normalizedReason) {
        $fields.deterministicReasonStreak + 1
    }
    elseif ($resolvedFailureClass -eq 'deterministic') {
        1
    }
    else {
        0
    }

    Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates @{
            attempts                    = if ($recovery.attempts) { [int]$recovery.attempts } else { 0 }
            terminal                    = $false
            reason                      = $normalizedReason
            degradedAttempts            = $nextDegradedAttempts
            degradedBackoffUntilMs      = $backoffUntilMs
            lastDegradedReason          = $reasonState.lastDegradedReason
            repeatedReasonCount         = $reasonState.repeatedReasonCount
            repeatedReasonWindowStartMs = $reasonState.repeatedReasonWindowStartMs
            stableWorkingPolls          = 0
            deterministicReasonStreak   = $deterministicStreak
            failureClass                = $resolvedFailureClass
        })

    if ($backoffSeconds -gt 0) {
        & $LogWriter "degraded backoff: $($ChildId) degradedAttempts=$nextDegradedAttempts; next restart in ${backoffSeconds}s"
    }

    return @{
        allowed          = $true
        reason           = 'restart'
        degradedAttempts = $nextDegradedAttempts
        backoffSeconds   = $backoffSeconds
        recovery         = $recovery
    }
}

function Update-OrchestratorWakeSupervisorChildStableWorkingRecovery {
    param(
        [hashtable]$Paths,
        [string]$ChildId
    )

    $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId
    $fields = Get-OrchestratorWakeSupervisorChildDegradedBackoffFields -RecoveryEntry $recovery
    $hasDegradedState = ($fields.degradedAttempts -gt 0) -or ($fields.degradedBackoffUntilMs -gt 0) `
        -or $fields.lastDegradedReason -or ($fields.repeatedReasonCount -gt 0)

    if (-not $hasDegradedState) {
        Reset-OrchestratorWakeSupervisorChildCrashRecoveryState -Paths $Paths -ChildId $ChildId
        if ($fields.stableWorkingPolls -gt 0) {
            Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates @{
                    stableWorkingPolls = 0
                })
        }
        return
    }

    $stablePolls = $fields.stableWorkingPolls + 1
    $threshold = Get-OrchestratorWakeSupervisorDegradedStableWorkingPolls
    if ($stablePolls -ge $threshold) {
        Clear-OrchestratorWakeSupervisorChildDegradedRecoveryState -Paths $Paths -ChildId $ChildId
        Reset-OrchestratorWakeSupervisorChildCrashRecoveryState -Paths $Paths -ChildId $ChildId
        return
    }

    Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates @{
            stableWorkingPolls = $stablePolls
        })
}

function Clear-OrchestratorWakeSupervisorChildDegradedRecoveryState {
    param(
        [hashtable]$Paths,
        [string]$ChildId
    )

    $recovery = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId
    $fields = Get-OrchestratorWakeSupervisorChildDegradedBackoffFields -RecoveryEntry $recovery
    if ($fields.degradedAttempts -eq 0 -and $fields.degradedBackoffUntilMs -eq 0 -and -not $fields.lastDegradedReason `
            -and $fields.repeatedReasonCount -eq 0 -and $fields.stableWorkingPolls -eq 0 `
            -and $fields.deterministicReasonStreak -eq 0 -and -not $fields.failureClass) {
        return
    }

    Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $Paths -ChildId $ChildId -RecoveryEntry (Merge-OrchestratorWakeSupervisorChildRecoveryEntry -Recovery $recovery -Updates @{
            attempts                    = 0
            terminal                    = $false
            reason                      = ''
            degradedAttempts            = 0
            degradedBackoffUntilMs      = 0
            lastDegradedReason          = ''
            repeatedReasonCount         = 0
            repeatedReasonWindowStartMs = 0
            stableWorkingPolls          = 0
            deterministicReasonStreak   = 0
            failureClass                = ''
        })
}

function Get-OrchestratorWakeSupervisorChildFailureClassFromProgress {
    param(
        [hashtable]$Paths,
        [string]$ChildId
    )

    $classEnvKey = "AO_WAKE_SUPERVISOR_TEST_FAILURE_CLASS_$($ChildId -replace '-', '_')"
    $fromEnv = [Environment]::GetEnvironmentVariable($classEnvKey, 'Process')
    if ($fromEnv) {
        return [string]$fromEnv
    }

    $progress = Read-OrchestratorWakeSupervisorChildProgress -Paths $Paths -ChildId $ChildId
    if ($progress -and $progress.failureClass) {
        return [string]$progress.failureClass
    }
    return ''
}

function Invoke-OrchestratorWakeSupervisorTestFaultInjection {
    param(
        [string]$ChildId,
        [ValidateSet('status-entry', 'recovery-stop')]
        [string]$Phase = 'status-entry'
    )

    $injectKey = "AO_WAKE_SUPERVISOR_TEST_INJECT_FAULT_$($ChildId -replace '-', '_')"
    $inject = [Environment]::GetEnvironmentVariable($injectKey, 'Process')
    if (-not $inject) { return }

    $expectsPhase = if ($inject -eq 'recovery-stop') { 'recovery-stop' } else { 'status-entry' }
    if ($Phase -ne $expectsPhase) { return }

    switch ($inject) {
        'status-entry' { throw "injected fault: status-entry for $ChildId" }
        'recovery-stop' { throw "injected fault: recovery-stop for $ChildId" }
        'child-entry-null' { throw (New-Object System.Management.Automation.ParameterBindingException('Cannot bind argument to parameter ''ChildEntry'' because it is null.')) }
        'redirect-disposed' { throw (New-Object System.ObjectDisposedException('TextWriter', 'Cannot write to a closed TextWriter.')) }
        default { throw "injected fault: $inject for $ChildId" }
    }
}
