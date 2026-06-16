#requires -Version 5.1
<#
.SYNOPSIS
  Invoke deferred-head review re-evaluation filter CLI and run review with fence (Issue #235).
#>

. (Join-Path $PSScriptRoot 'Review-TriggerReeval-Common.ps1')
. (Join-Path $PSScriptRoot 'Invoke-ReviewerWorkspacePreflight.ps1')
. (Join-Path $PSScriptRoot 'Review-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'Record-ReviewTriggerReevalWatch.ps1')
. (Join-Path $PSScriptRoot 'Review-StartClaim.ps1')

function Test-ReviewTriggerReevalForbiddenCommand {
    param([string]$CommandLine)

    Test-ReviewMechanicalForbiddenCommand -CommandLine $CommandLine

    if ($CommandLine -match '\bgh\s+pr\s+merge\b') {
        throw 'forbidden merge fragment in review re-eval command: gh pr merge'
    }
}

function Invoke-ReviewTriggerReevalPlannedRun {
    param(
        [object]$Action,
        [string]$ReviewCommand,
        [string]$RepoRoot = '',
        [string]$StateRoot = '',
        [string]$ProjectId = 'orchestrator-pack',
        [hashtable]$FixtureSnapshot,
        [scriptblock]$ResolveFreshSnapshot,
        [switch]$DryRun,
        [scriptblock]$LogWriter = { param([string]$Message) Write-Host $Message }
    )

    $planned = @{
        prNumber  = [int]$Action.prNumber
        headSha   = [string]$Action.headSha
        sessionId = [string]$Action.sessionId
    }

    $runArgs = @('review', 'run', $planned.sessionId, '--execute', '--command', $ReviewCommand)
    $commandLine = "ao $($runArgs -join ' ')"
    Test-ReviewTriggerReevalForbiddenCommand -CommandLine $commandLine

    $claim = @{ acquired = $true; dryRun = $true; key = "dry-run:$($planned.prNumber):$($planned.headSha)" }
    if (-not $DryRun) {
        $claimRuns = if ($FixtureSnapshot) {
            @($FixtureSnapshot.reviewRuns)
        }
        elseif ($ResolveFreshSnapshot) {
            @((& $ResolveFreshSnapshot $planned).reviewRuns)
        }
        else {
            @()
        }
        $claim = Acquire-ReviewStartClaim -PrNumber ([int]$planned.prNumber) -HeadSha ([string]$planned.headSha) `
            -Surface 'review-trigger-reeval' -ReviewRuns $claimRuns -ProjectId $ProjectId `
            -StartReason 'deferred_head_watch' -LogWriter $LogWriter
    }
    if (-not $claim.acquired) {
        if ($claim.escalation) {
            & $LogWriter "review-trigger-reeval: ESCALATE review-start-claim PR #$($planned.prNumber) head=$($planned.headSha) key=$($claim.key): $($claim.reason) $($claim.detail)"
            return @{
                triggered   = $false
                reason      = [string]$claim.reason
                retainWatch = $true
            }
        }
        $holder = Format-ReviewStartClaimHolder -Holder $claim.holder
        & $LogWriter "review-trigger-reeval: claim-skip PR #$($planned.prNumber) head=$($planned.headSha) key=$($claim.key): held by $holder reason=$($claim.reason)"
        return @{
            triggered   = $false
            reason      = [string]$claim.reason
            retainWatch = ([string]$claim.reason -ne 'covered_by_run')
        }
    }
    if ($claim.recovered) {
        & $LogWriter "review-trigger-reeval: recovered stale review-start-claim key=$($claim.key) previous=$(Format-ReviewStartClaimHolder -Holder $claim.recoveredRecord.holder)"
    }

    try {
        $fresh = if ($FixtureSnapshot) {
            $FixtureSnapshot
        }
        elseif ($ResolveFreshSnapshot) {
            & $ResolveFreshSnapshot $planned
        }
        else {
            throw 'FixtureSnapshot or ResolveFreshSnapshot required for Invoke-ReviewTriggerReevalPlannedRun'
        }

        $prKey = [string]$planned.prNumber
        $recheck = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'preRunRecheck' -Payload @{
            planned = $planned
            fresh   = @{
                openPrs                     = @($fresh.openPrs)
                reviewRuns                  = @($fresh.reviewRuns)
                sessions                    = @($fresh.sessions)
                ciChecks                    = @($fresh.ciChecksByPr[$prKey])
                requiredCheckNames          = @($fresh.requiredCheckNamesByPr[$prKey])
                requiredCheckLookupFailed   = [bool]$fresh.requiredCheckLookupFailedByPr[$prKey]
            }
        }
    }
    catch {
        Release-ReviewStartClaimAfterRecheckException -ClaimResult $claim -DryRun:$DryRun -ErrorRecord $_
        throw
    }

    if (-not $recheck.emitReviewRun) {
        & $LogWriter "review-trigger-reeval: pre-run re-check aborted PR #$($planned.prNumber) ($($recheck.reason))"
        if (-not $DryRun) {
            Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'aborted_by_recheck' -ReviewRuns @() -Extra @{ reason = [string]$recheck.reason } | Out-Null
        }
        return @{
            triggered   = $false
            reason      = [string]$recheck.reason
            retainWatch = $true
        }
    }

    if ($DryRun) {
        & $LogWriter "review-trigger-reeval: dry-run would run: $commandLine (PR #$($planned.prNumber) head=$($planned.headSha))"
        return @{
            triggered = $true
            reason    = 'dry_run'
            planned   = $planned
        }
    }

    if (-not (Test-ReviewStartClaimOwnership -ClaimResult $claim)) {
        & $LogWriter "review-trigger-reeval: review-start-claim ownership lost before invocation PR #$($planned.prNumber) key=$($claim.key); aborting"
        return @{
            triggered   = $false
            reason      = 'claim_ownership_lost'
            retainWatch = $true
        }
    }

    $lockPath = Get-ReviewTriggerReevalSideEffectLockPath -StateRoot $StateRoot
    if (-not (Enter-OrchestratorSideEffectFence -LockPath $lockPath -Metadata @{
            prNumber  = $planned.prNumber
            headSha   = $planned.headSha
            sessionId = $planned.sessionId
    })) {
        & $LogWriter "review-trigger-reeval: side-effect fence busy; skip duplicate run PR #$($planned.prNumber)"
        Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'released_for_retry' -ReviewRuns @() -Extra @{ reason = 'side_effect_in_flight' } | Out-Null
        return @{
            triggered   = $false
            reason      = 'side_effect_in_flight'
            retainWatch = $true
        }
    }

    try {
        & $LogWriter "review-trigger-reeval: starting review PR #$($planned.prNumber) head=$($planned.headSha) session=$($planned.sessionId)"
        if ($RepoRoot) {
            try {
                Invoke-ReviewerWorkspacePreflight -RepoRoot $RepoRoot
            }
            catch {
                Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns @() -Failure "reviewer workspace preflight failed: $_" | Out-Null
                throw
            }
        }
        & ao @runArgs
        if ($LASTEXITCODE -ne 0) {
            $failure = "ao review run failed (exit $LASTEXITCODE) for PR #$($planned.prNumber)"
            $postFailureRuns = if ($ResolveFreshSnapshot) { @((& $ResolveFreshSnapshot $planned).reviewRuns) } else { @() }
            Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns $postFailureRuns -Failure $failure | Out-Null
            throw $failure
        }
    }
    finally {
        Exit-OrchestratorSideEffectFence -LockPath $lockPath
    }

    $postRuns = if ($ResolveFreshSnapshot) { @((& $ResolveFreshSnapshot $planned).reviewRuns) } else { @($fresh.reviewRuns) }
    $complete = Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'run_started' -ReviewRuns $postRuns
    if (-not $complete.ok) {
        & $LogWriter "review-trigger-reeval: ESCALATE review-start-claim PR #$($planned.prNumber) head=$($planned.headSha) key=$($claim.key): run-start completion $($complete.reason)"
    }

    return @{
        triggered = $true
        reason    = 'head_ready_for_review'
        planned   = $planned
    }
}
