#requires -Version 5.1
<#
.SYNOPSIS
  Event-driven review run on completion wakes (Issue #207).
#>

$Script:ReviewWakeTriggerFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-wake-trigger.mjs'

. (Join-Path $PSScriptRoot 'Invoke-ReviewerWorkspacePreflight.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'Record-ReviewTriggerReevalWatch.ps1')
. (Join-Path $PSScriptRoot 'Record-ReviewHandoffWakeAdmission.ps1')
. (Join-Path $PSScriptRoot 'Review-StartClaim.ps1')

function Test-ReviewWakeTriggerForbiddenCommand {
    param([string]$CommandLine)

    Test-ReviewMechanicalForbiddenCommand -CommandLine $CommandLine

    if ($CommandLine -match '\bgh\s+pr\s+merge\b') {
        throw 'forbidden merge fragment in review wake command: gh pr merge'
    }
}

function Get-ReviewWakeTriggerSideEffectLockPath {
    param([string]$StateRoot = '')
    if ($StateRoot) {
        return Join-Path $StateRoot 'listener-side-effect.lock'
    }
    $fromEnv = $env:AO_WAKE_LISTENER_SIDE_EFFECT_LOCK
    if ($fromEnv) { return $fromEnv }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-wake-listener-side-effect.lock'
}

function Test-ReviewWakeTriggerSideEffectInFlight {
    param([string]$LockPath)
    return Test-OrchestratorSideEffectInFlight -LockPath $LockPath
}

function Enter-ReviewWakeTriggerSideEffectFence {
    param(
        [string]$LockPath,
        [hashtable]$Metadata = @{}
    )
    return Enter-OrchestratorSideEffectFence -LockPath $LockPath -Metadata $Metadata
}

function Exit-ReviewWakeTriggerSideEffectFence {
    param([string]$LockPath)
    Exit-OrchestratorSideEffectFence -LockPath $LockPath
}

function Invoke-ReviewWakeTriggerFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewWakeTriggerFilterCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-wake-trigger' -JsonDepth 30
}

function Get-ReviewWakeTriggerMergeEval {
    param(
        [int]$PrNumber,
        [hashtable]$Snapshot,
        [string]$HeadSha = '',
        [array]$ExtraReviewRuns = @()
    )

    $resolvedHeadSha = $HeadSha
    if (-not $resolvedHeadSha) {
        foreach ($pr in @($Snapshot.openPrs)) {
            if ([int]$pr.number -eq $PrNumber) {
                $resolvedHeadSha = [string]$pr.headRefOid
                break
            }
        }
    }
    if (-not $resolvedHeadSha) {
        return $null
    }

    return Invoke-ReviewWakeTriggerFilterCli -Subcommand 'mergeIntent' -Payload @{
        prNumber   = $PrNumber
        headSha    = $resolvedHeadSha
        reviewRuns = @($Snapshot.reviewRuns) + @($ExtraReviewRuns)
    }
}


function Get-ReviewWakeReconcileStatePath {
    if ($env:AO_REVIEW_TRIGGER_RECONCILE_STATE) { return $env:AO_REVIEW_TRIGGER_RECONCILE_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-reconcile-state.json'
}

function Get-ReviewWakeCycleStateFromReconcile {
    $defaults = @{ lastTickMs = $null; degradedCi = @{}; cycleState = @{} }
    $state = Get-MechanicalJsonStateFile -Path (Get-ReviewWakeReconcileStatePath) -DefaultState $defaults -ActionTracking
    if ($state.cycleState) {
        return Copy-MechanicalJsonMap -Map $state.cycleState
    }
    return @{}
}

function Get-ReviewWakeTriggerSnapshot {
    param(
        [int]$PrNumber,
        [string]$Project,
        [string]$RepoRoot,
        [hashtable]$FixtureSnapshot
    )

    if ($FixtureSnapshot) {
        return $FixtureSnapshot
    }

    $openPrs = Invoke-GhOpenPrList -RepoRoot $RepoRoot
    . (Join-Path $PSScriptRoot 'Review-PostRunRetry.ps1')
    $reviewRuns = @(Get-EnrichedAoReviewRuns -Project $Project -RepoRoot $RepoRoot)
    $sessions = Get-AoStatusSessions
    $checksBundle = Get-GhChecksBundleByPr -RepoRoot $RepoRoot -OpenPrs @(
        @($openPrs | Where-Object { [int]$_.number -eq $PrNumber })
    ) -MergeRequiredNames {
        param($payload)
        Invoke-MechanicalNodeFilterCli -FilterCliPath (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/ci-green-wake-reconcile.mjs') `
            -Subcommand 'merge-required-names' -Payload $payload -Label 'review-wake-trigger' -JsonDepth 20
    } -ProtectionLookupWarningTemplate 'warn: branch protection lookup failed PR #{0} (exit {1}); treating required CI as degraded'

    $prKey = [string]$PrNumber
    $cycleState = Get-ReviewWakeCycleStateFromReconcile
    return @{
        openPrs                       = @($openPrs)
        reviewRuns                    = @($reviewRuns)
        sessions                      = @($sessions)
        ciChecksByPr                  = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
        prKey                         = $prKey
        cycleState                    = $cycleState
        repoRoot                      = $RepoRoot
    }
}

function Invoke-ReviewWakeTriggerOnCompletionWake {
    param(
        [object]$FilterResult,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$RepoRoot = '',
        [string]$ReviewCommand = '',
        [string]$SideEffectLockPath = '',
        [string]$StateRoot = '',
        [hashtable]$FixtureSnapshot,
        [scriptblock]$ResolveFreshSnapshot,
        [switch]$DryRun,
        [long]$WakeReceivedMs = 0,
        [scriptblock]$LogWriter = { param([string]$Message) Write-Host $Message }
    )

    if (-not $FilterResult.ok) {
        return @{ triggered = $false; reason = 'filter_not_ok' }
    }

    $isCompletionWake = $FilterResult.wakeKind -eq 'merge.ready'
    $isHandoffWake = $FilterResult.wakeKind -eq 'ready_for_review'
    if (-not $isCompletionWake -and -not $isHandoffWake) {
        return @{ triggered = $false; reason = 'not_event_wake' }
    }

    $prNumber = [int]$FilterResult.prNumber
    if ($prNumber -le 0) {
        & $LogWriter 'review-wake-trigger: skip (no pr number on completion wake)'
        return @{ triggered = $false; reason = 'missing_pr_number' }
    }

    if ($isHandoffWake -and $FilterResult.handoffAdmission.auditLine) {
        & $LogWriter ([string]$FilterResult.handoffAdmission.auditLine)
    }

    $snapshot = Get-ReviewWakeTriggerSnapshot -PrNumber $prNumber -Project $ProjectId `
        -RepoRoot $RepoRoot -FixtureSnapshot $FixtureSnapshot

    if ($isHandoffWake -and $WakeReceivedMs -gt 0) {
        $wakeReceivedMs = $WakeReceivedMs
    }
    else {
        $wakeReceivedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    $prKey = if ($snapshot.prKey) { $snapshot.prKey } else { [string]$prNumber }
    $evaluatePayload = @{
        wakeKind                  = $FilterResult.wakeKind
        sessionId                 = [string]$FilterResult.sessionId
        prNumber                  = $prNumber
        wakeReceivedMs            = $wakeReceivedMs
        nowMs                     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        openPrs                   = @($snapshot.openPrs)
        reviewRuns                = @($snapshot.reviewRuns)
        sessions                  = @($snapshot.sessions)
        ciChecks                  = @($snapshot.ciChecksByPr[$prKey])
        requiredCheckNames        = @($snapshot.requiredCheckNamesByPr[$prKey])
        requiredCheckLookupFailed = [bool]$snapshot.requiredCheckLookupFailedByPr[$prKey]
    }
    if ($isHandoffWake) {
        $evaluatePayload.admittedBaseRef = [string]$FilterResult.handoffAdmission.admittedBaseRef
        $evaluatePayload.admittedHeadSha = [string]$FilterResult.handoffAdmission.admittedHeadSha
        $evaluatePayload.cycleState = if ($snapshot.cycleState) { $snapshot.cycleState } else { @{} }
        $evaluatePayload.repoRoot = [string]$snapshot.repoRoot
    }
    $evaluation = Invoke-ReviewWakeTriggerFilterCli -Subcommand 'evaluate' -Payload $evaluatePayload

    $resolvedStateRoot = if ($StateRoot) {
        $StateRoot
    }
    elseif ($SideEffectLockPath) {
        Split-Path -Parent $SideEffectLockPath
    }
    else {
        ''
    }

    if ($isHandoffWake) {
        $preSideEffectNowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $receiptBound = Test-ReviewHandoffReceiptToRunBound -WakeReceivedMs $wakeReceivedMs -RunCreatedAtMs $preSideEffectNowMs
        if (-not $receiptBound.withinBound) {
            & $LogWriter "review-wake-trigger: handoff receipt bound exceeded PR #$prNumber ($($receiptBound.receiptToRunMs)ms)"
            return @{
                triggered = $false
                reason    = 'handoff_receipt_bound_exceeded'
                mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $prNumber -Snapshot $snapshot
            }
        }
    }
    elseif (-not $evaluation.withinLatencyBound) {
        throw "review-wake-trigger exceeded wake-to-run decision bound (${evaluation.processingMs}ms)"
    }

    if ($isHandoffWake -and $resolvedStateRoot) {
        $admissionRecord = Record-ReviewHandoffWakeAdmission -StateRoot $resolvedStateRoot -FilterResult $FilterResult `
            -WakeReceivedMs $wakeReceivedMs -DryRun:$DryRun
        if ($admissionRecord.recorded) {
            & $LogWriter "review-handoff-wake: admission recorded key=$($admissionRecord.key)"
        }
    }

    if ($evaluation.route -eq 'empty_review_trap') {
        $term = [string]$evaluation.terminationReason
        & $LogWriter "review-wake-trigger: EMPTY REVIEW TRAP PR #$prNumber ($term)"
        return @{
            triggered = $false
            reason    = $evaluation.reason
            route     = $evaluation.route
            mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $prNumber -Snapshot $snapshot
        }
    }

    if (-not $evaluation.triggerReviewRun) {
        & $LogWriter "review-wake-trigger: defer PR #$prNumber ($($evaluation.reason))"
        if ($resolvedStateRoot -and $evaluation.reason -in @('uncovered_not_ready', 'ci_red_defer')) {
            $headShaForWatch = ''
            foreach ($pr in @($snapshot.openPrs)) {
                if ([int]$pr.number -eq $prNumber) {
                    $headShaForWatch = [string]$pr.headRefOid
                    break
                }
            }
            if ($headShaForWatch) {
                $deferReason = [string]$evaluation.reason
                $deferRecord = if ($deferReason -eq 'ci_red_defer') {
                    @{ primary = 'ci_red' }
                }
                else {
                    @{ primary = 'no_ready_for_review' }
                }
                $watchResult = Record-ReviewTriggerReevalWatchFromWakeDefer -StateRoot $resolvedStateRoot `
                    -PrNumber $prNumber -HeadSha $headShaForWatch -SessionId ([string]$FilterResult.sessionId) `
                    -DeferReason $deferReason -DeferRecord $deferRecord `
                    -DryRun:$DryRun
                if ($watchResult.recorded) {
                    & $LogWriter "review-wake-trigger: deferred-head watch recorded key=$($watchResult.watchKey) reason=$deferReason"
                }
            }
        }
        return @{
            triggered = $false
            reason    = $evaluation.reason
            mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $prNumber -Snapshot $snapshot
        }
    }

    $planned = $evaluation.planned
    $runArgs = @('review', 'run', $planned.sessionId, '--execute', '--command', $ReviewCommand)
    $commandLine = "ao $($runArgs -join ' ')"
    Test-ReviewWakeTriggerForbiddenCommand -CommandLine $commandLine

    $lockPath = if ($SideEffectLockPath) { $SideEffectLockPath } else { Get-ReviewWakeTriggerSideEffectLockPath }
    if (Test-ReviewWakeTriggerSideEffectInFlight -LockPath $lockPath) {
        & $LogWriter "review-wake-trigger: side-effect fence busy; skip duplicate run PR #$($planned.prNumber)"
        return @{
            triggered = $false
            reason    = 'side_effect_in_flight'
            mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $planned.prNumber -Snapshot $snapshot `
                -HeadSha $planned.headSha -ExtraReviewRuns @(@{
                    prNumber  = $planned.prNumber
                    targetSha = $planned.headSha
                    status    = 'queued'
            })
        }
    }

    $claim = @{ acquired = $true; dryRun = $true; key = "dry-run:$($planned.prNumber):$($planned.headSha)" }
    if (-not $DryRun) {
        $claimRuns = if ($FixtureSnapshot) { @($FixtureSnapshot.reviewRuns) } else { @(Get-AoReviewRuns -Project $ProjectId) }
        $claim = Acquire-ReviewStartClaim -PrNumber ([int]$planned.prNumber) -HeadSha ([string]$planned.headSha) `
            -Surface 'review-wake-trigger' -ReviewRuns $claimRuns -ProjectId $ProjectId `
            -StartReason $(if ($isHandoffWake) { 'handoff_wake' } else { 'completion_wake' }) -LogWriter $LogWriter
    }
    if (-not $claim.acquired) {
        if ($claim.escalation) {
            & $LogWriter "review-wake-trigger: ESCALATE review-start-claim PR #$($planned.prNumber) head=$($planned.headSha) key=$($claim.key): $($claim.reason) $($claim.detail)"
            return @{
                triggered = $false
                reason    = [string]$claim.reason
                mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $planned.prNumber -Snapshot $snapshot
            }
        }
        $holder = Format-ReviewStartClaimHolder -Holder $claim.holder
        & $LogWriter "review-wake-trigger: claim-skip PR #$($planned.prNumber) head=$($planned.headSha) key=$($claim.key): held by $holder reason=$($claim.reason)"
        if ($isHandoffWake) {
            Write-ReviewHandoffClaimAudit -Outcome 'claim_loss' -ClaimOutcome 'loss' -Reason ([string]$claim.reason) `
                -SessionId ([string]$FilterResult.sessionId) -PrNumber ([int]$planned.prNumber) -LogWriter $LogWriter
        }
        $mergeSnapshot = if ($claim.reason -eq 'covered_by_run') {
            if ($ResolveFreshSnapshot) {
                & $ResolveFreshSnapshot $planned
            }
            else {
                Get-ReviewWakeTriggerSnapshot -PrNumber $planned.prNumber -Project $ProjectId -RepoRoot $RepoRoot -FixtureSnapshot $FixtureSnapshot
            }
        }
        else {
            $null
        }
        return @{
            triggered = $false
            reason    = 'claim_skipped'
            mergeEval = if ($claim.reason -eq 'covered_by_run') {
                Get-ReviewWakeTriggerMergeEval -PrNumber $planned.prNumber -Snapshot $mergeSnapshot -HeadSha $planned.headSha
            }
            else {
                Get-ReviewWakeTriggerMergeEval -PrNumber $planned.prNumber -Snapshot $snapshot `
                    -HeadSha $planned.headSha -ExtraReviewRuns @(@{
                        prNumber  = $planned.prNumber
                        targetSha = $planned.headSha
                        status    = 'queued'
                    })
            }
        }
    }
    if ($claim.recovered) {
        & $LogWriter "review-wake-trigger: recovered stale review-start-claim key=$($claim.key) previous=$(Format-ReviewStartClaimHolder -Holder $claim.recoveredRecord.holder)"
    }
    if ($isHandoffWake) {
        Write-ReviewHandoffClaimAudit -Outcome 'claim_win' -ClaimOutcome 'win' -Reason 'head_ready_for_review' `
            -SessionId ([string]$FilterResult.sessionId) -PrNumber ([int]$planned.prNumber) -LogWriter $LogWriter
    }

    $holdRuns = if ($FixtureSnapshot) { @($FixtureSnapshot.reviewRuns) } else { @($claimRuns) }

    try {
        $fresh = if ($FixtureSnapshot) {
            $FixtureSnapshot
        }
        else {
            . (Join-Path $PSScriptRoot 'Get-ClaimedReviewStartSnapshot.ps1')
            $claimed = Get-ClaimedReviewStartSnapshot -PrNumber ([int]$planned.prNumber) -Project $ProjectId -RepoRoot $RepoRoot `
                -ClaimResult $claim -ResolveChecksBundle {
                param($openPrs, $prNumber, $repoRoot)
                Get-GhChecksBundleByPr -RepoRoot $repoRoot -OpenPrs @($openPrs) -MergeRequiredNames {
                    param($payload)
                    Invoke-MechanicalNodeFilterCli -FilterCliPath (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/ci-green-wake-reconcile.mjs') `
                        -Subcommand 'merge-required-names' -Payload $payload -Label 'review-wake-trigger' -JsonDepth 20
                } -ProtectionLookupWarningTemplate 'warn: branch protection lookup failed PR #{0} (exit {1}); treating required CI as degraded'
            }
            $cycleState = Get-ReviewWakeCycleStateFromReconcile
            $claimed.cycleState = $cycleState
            $claimed.repoRoot = $RepoRoot
            $claimed.prKey = [string]$planned.prNumber
            $claimed
        }
        $freshPrKey = if ($fresh.prKey) { $fresh.prKey } else { [string]$planned.prNumber }
        if (-not $FixtureSnapshot) {
            $holdRuns = @($fresh.reviewRuns)
        }
        $plannedStartReason = if ($planned.startReason) {
            [string]$planned.startReason
        }
        elseif ($isHandoffWake) {
            'handoff_wake'
        }
        else {
            'completion_wake'
        }
        $plannedAdmittedBase = if ($planned.admittedBaseRef) {
            [string]$planned.admittedBaseRef
        }
        elseif ($isHandoffWake -and $FilterResult.handoffAdmission) {
            [string]$FilterResult.handoffAdmission.admittedBaseRef
        }
        else {
            ''
        }
        $plannedHeadSha = if ($planned.headSha) {
            [string]$planned.headSha
        }
        elseif ($isHandoffWake -and $FilterResult.handoffAdmission) {
            [string]$FilterResult.handoffAdmission.admittedHeadSha
        }
        else {
            ''
        }
        $transportDenial = Get-ReviewStartSupervisedGhInfraTransportRecheckDenial -Snapshot $fresh
        if ($transportDenial) {
            $recheck = $transportDenial
        }
        else {
            $recheck = Invoke-ReviewWakeTriggerFilterCli -Subcommand 'preRunRecheck' -Payload @{
            wakeKind = [string]$FilterResult.wakeKind
            planned  = @{
                prNumber        = $planned.prNumber
                headSha         = $plannedHeadSha
                sessionId       = $planned.sessionId
                startReason     = $plannedStartReason
                admittedBaseRef = $plannedAdmittedBase
            }
            fresh    = @{
                openPrs                   = @($fresh.openPrs)
                reviewRuns                = @($fresh.reviewRuns)
                sessions                  = @($fresh.sessions)
                ciChecks                  = @($fresh.ciChecksByPr[$freshPrKey])
                requiredCheckNames        = @($fresh.requiredCheckNamesByPr[$freshPrKey])
                requiredCheckLookupFailed = [bool]$fresh.requiredCheckLookupFailedByPr[$freshPrKey]
            }
        }
        }
    }
    catch {
        Release-ReviewStartClaimAfterRecheckException -ClaimResult $claim -DryRun:$DryRun -ErrorRecord $_
        throw
    }

    if (-not $recheck.emitReviewRun) {
        & $LogWriter "review-wake-trigger: pre-run re-check aborted PR #$($planned.prNumber) ($($recheck.reason))"
        if (-not $DryRun) {
            Complete-ReviewStartClaimPreRunRecheckDenied -ClaimResult $claim -Recheck $recheck -ReviewRuns @() | Out-Null
        }
        return @{
            triggered = $false
            reason    = $recheck.reason
            mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $planned.prNumber -Snapshot $fresh
        }
    }

    if ($DryRun) {
        & $LogWriter "review-wake-trigger: dry-run would run: $commandLine (PR #$($planned.prNumber) head=$($planned.headSha))"
    }
    else {
        if (-not (Enter-ReviewWakeTriggerSideEffectFence -LockPath $lockPath -Metadata @{
                prNumber  = $planned.prNumber
                headSha   = $planned.headSha
                sessionId = $planned.sessionId
            })) {
            & $LogWriter "review-wake-trigger: side-effect fence busy; skip duplicate run PR #$($planned.prNumber)"
            Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'released_for_retry' -ReviewRuns @() -Extra @{ reason = 'side_effect_in_flight' } | Out-Null
            return @{
                triggered = $false
                reason    = 'side_effect_in_flight'
                mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $planned.prNumber -Snapshot $snapshot `
                    -HeadSha $planned.headSha -ExtraReviewRuns @(@{
                        prNumber  = $planned.prNumber
                        targetSha = $planned.headSha
                        status    = 'queued'
                    })
            }
        }
        $handoffReceiptAbort = $false
        try {
            try {
                Invoke-ReviewerWorkspacePreflight -RepoRoot $RepoRoot
            }
            catch {
                Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns @() -Failure "reviewer workspace preflight failed: $_" | Out-Null
                throw
            }
            $launchGate = Confirm-ReviewStartClaimLaunchGate -ClaimResult $claim -ReviewRuns @($holdRuns) -LogWriter $LogWriter
            if (-not $launchGate.ok) {
                & $LogWriter "review-wake-trigger: launch gate denied PR #$($planned.prNumber) head=$($planned.headSha) reason=$($launchGate.reason)"
                return @{
                    triggered = $false
                    reason    = [string]$launchGate.reason
                    mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $planned.prNumber -Snapshot $fresh
                }
            }
            if ($isHandoffWake) {
                $preInvokeNowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                $preInvokeReceiptBound = Test-ReviewHandoffReceiptToRunBound -WakeReceivedMs $wakeReceivedMs -RunCreatedAtMs $preInvokeNowMs
                if (-not $preInvokeReceiptBound.withinBound) {
                    & $LogWriter "review-wake-trigger: handoff receipt bound exceeded before review run PR #$($planned.prNumber) ($($preInvokeReceiptBound.receiptToRunMs)ms)"
                    Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'aborted_by_recheck' -ReviewRuns @() -Extra @{ reason = 'handoff_receipt_bound_exceeded' } | Out-Null
                    $handoffReceiptAbort = $true
                }
            }
            if (-not $handoffReceiptAbort) {
                Register-PostRunAutonomousRetryAttemptFromClaim -ClaimResult $claim -ReviewRuns @($holdRuns) | Out-Null
                & $LogWriter "review-wake-trigger: starting review PR #$($planned.prNumber) head=$($planned.headSha) session=$($planned.sessionId)"
                & ao @runArgs
                if ($LASTEXITCODE -ne 0) {
                    $failure = "ao review run failed (exit $LASTEXITCODE) for PR #$($planned.prNumber)"
                    $postFailureRuns = @(Get-AoReviewRuns -Project $ProjectId)
                    Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns $postFailureRuns -Failure $failure | Out-Null
                    throw $failure
                }
            }
        }
        finally {
            Exit-ReviewWakeTriggerSideEffectFence -LockPath $lockPath
        }
        if ($handoffReceiptAbort) {
            return @{
                triggered = $false
                reason    = 'handoff_receipt_bound_exceeded'
                mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $planned.prNumber -Snapshot $fresh
            }
        }
    }

    $postRuns = if ($DryRun -and $FixtureSnapshot) {
        @($FixtureSnapshot.reviewRuns) + @(@{
                prNumber   = $planned.prNumber
                targetSha  = $planned.headSha
                status     = 'queued'
                linkedSessionId = $planned.sessionId
            })
    }
    elseif ($DryRun) {
        @($snapshot.reviewRuns) + @(@{
                prNumber   = $planned.prNumber
                targetSha  = $planned.headSha
                status     = 'queued'
                linkedSessionId = $planned.sessionId
            })
    }
    else {
        @(Get-AoReviewRuns -Project $ProjectId)
    }

    if (-not $DryRun) {
        $resolveRuns = if ($FixtureSnapshot) {
            { @($FixtureSnapshot.reviewRuns) }
        }
        else {
            { @(Get-ReviewWakeTriggerSnapshot -PrNumber $planned.prNumber -Project $ProjectId -RepoRoot $RepoRoot).reviewRuns }
        }
        $complete = Complete-ReviewStartClaimAfterRunInvoke -ClaimResult $claim -ReviewRuns $postRuns `
            -ResolveReviewRuns $resolveRuns -LogWriter $LogWriter
        if (-not $complete.ok) {
            & $LogWriter "review-wake-trigger: ESCALATE review-start-claim PR #$($planned.prNumber) head=$($planned.headSha) key=$($claim.key): run-start completion $($complete.reason)"
        }
    }

    $mergeEval = Invoke-ReviewWakeTriggerFilterCli -Subcommand 'mergeIntent' -Payload @{
        prNumber   = $planned.prNumber
        headSha    = $planned.headSha
        reviewRuns = @($postRuns)
    }

    return @{
        triggered = $true
        reason    = 'head_ready_for_review'
        planned   = $planned
        mergeEval = $mergeEval
        postReviewRuns = @($postRuns)
    }
}

function Resolve-ReviewWakeMergeMessage {
    param(
        [string]$WakeMessage,
        [object]$MergeEval
    )

    if (-not $MergeEval -or $MergeEval.mergeable -ne $false) {
        return $WakeMessage
    }
    $reason = [string]$MergeEval.reason
    if (-not $reason) {
        return $WakeMessage
    }
    return "$WakeMessage mergeable=false reason=$reason"
}
