#requires -Version 5.1
<#
.SYNOPSIS
  Low-frequency state-derived review-trigger reconciliation (Issue #163, #195).

.DESCRIPTION
  Independent process from the LLM orchestrator turn loop. Enumerates open PR heads via gh,
  compares coverage from Get-AoReviewRuns fan-out, and starts review via ao-review run only when the head
  is ready for review (Issue #195) — never ao spawn, --claim-pr, ao session kill, or ao send.

  Composes with Issue #98/#189 idempotency and reviewer-workspace-preflight.ps1.

  See docs/orchestrator-autoloop-go-live.md and docs/orchestrator-recovery-runbook.md.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [int]$IntervalMinutes = 0,
    [int]$PollSeconds = 60,
    [string]$StateFile = '',
    [string]$CiGreenWakeStateFile = '',
    [string]$YamlPath = '',
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = ''
)

. (Join-Path $PSScriptRoot 'lib/Invoke-OrchestratorEscalationEmit.ps1')

$ErrorActionPreference = 'Stop'
$Script:ReconcileLogPrefix = 'review-trigger-reconcile'

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) {
    $RepoRoot = $PackRoot
}

$ReconcileFilterCli = Join-Path $PackRoot 'docs/review-trigger-reconcile.mjs'
$Script:DefaultIntervalMinutes = 10

. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-WorkerMessageAdoptionBinding.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-ReactionMessagesFromYaml.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-ReviewerWorkspacePreflight.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-StartClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoReviewApi.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-ReconcileChecksByPr.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-WorkerMessageDispatch.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-CycleCap.ps1')

function Get-ReconcileIntervalMinutes {
    if ($IntervalMinutes -gt 0) { return $IntervalMinutes }
    $envMinutes = $env:AO_REVIEW_TRIGGER_RECONCILE_INTERVAL_MINUTES
    if ($envMinutes -and [int]::TryParse($envMinutes, [ref]$null)) {
        return [int]$envMinutes
    }
    return $Script:DefaultIntervalMinutes
}

function Get-ReconcileStatePath {
    param([string]$CliPath)
    if ($CliPath) { return $CliPath }
    if ($env:AO_REVIEW_TRIGGER_RECONCILE_STATE) { return $env:AO_REVIEW_TRIGGER_RECONCILE_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-reconcile-state.json'
}

function Get-CiGreenWakeSharedStatePath {
    param([string]$CliPath = '')
    if ($CliPath) { return $CliPath }
    if ($env:AO_CI_GREEN_WAKE_RECONCILE_STATE) { return $env:AO_CI_GREEN_WAKE_RECONCILE_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-ci-green-wake-state.json'
}

function Merge-LegacyNudgedWithPendingJournal {
    param(
        [hashtable]$Nudged,
        [hashtable]$PendingJournal
    )

    $merged = Copy-MechanicalJsonMap -Map $Nudged
    foreach ($transitionId in @($PendingJournal.Keys)) {
        $pending = $PendingJournal[$transitionId]
        if (-not $pending) {
            continue
        }
        $key = [string]$transitionId
        if ($merged.ContainsKey($key)) {
            continue
        }
        $sessionId = [string]$pending.sessionId
        $sentAtMs = [long]$pending.sentAtMs
        if (-not $sessionId -or $sentAtMs -le 0) {
            continue
        }
        $merged[$key] = @{
            sessionId = $sessionId
            sentAtMs  = $sentAtMs
        }
    }
    return $merged
}

function Get-CiGreenWakeSharedCycleEvidence {
    param([string]$Path = '')

    $resolved = if ($Path) { $Path } else { Get-CiGreenWakeSharedStatePath }
    $defaults = @{
        heads          = @{}
        nudged         = @{}
        pendingJournal = @{}
        cycleState     = @{}
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        return @{
            sharedCycleState = @{}
            legacyNudged     = @{}
        }
    }

    $state = Get-MechanicalJsonStateFile -Path $resolved -DefaultState $defaults -ActionTracking
    return @{
        sharedCycleState = $state.cycleState
        legacyNudged     = Merge-LegacyNudgedWithPendingJournal -Nudged $state.nudged -PendingJournal $state.pendingJournal
    }
}

function Write-ReconcileLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReconcileLogPrefix): $Message"
}

$Script:GhPrChecksLogWriter = { param([string]$Message) Write-ReconcileLog $Message }

