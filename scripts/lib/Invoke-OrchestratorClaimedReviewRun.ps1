#requires -Version 5.1
<#
  Claimed review-start entry point for the LLM-orchestrator turn (Issue #318).
#>

. (Join-Path $PSScriptRoot 'Review-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'Invoke-ReviewerWorkspacePreflight.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'Review-StartClaim.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-AutonomousReviewStartGate.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-ReviewStartAudit.ps1')
. (Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Get-ClaimedReviewStartSnapshot.ps1')
. (Join-Path $PSScriptRoot 'Get-ReconcileChecksByPr.ps1')

$Script:OrchestratorPreRecheckFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-trigger-reconcile.mjs'

function Get-OrchestratorClaimedReviewSnapshot {
    param(
        [int]$PrNumber,
        [string]$Project,
        [string]$RepoRoot,
        [hashtable]$FixtureSnapshot
    )

    return Get-ClaimedReviewStartSnapshot -PrNumber $PrNumber -Project $Project -RepoRoot $RepoRoot `
        -FixtureSnapshot $FixtureSnapshot -ResolveChecksBundle {
            param($OpenPrs, $TargetPr, $Root)
            Get-ReconcileChecksByPr -RepoRoot $Root -OpenPrs @(@($OpenPrs | Where-Object { [int]$_.number -eq $TargetPr }))
        }
}

function Invoke-OrchestratorClaimedReviewRunPreRecheck {
    param(
        [hashtable]$PlannedAction,
        [hashtable]$Snapshot
    )

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
        [string]$AuditRoot = ''
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
        Write-OrchestratorReviewStartPreflightRefusal -AuditRoot $AuditRoot -Reason $preflight.reason -MarkerState ([string]$preflight.markerState) | Out-Null
        return @{ started = $false; reason = $preflight.reason; preflightRefusal = $true }
    }

    $snapshot = Get-OrchestratorClaimedReviewSnapshot -PrNumber $PrNumber -Project $Project -RepoRoot $RepoRoot -FixtureSnapshot $FixtureSnapshot
    $prKey = [string]$PrNumber
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
    }
    $preClaim = Invoke-OrchestratorClaimedReviewRunFilterCli -Subcommand 'evaluateTurnGate' -Payload $gatePayload
    if (-not $preClaim.launch) {
        if ($preClaim.currentHeadSha) {
            Write-OrchestratorReviewStartDenialAudit -AuditRoot $AuditRoot -PrNumber $PrNumber `
                -HeadSha ([string]$preClaim.currentHeadSha) -Reason ([string]$preClaim.reason) `
                -ClaimOutcome 'no_claim' | Out-Null
        }
        else {
            Write-OrchestratorReviewStartPreflightRefusal -AuditRoot $AuditRoot -Reason ([string]$preClaim.reason) -MarkerState 'head_unresolved' | Out-Null
        }
        & $writeLog "orchestrator-claimed-review-run: denied before claim PR #$PrNumber reason=$($preClaim.reason)"
        return @{ started = $false; reason = [string]$preClaim.reason; deniedBeforeClaim = $true; gate = $preClaim }
    }

    $headSha = [string]$preClaim.currentHeadSha
    $runArgs = @('review', 'run', $SessionId, '--execute', '--command', $ReviewCommand)
    $commandLine = "ao $($runArgs -join ' ')"
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

    $hold = Test-ReviewStartClaimHoldBudgetExceeded -ClaimResult $claim
    if ($hold.exceeded) {
        Invoke-ReviewStartClaimReclaimOrphan -Namespace $claim.namespace -Path $claim.path -Record $claim.claim -ReviewRuns @($claimRuns) -DecisionSource 'hold_budget' -LogWriter $writeLog | Out-Null
        & $writeLog "orchestrator-claimed-review-run: hold budget exceeded PR #$PrNumber head=$headSha"
        return @{ started = $false; reason = 'hold_budget_exceeded'; headSha = $headSha }
    }

    try {
        $fresh = if ($FixtureSnapshot) { $FixtureSnapshot } else { Get-OrchestratorClaimedReviewSnapshot -PrNumber $PrNumber -Project $Project -RepoRoot $RepoRoot }
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
        Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'aborted_by_recheck' -ReviewRuns @() -Extra @{ reason = [string]$recheck.reason } | Out-Null
        Write-OrchestratorReviewStartDenialAudit -AuditRoot $AuditRoot -PrNumber $PrNumber -HeadSha $headSha `
            -Reason ([string]$recheck.reason) -ClaimOutcome 'covered_abort' | Out-Null
        & $writeLog "orchestrator-claimed-review-run: recheck aborted PR #$PrNumber head=$headSha reason=$($recheck.reason)"
        return @{ started = $false; reason = [string]$recheck.reason; recheckAborted = $true; headSha = $headSha }
    }

    if (-not (Test-ReviewStartClaimOwnership -ClaimResult $claim)) {
        return @{ started = $false; reason = 'claim_ownership_lost'; headSha = $headSha }
    }

    try {
        Invoke-ReviewerWorkspacePreflight -RepoRoot $RepoRoot
    }
    catch {
        Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns @() -Failure "reviewer workspace preflight failed: $_" | Out-Null
        throw
    }

    Set-ReviewStartClaimLaunchPending -ClaimResult $claim | Out-Null
    & $writeLog "orchestrator-claimed-review-run: starting review PR #$PrNumber head=$headSha session=$SessionId"
    $lockPath = Join-Path $AuditRoot 'orchestrator-turn-side-effect.lock'
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        $prevBypass = $env:AO_CLAIMED_REVIEW_RUN_BYPASS
        $env:AO_CLAIMED_REVIEW_RUN_BYPASS = '1'
        try {
            & ao @runArgs
            if ($LASTEXITCODE -ne 0) {
                $failure = "ao review run failed (exit $LASTEXITCODE) for PR #$PrNumber"
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
        finally {
            if ($null -eq $prevBypass) {
                Remove-Item Env:AO_CLAIMED_REVIEW_RUN_BYPASS -ErrorAction SilentlyContinue
            }
            else {
                $env:AO_CLAIMED_REVIEW_RUN_BYPASS = $prevBypass
            }
        }
    }
    if (-not $fenced.ok) {
        Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'released_for_retry' -ReviewRuns @() -Extra @{ reason = 'side_effect_in_flight' } | Out-Null
        return @{ started = $false; reason = 'side_effect_in_flight'; headSha = $headSha }
    }

    $postRuns = if ($FixtureSnapshot) { @($FixtureSnapshot.reviewRuns) } else { @(Get-AoReviewRuns -Project $Project) }
    $complete = Complete-ReviewStartClaimAfterRunInvoke -ClaimResult $claim -ReviewRuns $postRuns -LogWriter $writeLog
    if (-not $complete.ok) {
        & $writeLog "orchestrator-claimed-review-run: ESCALATE claim completion PR #$PrNumber head=$headSha reason=$($complete.reason)"
    }
    return @{ started = $true; reason = 'started'; headSha = $headSha }
}
