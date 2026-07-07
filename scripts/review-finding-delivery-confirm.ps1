#requires -Version 5.1
<#
.SYNOPSIS
  Sender-side review-finding delivery confirmation (Issue #171).

.DESCRIPTION
  Low-frequency mechanical loop: observes run-level state from Get-AoReviewRuns fan-out
  and worker reports from ao status --reports full. Confirms delivery only when the
  linked worker reports addressing_reviews (or equivalent) after deliveredAt; on timeout
  escalates (AO 0.10 auto-delivery — observe-only, no pack redelivery); draft submit is owned by worker-message-submit-reconcile.ps1
  (Issue #232). Never ao spawn,
  --claim-pr, ao session kill, or ao send.

  Distinct from review-trigger-reconcile.ps1 (Issue #163), which only starts review runs.

  See docs/orchestrator-recovery-runbook.md and docs/issues_drafts/00-architecture-decisions.md §H.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [int]$IntervalMinutes = 0,
    [int]$ConfirmationWindowMinutes = 0,
    [int]$MaxRedeliveries = -1,
    [int]$PollSeconds = 60,
    [string]$StateFile = '',
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'

$PackRoot = Split-Path -Parent $PSScriptRoot
$DeliveryFilterCli = Join-Path $PackRoot 'docs/review-finding-delivery-confirm.mjs'
$SendFilterCli = Join-Path $PackRoot 'docs/review-send-reconcile.mjs'
$Script:DefaultIntervalMinutes = 5
$Script:DefaultConfirmationWindowMinutes = 5
$Script:DefaultMaxRedeliveries = 2
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-FloodActiveSessionMap.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-AutonomousNudgeGate.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')

$Script:DeliveryDefaultState = @{ runs = @{}; lastTickMs = $null }

function Invoke-ReviewSendFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $SendFilterCli -Subcommand $Subcommand `
        -Payload $Payload -Label 'review-finding-delivery-confirm' -JsonDepth 30
}

function Get-DeliveryIntervalMinutes {
    if ($IntervalMinutes -gt 0) { return $IntervalMinutes }
    $envMinutes = $env:AO_REVIEW_DELIVERY_CONFIRM_INTERVAL_MINUTES
    if ($envMinutes -and [int]::TryParse($envMinutes, [ref]$null)) {
        return [int]$envMinutes
    }
    return $Script:DefaultIntervalMinutes
}

function Get-DeliveryConfirmationWindowMinutes {
    if ($ConfirmationWindowMinutes -gt 0) { return $ConfirmationWindowMinutes }
    $envMinutes = $env:AO_REVIEW_DELIVERY_CONFIRM_WINDOW_MINUTES
    if ($envMinutes -and [int]::TryParse($envMinutes, [ref]$null)) {
        return [int]$envMinutes
    }
    return $Script:DefaultConfirmationWindowMinutes
}

function Get-DeliveryMaxRedeliveries {
    if ($MaxRedeliveries -ge 0) { return $MaxRedeliveries }
    $envMax = $env:AO_REVIEW_DELIVERY_CONFIRM_MAX_REDELIVERIES
    if ($envMax -and [int]::TryParse($envMax, [ref]$null)) {
        return [int]$envMax
    }
    return $Script:DefaultMaxRedeliveries
}

function Get-DeliveryStatePath {
    param([string]$CliPath)
    if ($CliPath) { return $CliPath }
    if ($env:AO_REVIEW_DELIVERY_CONFIRM_STATE) { return $env:AO_REVIEW_DELIVERY_CONFIRM_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-delivery-confirm-state.json'
}

function Write-DeliveryLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] review-finding-delivery-confirm: $Message"
}

function Invoke-DeliveryFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    $json = $Payload | ConvertTo-Json -Depth 30 -Compress
    $output = $json | & node $DeliveryFilterCli $Subcommand 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "review-finding-delivery-confirm.mjs $Subcommand exited ${LASTEXITCODE}: $output"
    }

    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    return $text | ConvertFrom-Json
}

function Get-DeliveryState {
    param([string]$Path)

    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $Script:DeliveryDefaultState -ActionTracking
}

function Set-DeliveryState {
    param(
        [string]$Path,
        [object]$State
    )

    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $Script:DeliveryDefaultState -JsonDepth 30
}

function Copy-DeliveryTrackingRuns {
    param([object]$Tracking)

    if (-not $Tracking) { return @{} }
    if ($Tracking -is [System.Collections.IDictionary]) {
        return Copy-MechanicalJsonMap -Map $Tracking['runs']
    }
    return Copy-MechanicalJsonMap -Map $Tracking.runs
}

function Get-PlannedDeliveryRunRecord {
    param(
        [object]$PlannedTracking,
        [string]$RunId
    )

    if (-not $PlannedTracking -or -not $PlannedTracking.runs) {
        return $null
    }

    $plannedRuns = $PlannedTracking.runs
    if ($plannedRuns -is [System.Collections.IDictionary]) {
        return $plannedRuns[$RunId]
    }

    return $plannedRuns.$RunId
}

function Save-PartialDeliveryTracking {
    param(
        [string]$Path,
        [hashtable]$AppliedTracking,
        [switch]$DryRunMode
    )

    if ($DryRunMode -or -not $Path) {
        return
    }

    Set-DeliveryState -Path $Path -State $AppliedTracking
}

function Merge-DeliveryTickTracking {
    param(
        [object]$PlannedTracking,
        [hashtable]$AppliedRuns
    )

    $finalRuns = @{}
    if ($PlannedTracking -and $PlannedTracking.runs) {
        $plannedRuns = $PlannedTracking.runs
        if ($plannedRuns -is [System.Collections.IDictionary]) {
            foreach ($runId in $plannedRuns.Keys) {
                if ($AppliedRuns.ContainsKey($runId)) {
                    $finalRuns[$runId] = $AppliedRuns[$runId]
                }
                else {
                    $finalRuns[$runId] = $plannedRuns[$runId]
                }
            }
        }
        else {
            foreach ($prop in $plannedRuns.PSObject.Properties) {
                $runId = $prop.Name
                if ($AppliedRuns.ContainsKey($runId)) {
                    $finalRuns[$runId] = $AppliedRuns[$runId]
                }
                else {
                    $finalRuns[$runId] = $prop.Value
                }
            }
        }
    }

    return @{
        runs       = $finalRuns
        lastTickMs = $PlannedTracking.lastTickMs
    }
}

function Get-OpenPrList {
    # Fail tick when gh pr list failed (exit) propagates from Invoke-GhOpenPrList.
    try {
        return @(Invoke-GhOpenPrList -RepoRoot $PackRoot)
    }
    catch {
        $message = $_.Exception.Message
        if ($message -match 'gh pr list failed|snapshot_populate_failed|child_list_bypass') {
            throw $message
        }
        throw
    }
}

function Get-FixtureDeliveryPayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    return @{
        reviewRuns          = @($fixture.reviewRuns)
        sessions            = @($fixture.sessions)
        openPrs             = ConvertTo-GhOpenPrArray -OpenPrs $fixture.openPrs
        tracking            = $fixture.tracking
        nowMs               = [long]$fixture.nowMs
        config              = $fixture.config
        aoEvents            = @($fixture.aoEvents)
        floodActiveSessions = $fixture.floodActiveSessions
    }
}

function Invoke-PlannedReviewSend {
    param(
        [string]$RunId,
        [int]$PrNumber,
        [string]$SessionId,
        [string]$TargetSha,
        [int]$Attempt,
        [string]$ProjectId = 'orchestrator-pack',
        [switch]$DryRunMode
    )

    if ($DryRunMode) {
        Write-DeliveryLog "dry-run would skip redelivery (observe-only on AO 0.10): run=$RunId PR #$PrNumber attempt=$Attempt"
        return @{ sent = $false; reason = 'dry_run' }
    }

    $intentClass = 'review-findings-redelivery'
    $cycleKey = "redelivery:${RunId}:${Attempt}"
    $openPrs = ConvertTo-GhOpenPrArray -OpenPrs (Get-OpenPrList)
    $targetResolution = Resolve-WorkerNudgeTargetFromPrClaim -PrNumber $PrNumber -SessionId $SessionId `
        -HeadSha $TargetSha -ProjectId $ProjectId -OpenPrs $openPrs
    if (-not $targetResolution.ok) {
        Write-DeliveryLog "redelivery suppressed (PR-claim target unresolved) run=${RunId}: $($targetResolution.reason)"
        return @{ sent = $false; reason = [string]$targetResolution.reason; targetUnresolved = $true }
    }
    $targetId = [string]$targetResolution.targetId
    $targetGeneration = [string]$targetResolution.targetGeneration
    $workerTarget = [string]$targetResolution.workerTarget
    if (-not $workerTarget) { $workerTarget = "$targetId`:$targetGeneration" }
    $sendSessionId = [string]$targetResolution.ownerSessionId
    if (-not $sendSessionId) { $sendSessionId = $SessionId }
    $tupleKey = "$PrNumber|$cycleKey|$intentClass|$workerTarget"
    $reviewMessage = 'Review findings for PR #' + $PrNumber + ' (run ' + $RunId + ', redelivery attempt ' + $Attempt + ')'

    $claim = Acquire-WorkerNudgeClaim -PrNumber $PrNumber -CycleKey $cycleKey -IntentClass $intentClass `
        -WorkerTarget $workerTarget -SessionId $sendSessionId -TargetId $targetId -TargetGeneration $targetGeneration `
        -TupleKey $tupleKey -Surface 'review-finding-delivery-confirm' -ProjectId $ProjectId -Message $reviewMessage
    if (-not $claim.acquired) {
        Write-DeliveryLog "redelivery suppressed by claim gate run=${RunId}: $($claim.reason)"
        return @{
            sent         = $false
            reason       = [string]$claim.reason
            claimSkipped = $true
            escalate     = [bool]$claim.escalate
            diagnosis    = [string]$claim.diagnosis
        }
    }

    $sendAttempt = Set-WorkerNudgeClaimSendAttempted -ClaimResult $claim
    if (-not $sendAttempt.ok) {
        Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'FAILED_DEFINITIVE' -Extra @{ reason = [string]$sendAttempt.reason } | Out-Null
        Write-DeliveryLog "redelivery aborted (claim send-attempt failed) run=${RunId}: $($sendAttempt.reason)"
        return @{ sent = $false; reason = [string]$sendAttempt.reason }
    }

    Write-DeliveryLog "redelivery skipped (observe-only on AO 0.10) run=$RunId PR #$PrNumber attempt=$Attempt"
    Release-WorkerNudgeActiveClaim -ClaimResult $claim | Out-Null
    return @{ sent = $false; reason = 'redelivery_removed' }
}

function Invoke-DeliveryTick {
    param(
        [string]$Project,
        [hashtable]$Config,
        [switch]$DryRunMode,
        [string]$Fixture,
        [object]$TrackingState,
        [long]$NowMs,
        [string]$PartialStatePath = ''
    )

    if ($Fixture) {
        $payload = Get-FixtureDeliveryPayload -Path $Fixture
        $reviewRuns = $payload.reviewRuns
        $sessions = $payload.sessions
        $openPrs = ConvertTo-GhOpenPrArray -OpenPrs $payload.openPrs
        $tracking = if ($payload.tracking) { $payload.tracking } else { $TrackingState }
        $now = if ($payload.nowMs) { [long]$payload.nowMs } else { $NowMs }
        $tickConfig = if ($payload.config) { $payload.config } else { $Config }
        $aoEvents = @($payload.aoEvents)
        if ($payload.floodActiveSessions) {
            $floodActiveSessions = @{}
            foreach ($prop in $payload.floodActiveSessions.PSObject.Properties) {
                $floodActiveSessions[$prop.Name] = [bool]$prop.Value
            }
        }
        else {
            $floodActiveSessions = Get-FloodActiveSessionMap -Events $aoEvents -NowMs $now
        }
    }
    else {
        $reviewRuns = Get-AoReviewRuns -Project $Project
        $sessions = Get-AoStatusSessions
        $openPrs = ConvertTo-GhOpenPrArray -OpenPrs (Get-OpenPrList)
        $tracking = $TrackingState
        $now = $NowMs
        $tickConfig = $Config
        $aoEvents = Get-AoEventsSince -SinceMinutes 30
        $floodActiveSessions = Get-FloodActiveSessionMap -Events $aoEvents -NowMs $now
    }

    $plan = Invoke-DeliveryFilterCli -Subcommand 'plan' -Payload @{
        reviewRuns          = @($reviewRuns)
        sessions            = @($sessions)
        openPrs             = ConvertTo-GhOpenPrArray -OpenPrs $openPrs
        tracking            = $tracking
        nowMs               = $now
        config              = $tickConfig
        aoEvents            = @($aoEvents)
        floodActiveSessions = $floodActiveSessions
    }

    $redelivered = 0
    $deferred = 0
    $escalated = 0
    $confirmed = 0
    $appliedTracking = @{
        runs       = Copy-DeliveryTrackingRuns -Tracking $tracking
        lastTickMs = $tracking.lastTickMs
    }

    foreach ($action in @($plan.actions)) {
        switch ($action.type) {
            'mark_confirmed' {
                Write-DeliveryLog "delivery confirmed: run=$($action.runId) PR #$($action.prNumber)"
                $confirmed++
                $record = Get-PlannedDeliveryRunRecord -PlannedTracking $plan.tracking -RunId $action.runId
                if ($record) {
                    $appliedTracking.runs[$action.runId] = $record
                    Save-PartialDeliveryTracking -Path $PartialStatePath -AppliedTracking $appliedTracking -DryRunMode:$DryRunMode
                }
            }
            'redeliver' {
                $targetRun = @($reviewRuns | Where-Object { [string]$_.id -eq [string]$action.runId } | Select-Object -First 1)
                $targetSha = if ($targetRun) { [string]$targetRun.targetSha } else { '' }
                $sendResult = Invoke-PlannedReviewSend -RunId $action.runId -PrNumber $action.prNumber `
                    -SessionId $action.sessionId -TargetSha $targetSha -Attempt $action.attempt `
                    -ProjectId $ProjectId -DryRunMode:$DryRunMode
                if ($sendResult.sent) {
                    $redelivered++
                    $record = Get-PlannedDeliveryRunRecord -PlannedTracking $plan.tracking -RunId $action.runId
                    if ($record) {
                        $appliedTracking.runs[$action.runId] = $record
                        Save-PartialDeliveryTracking -Path $PartialStatePath -AppliedTracking $appliedTracking -DryRunMode:$DryRunMode
                    }
                }
                else {
                    $priorRecord = Get-PlannedDeliveryRunRecord -PlannedTracking $tracking -RunId $action.runId
                    if ($priorRecord) {
                        $appliedTracking.runs[$action.runId] = $priorRecord
                    }
                    else {
                        $planRecord = Get-PlannedDeliveryRunRecord -PlannedTracking $plan.tracking -RunId $action.runId
                        if ($planRecord) {
                            $appliedTracking.runs[$action.runId] = @{
                                deliveryState    = 'unconfirmed'
                                sendObservedAtMs = $planRecord.sendObservedAtMs
                                redeliveryCount  = [Math]::Max(0, [int]$action.attempt - 1)
                            }
                        }
                    }
                    Save-PartialDeliveryTracking -Path $PartialStatePath -AppliedTracking $appliedTracking -DryRunMode:$DryRunMode
                }
            }
            'escalate' {
                Write-DeliveryLog $action.message
                $escalated++
                $record = Get-PlannedDeliveryRunRecord -PlannedTracking $plan.tracking -RunId $action.runId
                if ($record) {
                    $appliedTracking.runs[$action.runId] = $record
                    Save-PartialDeliveryTracking -Path $PartialStatePath -AppliedTracking $appliedTracking -DryRunMode:$DryRunMode
                }
            }
            'defer' {
                Write-DeliveryLog "deferred: run=$($action.runId) $($action.reason) (flood or channel not ready)"
                $deferred++
            }
            'wait' {
                Write-DeliveryLog "waiting: run=$($action.runId) $($action.reason) (~$([math]::Round($action.remainingMs / 1000))s left)"
            }
        }
    }

    return @{
        tracking    = Merge-DeliveryTickTracking -PlannedTracking $plan.tracking -AppliedRuns $appliedTracking.runs
        redelivered = $redelivered
        deferred    = $deferred
        escalated   = $escalated
        confirmed   = $confirmed
    }
}

$intervalMinutes = Get-DeliveryIntervalMinutes
$intervalMs = [Math]::Max(1, $intervalMinutes) * 60 * 1000
$windowMinutes = Get-DeliveryConfirmationWindowMinutes
$windowMs = [Math]::Max(1, $windowMinutes) * 60 * 1000
$maxRedeliveries = Get-DeliveryMaxRedeliveries
$pollMs = [Math]::Max(5, $PollSeconds) * 1000
$statePath = Get-DeliveryStatePath -CliPath $StateFile
$config = @{
    confirmationWindowMs = $windowMs
    maxRedeliveries      = $maxRedeliveries
}

Write-DeliveryLog "starting (project=$ProjectId, interval=${intervalMinutes}m, window=${windowMinutes}m, maxRedeliveries=$maxRedeliveries, state=$statePath, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"

if ($FixturePath) {
    $state = Get-DeliveryState -Path $statePath
    $result = Invoke-DeliveryTick -Project $ProjectId -Config $config -DryRunMode:$DryRun `
        -Fixture $FixturePath -TrackingState $state -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    if (-not $DryRun) {
        Set-DeliveryState -Path $statePath -State $result.tracking
    }
    Write-DeliveryLog "fixture tick complete (confirmed=$($result.confirmed) redelivered=$($result.redelivered) deferred=$($result.deferred) escalated=$($result.escalated))"
    exit 0
}

$tickFailed = $false

try {
    do {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $state = Get-DeliveryState -Path $statePath
        $lastTickMs = $null
        if ($state.lastTickMs) {
            $lastTickMs = [long]$state.lastTickMs
        }

        $gate = Invoke-DeliveryFilterCli -Subcommand 'interval' -Payload @{
            nowMs      = $nowMs
            lastTickMs = $lastTickMs
            intervalMs = $intervalMs
        }

        Write-OrchestratorSideProcessProgress -ChildId 'review-finding-delivery-confirm' -Phase 'poll'
        if (-not $gate.ok) {
            Write-DeliveryLog "tick skipped: $($gate.reason)"
        }
        else {
            if (-not (Test-MechanicalJsonStateFencesTrusted -State $state)) {
                $reason = Get-MechanicalJsonStateRecoveryReason -State $state
                Write-DeliveryLog "STATE FENCES UNTRUSTED: $reason; failing closed for side effects"
                Write-OrchestratorSideProcessTickError -ChildId 'review-finding-delivery-confirm' `
                    -ErrorMessage "fences untrusted: $reason"
            }
            else {
                try {
                    $partialStatePath = if ($DryRun) { '' } else { $statePath }
                    $result = Invoke-DeliveryTick -Project $ProjectId -Config $config -DryRunMode:$DryRun `
                        -TrackingState $state -NowMs $nowMs -PartialStatePath $partialStatePath
                    $nextState = $result.tracking
                    $nextState.lastTickMs = $nowMs
                    if (-not $DryRun) {
                        Set-DeliveryState -Path $statePath -State $nextState
                    }
                    else {
                        Write-DeliveryLog 'dry-run: delivery state not updated'
                    }
                    Write-DeliveryLog "tick complete (confirmed=$($result.confirmed) redelivered=$($result.redelivered) deferred=$($result.deferred) escalated=$($result.escalated))"
                    Write-OrchestratorSideProcessTickSuccess -ChildId 'review-finding-delivery-confirm'
                }
                catch {
                    $tickFailed = $true
                    Write-DeliveryLog "tick error: $_"
                    Write-OrchestratorSideProcessTickError -ChildId 'review-finding-delivery-confirm' -ErrorMessage "$_"
                }
            }
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)

    if ($Once -and $tickFailed) {
        exit 1
    }
}
finally {
    Write-DeliveryLog 'stopped'
}