function Invoke-ReconcileFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $ReconcileFilterCli -Subcommand $Subcommand `
        -Payload $Payload -Label $Script:ReconcileLogPrefix -JsonDepth 30
}

$Script:ReconcileDefaultState = @{ lastTickMs = $null; degradedCi = @{}; cycleState = @{} }

function Get-ReconcileState {
    param([string]$Path)

    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $Script:ReconcileDefaultState -ActionTracking
}

function Set-ReconcileState {
    param(
        [string]$Path,
        [object]$State
    )

    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $Script:ReconcileDefaultState -JsonDepth 30
}

function Resolve-ReconcileReactionConfig {
    param(
        [object]$Fixture,
        [string]$PackRoot = '',
        [string]$YamlPath = ''
    )

    if ($Fixture) {
        if ($Fixture.reactionConfigUnavailable) {
            return @{
                ok       = $false
                reason   = 'reaction_config_unavailable'
                messages = @{}
            }
        }
        if ($Fixture.reactionMessages) {
            $map = @{}
            foreach ($prop in $Fixture.reactionMessages.PSObject.Properties) {
                $map[$prop.Name] = [string]$prop.Value
            }
            return @{
                ok       = $true
                messages = $map
            }
        }
        return @{
            ok       = $true
            messages = @{}
        }
    }

    return Get-ReactionMessagesFromYaml -PackRoot $PackRoot -YamlPath $YamlPath
}

function Get-ReconcileReactionMessages {
    param(
        [object]$Fixture,
        [string]$PackRoot = '',
        [string]$YamlPath = ''
    )

    $resolved = Resolve-ReconcileReactionConfig -Fixture $Fixture -PackRoot $PackRoot -YamlPath $YamlPath
    if (-not $resolved.ok) {
        return @{}
    }
    return $resolved.messages
}

function Test-ReconcileReactionConfigDefer {
    param(
        [bool]$ReactionConfigUnavailable,
        [array]$AoEvents
    )

    if (-not $ReactionConfigUnavailable) {
        return $false
    }

    return @($AoEvents | Where-Object {
            $_.kind -eq 'reaction.action_succeeded' -and
            $_.data -and $_.data.action -eq 'send-to-agent'
        }).Count -gt 0
}

function Get-FixtureReconcilePayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $payload = @{
        openPrs       = @($fixture.openPrs)
        reviewRuns    = @($fixture.reviewRuns)
        sessions      = @($fixture.sessions)
        reviewCommand = [string]$fixture.reviewCommand
    }
    if ($fixture.ciChecksByPr) {
        $payload.ciChecksByPr = $fixture.ciChecksByPr
    }
    if ($fixture.requiredCheckNamesByPr) {
        $payload.requiredCheckNamesByPr = $fixture.requiredCheckNamesByPr
    }
    if ($fixture.requiredCheckLookupFailedByPr) {
        $payload.requiredCheckLookupFailedByPr = $fixture.requiredCheckLookupFailedByPr
    }
    if ($fixture.tracking) {
        $payload.tracking = $fixture.tracking
    }
    if ($fixture.nowMs) {
        $payload.nowMs = [long]$fixture.nowMs
    }
    if ($fixture.cycleState) {
        $payload.cycleState = Copy-MechanicalJsonMap -Map $fixture.cycleState
    }
    if ($fixture.sharedCycleState) {
        $payload.sharedCycleState = Copy-MechanicalJsonMap -Map $fixture.sharedCycleState
    }
    if ($fixture.legacyNudged) {
        $payload.legacyNudged = Copy-MechanicalJsonMap -Map $fixture.legacyNudged
    }
    $payload = Merge-MechanicalFixtureDeliveryFields -Payload $payload -Fixture $fixture
    $reactionConfig = Resolve-ReconcileReactionConfig -Fixture $fixture
    $payload.reactionMessages = @{}
    if ($reactionConfig.ok) {
        foreach ($entry in $reactionConfig.messages.GetEnumerator()) {
            $payload.reactionMessages[$entry.Key] = [string]$entry.Value
        }
    }
    $payload.reactionConfigUnavailable = -not $reactionConfig.ok
    return $payload
}

function Get-ReconcileDeliveryPayload {
    param(
        [string]$FixturePath,
        [string]$Project,
        [string]$ConfigYaml = ''
    )

    if ($FixturePath) {
        return @{
            workerDeliveries = @()
            aoEvents         = @()
            dispatchJournal  = @{}
        }
    }

    $reactionConfig = Resolve-ReconcileReactionConfig -PackRoot $RepoRoot -YamlPath $ConfigYaml
    $reactionMessages = @{}
    if ($reactionConfig.ok) {
        foreach ($entry in $reactionConfig.messages.GetEnumerator()) {
            $reactionMessages[$entry.Key] = [string]$entry.Value
        }
    }

    return @{
        workerDeliveries            = @()
        aoEvents                    = @(Get-AoEventsSince -SinceMinutes 30)
        dispatchJournal             = Get-WorkerMessageDispatchJournal
        reviewRuns                  = @(Get-AoReviewRuns -Project $Project)
        reactionMessages            = $reactionMessages
        reactionConfigUnavailable   = -not $reactionConfig.ok
    }
}

function Get-ReconcileWorkerDeliveries {
    param($Deliveries)

    if ($null -eq $Deliveries) {
        return @()
    }
    return @($Deliveries)
}

function Merge-ReconcileTrackingIntoPlanPayload {
    param(
        [hashtable]$PlanPayload,
        [hashtable]$TrackingState
    )

    if ($null -eq $TrackingState) {
        return
    }
    if ($TrackingState.ContainsKey('cycleState')) {
        $PlanPayload.cycleState = $TrackingState.cycleState
    }
    if ($TrackingState.ContainsKey('sharedCycleState')) {
        $PlanPayload.sharedCycleState = $TrackingState.sharedCycleState
    }
    if ($TrackingState.ContainsKey('legacyNudged')) {
        $PlanPayload.legacyNudged = $TrackingState.legacyNudged
    }
    if ($TrackingState.ContainsKey('capCycleState')) {
        $PlanPayload.capCycleState = $TrackingState.capCycleState
    }
}

function Get-PreRunRecheckSnapshot {
    param(
        [int]$PrNumber,
        [string]$Project,
        [string]$ConfigYaml = '',
        [hashtable]$ClaimResult = $null
    )

    $transportFailure = $null
    $targetStateDenial = $null
    if ($ClaimResult -and $ClaimResult.acquired) {
        . (Join-Path $PSScriptRoot 'lib/Get-ClaimedReviewStartSnapshot.ps1')
        $claimed = Get-ClaimedReviewStartSnapshot -PrNumber $PrNumber -Project $Project -RepoRoot $RepoRoot `
            -ClaimResult $ClaimResult -ResolveChecksBundle {
            param($openPrs, $prNumber, $repoRoot)
            Get-ReconcileChecksByPr -RepoRoot $repoRoot -OpenPrs @($openPrs)
        }
        $transportFailure = $claimed.transportFailure
        $targetStateDenial = $claimed.targetStateDenial
        $openPrs = @($claimed.openPrs)
        $reviewRuns = @($claimed.reviewRuns)
        $sessions = @($claimed.sessions)
        $checksBundle = @{
            ciChecksByPr                  = $claimed.ciChecksByPr
            requiredCheckNamesByPr        = $claimed.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $claimed.requiredCheckLookupFailedByPr
        }
    }
    else {
        $openPrs = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot)
        $reviewRuns = Get-AoReviewRuns -Project $Project
        $sessions = Get-AoStatusSessionsWithReports
        $checksBundle = Get-ReconcileChecksByPr -RepoRoot $RepoRoot -OpenPrs @(
            @($openPrs | Where-Object { [int]$_.number -eq $PrNumber })
        )
    }
    $deliveryPayload = Get-ReconcileDeliveryPayload -Project $Project -ConfigYaml $ConfigYaml

    return @{
        openPrs                         = @($openPrs)
        reviewRuns                      = @($reviewRuns)
        sessions                        = @($sessions)
        ciChecksByPr                    = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr          = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr   = $checksBundle.requiredCheckLookupFailedByPr
        aoEvents                        = @($deliveryPayload.aoEvents)
        dispatchJournal                 = $deliveryPayload.dispatchJournal
        workerDeliveries                = Get-ReconcileWorkerDeliveries $deliveryPayload.workerDeliveries
        reactionMessages                = $deliveryPayload.reactionMessages
        reactionConfigUnavailable       = [bool]$deliveryPayload.reactionConfigUnavailable
        transportFailure                = $transportFailure
        targetStateDenial               = $targetStateDenial
    }
}

