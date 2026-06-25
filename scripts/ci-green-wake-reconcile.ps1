#requires -Version 5.1
<#
.SYNOPSIS
  State-derived CI-green worker wake reconciliation (Issue #191).

.DESCRIPTION
  Independent process from the LLM orchestrator turn loop. Enumerates open PR heads,
  evaluates required CI + worker pre-hand-off state, and ao send nudges to the live
  head-owning worker when CI is green — never ao spawn, --claim-pr, or ao session kill.

  AO 0.9.x has no CI-green reaction key for send-to-agent; this script is the
  non-turn-gated fast path (default 1-minute tick; worst-case latency ~60s + poll,
  far below report-stale ~30m). reactions.ci-failed and report-stale remain upstream
  backstops. Does not recover dead workers (#98).

  See docs/orchestrator-autoloop-go-live.md and docs/migration_notes.md.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [int]$IntervalMinutes = 0,
    [int]$PollSeconds = 60,
    [string]$StateFile = '',
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'
$Script:ReconcileLogPrefix = 'ci-green-wake-reconcile'

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) {
    $RepoRoot = $PackRoot
}

$WakeFilterCli = Join-Path $PackRoot 'docs/ci-green-wake-reconcile.mjs'
$Script:DefaultIntervalMinutes = 1

. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Ci-Green-Wake-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-WorkerMessageDispatch.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-AutonomousNudgeGate.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeAudit.ps1')

function Get-CiGreenWakeIntervalMinutes {
    if ($IntervalMinutes -gt 0) { return $IntervalMinutes }
    $envMinutes = $env:AO_CI_GREEN_WAKE_RECONCILE_INTERVAL_MINUTES
    if ($envMinutes -and [int]::TryParse($envMinutes, [ref]$null)) {
        return [int]$envMinutes
    }
    return $Script:DefaultIntervalMinutes
}

function Get-CiGreenWakeStatePath {
    param([string]$CliPath)
    if ($CliPath) { return $CliPath }
    if ($env:AO_CI_GREEN_WAKE_RECONCILE_STATE) { return $env:AO_CI_GREEN_WAKE_RECONCILE_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-ci-green-wake-state.json'
}

function Write-CiGreenWakeLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReconcileLogPrefix): $Message"
}

$Script:GhPrChecksLogWriter = { param([string]$Message) Write-CiGreenWakeLog $Message }

