#requires -Version 5.1
<#
  Claimed review-start entry point for the LLM-orchestrator turn (Issue #318).
#>

. (Join-Path $PSScriptRoot 'Review-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'Invoke-AoReviewApi.ps1')
. (Join-Path $PSScriptRoot 'Invoke-ReviewerWorkspacePreflight.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'Review-StartClaim.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-AutonomousReviewStartGate.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-ReviewStartAudit.ps1')
. (Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Get-ClaimedReviewStartSnapshot.ps1')
. (Join-Path $PSScriptRoot 'Review-PostRunRetry.ps1')
. (Join-Path $PSScriptRoot 'Get-ReconcileChecksByPr.ps1')
. (Join-Path $PSScriptRoot 'Review-CycleCap.ps1')

$Script:OrchestratorPreRecheckFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-trigger-reconcile.mjs'

function Get-OrchestratorClaimedReviewSnapshot {
    param(
        [int]$PrNumber,
        [string]$Project,
        [string]$RepoRoot,
        [hashtable]$FixtureSnapshot,
        [hashtable]$ClaimResult
    )

    return Get-ClaimedReviewStartSnapshot -PrNumber $PrNumber -Project $Project -RepoRoot $RepoRoot `
        -FixtureSnapshot $FixtureSnapshot -ClaimResult $ClaimResult -ResolveChecksBundle {
            param($OpenPrs, $TargetPr, $Root)
            Get-ReconcileChecksByPr -RepoRoot $Root -OpenPrs @(@($OpenPrs | Where-Object { [int]$_.number -eq $TargetPr }))
        }
}

function Invoke-OrchestratorClaimedReviewRunPreRecheck {
    param(
        [hashtable]$PlannedAction,
        [hashtable]$Snapshot
    )

    $targetStateDenial = Get-ReviewStartTargetStateRecheckDenial -Snapshot $Snapshot
    if ($targetStateDenial) {
        return $targetStateDenial
    }

    $transportDenial = Get-ReviewStartSupervisedGhInfraTransportRecheckDenial -Snapshot $Snapshot
    if ($transportDenial) {
        return $transportDenial
    }

    $prKey = [string]$PlannedAction.prNumber
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:OrchestratorPreRecheckFilterCli `
        -Subcommand 'preRunRecheck' -Payload @{
        planned = @{
            prNumber    = $PlannedAction.prNumber
            headSha     = $PlannedAction.headSha
            sessionId   = $PlannedAction.sessionId
            startReason = [string]$PlannedAction.startReason
        }
        fresh   = @{
            openPrs                   = @($Snapshot.openPrs)
            reviewRuns                = @($Snapshot.reviewRuns)
            sessions                  = @($Snapshot.sessions)
            ciChecks                  = @($Snapshot.ciChecksByPr[$prKey])
            requiredCheckNames        = @($Snapshot.requiredCheckNamesByPr[$prKey])
            requiredCheckLookupFailed = [bool]$Snapshot.requiredCheckLookupFailedByPr[$prKey]
            nowMs                     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
    } -Label 'orchestrator-pre-recheck' -JsonDepth 30
}

function Invoke-OrchestratorClaimedReviewRun {
    param(
        [string]$SessionId,
        [string]$ReviewCommand,
        [int]$PrNumber,
        [string]$EventHeadSha = '',
        [string]$Project = 'orchestrator-pack',
        [string]$RepoRoot = '',
        [hashtable]$FixtureSnapshot,
        [switch]$DryRun,
        [scriptblock]$LogWriter = $null,
        [string]$StartReason = 'orchestrator_turn',
        [string]$AuditRoot = '',
        [hashtable]$CapCycleState = $null
    )

    if (-not $RepoRoot) {
        $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    if (-not $AuditRoot) {
        $AuditRoot = Get-OrchestratorReviewStartAuditRoot -ProjectId $Project
    }

    $writeLog = if ($LogWriter) { $LogWriter } else { { param($Message) Write-Host $Message } }

    $preflight = Test-OrchestratorReviewStartGatePreflight -FixtureMode:([bool]$FixtureSnapshot)
    if (-not $preflight.ok) {
        $preflightHead = ([string]$EventHeadSha).Trim().ToLowerInvariant()
        Write-OrchestratorReviewStartPreflightRefusal -AuditRoot $AuditRoot -Reason $preflight.reason `
            -MarkerState ([string]$preflight.markerState) -PrNumber $PrNumber -HeadSha $preflightHead | Out-Null
        return @{ started = $false; reason = $preflight.reason; preflightRefusal = $true }
    }

    $snapshot = Get-OrchestratorClaimedReviewSnapshot -PrNumber $PrNumber -Project $Project -RepoRoot $RepoRoot -FixtureSnapshot $FixtureSnapshot
    $prKey = [string]$PrNumber
    $capCycleState = if ($CapCycleState) { $CapCycleState } else { Get-ReviewCycleCapState -Path (Get-ReviewCycleCapStatePath -ProjectId $Project) }
    $gatePayload = @{
        prNumber                    = $PrNumber
        eventHeadSha                = $EventHeadSha
        openPrs                     = @($snapshot.openPrs)
        reviewRuns                  = @($snapshot.reviewRuns)
        sessions                    = @($snapshot.sessions)
        ciChecks                    = @($snapshot.ciChecksByPr[$prKey])
        requiredCheckNames          = @($snapshot.requiredCheckNamesByPr[$prKey])
        requiredCheckLookupFailed   = [bool]$snapshot.requiredCheckLookupFailedByPr[$prKey]
        sessionId                   = $SessionId
        claimWindow                 = 'free'
        provenanceAutonomous        = $true
        capCycleState               = $capCycleState
    }
    if ($snapshot.targetStateDenial) {
        $gatePayload.targetStateDenial = $snapshot.targetStateDenial
    }
    if ($snapshot.transportFailure) {
        $gatePayload.transportFailure = $snapshot.transportFailure
    }
    $preClaim = Invoke-OrchestratorClaimedReviewRunFilterCli -Subcommand 'evaluateTurnGate' -Payload $gatePayload
    if (-not $preClaim.launch) {
        if ($preClaim.currentHeadSha) {
            Write-OrchestratorReviewStartDenialAudit -AuditRoot $AuditRoot -PrNumber $PrNumber `
                -HeadSha ([string]$preClaim.currentHeadSha) -Reason ([string]$preClaim.reason) `
                -ClaimOutcome 'no_claim' | Out-Null
        }
        else {
            $refusalHead = ([string]$EventHeadSha).Trim().ToLowerInvariant()
            Write-OrchestratorReviewStartPreflightRefusal -AuditRoot $AuditRoot -Reason ([string]$preClaim.reason) `
                -MarkerState 'head_unresolved' -PrNumber $PrNumber -HeadSha $refusalHead | Out-Null
        }
        & $writeLog "orchestrator-claimed-review-run: denied before claim PR #$PrNumber reason=$($preClaim.reason)"
        if ($preClaim.capCycleState) {
            Set-ReviewCycleCapState -Path (Get-ReviewCycleCapStatePath -ProjectId $Project) -State $preClaim.capCycleState
        }
        return @{ started = $false; reason = [string]$preClaim.reason; deniedBeforeClaim = $true; gate = $preClaim }
    }

    $headSha = [string]$preClaim.currentHeadSha
    $commandLine = Get-ReviewTriggerInvocationLine -SessionId $SessionId
    Test-ReviewMechanicalForbiddenCommand -CommandLine $commandLine

    if ($DryRun) {
        & $writeLog "orchestrator-claimed-review-run: dry-run would run: $commandLine (PR #$PrNumber head=$headSha)"
        return @{ started = $true; reason = 'dry_run'; headSha = $headSha }
    }

    $claimRuns = @($snapshot.reviewRuns)
    $claim = Acquire-ReviewStartClaim -PrNumber $PrNumber -HeadSha $headSha -Surface 'orchestrator-turn' `
        -ReviewRuns $claimRuns -ProjectId $Project -StartReason $StartReason -LogWriter $writeLog
    if (-not $claim.acquired) {
        $outcome = if ($claim.reason -eq 'covered_by_run') { 'covered_abort' } else { 'claim_lost' }
        Write-OrchestratorReviewStartDenialAudit -AuditRoot $AuditRoot -PrNumber $PrNumber -HeadSha $headSha `
            -Reason ([string]$claim.reason) -ClaimOutcome $outcome | Out-Null
        & $writeLog "orchestrator-claimed-review-run: claim-skip PR #$PrNumber head=$headSha reason=$($claim.reason)"
        return @{ started = $false; reason = [string]$claim.reason; claimSkipped = $true; headSha = $headSha }
    }

    try {
        $fresh = if ($FixtureSnapshot) { $FixtureSnapshot } else {
            Get-OrchestratorClaimedReviewSnapshot -PrNumber $PrNumber -Project $Project -RepoRoot $RepoRoot -ClaimResult $claim
        }
        $recheck = Invoke-OrchestratorClaimedReviewRunPreRecheck -PlannedAction @{
            prNumber    = $PrNumber
            headSha     = $headSha
            sessionId   = $SessionId
            startReason = $StartReason
        } -Snapshot $fresh
    }
    catch {
        Release-ReviewStartClaimAfterRecheckException -ClaimResult $claim -ErrorRecord $_
        throw
    }

    if (-not $recheck.emitReviewRun) {
        Complete-ReviewStartClaimPreRunRecheckDenied -ClaimResult $claim -Recheck $recheck -ReviewRuns @() | Out-Null
        Write-OrchestratorReviewStartDenialAudit -AuditRoot $AuditRoot -PrNumber $PrNumber -HeadSha $headSha `
            -Reason ([string]$recheck.reason) -ClaimOutcome 'covered_abort' | Out-Null
        & $writeLog "orchestrator-claimed-review-run: recheck aborted PR #$PrNumber head=$headSha reason=$($recheck.reason)"
        return @{ started = $false; reason = [string]$recheck.reason; recheckAborted = $true; headSha = $headSha }
    }

    try {
        Invoke-ReviewerWorkspacePreflight -RepoRoot $RepoRoot
    }
    catch {
        Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns @() -Failure "reviewer workspace preflight failed: $_" | Out-Null
        throw
    }

    $launchGate = Confirm-ReviewStartClaimLaunchGate -ClaimResult $claim -ReviewRuns @($claimRuns) -LogWriter $writeLog
    if (-not $launchGate.ok) {
        & $writeLog "orchestrator-claimed-review-run: launch gate denied PR #$PrNumber head=$headSha reason=$($launchGate.reason)"
        return @{ started = $false; reason = [string]$launchGate.reason; headSha = $headSha }
    }
    & $writeLog "orchestrator-claimed-review-run: starting review PR #$PrNumber head=$headSha session=$SessionId"
    $lockPath = Join-Path $AuditRoot 'orchestrator-turn-side-effect.lock'
    $script:OrchestratorClaimedReviewTriggerInvalid = $false
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        Register-PostRunAutonomousRetryAttemptFromClaim -ClaimResult $claim -ReviewRuns @($claimRuns) | Out-Null
        $triggerResult = Invoke-AoReviewTriggerForWorker -SessionId $SessionId
        if (-not $triggerResult.ok) {
            $failure = "review trigger failed (http $($triggerResult.httpStatus)) for PR #$PrNumber"
            if ($triggerResult.httpStatus -eq 422) {
                $script:OrchestratorClaimedReviewTriggerInvalid = $true
                Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'aborted_by_recheck' -ReviewRuns @() `
                    -Extra @{ reason = 'review_trigger_invalid' } | Out-Null
                return
            }
            $postFailureRuns = if ($FixtureSnapshot) {
                @($FixtureSnapshot.reviewRuns)
            }
            else {
                @(Get-AoReviewRuns -Project $Project)
            }
            Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns $postFailureRuns -Failure $failure | Out-Null
            throw $failure
        }
    }
    if ($script:OrchestratorClaimedReviewTriggerInvalid) {
        & $writeLog "orchestrator-claimed-review-run: skip invalid worker PR #$PrNumber session=$SessionId"
        return @{ started = $false; reason = 'review_trigger_invalid'; headSha = $headSha }
    }
    if (-not $fenced.ok) {
        Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'released_for_retry' -ReviewRuns @() -Extra @{ reason = 'side_effect_in_flight' } | Out-Null
        return @{ started = $false; reason = 'side_effect_in_flight'; headSha = $headSha }
    }

    $postRuns = if ($FixtureSnapshot) { @($FixtureSnapshot.reviewRuns) } else { @(Get-AoReviewRuns -Project $Project) }
    $resolveRuns = if ($FixtureSnapshot) {
        { @($FixtureSnapshot.reviewRuns) }
    }
    else {
        { @(Get-AoReviewRuns -Project $Project) }
    }
    $complete = Complete-ReviewStartClaimAfterRunInvoke -ClaimResult $claim -ReviewRuns $postRuns `
        -ResolveReviewRuns $resolveRuns -LogWriter $writeLog
    if (-not $complete.ok) {
        & $writeLog "orchestrator-claimed-review-run: ESCALATE claim completion PR #$PrNumber head=$headSha reason=$($complete.reason)"
    }
    if ($preClaim.capCycleState) {
        Set-ReviewCycleCapState -Path (Get-ReviewCycleCapStatePath -ProjectId $Project) -State $preClaim.capCycleState
    }
    return @{ started = $true; reason = 'started'; headSha = $headSha }
}