function Test-PreRunHeadReadyRecheck {
    param(
        [hashtable]$PlannedAction,
        [string]$Project,
        [hashtable]$FixtureSnapshot,
        [hashtable]$TrackingState = $null,
        [string]$CiGreenWakeStatePath = '',
        [string]$ConfigYaml = '',
        [hashtable]$ClaimResult = $null
    )

    $fresh = if ($FixtureSnapshot) {
        $FixtureSnapshot
    }
    else {
        Get-PreRunRecheckSnapshot -PrNumber $PlannedAction.prNumber -Project $Project -ConfigYaml $ConfigYaml -ClaimResult $ClaimResult
    }

    if (-not $FixtureSnapshot) {
        $sharedEvidence = Get-CiGreenWakeSharedCycleEvidence -Path $CiGreenWakeStatePath
        if ($TrackingState -and $TrackingState.cycleState) {
            $fresh.cycleState = $TrackingState.cycleState
        }
        $fresh.sharedCycleState = $sharedEvidence.sharedCycleState
        $fresh.legacyNudged = $sharedEvidence.legacyNudged
        $fresh.repoRoot = $RepoRoot
    }

    if (Test-ReconcileReactionConfigDefer -ReactionConfigUnavailable ([bool]$fresh.reactionConfigUnavailable) -AoEvents @($fresh.aoEvents)) {
        return @{
            emitReviewRun = $false
            reason        = 'reaction_config_unavailable'
        }
    }

    $targetStateDenial = Get-ReviewStartTargetStateRecheckDenial -Snapshot $fresh
    if ($targetStateDenial) {
        return $targetStateDenial
    }

    $transportDenial = Get-ReviewStartSupervisedGhInfraTransportRecheckDenial -Snapshot $fresh
    if ($transportDenial) {
        return $transportDenial
    }

    $prKey = [string]$PlannedAction.prNumber
    $recheck = Invoke-ReconcileFilterCli -Subcommand 'preRunRecheck' -Payload @{
        planned = @{
            prNumber    = $PlannedAction.prNumber
            headSha     = $PlannedAction.headSha
            sessionId   = $PlannedAction.sessionId
            startReason = [string]$PlannedAction.startReason
        }
        fresh   = @{
            openPrs                       = @($fresh.openPrs)
            reviewRuns                    = @($fresh.reviewRuns)
            sessions                      = @($fresh.sessions)
            ciChecks                      = @($fresh.ciChecksByPr[$prKey])
            requiredCheckNames            = @($fresh.requiredCheckNamesByPr[$prKey])
            requiredCheckLookupFailed     = [bool]$fresh.requiredCheckLookupFailedByPr[$prKey]
            aoEvents                      = @($fresh.aoEvents)
            dispatchJournal               = $fresh.dispatchJournal
            workerDeliveries              = Get-ReconcileWorkerDeliveries $fresh.workerDeliveries
            reactionMessages              = $fresh.reactionMessages
            nowMs                         = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            cycleState                    = $fresh.cycleState
            sharedCycleState              = $fresh.sharedCycleState
            legacyNudged                  = $fresh.legacyNudged
            repoRoot                      = $fresh.repoRoot
        }
    }

    return $recheck
}

