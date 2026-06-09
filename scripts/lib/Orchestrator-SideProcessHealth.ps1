#requires -Version 5.1
<#
  Health / workability classification for orchestrator side-process children (Issue #248).
#>

function Get-OrchestratorSideProcessHealthDegradedThreshold {
    $fromEnv = $env:AO_SIDE_PROCESS_HEALTH_DEGRADED_THRESHOLD
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(2, [int]$fromEnv)
    }
    return 3
}

function Get-OrchestratorSideProcessHealthRecoveryMaxAttempts {
    $fromEnv = $env:AO_SIDE_PROCESS_HEALTH_RECOVERY_MAX_ATTEMPTS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1, [int]$fromEnv)
    }
    return 3
}

function Test-OrchestratorSideProcessRecoveryShouldEscalate {
    param(
        [int]$PriorRecoveryAttempts,
        [int]$MaxAttempts
    )

    return ($PriorRecoveryAttempts + 1) -gt $MaxAttempts
}

function Get-OrchestratorSideProcessRecentOutcomes {
    param($Progress)

    if (-not $Progress) { return @() }
    if ($Progress.recentOutcomes) {
        return @($Progress.recentOutcomes)
    }
    if ($Progress.tickOutcome) {
        return @([string]$Progress.tickOutcome)
    }
    if ($Progress.phase -eq 'tick_error') {
        return @('error')
    }
    if ($Progress.phase -eq 'tick_complete' -or $Progress.phase -eq 'tick_success') {
        return @('success')
    }
    return @()
}

function Test-OrchestratorSideProcessSustainedErrors {
    param(
        $Progress,
        [int]$Threshold = 0
    )

    if ($Threshold -le 0) {
        $Threshold = Get-OrchestratorSideProcessHealthDegradedThreshold
    }

    $outcomes = Get-OrchestratorSideProcessRecentOutcomes -Progress $Progress
    if ($outcomes.Count -lt $Threshold) {
        return $false
    }
    $tail = @($outcomes | Select-Object -Last $Threshold)
    return (($tail | Where-Object { $_ -eq 'error' }).Count -eq $Threshold)
}

function Get-OrchestratorSideProcessHealthVerdict {
    param(
        [Parameter(Mandatory = $true)]
        $ChildEntry,
        [Parameter(Mandatory = $true)]
        [hashtable]$Paths,
        [string]$SupervisorPhase = 'running',
        [bool]$ChildAlive = $false,
        $Progress = $null,
        [int]$ChildPid = 0,
        [int]$StallThresholdMs = 0,
        [long]$ChildStartedMs = 0
    )

    $reason = ''
    $lastError = ''
    if ($Progress) {
        if ($Progress.lastError) {
            $lastError = [string]$Progress.lastError
        }
        if ($Progress.reason) {
            $reason = [string]$Progress.reason
        }
    }

    $requiresSession = $false
    if ($ChildEntry) {
        if ($ChildEntry.RequiresOrchestratorSession) {
            $requiresSession = $true
        }
        elseif ($ChildEntry.requiresOrchestratorSession) {
            $requiresSession = [bool]$ChildEntry.requiresOrchestratorSession
        }
    }

    if ($requiresSession -and $SupervisorPhase -eq 'waiting' -and -not $ChildAlive) {
        return @{
            Status    = 'waiting'
            Reason    = 'no orchestrator session'
            LastError = ''
        }
    }

    if (-not $ChildAlive) {
        if ($requiresSession -and $SupervisorPhase -eq 'waiting') {
            return @{
                Status    = 'waiting'
                Reason    = 'no orchestrator session'
                LastError = ''
            }
        }
        return @{
            Status    = 'stopped'
            Reason    = 'process not running'
            LastError = $lastError
        }
    }

    $progressPid = 0
    if ($Progress -and $Progress.pid) {
        $progressPid = [int]$Progress.pid
    }
    $freshStart = ($ChildPid -gt 0 -and $progressPid -gt 0 -and $progressPid -ne $ChildPid)
    $hasCurrentProgress = ($Progress -and -not $freshStart)

    if ($hasCurrentProgress) {
        if (Test-OrchestratorSideProcessSustainedErrors -Progress $Progress) {
            $errorReason = if ($lastError) { $lastError } else { 'sustained tick errors' }
            return @{
                Status    = 'degraded'
                Reason    = $errorReason
                LastError = $errorReason
            }
        }

        if ($StallThresholdMs -gt 0 -and $Progress.lastProgressMs) {
            $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            $lastMs = [long]$Progress.lastProgressMs
            $phase = [string]$Progress.phase
            $isProgressPhase = $phase -in @('tick_complete', 'tick_success', 'tick_error', 'poll', 'idle', 'listening', 'side_effect')
            if ($isProgressPhase -and (($nowMs - $lastMs) -ge $StallThresholdMs)) {
                return @{
                    Status    = 'stalled'
                    Reason    = 'no fresh tick progress'
                    LastError = $lastError
                }
            }
        }

        if ($Progress.tickOutcome -eq 'error' -or $Progress.phase -eq 'tick_error') {
            $errorReason = if ($lastError) { $lastError } else { 'recent tick error' }
            return @{
                Status    = 'working'
                Reason    = ''
                LastError = $errorReason
            }
        }
    }

    if ($StallThresholdMs -gt 0 -and $ChildStartedMs -gt 0) {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if (($nowMs - $ChildStartedMs) -ge $StallThresholdMs) {
            if (-not $hasCurrentProgress) {
                $stallReason = if ($freshStart) { 'stale progress from prior process' } else { 'no progress heartbeat' }
                return @{
                    Status    = 'stalled'
                    Reason    = $stallReason
                    LastError = $lastError
                }
            }
            if (-not $Progress.lastProgressMs) {
                return @{
                    Status    = 'stalled'
                    Reason    = 'no progress timestamp'
                    LastError = $lastError
                }
            }
        }
    }

    return @{
        Status    = 'working'
        Reason    = $reason
        LastError = $lastError
    }
}

function Format-OrchestratorSideProcessHealthLabel {
    param($Verdict)

    $status = [string]$Verdict.Status
    if ($status -eq 'degraded' -or $status -eq 'stalled') {
        $reason = [string]$Verdict.Reason
        if ($reason) {
            return "$status ($reason)"
        }
    }
    return $status
}