function Invoke-CiGreenWakeFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $WakeFilterCli -Subcommand $Subcommand `
        -Payload $Payload -Label $Script:ReconcileLogPrefix -JsonDepth 30
}

$Script:CiGreenWakeDefaultState = @{ heads = @{}; nudged = @{}; pendingJournal = @{}; lastTickMs = $null; cycleState = @{} }

function Get-CiGreenWakeState {
    param([string]$Path)

    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $Script:CiGreenWakeDefaultState -ActionTracking
}

function Set-CiGreenWakeState {
    param(
        [string]$Path,
        [object]$State
    )

    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $Script:CiGreenWakeDefaultState -JsonDepth 30
}

function Save-PartialCiGreenWakeTracking {
    param(
        [string]$Path,
        [hashtable]$HeadRecords,
        [hashtable]$Nudged,
        [hashtable]$PendingJournal,
        [object]$CycleState,
        [switch]$DryRunMode
    )

    if ($DryRunMode -or -not $Path) {
        return
    }

    $existing = Get-CiGreenWakeState -Path $Path
    $merged = @{
        heads          = $HeadRecords
        nudged         = $Nudged
        pendingJournal = $PendingJournal
        cycleState     = $CycleState
        lastTickMs     = $existing.lastTickMs
    }
    Set-CiGreenWakeState -Path $Path -State $merged
}

function Commit-CiGreenNudgeSentCycleState {
    param(
        [object]$CycleState,
        [object]$Action,
        [long]$SentAtMs
    )

    if (-not $Action.ownerCycle) {
        return $CycleState
    }

    $commit = Invoke-CiGreenWakeFilterCli -Subcommand 'commit-nudge-sent' -Payload @{
        cycleState     = $CycleState
        repoId         = [string]$Action.ownerCycle.repoId
        prNumber       = [int]$Action.prNumber
        ownerSessionId = [string]$Action.sessionId
        cycle          = $Action.ownerCycle.cycle
        sentAtMs       = $SentAtMs
    }
    if ($commit.cycleState) {
        return $commit.cycleState
    }
    return $CycleState
}

function Retry-PendingCiGreenDispatchJournals {
    param(
        [hashtable]$PendingJournal,
        [hashtable]$Nudged,
        [switch]$DryRunMode
    )

    if ($DryRunMode) {
        if ($PendingJournal.Count -gt 0) {
            Write-CiGreenWakeLog "dry-run skipping $($PendingJournal.Count) pending dispatch journal replay(s)"
        }
        return 0
    }

    $resolved = 0
    foreach ($transitionId in @($PendingJournal.Keys)) {
        $pending = $PendingJournal[$transitionId]
        if (-not $pending) {
            continue
        }
        $dispatchResult = Register-WorkerMessageDispatch -SessionId ([string]$pending.sessionId) `
            -Message ([string]$pending.message) `
            -Source 'pack-send' -SourceKey "ci-green:$transitionId" `
            -DeliveredAtMs ([long]$pending.sentAtMs)
        if (-not $dispatchResult.recorded) {
            continue
        }
        $Nudged[$transitionId] = @{
            sessionId = [string]$pending.sessionId
            sentAtMs  = [long]$pending.sentAtMs
        }
        $PendingJournal.Remove($transitionId) | Out-Null
        $resolved++
        Write-CiGreenWakeLog "dispatch journal recovered transition=$transitionId session=$($pending.sessionId)"
    }
    return $resolved
}

function Get-CiGreenWakeChecksByPr {
    param([array]$OpenPrs)

    return Get-GhChecksBundleByPr -RepoRoot $RepoRoot -OpenPrs @($OpenPrs) `
        -MergeRequiredNames {
            param($payload)
            Invoke-CiGreenWakeFilterCli -Subcommand 'merge-required-names' -Payload $payload
        } `
        -ProtectionLookupWarningTemplate 'warn: branch protection lookup failed PR #{0} (exit {1}); treating required CI as pending'
}

function Get-CiGreenWakeDeliveryPayload {
    param(
        [string]$Project
    )

    return @{
        workerDeliveries = @()
        aoEvents           = @(Get-AoEventsSince -SinceMinutes 30)
        dispatchJournal    = Get-WorkerMessageDispatchJournal
        reviewRuns         = @(Get-AoReviewRuns -Project $Project)
    }
}

function Get-CiGreenWakePreSendSnapshot {
    param(
        [int]$PrNumber,
        [string]$Project,
        [object]$Tracking = $null
    )

    $openPrs = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot)
    $sessions = Get-AoStatusSessions
    $checksBundle = Get-CiGreenWakeChecksByPr -OpenPrs @(
        @($openPrs | Where-Object { [int]$_.number -eq $PrNumber })
    )
    $deliveryPayload = Get-CiGreenWakeDeliveryPayload -Project $Project

    $snapshot = @{
        openPrs                         = @($openPrs)
        sessions                        = @($sessions)
        ciChecksByPr                    = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr          = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr   = $checksBundle.requiredCheckLookupFailedByPr
        reviewRuns                      = @($deliveryPayload.reviewRuns)
        aoEvents                        = @($deliveryPayload.aoEvents)
        dispatchJournal                 = $deliveryPayload.dispatchJournal
        nowMs                           = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        repoRoot                        = $RepoRoot
    }
    if ($Tracking) {
        if ($Tracking.cycleState) {
            $snapshot.cycleState = $Tracking.cycleState
        }
        if ($Tracking.nudged) {
            $snapshot.nudged = $Tracking.nudged
        }
    }
    return $snapshot
}

function Get-FixtureCiGreenWakePayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $payload = @{
        openPrs                         = @($fixture.openPrs)
        sessions                        = @($fixture.sessions)
        ciChecksByPr                    = $fixture.ciChecksByPr
        requiredCheckNamesByPr          = $fixture.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr   = $fixture.requiredCheckLookupFailedByPr
        tracking                        = $fixture.tracking
    }
    if ($fixture.reviewRuns) {
        $payload.reviewRuns = @($fixture.reviewRuns)
    }
    return Merge-MechanicalFixtureDeliveryFields -Payload $payload -Fixture $fixture
}

function Invoke-PlannedCiGreenWakeSend {
    param(
        [object]$Action,
        [object]$FreshPayload,
        [string]$Project,
        [object]$Tracking = $null,
        [switch]$DryRunMode,
        [switch]$UseFixtureSnapshot
    )

    if ($UseFixtureSnapshot) {
        if (-not $FreshPayload) {
            throw 'FreshPayload is required when UseFixtureSnapshot is set'
        }
    }
    else {
        $FreshPayload = Get-CiGreenWakePreSendSnapshot -PrNumber ([int]$Action.prNumber) -Project $Project `
            -Tracking $Tracking
    }

    $recheck = Invoke-CiGreenWakeFilterCli -Subcommand 'recheck' -Payload @{
        planned = @{
            sessionId = [string]$Action.sessionId
            prNumber  = [int]$Action.prNumber
            headSha   = [string]$Action.headSha
        }
        fresh = $FreshPayload
    }

    if (-not $recheck.ok) {
        Write-CiGreenWakeLog "pre-send recheck failed PR #$($Action.prNumber): $($recheck.reason)"
        return @{ sent = $false; reason = $recheck.reason }
    }

    $sendArgs = @('send', [string]$Action.sessionId, [string]$Action.message)
    $commandLine = "ao $($sendArgs -join ' ')"
    Test-CiGreenWakeMechanicalForbiddenCommand -CommandLine $commandLine

    if ($DryRunMode) {
        Write-CiGreenWakeLog "dry-run would send: PR #$($Action.prNumber) head=$($Action.headSha) session=$($Action.sessionId) transition=$($Action.transitionId)"
        return @{ sent = $true; reason = 'dry_run' }
    }

    $cycleKey = "transition:$([string]$Action.transitionId)"
    $sessionId = [string]$Action.sessionId
    $openPrs = @()
    if ($FreshPayload -and $FreshPayload.openPrs) {
        $openPrs = @($FreshPayload.openPrs)
    }
    $targetResolution = Resolve-WorkerNudgeTargetFromPrClaim -PrNumber ([int]$Action.prNumber) -SessionId $sessionId `
        -HeadSha ([string]$Action.headSha) -ProjectId $ProjectId -OpenPrs $openPrs
    if (-not $targetResolution.ok) {
        Write-CiGreenWakeLog "nudge suppressed (PR-claim target unresolved) PR #$($Action.prNumber): $($targetResolution.reason)"
        return @{ sent = $false; reason = [string]$targetResolution.reason; targetUnresolved = $true }
    }
    $targetId = [string]$targetResolution.targetId
    $targetGeneration = [string]$targetResolution.targetGeneration
    $workerTarget = [string]$targetResolution.workerTarget
    if (-not $workerTarget) { $workerTarget = "$targetId`:$targetGeneration" }
    $sendSessionId = [string]$targetResolution.ownerSessionId
    if (-not $sendSessionId) { $sendSessionId = $sessionId }
    $ciGreenMessage = [string]$Action.message
    $tupleKey = "$([int]$Action.prNumber)|$cycleKey|ci-green-handoff|$workerTarget"
    $namespace = Resolve-WorkerNudgeClaimNamespace -ProjectId $ProjectId
    $targetResolutionSource = [string]$targetResolution.targetResolutionSource
    if (-not $targetResolutionSource) { $targetResolutionSource = 'pr-claim' }
    $gate = Invoke-WorkerNudgeFilterCli -Subcommand 'evaluateNudgeGate' -Payload @{
        prNumber               = [int]$Action.prNumber
        headSha                = [string]$Action.headSha
        sessionId              = $sendSessionId
        sendTarget             = $sendSessionId
        intentClass            = 'ci-green-handoff'
        cycleKey               = $cycleKey
        targetId               = $targetId
        targetGeneration       = $targetGeneration
        source                 = 'ci-green-wake-reconcile'
        surface                = 'ci-green-wake-reconcile'
        message                = $ciGreenMessage
        storePath              = $namespace
        targetResolutionSource = $targetResolutionSource
        claims                 = @(Get-WorkerNudgeClaimRecordsForGate -Namespace $namespace)
    }
    if (-not $gate.allow) {
        Write-WorkerNudgeGateDecisionAudit -Record $gate.audit -ProjectId $ProjectId | Out-Null
        Write-CiGreenWakeLog "nudge suppressed by gate PR #$($Action.prNumber): $($gate.reason)"
        return @{
            sent         = $false
            reason       = [string]$gate.reason
            claimSkipped = $true
            escalate     = [bool]$gate.escalate
            diagnosis    = [string]$gate.diagnosis
        }
    }
    $claim = Acquire-WorkerNudgeClaim -PrNumber ([int]$Action.prNumber) -CycleKey $cycleKey -IntentClass 'ci-green-handoff' `
        -WorkerTarget $workerTarget -SessionId $sendSessionId -TargetId $targetId -TargetGeneration $targetGeneration `
        -TupleKey $tupleKey -Surface 'ci-green-wake-reconcile' -ProjectId $ProjectId -Message $ciGreenMessage -Namespace $namespace
    if (-not $claim.acquired) {
        $claimPhase = if ($claim.phase) { [string]$claim.phase } else { 'none' }
        Write-WorkerNudgeGateDecisionAudit -Record (Merge-WorkerNudgeClaimSkipAudit -GateAudit $gate.audit -Reason ([string]$claim.reason) -ClaimPhase $claimPhase) -ProjectId $ProjectId | Out-Null
        Write-CiGreenWakeLog "nudge suppressed by claim gate PR #$($Action.prNumber): $($claim.reason)"
        return @{
            sent         = $false
            reason       = [string]$claim.reason
            claimSkipped = $true
            escalate     = [bool]$claim.escalate
            diagnosis    = [string]$claim.diagnosis
        }
    }
    $messageHashResult = Invoke-WorkerNudgeFilterCli -Subcommand 'hashMessageContent' -Payload @{ message = $ciGreenMessage }
    $messageContentHash = [string]$messageHashResult.messageContentHash
    $hashPersist = Set-WorkerNudgeClaimMessageContentHash -ClaimResult $claim -MessageContentHash $messageContentHash
    if (-not $hashPersist.ok) {
        Release-WorkerNudgeActiveClaim -ClaimResult $claim | Out-Null
        Write-CiGreenWakeLog "message hash persist failed PR #$($Action.prNumber): $($hashPersist.reason)"
        return @{ sent = $false; reason = 'message_hash_persist_failed'; detail = [string]$hashPersist.reason }
    }
    $claimToken = New-WorkerNudgeClaimToken -ClaimResult $claim

    Write-CiGreenWakeLog "nudging worker: PR #$($Action.prNumber) head=$($Action.headSha) session=$sendSessionId transition=$($Action.transitionId)"
    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'ci-green-wake-side-effect.lock'
    Write-OrchestratorSideProcessProgress -ChildId 'ci-green-wake-reconcile' -Phase 'side_effect'
    $journaledScript = Join-Path $PSScriptRoot 'journaled-worker-send.ps1'
    $sendExitCapture = @{ exitCode = 0 }
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        $ciGreenMessage | pwsh -NoProfile -File $journaledScript $sendSessionId `
            -Source 'pack-send' -SourceKey "ci-green:$([string]$Action.transitionId)" `
            -ClaimToken $claimToken -GatedNudge -NoWait
        $sendExitCapture.exitCode = $LASTEXITCODE
    }
    $sendExitCode = [int]$sendExitCapture.exitCode
    if (-not $fenced.ok) {
        Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'FAILED_DEFINITIVE' -Extra @{ reason = 'side_effect_busy' } | Out-Null
        Write-WorkerNudgeGateDecisionAudit -Record (Merge-WorkerNudgeClaimSkipAudit -GateAudit $gate.audit -Reason 'side_effect_busy' -ClaimPhase 'CLAIMED') -ProjectId $ProjectId | Out-Null
        Write-CiGreenWakeLog "nudge skipped (side-effect busy) PR #$($Action.prNumber)"
        return @{ sent = $false; reason = 'side_effect_busy' }
    }
    if ($sendExitCode -ne 0) {
        if ($sendExitCode -eq 44 -or $sendExitCode -eq 47) {
            $uncertainReason = if ($sendExitCode -eq 47) { 'journal_update_unknown' } else { 'dispatch_unknown' }
            Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'UNCERTAIN' -Extra @{ reason = $uncertainReason } | Out-Null
            Write-WorkerNudgeGateDecisionAudit -Record (Merge-WorkerNudgeClaimSkipAudit -GateAudit $gate.audit -Reason $uncertainReason -ClaimPhase 'UNCERTAIN') -ProjectId $ProjectId | Out-Null
            Write-CiGreenWakeLog "journaled worker send uncertain PR #$($Action.prNumber): $uncertainReason exit=$sendExitCode"
            return @{
                sent            = $false
                reason          = $uncertainReason
                uncertain       = $true
                delivered       = $true
                journalRecorded = $false
            }
        }
        Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'FAILED_DEFINITIVE' -Extra @{ exitCode = $sendExitCode } | Out-Null
        Write-CiGreenWakeLog "journaled worker send failed PR #$($Action.prNumber): exit=$sendExitCode"
        return @{ sent = $false; reason = 'send_failed'; exitCode = $sendExitCode }
    }

    Write-WorkerNudgeGateDecisionAudit -Record $gate.audit -ProjectId $ProjectId | Out-Null
    return @{
        sent            = $true
        delivered       = $true
        journalRecorded = $true
        reason          = 'sent'
    }
}

