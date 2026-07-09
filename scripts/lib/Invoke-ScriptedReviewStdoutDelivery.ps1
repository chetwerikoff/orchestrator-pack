#requires -Version 5.1
<#
  Stdout-first scripted review delivery orchestration (Issue #718).
#>

function Write-ScriptedReviewStdoutDeliveryLog {
    param([string]$Message)
    if ($env:AO_SCRIPTED_REVIEW_DELIVERY_DEBUG) {
        [Console]::Error.WriteLine("scripted-review-stdout-delivery: $Message")
    }
}

function Invoke-ScriptedReviewDeliveryBestEffortTelemetry {
    param(
        [int]$PrNumber,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$RepoRoot = ''
    )

    try {
        . (Join-Path $PSScriptRoot 'Invoke-AoReviewApi.ps1')
        $null = Get-AoReviewRunsFromWorkerSessions -Project $ProjectId
    }
    catch {
        Write-ScriptedReviewStdoutDeliveryLog "telemetry reviews list failed: $($_.Exception.Message)"
    }
}

function Resolve-ScriptedReviewDeliveryWorkerSession {
    param(
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$RepoRoot = '',
        [object[]]$Sessions = $null,
        [object[]]$OpenPrs = $null
    )

    . (Join-Path $PSScriptRoot 'Worker-NudgeClaim.ps1')
    . (Join-Path $PSScriptRoot 'Worker-AutonomousNudgeGate.ps1')

    if ($null -eq $OpenPrs) {
        if ($RepoRoot) {
            . (Join-Path $PSScriptRoot 'Gh-PrChecks.ps1')
            $OpenPrs = @(ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot))
        }
        else {
            $OpenPrs = @()
        }
    }
    if ($null -eq $Sessions) {
        . (Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1')
        $Sessions = @(Get-AoStatusSessions)
    }

    $ownerResolve = Invoke-WorkerNudgeFilterCli -Subcommand 'resolvePrOwnerSession' -Payload @{
        prNumber  = $PrNumber
        sessionId = ''
        headSha   = $HeadSha
        sessions  = @($Sessions)
        openPrs   = @($OpenPrs)
    }
    if (-not $ownerResolve.ok) {
        return @{ ok = $false; reason = [string]$ownerResolve.reason }
    }
    $sessionId = [string]$ownerResolve.ownerSessionId
    if (-not $sessionId) {
        return @{ ok = $false; reason = 'session_unresolved' }
    }
    return @{
        ok           = $true
        sessionId    = $sessionId
        workerTarget = @{ sessionId = $sessionId }
        openPrs      = @($OpenPrs)
    }
}

function Invoke-ScriptedReviewStdoutDeliverySend {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][string]$MessageText,
        [Parameter(Mandatory = $true)][string]$DeliveryKey,
        [Parameter(Mandatory = $true)][string]$DeliveryId,
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$TargetSha,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$FindingsHash = '',
        [int]$MaxDispatchUnknownAttempts = 3,
        [switch]$DryRun
    )

    . (Join-Path $PSScriptRoot 'Review-DeliveryLifecycle.ps1')
    . (Join-Path $PSScriptRoot 'Orchestrator-SideProcessSupervisor.ps1')
    . (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')
    . (Join-Path $PSScriptRoot 'Record-WorkerMessageDispatch.ps1')

    $journaledScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'journaled-worker-send.ps1'
    $journalPath = Get-WorkerMessageDispatchJournalPath
    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'scripted-review-stdout-delivery.lock'

    for ($attempt = 1; $attempt -le $MaxDispatchUnknownAttempts; $attempt++) {
        if ($DryRun) {
            Write-ScriptedReviewStdoutDeliveryLog "dry-run would send to $SessionId key=$DeliveryKey"
            return @{ ok = $true; sent = $false; reason = 'dry_run'; terminal = 'delivered' }
        }

        Set-ReviewDeliveryLifecycleEntry -DeliveryKey $DeliveryKey -Patch @{
            state          = 'delivery_claimed'
            deliveryId     = $DeliveryId
            sessionId      = $SessionId
            prNumber       = $PrNumber
            headSha        = $TargetSha
            findingsHash   = $FindingsHash
            claimAttempt   = $attempt
        } | Out-Null

        $register = Register-WorkerMessageDispatch `
            -SessionId $SessionId `
            -Message $MessageText `
            -Source 'pack-send' `
            -SourceKey $DeliveryKey `
            -JournalPath $journalPath `
            -DispatchOutcome 'dispatch_in_flight' `
            -HashIdentity `
            -DeliveryId $DeliveryId `
            -DeterministicDeliveryKey $DeliveryKey `
            -FindingsHash $FindingsHash
        if (-not $register.recorded) {
            Set-ReviewDeliveryLifecycleEntry -DeliveryKey $DeliveryKey -Patch @{
                terminalStatus = 'escalated'
                terminalAtMs   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                escalateReason = "journal_register_failed:$($register.reason)"
            } | Out-Null
            return @{ ok = $false; sent = $false; reason = 'journal_register_failed'; terminal = 'escalated' }
        }
        if ($register.duplicateNoOp) {
            Set-ReviewDeliveryLifecycleEntry -DeliveryKey $DeliveryKey -Patch @{
                state          = 'delivered'
                terminalStatus = 'delivered'
                terminalAtMs   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            } | Out-Null
            return @{ ok = $true; sent = $false; skipped = $true; reason = 'journal_duplicate_no_op'; terminal = 'delivered' }
        }

        $sendExitCapture = @{ exitCode = 0 }
        $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
            $MessageText | pwsh -NoProfile -File $journaledScript $SessionId `
                -Source 'pack-send' -SourceKey $DeliveryKey `
                -DeliveryId $DeliveryId -DeterministicDeliveryKey $DeliveryKey `
                -FindingsHash $FindingsHash -NoWait
            $sendExitCapture.exitCode = $LASTEXITCODE
        }
        $sendExitCode = [int]$sendExitCapture.exitCode

        Set-ReviewDeliveryLifecycleEntry -DeliveryKey $DeliveryKey -Patch @{
            state            = 'delivery_attempted'
            lastSendExitCode = $sendExitCode
            sendAttempt      = $attempt
        } | Out-Null

        if ($fenced.ok -and $sendExitCode -eq 0) {
            Set-ReviewDeliveryLifecycleEntry -DeliveryKey $DeliveryKey -Patch @{
                state          = 'delivered'
                terminalStatus = 'delivered'
                terminalAtMs   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            } | Out-Null
            return @{ ok = $true; sent = $true; reason = 'explicit_send_dispatched'; terminal = 'delivered' }
        }
        if ($sendExitCode -ne 44) {
            Set-ReviewDeliveryLifecycleEntry -DeliveryKey $DeliveryKey -Patch @{
                terminalStatus = 'escalated'
                terminalAtMs   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                escalateReason = "send_exit=$sendExitCode"
            } | Out-Null
            return @{ ok = $false; sent = $false; reason = 'explicit_send_failed'; terminal = 'escalated'; exitCode = $sendExitCode }
        }
        Write-ScriptedReviewStdoutDeliveryLog "dispatch_unknown attempt $attempt for key=$DeliveryKey"
    }

    Set-ReviewDeliveryLifecycleEntry -DeliveryKey $DeliveryKey -Patch @{
        terminalStatus = 'escalated'
        terminalAtMs   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        escalateReason = 'dispatch_unknown_exhausted'
    } | Out-Null
    return @{ ok = $false; sent = $false; reason = 'dispatch_unknown_exhausted'; terminal = 'escalated' }
}

function Invoke-ScriptedReviewStdoutDelivery {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$WrapperStdout,
        [Parameter(Mandatory = $true)][hashtable]$ParsedStdout,
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$TargetSha,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$LifecycleStorePath = '',
        [object[]]$Sessions = $null,
        [object[]]$OpenPrs = $null,
        [switch]$DryRun,
        [switch]$SkipTelemetry,
        [switch]$SimulateCrashBeforeVerdictPersist,
        [switch]$SimulateCrashAfterVerdictBeforeSend,
        [switch]$ResumeOnly
    )

    . (Join-Path $PSScriptRoot 'Invoke-ScriptedReviewPostSubmitDelivery.ps1')
    . (Join-Path $PSScriptRoot 'Review-DeliveryLifecycle.ps1')
    . (Join-Path $PSScriptRoot 'Invoke-ScriptedReviewDeliveryEscalation.ps1')

    $findings = @($ParsedStdout.findings)
    if (-not $findings -and $ParsedStdout.rawFindings) {
        $findings = @($ParsedStdout.rawFindings)
    }

    $keyResult = New-ReviewDeliveryDeterministicKey -PrNumber $PrNumber -HeadSha $TargetSha `
        -Findings $findings
    if (-not $keyResult.ok) {
        return Invoke-ScriptedReviewPostSubmitDeliveryEscalation -Reason ([string]$keyResult.reason) -PrNumber $PrNumber
    }
    $deliveryKey = [string]$keyResult.deliveryKey
    $findingsHash = [string](Invoke-ReviewDeliveryLifecycleCli -Subcommand 'hash-findings' -Payload @{
        findings = @($findings)
    }).findingsHash

    if ($SimulateCrashBeforeVerdictPersist) {
        return Invoke-ScriptedReviewPostSubmitDeliveryEscalation -Reason 'verdict_snapshot_lost' -PrNumber $PrNumber `
            -Detail "deliveryKey=$deliveryKey"
    }

    if (-not $ResumeOnly) {
        $verdictPatch = @{
            state           = 'verdict_recorded'
            prNumber        = $PrNumber
            headSha         = $TargetSha
            gateVerdict     = [string]$ParsedStdout.gateVerdict
            packVerdict     = [string]$ParsedStdout.packVerdict
            findingsHash    = $findingsHash
            stdoutSnapshot  = $WrapperStdout
            verdictSource   = 'wrapper-stdout'
        }
        if ($LifecycleStorePath) {
            Set-ReviewDeliveryLifecycleEntry -DeliveryKey $deliveryKey -Patch $verdictPatch -Path $LifecycleStorePath | Out-Null
        }
        else {
            Set-ReviewDeliveryLifecycleEntry -DeliveryKey $deliveryKey -Patch $verdictPatch | Out-Null
        }
    }

    if ($SimulateCrashAfterVerdictBeforeSend) {
        return @{ ok = $false; escalated = $false; resumed = $true; reason = 'crash_after_verdict_recorded' }
    }

    $existing = if ($LifecycleStorePath) {
        Get-ReviewDeliveryLifecycleEntry -DeliveryKey $deliveryKey -Path $LifecycleStorePath
    }
    else {
        Get-ReviewDeliveryLifecycleEntry -DeliveryKey $deliveryKey
    }
    $entry = $existing.entry
    if ($entry -and [string]$entry.terminalStatus -eq 'delivered') {
        return @{ ok = $true; skipped = $true; reason = 'already_delivered'; deliveryKey = $deliveryKey }
    }

    $sessionResolve = Resolve-ScriptedReviewDeliveryWorkerSession -PrNumber $PrNumber -HeadSha $TargetSha `
        -ProjectId $ProjectId -RepoRoot $RepoRoot -Sessions $Sessions -OpenPrs $OpenPrs
    if (-not $sessionResolve.ok) {
        Set-ReviewDeliveryLifecycleEntry -DeliveryKey $deliveryKey -Patch @{
            terminalStatus = 'escalated'
            terminalAtMs   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            escalateReason = [string]$sessionResolve.reason
        } | Out-Null
        return Invoke-ScriptedReviewPostSubmitDeliveryEscalation -Reason ([string]$sessionResolve.reason) -PrNumber $PrNumber
    }

    $sessionId = [string]$sessionResolve.sessionId
    $deliveryIdResult = New-ReviewDeliveryDeterministicDeliveryId -SessionId $sessionId -DeliveryKey $deliveryKey
    if (-not $deliveryIdResult.ok) {
        return Invoke-ScriptedReviewPostSubmitDeliveryEscalation -Reason ([string]$deliveryIdResult.reason) -PrNumber $PrNumber
    }
    $deliveryId = [string]$deliveryIdResult.deliveryId

    $message = Invoke-ScriptedReviewPostSubmitDeliveryCli -Subcommand 'build-delivery-message' -Payload @{
        prNumber    = $PrNumber
        deliveryKey = $deliveryKey
        headSha     = $TargetSha
        gateVerdict = [string]$ParsedStdout.gateVerdict
    }
    if (-not $message.ok) {
        return Invoke-ScriptedReviewPostSubmitDeliveryEscalation -Reason ([string]$message.reason) -PrNumber $PrNumber -SessionId $sessionId
    }

    $send = Invoke-ScriptedReviewStdoutDeliverySend -SessionId $sessionId `
        -MessageText ([string]$message.message) -DeliveryKey $deliveryKey -DeliveryId $deliveryId `
        -PrNumber $PrNumber -TargetSha $TargetSha -ProjectId $ProjectId -FindingsHash $findingsHash -DryRun:$DryRun

    if (-not $SkipTelemetry) {
        Invoke-ScriptedReviewDeliveryBestEffortTelemetry -PrNumber $PrNumber -ProjectId $ProjectId -RepoRoot $RepoRoot
    }

    if (-not $send.ok) {
        return Invoke-ScriptedReviewPostSubmitDeliveryEscalation -Reason ([string]$send.reason) `
            -PrNumber $PrNumber -SessionId $sessionId -Detail "deliveryKey=$deliveryKey"
    }

    return @{
        ok          = $true
        skipped     = -not [bool]$send.sent
        deliveryKey = $deliveryKey
        sessionId   = $sessionId
        deliveryId  = $deliveryId
        verdict     = [string]$ParsedStdout.gateVerdict
        terminal    = [string]$send.terminal
    }
}

function Resume-ScriptedReviewStdoutDeliveryFromLifecycle {
    param(
        [Parameter(Mandatory = $true)][string]$DeliveryKey,
        [string]$LifecycleStorePath = '',
        [string]$RepoRoot = '',
        [string]$ProjectId = 'orchestrator-pack',
        [object[]]$Sessions = $null,
        [object[]]$OpenPrs = $null,
        [switch]$DryRun
    )

    . (Join-Path $PSScriptRoot 'Review-DeliveryLifecycle.ps1')
    . (Join-Path $PSScriptRoot 'Invoke-ScriptedReviewPostSubmitDelivery.ps1')

    $entryResult = if ($LifecycleStorePath) {
        Get-ReviewDeliveryLifecycleEntry -DeliveryKey $DeliveryKey -Path $LifecycleStorePath
    }
    else {
        Get-ReviewDeliveryLifecycleEntry -DeliveryKey $DeliveryKey
    }
    $entry = $entryResult.entry
    if (-not $entry) {
        return @{ ok = $false; reason = 'lifecycle_entry_missing' }
    }
    if ([string]$entry.terminalStatus -eq 'delivered') {
        return @{ ok = $true; skipped = $true; reason = 'already_delivered' }
    }
    if ([string]$entry.state -ne 'verdict_recorded' -and [string]$entry.state -ne 'delivery_claimed' -and [string]$entry.state -ne 'delivery_attempted') {
        return @{ ok = $false; reason = 'not_resumable' }
    }

    $stdout = [string]$entry.stdoutSnapshot
    $parsedObj = Invoke-ScriptedReviewPostSubmitDeliveryCli -Subcommand 'parse-terminal-stdout' -Payload @{
        stdout = $stdout
    }
    if (-not $parsedObj.ok) {
        return @{ ok = $false; reason = [string]$parsedObj.reason }
    }
    $parsed = @{
        ok          = $true
        gateVerdict = [string]$parsedObj.gateVerdict
        packVerdict = [string]$parsedObj.packVerdict
        findings    = @($parsedObj.findings)
    }

    return Invoke-ScriptedReviewStdoutDelivery -RepoRoot $RepoRoot -WrapperStdout $stdout `
        -ParsedStdout $parsed -PrNumber ([int]$entry.prNumber) -TargetSha ([string]$entry.headSha) `
        -ProjectId $ProjectId -LifecycleStorePath $LifecycleStorePath -Sessions $Sessions -OpenPrs $OpenPrs `
        -DryRun:$DryRun -SkipTelemetry -ResumeOnly
}
