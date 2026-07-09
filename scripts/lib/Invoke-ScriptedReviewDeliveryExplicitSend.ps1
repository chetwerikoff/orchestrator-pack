#requires -Version 5.1
<#
  Shared explicit journaled-worker-send path for scripted review delivery (Issues #669/#683).
#>

function Invoke-ScriptedReviewDeliveryExplicitSend {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][string]$RunId,
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$TargetSha,
        [Parameter(Mandatory = $true)][string]$ProjectId,
        [Parameter(Mandatory = $true)][string]$MessageText,
        [Parameter(Mandatory = $true)][string]$GateFilterCli,
        [Parameter(Mandatory = $true)][string]$LogPrefix,
        [Parameter(Mandatory = $true)][string]$ChildId,
        [Parameter(Mandatory = $true)][hashtable]$PollStepBase,
        [Parameter(Mandatory = $true)][scriptblock]$GetOpenPrs,
        [Parameter(Mandatory = $true)][scriptblock]$GetSessions,
        [Parameter(Mandatory = $true)][scriptblock]$FindSession,
        [Parameter(Mandatory = $true)][scriptblock]$WriteLog,
        [Parameter(Mandatory = $true)][scriptblock]$OnEscalation,
        [switch]$DryRun
    )

    $openPrs = & $GetOpenPrs
    $sessions = & $GetSessions
    $session = & $FindSession $sessions
    $step = Invoke-MechanicalNodeFilterCli -FilterCliPath $GateFilterCli -Subcommand 'poll-step' `
        -Payload ($PollStepBase + @{
            reviews     = @()
            session     = $session
            openPrs     = @($openPrs)
            startedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            nowMs       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }) -Label $LogPrefix -JsonDepth 30
    $liveness = $step.liveness
    if ($liveness.liveness -ne 'live_head_owning') {
        return & $OnEscalation ([string]$liveness.reason) ''
    }

    if ($DryRun) {
        & $WriteLog "dry-run would send explicit review findings to $SessionId (PR #$PrNumber run=$RunId)"
        return @{ action = 'send'; sent = $false; reason = 'dry_run' }
    }

    $cycleKey = "run:$RunId"
    $resolve = Resolve-WorkerNudgeTargetFromPrClaim -PrNumber $PrNumber -SessionId $SessionId `
        -HeadSha $TargetSha -ProjectId $ProjectId -OpenPrs $openPrs
    if (-not $resolve.ok) {
        return & $OnEscalation ([string]$resolve.reason) ''
    }
    $claim = Acquire-WorkerNudgeClaim -PrNumber $PrNumber -CycleKey $cycleKey -IntentClass 'review-findings' `
        -WorkerTarget $resolve.workerTarget -SessionId $SessionId `
        -Surface $LogPrefix -ProjectId $ProjectId -Message $MessageText
    if (-not $claim.acquired) {
        return & $OnEscalation ([string]$claim.reason) ''
    }

    $hashResult = Invoke-WorkerNudgeFilterCli -Subcommand 'hashMessageContent' -Payload @{ message = $MessageText }
    $hashPersist = Set-WorkerNudgeClaimMessageContentHash -ClaimResult $claim -MessageContentHash ([string]$hashResult.messageContentHash)
    if (-not $hashPersist.ok) {
        Release-WorkerNudgeActiveClaim -ClaimResult $claim | Out-Null
        return & $OnEscalation 'message_hash_persist_failed' ([string]$hashPersist.reason)
    }
    $claimToken = New-WorkerNudgeClaimToken -ClaimResult $claim
    $journaledScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'journaled-worker-send.ps1'
    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'scripted-review-delivery-side-effect.lock'
    Write-OrchestratorSideProcessProgress -ChildId $ChildId -Phase 'side_effect'
    $sendExitCapture = @{ exitCode = 0 }
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        $MessageText | pwsh -NoProfile -File $journaledScript $SessionId `
            -Source 'pack-send' -SourceKey "scripted-review:$RunId" `
            -ClaimToken $claimToken -GatedNudge -NoWait
        $sendExitCapture.exitCode = $LASTEXITCODE
    }
    $sendExitCode = [int]$sendExitCapture.exitCode
    if (-not $fenced.ok -or $sendExitCode -ne 0) {
        Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'FAILED_DEFINITIVE' -Extra @{ exitCode = $sendExitCode } | Out-Null
        return & $OnEscalation 'explicit_send_failed' "exit=$sendExitCode"
    }
    Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'SENT' | Out-Null
    & $WriteLog "explicit send ok PR #$PrNumber session=$SessionId run=$RunId"
    return @{ action = 'send'; sent = $true; reason = 'explicit_send_dispatched'; dedupApplied = $true }
}

function Complete-ScriptedReviewDeliveryExplicitSend {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][string]$RunId,
        [string]$BatchId = '',
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$TargetSha,
        [Parameter(Mandatory = $true)][ValidateSet('approved', 'changes_requested')][string]$Verdict,
        [Parameter(Mandatory = $true)][string]$GateFilterCli,
        [Parameter(Mandatory = $true)][string]$LogPrefix,
        [Parameter(Mandatory = $true)][scriptblock]$GetReviewsPayload,
        [Parameter(Mandatory = $true)][scriptblock]$WriteLog,
        [Parameter(Mandatory = $true)][scriptblock]$OnEscalation,
        [bool]$SendSucceeded,
        [bool]$DedupApplied = $false
    )

    $classifyInput = @{
        reviews       = @()
        runId         = $RunId
        batchId       = $BatchId
        prNumber      = $PrNumber
        targetSha     = $TargetSha
        sendSucceeded = $SendSucceeded
    }
    if ($SendSucceeded -and $Verdict -eq 'changes_requested') {
        try {
            $reviewsPayload = & $GetReviewsPayload
            $classifyInput.reviews = @($reviewsPayload.reviews)
        }
        catch {
            & $WriteLog "post-send reviews read failed: $($_.Exception.Message)"
        }
    }

    $classified = Invoke-MechanicalNodeFilterCli -FilterCliPath $GateFilterCli -Subcommand 'classify-post-send' `
        -Payload $classifyInput -Label $LogPrefix -JsonDepth 30
    $composition = Invoke-MechanicalNodeFilterCli -FilterCliPath $GateFilterCli -Subcommand 'post-send' -Payload @{
        explicitSendOutcome       = [string]$classified.explicitSendOutcome
        lateAutoDeliveryConfirmed = [bool]$classified.lateAutoDeliveryConfirmed
        dedupApplied              = $DedupApplied
        dedupFailed               = $false
    } -Label $LogPrefix -JsonDepth 30

    $terminal = [string]$composition.terminal
    if ($terminal -eq 'escalate') {
        & $OnEscalation ([string]$composition.reason) '' | Out-Null
        return @{ ok = $false }
    }
    if ($terminal -eq 'dedup_or_escalate') {
        & $WriteLog "post-send late auto-delivery race; dedup applied ($($composition.reason))"
    }
    & $WriteLog "post-send complete: $terminal ($($composition.reason))"
    return @{ ok = $true; terminal = $terminal }
}