function Invoke-CiGreenWakeTick {
    param(
        [string]$Project,
        [string]$StatePath,
        [switch]$DryRunMode,
        [string]$Fixture
    )

    $tracking = Get-CiGreenWakeState -Path $StatePath
    Assert-MechanicalJsonStateFencesTrusted -State $tracking -Context 'side effects'

    $ciChecksByPr = @{}
    $requiredCheckNamesByPr = @{}
    $requiredCheckLookupFailedByPr = @{}

    if ($Fixture) {
        $payload = Get-FixtureCiGreenWakePayload -Path $Fixture
        $openPrs = $payload.openPrs
        $sessions = $payload.sessions
        $ciChecksByPr = $payload.ciChecksByPr
        if ($payload.requiredCheckNamesByPr) {
            $requiredCheckNamesByPr = $payload.requiredCheckNamesByPr
        }
        if ($payload.requiredCheckLookupFailedByPr) {
            $requiredCheckLookupFailedByPr = $payload.requiredCheckLookupFailedByPr
        }
        if ($payload.tracking) {
            $tracking = $payload.tracking
        }
    }
    else {
        $openPrs = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot)
        $sessions = Get-AoStatusSessions
        $checksBundle = Get-CiGreenWakeChecksByPr -OpenPrs @($openPrs)
        $ciChecksByPr = $checksBundle.ciChecksByPr
        $requiredCheckNamesByPr = $checksBundle.requiredCheckNamesByPr
        $requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
    }

    $nudged = Copy-MechanicalJsonMap -Map $tracking.nudged
    $pendingJournal = Copy-MechanicalJsonMap -Map $tracking.pendingJournal
    $journalRetries = Retry-PendingCiGreenDispatchJournals -PendingJournal $pendingJournal -Nudged $nudged `
        -DryRunMode:$DryRunMode
    if ($journalRetries -gt 0) {
        Write-CiGreenWakeLog "recovered $journalRetries pending dispatch journal record(s)"
    }
    $tracking = @{
        heads          = $tracking.heads
        nudged         = $nudged
        pendingJournal = $pendingJournal
        cycleState     = $tracking.cycleState
        lastTickMs     = $tracking.lastTickMs
    }

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $reviewRuns = @()
    $workerDeliveries = @()
    $aoEvents = @()
    $dispatchJournal = @{}
    if ($Fixture) {
        if ($payload.reviewRuns) { $reviewRuns = @($payload.reviewRuns) }
        if ($payload.workerDeliveries) { $workerDeliveries = @($payload.workerDeliveries) }
        if ($payload.aoEvents) { $aoEvents = @($payload.aoEvents) }
        if ($payload.dispatchJournal) { $dispatchJournal = $payload.dispatchJournal }
    }
    else {
        $deliveryPayload = Get-CiGreenWakeDeliveryPayload -Project $Project
        $reviewRuns = @($deliveryPayload.reviewRuns)
        $aoEvents = @($deliveryPayload.aoEvents)
        $dispatchJournal = $deliveryPayload.dispatchJournal
    }

    $planPayload = @{
        openPrs                         = @($openPrs)
        sessions                        = @($sessions)
        ciChecksByPr                    = $ciChecksByPr
        requiredCheckNamesByPr          = $requiredCheckNamesByPr
        requiredCheckLookupFailedByPr   = $requiredCheckLookupFailedByPr
        tracking                        = $tracking
        reviewRuns                      = @($reviewRuns)
        workerDeliveries                = @($workerDeliveries)
        aoEvents                        = @($aoEvents)
        dispatchJournal                 = $dispatchJournal
        nowMs                           = $nowMs
        repoRoot                        = $RepoRoot
    }

    $plan = Invoke-CiGreenWakeFilterCli -Subcommand 'plan' -Payload $planPayload
    $useFixtureSnapshot = [bool]$Fixture

    $headRecords = Copy-MechanicalJsonMap -Map $plan.headRecords
    $cycleState = $plan.cycleState
    if (-not $cycleState) {
        $cycleState = $tracking.cycleState
    }

    $sent = 0
    $nudged = Copy-MechanicalJsonMap -Map $tracking.nudged
    $pendingJournal = Copy-MechanicalJsonMap -Map $tracking.pendingJournal

    $fixtureFreshPayload = $null
    if ($useFixtureSnapshot) {
        $fixtureFreshPayload = @{
            openPrs                         = @($openPrs)
            sessions                        = @($sessions)
            ciChecksByPr                    = $ciChecksByPr
            requiredCheckNamesByPr          = $requiredCheckNamesByPr
            requiredCheckLookupFailedByPr   = $requiredCheckLookupFailedByPr
            reviewRuns                      = @($reviewRuns)
            aoEvents                        = @($aoEvents)
            dispatchJournal                 = $dispatchJournal
            cycleState                      = $cycleState
            nudged                          = $nudged
            nowMs                           = $nowMs
            repoRoot                        = $RepoRoot
        }
    }

    $partialStatePath = if ($DryRunMode) { '' } else { $StatePath }

    foreach ($action in @($plan.actions)) {
        if ($action.type -eq 'skip') {
            Write-CiGreenWakeLog "skip PR #$($action.prNumber): $($action.reason)"
            continue
        }
        if ($action.type -ne 'nudge') {
            continue
        }

        if ($pendingJournal[[string]$action.transitionId]) {
            Write-CiGreenWakeLog "skip PR #$($action.prNumber): journal_pending"
            continue
        }

        try {
            $result = Invoke-PlannedCiGreenWakeSend -Action $action -FreshPayload $fixtureFreshPayload `
                -Project $Project -Tracking $tracking -DryRunMode:$DryRunMode -UseFixtureSnapshot:$useFixtureSnapshot
        }
        catch {
            Write-CiGreenWakeLog "send error PR #$($action.prNumber): $_"
            continue
        }

        if ($result.delivered -and -not $result.journalRecorded) {
            if (-not $DryRunMode) {
                $sentAtMs = if ($result.deliveredAtMs) {
                    [long]$result.deliveredAtMs
                }
                else {
                    [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                }
                $pendingJournal[[string]$action.transitionId] = @{
                    sessionId = [string]$action.sessionId
                    sentAtMs  = $sentAtMs
                    message   = [string]$action.message
                }
                $cycleState = Commit-CiGreenNudgeSentCycleState -CycleState $cycleState -Action $action -SentAtMs $sentAtMs
                Save-PartialCiGreenWakeTracking -Path $partialStatePath -HeadRecords $headRecords `
                    -Nudged $nudged -PendingJournal $pendingJournal -CycleState $cycleState -DryRunMode:$DryRunMode
            }
            continue
        }

        if ($result.sent) {
            if (-not $DryRunMode) {
                $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                $nudged[[string]$action.transitionId] = @{
                    sessionId = [string]$action.sessionId
                    sentAtMs  = $nowMs
                }
                $cycleState = Commit-CiGreenNudgeSentCycleState -CycleState $cycleState -Action $action -SentAtMs $nowMs
                Save-PartialCiGreenWakeTracking -Path $partialStatePath -HeadRecords $headRecords `
                    -Nudged $nudged -PendingJournal $pendingJournal -CycleState $cycleState -DryRunMode:$DryRunMode
            }
            $sent++
        }
    }

    $merged = @{
        heads          = $headRecords
        nudged         = $nudged
        pendingJournal = $pendingJournal
        cycleState     = $cycleState
        lastTickMs     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    if (-not $DryRunMode) {
        Set-CiGreenWakeState -Path $StatePath -State $merged
    }

    return $sent
}