function Invoke-PlannedReviewRun {
    param(
        [string]$SessionId,
        [string]$ReviewCommand,
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$Project,
        [switch]$DryRunMode,
        [hashtable]$FixtureSnapshot,
        [hashtable]$TrackingState = $null,
        [string]$StartReason = '',
        [string]$CiGreenWakeStatePath = '',
        [string]$ConfigYaml = ''
    )

    $commandLine = Get-ReviewTriggerInvocationLine -SessionId $SessionId
    Test-ReviewMechanicalForbiddenCommand -CommandLine $commandLine

    if ($DryRunMode) {
        Write-ReconcileLog "dry-run would run: $commandLine (PR #$PrNumber head=$HeadSha)"
        return @{ started = $true; reason = 'dry_run' }
    }

    $claimRuns = if ($FixtureSnapshot) { @($FixtureSnapshot.reviewRuns) } else { @(Get-AoReviewRuns -Project $Project) }
    $claim = Acquire-ReviewStartClaim -PrNumber $PrNumber -HeadSha $HeadSha -Surface 'review-trigger-reconcile' `
        -ReviewRuns $claimRuns -ProjectId $Project -StartReason $StartReason -LogWriter { param($m) Write-ReconcileLog $m }
    if (-not $claim.acquired) {
        if ($claim.escalation) {
            Write-ReconcileLog "ESCALATE review-start-claim PR #$PrNumber head=$HeadSha key=$($claim.key): $($claim.reason) $($claim.detail)"
            return @{ started = $false; reason = [string]$claim.reason; escalated = $true }
        }
        $holder = Format-ReviewStartClaimHolder -Holder $claim.holder
        Write-ReconcileLog "claim-skip PR #$PrNumber head=$HeadSha key=$($claim.key): held by $holder reason=$($claim.reason)"
        return @{ started = $false; reason = [string]$claim.reason; claimSkipped = $true }
    }
    if ($claim.recovered) {
        Write-ReconcileLog "review-start-claim recovered stale claim key=$($claim.key) previous=$(Format-ReviewStartClaimHolder -Holder $claim.recoveredRecord.holder)"
    }

    try {
        $recheck = Test-PreRunHeadReadyRecheck -PlannedAction @{
            prNumber    = $PrNumber
            headSha     = $HeadSha
            sessionId   = $SessionId
            startReason = $StartReason
        } -Project $Project -FixtureSnapshot $FixtureSnapshot -TrackingState $TrackingState `
            -CiGreenWakeStatePath $CiGreenWakeStatePath -ConfigYaml $ConfigYaml -ClaimResult $claim
    }
    catch {
        Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'released_for_retry' -ReviewRuns @() -Extra @{
            reason = 'pre_run_recheck_exception'
            error  = [string]$_
        } | Out-Null
        throw
    }

    if (-not $recheck.emitReviewRun) {
        Write-ReconcileLog "pre-run re-check aborted review for PR #$PrNumber head=$HeadSha ($($recheck.reason))"
        Complete-ReviewStartClaimPreRunRecheckDenied -ClaimResult $claim -Recheck $recheck -ReviewRuns @() | Out-Null
        return @{ started = $false; reason = [string]$recheck.reason; recheckAborted = $true }
    }

    try {
        Invoke-ReviewerWorkspacePreflight -RepoRoot $RepoRoot
    }
    catch {
        Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns @() -Failure "reviewer workspace preflight failed: $_" | Out-Null
        throw
    }
    $launchGate = Confirm-ReviewStartClaimLaunchGate -ClaimResult $claim -ReviewRuns @($claimRuns) -DecisionSource 'hold_budget' -LogWriter { param($m) Write-ReconcileLog $m }
    if (-not $launchGate.ok) {
        Write-ReconcileLog "launch gate denied PR #$PrNumber head=$HeadSha reason=$($launchGate.reason)"
        return @{ started = $false; reason = [string]$launchGate.reason }
    }
    Write-ReconcileLog "starting review: PR #$PrNumber head=$HeadSha session=$SessionId"
    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'review-trigger-side-effect.lock'
    Write-OrchestratorSideProcessProgress -ChildId 'review-trigger-reconcile' -Phase 'side_effect'
    $script:ReconcileTriggerSkipReason = ''
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        $triggerResult = Invoke-AoReviewTriggerForWorker -SessionId $SessionId
        if (-not $triggerResult.ok) {
            if ($triggerResult.httpStatus -eq 422) {
                $script:ReconcileTriggerSkipReason = 'review_trigger_invalid'
                return
            }
            $failure = "review trigger failed (http $($triggerResult.httpStatus)) for PR #$PrNumber"
            $postFailureRuns = @(Get-AoReviewRuns -Project $Project)
            Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns $postFailureRuns -Failure $failure | Out-Null
            throw $failure
        }
    }
    if ($script:ReconcileTriggerSkipReason) {
        Write-ReconcileLog "review trigger skipped (422 invalid/terminated) PR #$PrNumber session=$SessionId"
        Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'aborted_by_recheck' -ReviewRuns @() -Extra @{ reason = $script:ReconcileTriggerSkipReason } | Out-Null
        return @{ started = $false; reason = $script:ReconcileTriggerSkipReason }
    }
    if (-not $fenced.ok) {
        Write-ReconcileLog "review run skipped (side-effect busy) PR #$PrNumber"
        Complete-ReviewStartClaim -ClaimResult $claim -Outcome 'released_for_retry' -ReviewRuns @() -Extra @{ reason = 'side_effect_in_flight' } | Out-Null
        return @{ started = $false; reason = 'side_effect_in_flight' }
    }

    $postRuns = @(Get-AoReviewRuns -Project $Project)
    $complete = Complete-ReviewStartClaimAfterRunInvoke -ClaimResult $claim -ReviewRuns $postRuns `
        -ResolveReviewRuns { @(Get-AoReviewRuns -Project $Project) } -LogWriter { param($m) Write-ReconcileLog $m }
    if (-not $complete.ok) {
        Write-ReconcileLog "ESCALATE review-start-claim PR #$PrNumber head=$HeadSha key=$($claim.key): run-start completion $($complete.reason)"
    }
    return @{ started = $true; reason = 'started' }
}

function Merge-DegradedCiTracking {
    param(
        [hashtable]$Existing,
        [array]$Actions,
        [long]$NowMs
    )

    $merged = @{}
    foreach ($key in $Existing.Keys) {
        $merged[$key] = $Existing[$key]
    }

    foreach ($action in @($Actions)) {
        if ($action.type -ne 'track_degraded_ci') {
            continue
        }
        $trackKey = "$($action.prNumber):$($action.headSha)".ToLowerInvariant()
        $merged[$trackKey] = @{
            attempts       = [int]$action.attempts
            lastAttemptMs  = [long]$action.lastAttemptMs
        }
    }

    return $merged
}

function Invoke-ReconcileTick {
    param(
        [string]$Project,
        [string]$ConfigYaml,
        [switch]$DryRunMode,
        [string]$Fixture,
        [hashtable]$TrackingState,
        [string]$CiGreenWakeStatePath = ''
    )

    $fixtureSnapshot = $null
    if ($Fixture) {
        $payload = Get-FixtureReconcilePayload -Path $Fixture
        $reviewCommand = $payload.reviewCommand
        if (-not $reviewCommand) {
            $reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $ConfigYaml
        }
        $fixtureSnapshot = @{
            openPrs                       = @($payload.openPrs)
            reviewRuns                    = $payload.reviewRuns
            sessions                      = $payload.sessions
            ciChecksByPr                  = $payload.ciChecksByPr
            requiredCheckNamesByPr        = $payload.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $payload.requiredCheckLookupFailedByPr
            aoEvents                      = @($payload.aoEvents)
            dispatchJournal               = $payload.dispatchJournal
            workerDeliveries              = Get-ReconcileWorkerDeliveries $payload.workerDeliveries
            reactionMessages              = $payload.reactionMessages
            reactionConfigUnavailable     = [bool]$payload.reactionConfigUnavailable
            cycleState                    = $payload.cycleState
            sharedCycleState              = $payload.sharedCycleState
            legacyNudged                  = $payload.legacyNudged
            repoRoot                      = $RepoRoot
            capCycleState                 = if ($payload.capCycleState) { Copy-MechanicalJsonMap -Map $payload.capCycleState } else { @{} }
        }
    }
    else {
        $openPrs = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot)
        $reviewRuns = Get-AoReviewRuns -Project $Project
        $sessions = Get-AoStatusSessionsWithReports
        $checksBundle = Get-ReconcileChecksByPr -RepoRoot $RepoRoot -OpenPrs @($openPrs)
        $deliveryPayload = Get-ReconcileDeliveryPayload -Project $Project -ConfigYaml $ConfigYaml
        $payload = @{
            openPrs                       = @($openPrs)
            reviewRuns                    = @($reviewRuns)
            sessions                      = @($sessions)
            ciChecksByPr                  = $checksBundle.ciChecksByPr
            requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
            aoEvents                      = @($deliveryPayload.aoEvents)
            dispatchJournal               = $deliveryPayload.dispatchJournal
            reactionMessages              = $deliveryPayload.reactionMessages
            reactionConfigUnavailable     = [bool]$deliveryPayload.reactionConfigUnavailable
        }
        $reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $ConfigYaml
    }

    if (-not $reviewCommand) {
        throw 'Could not resolve REVIEW_COMMAND from agent-orchestrator.yaml'
    }

    if (Test-ReconcileReactionConfigDefer -ReactionConfigUnavailable ([bool]$payload.reactionConfigUnavailable) -AoEvents @($payload.aoEvents)) {
        $reactionEventCount = @($payload.aoEvents | Where-Object {
                $_.kind -eq 'reaction.action_succeeded' -and
                $_.data -and $_.data.action -eq 'send-to-agent'
            }).Count
        Write-ReconcileLog "deferred: reason=reaction_config_unavailable reactionEventCount=$reactionEventCount"
        return @{
            started    = 0
            plan       = @()
            cycleState = @{}
            capCycleState = if ($TrackingState.capCycleState) { $TrackingState.capCycleState } else { @{} }
            deferred   = 1
        }
    }

    $planPayload = $payload.Clone()
    $planPayload.tracking = $TrackingState
    $planPayload.nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Merge-ReconcileTrackingIntoPlanPayload -PlanPayload $planPayload -TrackingState $TrackingState
    $planPayload.repoRoot = $RepoRoot

    $planResult = Invoke-ReconcileFilterCli -Subcommand 'plan' -Payload $planPayload
    $plan = @()
    $cycleState = @{}
    $capCycleState = if ($TrackingState.capCycleState) { Copy-MechanicalJsonMap -Map $TrackingState.capCycleState } else { @{} }
    if ($planResult.actions) {
        $plan = @($planResult.actions)
        if ($planResult.cycleState) {
            $cycleState = $planResult.cycleState
        }
        if ($planResult.capCycleState) {
            $capCycleState = $planResult.capCycleState
        }
    }
    else {
        $plan = @($planResult)
    }
    $started = 0
    foreach ($action in @($plan)) {
        if ($action.type -eq 'skip') {
            $detail = ''
            if ($action.record) {
                $detail = " record=$($action.record | ConvertTo-Json -Compress -Depth 8)"
            }
            Write-ReconcileLog "skip PR #$($action.prNumber): $($action.reason)$detail"
            continue
        }
        if ($action.type -eq 'escalate_degraded_ci') {
            Write-ReconcileLog "ESCALATE PR #$($action.prNumber): $($action.message)"
            $corr = "corr:review-trigger:$($action.prUrl):$($action.headSha)"
            $dedupe = "$corr:degraded_ci"
            Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-review-trigger-degraded-ci' `
                -SourceProcess 'review-trigger-reconcile' -CorrelationKey $corr -DedupeKey $dedupe `
                -Diagnosis @{ prNumber = $action.prNumber; headSha = $action.headSha; message = $action.message } | Out-Null
            continue
        }
        if ($action.type -eq 'track_degraded_ci') {
            Write-ReconcileLog "degraded-ci retry PR #$($action.prNumber) head=$($action.headSha) attempt=$($action.attempts)"
            continue
        }
        if ($action.type -ne 'start_review') {
            continue
        }

        if ($action.startReason -eq 'quiescent_worker_handoff_fallback') {
            $basis = if ($action.quiescenceBasis) { $action.quiescenceBasis | ConvertTo-Json -Compress -Depth 6 } else { '{}' }
            Write-ReconcileLog "quiescent handoff fallback PR #$($action.prNumber) head=$($action.headSha) session=$($action.sessionId) basis=$basis"
        }

        $startResult = Invoke-PlannedReviewRun -SessionId $action.sessionId -ReviewCommand $reviewCommand `
            -PrNumber $action.prNumber -HeadSha $action.headSha -Project $Project `
            -DryRunMode:$DryRunMode -FixtureSnapshot $fixtureSnapshot -TrackingState $TrackingState `
            -StartReason $action.startReason -CiGreenWakeStatePath $CiGreenWakeStatePath `
            -ConfigYaml $ConfigYaml
        if ($startResult.started) {
            if (-not $DryRunMode -and $action.ownerCycle) {
                $commit = Invoke-ReconcileFilterCli -Subcommand 'commit-review-started' -Payload @{
                    cycleState         = $cycleState
                    repoId             = [string]$action.ownerCycle.repoId
                    prNumber           = [int]$action.prNumber
                    ownerSessionId     = [string]$action.sessionId
                    cycle              = $action.ownerCycle.cycle
                    isQuiescentFallback = [bool]$action.ownerCycle.isQuiescentFallback
                }
                if ($commit.cycleState) {
                    $cycleState = $commit.cycleState
                }
            }
            $started++
        }
    }

    return @{
        started    = $started
        plan       = @($plan)
        cycleState = $cycleState
        capCycleState = $capCycleState
    }
}

$intervalMinutes = Get-ReconcileIntervalMinutes
$intervalMs = [Math]::Max(1, $intervalMinutes) * 60 * 1000
$pollMs = [Math]::Max(5, $PollSeconds) * 1000
$statePath = Get-ReconcileStatePath -CliPath $StateFile
$ciGreenWakeStatePath = Get-CiGreenWakeSharedStatePath -CliPath $CiGreenWakeStateFile
$configYaml = Resolve-OperatorOrchestratorYamlPath -YamlPathOverride $YamlPath -PackRoot $PackRoot

$claimNamespace = Resolve-ReviewStartClaimNamespace -ProjectId $ProjectId
Get-ReviewStartClaimStaleMinutes -LogWriter { param($m) Write-ReconcileLog $m } | Out-Null
Write-ReconcileLog "starting (project=$ProjectId, interval=${intervalMinutes}m, state=$statePath, ciGreenWakeState=$ciGreenWakeStatePath, claimNamespace=$claimNamespace, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"

if ($FixturePath) {
    $state = Get-ReconcileState -Path $statePath
    $tracking = @{ degradedCi = (Copy-MechanicalJsonMap -Map $state.degradedCi) }
    $result = Invoke-ReconcileTick -Project $ProjectId -ConfigYaml $configYaml -DryRunMode:$DryRun `
        -Fixture $FixturePath -TrackingState $tracking -CiGreenWakeStatePath $ciGreenWakeStatePath
    Write-ReconcileLog "fixture tick complete (started=$($result.started))"
    exit 0
}