$intervalMinutes = Get-CiGreenWakeIntervalMinutes
$intervalMs = [Math]::Max(1, $intervalMinutes) * 60 * 1000
$pollMs = [Math]::Max(5, $PollSeconds) * 1000
$statePath = Get-CiGreenWakeStatePath -CliPath $StateFile

Write-CiGreenWakeLog "starting (project=$ProjectId, interval=${intervalMinutes}m, state=$statePath, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"
Write-CiGreenWakeLog "feasibility: AO 0.9.x has no CI-green send-to-agent reaction; this process is the fast path (worst-case ~${PollSeconds}s poll + ${intervalMinutes}m tick, << report-stale ~30m)"

if ($FixturePath) {
    $count = Invoke-CiGreenWakeTick -Project $ProjectId -StatePath $statePath -DryRunMode:$DryRun -Fixture $FixturePath
    Write-CiGreenWakeLog "fixture tick complete (sent=$count)"
    exit 0
}

try {
    do {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $state = Get-CiGreenWakeState -Path $statePath
        $lastTickMs = $null
        if ($state.lastTickMs) {
            $lastTickMs = [long]$state.lastTickMs
        }

        $gate = Invoke-CiGreenWakeFilterCli -Subcommand 'interval' -Payload @{
            nowMs      = $nowMs
            lastTickMs = $lastTickMs
            intervalMs = $intervalMs
        }

        Write-OrchestratorSideProcessProgress -ChildId 'ci-green-wake-reconcile' -Phase 'poll'
        if (-not $gate.ok) {
            Write-CiGreenWakeLog "tick skipped: $($gate.reason)"
        }
        else {
            try {
                $count = Invoke-CiGreenWakeTick -Project $ProjectId -StatePath $statePath -DryRunMode:$DryRun
                Write-CiGreenWakeLog "tick complete (sent=$count)"
                Write-OrchestratorSideProcessTickSuccess -ChildId 'ci-green-wake-reconcile'
            }
            catch {
                Write-CiGreenWakeLog "tick error: $_"
                Write-OrchestratorSideProcessTickError -ChildId 'ci-green-wake-reconcile' -ErrorMessage "$_"
            }
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-CiGreenWakeLog 'stopped'
}