try {
    do {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $state = Get-ReconcileState -Path $statePath
        $lastTickMs = $null
        if ($state.lastTickMs) {
            $lastTickMs = [long]$state.lastTickMs
        }

        $gate = Invoke-ReconcileFilterCli -Subcommand 'interval' -Payload @{
            nowMs      = $nowMs
            lastTickMs = $lastTickMs
            intervalMs = $intervalMs
        }

        Write-OrchestratorSideProcessProgress -ChildId 'review-trigger-reconcile' -Phase 'poll'
        if (-not $gate.ok) {
            Write-ReconcileLog "tick skipped: $($gate.reason)"
        }
        else {
            if (-not (Test-MechanicalJsonStateFencesTrusted -State $state)) {
                $reason = Get-MechanicalJsonStateRecoveryReason -State $state
                Write-ReconcileLog "STATE FENCES UNTRUSTED: $reason; failing closed for side effects"
                Write-OrchestratorSideProcessTickError -ChildId 'review-trigger-reconcile' -ErrorMessage "fences untrusted: $reason"
            }
            else {
            $sharedEvidence = Get-CiGreenWakeSharedCycleEvidence -Path $ciGreenWakeStatePath
            $capStatePath = Get-ReviewCycleCapStatePath -ProjectId $ProjectId
            $capCycleState = Get-ReviewCycleCapState -Path $capStatePath
            $tickTracking = @{
                degradedCi         = (Copy-MechanicalJsonMap -Map $state.degradedCi)
                cycleState         = $state.cycleState
                capCycleState      = $capCycleState
                sharedCycleState   = $sharedEvidence.sharedCycleState
                legacyNudged       = $sharedEvidence.legacyNudged
            }
            try {
                $result = Invoke-ReconcileTick -Project $ProjectId -ConfigYaml $configYaml `
                    -DryRunMode:$DryRun -TrackingState $tickTracking -CiGreenWakeStatePath $ciGreenWakeStatePath
                Write-ReconcileLog "tick complete (started=$($result.started))"
                Write-OrchestratorSideProcessTickSuccess -ChildId 'review-trigger-reconcile'
            }
            catch {
                Write-ReconcileLog "tick error: $_"
                Write-OrchestratorSideProcessTickError -ChildId 'review-trigger-reconcile' -ErrorMessage "$_"
                $result = $null
            }
            finally {
                if (-not $DryRun) {
                    $degradedCi = $tickTracking.degradedCi
                    $cycleState = $tickTracking.cycleState
                    if ($result -and $result.plan) {
                        $degradedCi = Merge-DegradedCiTracking -Existing $tickTracking.degradedCi `
                            -Actions $result.plan -NowMs $nowMs
                    }
                    if ($result -and $result.cycleState) {
                        $cycleState = $result.cycleState
                    }
                    if ($result -and $result.capCycleState) {
                        $capCycleState = $result.capCycleState
                    }
                    Set-ReviewCycleCapState -Path $capStatePath -State $capCycleState
                    Set-ReconcileState -Path $statePath -State @{
                        lastTickMs = $nowMs
                        degradedCi = $degradedCi
                        cycleState = $cycleState
                    }
                }
                else {
                    Write-ReconcileLog 'dry-run: interval state not updated'
                }
            }
            }
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-ReconcileLog 'stopped'
}
