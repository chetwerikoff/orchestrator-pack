#requires -Version 5.1
<#
.SYNOPSIS
  State-derived first review-finding delivery reconciliation (Issue #202).

.DESCRIPTION
  Issue #202 first-send path only: when review completes into needs_triage with
  sentFindingCount: 0, this loop ao review send's findings to the live head-owning worker
  without an LLM orchestrator turn. Split-brain envelope forbids ao spawn, claim-pr,
  session kill, ao send, ao report, and ao review run.

  Bounded re-delivery after send stays in review-finding-delivery-confirm.ps1 (#171).
  Operator surfaces: docs/orchestrator-autoloop-go-live.md,
  docs/orchestrator-recovery-runbook.md (First-send review findings undelivered).
#>
[CmdletBinding()]
param(
    # AO project id for ao review list / ao status snapshots
    [string]$ProjectId = 'orchestrator-pack',
  # Pack repo root passed to gh pr list helpers
    [string]$RepoRoot = '',
  # Tick cadence override; env AO_REVIEW_SEND_RECONCILE_INTERVAL_MINUTES wins when zero
    [int]$IntervalMinutes = 0,
  # Poll sleep between interval gate checks (seconds)
    [int]$PollSeconds = 60,
  # Dedupe state path; env AO_REVIEW_SEND_RECONCILE_STATE when empty
    [string]$StateFile = '',
    [switch]$DryRun,
    [switch]$Once,
  # JSON fixture for contract tests (no live ao/gh)
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'
$Script:ReconcileLogPrefix = 'review-send-reconcile'

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) {
    $RepoRoot = $PackRoot
}

$SendFilterCli = Join-Path $PackRoot 'docs/review-send-reconcile.mjs'
$Script:DefaultIntervalMinutes = 2

. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-Send-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-WorkerMessageDispatch.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-AutonomousNudgeGate.ps1')

function Get-ReviewSendIntervalMinutes {
    if ($IntervalMinutes -gt 0) { return $IntervalMinutes }
    $envMinutes = $env:AO_REVIEW_SEND_RECONCILE_INTERVAL_MINUTES
    if ($envMinutes -and [int]::TryParse($envMinutes, [ref]$null)) {
        return [int]$envMinutes
    }
    return $Script:DefaultIntervalMinutes
}

function Get-ReviewSendStatePath {
    param([string]$CliPath)
    if ($CliPath) { return $CliPath }
    if ($env:AO_REVIEW_SEND_RECONCILE_STATE) { return $env:AO_REVIEW_SEND_RECONCILE_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-send-reconcile-state.json'
}

function Write-ReviewSendLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReconcileLogPrefix): $Message"
}

function Invoke-ReviewSendFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $SendFilterCli -Subcommand $Subcommand `
        -Payload $Payload -Label $Script:ReconcileLogPrefix -JsonDepth 30
}

$Script:ReviewSendDefaultState = @{ sent = @{}; lastTickMs = $null }

function Get-ReviewSendState {
    param([string]$Path)

    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $Script:ReviewSendDefaultState -ActionTracking
}

function Set-ReviewSendState {
    param(
        [string]$Path,
        [object]$State
    )

    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $Script:ReviewSendDefaultState -JsonDepth 30
}

function Save-PartialReviewSendTracking {
    param(
        [string]$Path,
        [hashtable]$Sent,
        [switch]$DryRunMode
    )

    if ($DryRunMode -or -not $Path) {
        return
    }

    $existing = Get-ReviewSendState -Path $Path
    $merged = @{
        sent       = $Sent
        lastTickMs = $existing.lastTickMs
    }
    Set-ReviewSendState -Path $Path -State $merged
}

function Get-FixtureReviewSendPayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $payload = @{
        reviewRuns = @($fixture.reviewRuns)
        sessions   = @($fixture.sessions)
        openPrs    = @($fixture.openPrs)
    }
    if ($fixture.mergedPrNumbers) {
        $payload.mergedPrNumbers = @($fixture.mergedPrNumbers)
    }
    if ($fixture.tracking) {
        $payload.tracking = $fixture.tracking
    }
    return $payload
}

function Get-ReviewSendPreSendSnapshot {
    param(
        [string]$RunId,
        [string]$Project
    )

    return @{
        reviewRuns = @(Get-AoReviewRuns -Project $Project)
        sessions   = @(Get-AoStatusSessions)
        openPrs    = @(Invoke-GhOpenPrList -RepoRoot $RepoRoot)
    }
}

function Invoke-PlannedFirstReviewSend {
    param(
        [object]$Action,
        [object]$FreshPayload,
        [string]$Project,
        [switch]$DryRunMode,
        [switch]$UseFixtureSnapshot
    )

    if ($UseFixtureSnapshot) {
        # Fixture ticks never call live ao/gh (contract tests must run without AO).
        $DryRunMode = $true
        if (-not $FreshPayload) {
            throw 'FreshPayload is required when UseFixtureSnapshot is set'
        }
    }
    elseif (-not $FreshPayload) {
        $FreshPayload = Get-ReviewSendPreSendSnapshot -RunId ([string]$Action.runId) -Project $Project
    }

    $recheck = Invoke-ReviewSendFilterCli -Subcommand 'recheck' -Payload @{
        planned = @{
            runId     = [string]$Action.runId
            prNumber  = [int]$Action.prNumber
            targetSha = [string]$Action.targetSha
            sessionId = [string]$Action.sessionId
        }
        fresh   = $FreshPayload
    }

    if (-not $recheck.ok) {
        Write-ReviewSendLog "pre-send recheck failed run=$($Action.runId): $($recheck.reason)"
        return @{ sent = $false; reason = $recheck.reason }
    }

    $sendArgs = @('review', 'send', [string]$Action.runId)
    $commandLine = "ao $($sendArgs -join ' ')"
    Test-ReviewSendMechanicalForbiddenCommand -CommandLine $commandLine

    if ($DryRunMode) {
        Write-ReviewSendLog "dry-run would send: run=$($Action.runId) PR #$($Action.prNumber) head=$($Action.targetSha) session=$($Action.sessionId)"
        return @{ sent = $true; reason = 'dry_run' }
    }

    $cycleKey = "run:$([string]$Action.runId)"
    $sessionId = [string]$Action.sessionId
    $openPrs = @()
    if ($FreshPayload -and $FreshPayload.openPrs) {
        $openPrs = @($FreshPayload.openPrs)
    }
    $targetResolution = Resolve-WorkerNudgeTargetFromPrClaim -PrNumber ([int]$Action.prNumber) -SessionId $sessionId `
        -HeadSha ([string]$Action.targetSha) -ProjectId $Project -OpenPrs $openPrs
    if (-not $targetResolution.ok) {
        Write-ReviewSendLog "send suppressed (PR-claim target unresolved) run=$($Action.runId): $($targetResolution.reason)"
        return @{ sent = $false; reason = [string]$targetResolution.reason; targetUnresolved = $true }
    }
    $targetId = [string]$targetResolution.targetId
    $targetGeneration = [string]$targetResolution.targetGeneration
    $workerTarget = [string]$targetResolution.workerTarget
    if (-not $workerTarget) { $workerTarget = "$targetId`:$targetGeneration" }
    $sendSessionId = [string]$targetResolution.ownerSessionId
    if (-not $sendSessionId) { $sendSessionId = $sessionId }
    $tupleKey = "$([int]$Action.prNumber)|$cycleKey|findings-delivery|$workerTarget"
    $claim = Acquire-WorkerNudgeClaim -PrNumber ([int]$Action.prNumber) -CycleKey $cycleKey -IntentClass 'findings-delivery' `
        -WorkerTarget $workerTarget -SessionId $sendSessionId -TargetId $targetId -TargetGeneration $targetGeneration `
        -TupleKey $tupleKey -Surface 'review-send-reconcile' -ProjectId $Project
    if (-not $claim.acquired) {
        Write-ReviewSendLog "send suppressed by claim gate run=$($Action.runId): $($claim.reason)"
        return @{ sent = $false; reason = [string]$claim.reason; claimSkipped = $true }
    }

    $sendAttempt = Set-WorkerNudgeClaimSendAttempted -ClaimResult $claim
    if (-not $sendAttempt.ok) {
        Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'FAILED_DEFINITIVE' -Extra @{ reason = [string]$sendAttempt.reason } | Out-Null
        Write-ReviewSendLog "send aborted (claim send-attempt failed) run=$($Action.runId): $($sendAttempt.reason)"
        return @{ sent = $false; reason = [string]$sendAttempt.reason }
    }

    Write-ReviewSendLog "sending findings: run=$($Action.runId) PR #$($Action.prNumber) head=$($Action.targetSha) session=$sendSessionId"
    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'review-send-side-effect.lock'
    Write-OrchestratorSideProcessProgress -ChildId 'review-send-reconcile' -Phase 'side_effect'
    $sendFailed = $false
    $sendError = $null
    try {
        $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
            & ao @sendArgs
            if ($LASTEXITCODE -ne 0) {
                $script:sendFailed = $true
                throw "ao review send failed (exit $LASTEXITCODE) for run $($Action.runId)"
            }
        }
        if (-not $fenced.ok) {
            Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'FAILED_DEFINITIVE' -Extra @{ reason = 'side_effect_busy' } | Out-Null
            Write-ReviewSendLog "send skipped (side-effect busy) run=$($Action.runId)"
            return @{ sent = $false; reason = 'side_effect_busy' }
        }
    }
    catch {
        $sendError = [string]$_.Exception.Message
        Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'FAILED_DEFINITIVE' -Extra @{ reason = 'send_failed'; detail = $sendError } | Out-Null
        Write-ReviewSendLog "send failed run=$($Action.runId): $sendError"
        return @{ sent = $false; reason = 'send_failed'; detail = $sendError }
    }
    Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'SENT' | Out-Null

    $post = Get-ReviewSendPreSendSnapshot -RunId ([string]$Action.runId) -Project $Project
    $verify = Invoke-ReviewSendFilterCli -Subcommand 'verify-sent' -Payload @{
        reviewRuns = @($post.reviewRuns)
        runId      = [string]$Action.runId
        targetSha  = [string]$Action.targetSha
    }
    if (-not $verify.ok) {
        Write-ReviewSendLog "post-send verify failed run=$($Action.runId): $($verify.reason)"
        return @{ sent = $false; reason = $verify.reason }
    }

    $dispatchResult = Register-WorkerMessageDispatch -SessionId $Action.sessionId `
        -Message ('Review findings for PR #' + $Action.prNumber + ' (run ' + $Action.runId + ')') `
        -Source 'review-send' -SourceKey ([string]$Action.runId) `
        -DeliveryPath 'pending-draft'
    $outcome = Resolve-DispatchJournalSendOutcomeAfterDelivered -DispatchResult $dispatchResult
    if (-not $outcome.journalRecorded) {
        Write-ReviewSendLog "dispatch journal record failed run=$($Action.runId): $($outcome.journalFailureReason) (review send delivered; deduped, journal will retry)"
    }
    return $outcome
}

function Invoke-ReviewSendTick {
    param(
        [string]$Project,
        [string]$StatePath,
        [switch]$DryRunMode,
        [string]$Fixture
    )

    $tracking = Get-ReviewSendState -Path $StatePath
    Assert-MechanicalJsonStateFencesTrusted -State $tracking -Context 'side effects'

    if ($Fixture) {
        $payload = Get-FixtureReviewSendPayload -Path $Fixture
        $reviewRuns = $payload.reviewRuns
        $sessions = $payload.sessions
        $openPrs = @($payload.openPrs)
        if ($payload.tracking) {
            $tracking = $payload.tracking
        }
        $mergedPrNumbers = @()
        if ($payload.mergedPrNumbers) {
            $mergedPrNumbers = @($payload.mergedPrNumbers)
        }
    }
    else {
        $reviewRuns = Get-AoReviewRuns -Project $Project
        $sessions = Get-AoStatusSessions
        $openPrs = Invoke-GhOpenPrList -RepoRoot $RepoRoot
        $mergedPrNumbers = @()
    }

    $planPayload = @{
        reviewRuns      = @($reviewRuns)
        sessions        = @($sessions)
        openPrs         = @($openPrs)
        mergedPrNumbers = $mergedPrNumbers
        tracking        = $tracking
    }

    $plan = Invoke-ReviewSendFilterCli -Subcommand 'plan' -Payload $planPayload
    $useFixtureSnapshot = [bool]$Fixture
    $fixtureFreshPayload = $null
    if ($useFixtureSnapshot) {
        $fixtureFreshPayload = @{
            reviewRuns      = @($reviewRuns)
            sessions        = @($sessions)
            openPrs         = @($openPrs)
            mergedPrNumbers = $mergedPrNumbers
        }
    }

    $sent = 0
    $sentRecords = Copy-MechanicalJsonMap -Map $tracking.sent

    $partialStatePath = if ($DryRunMode) { '' } else { $StatePath }

    foreach ($action in @($plan.actions)) {
        if ($action.type -eq 'skip') {
            if ($action.runId) {
                Write-ReviewSendLog "skip run=$($action.runId): $($action.reason)"
            }
            continue
        }
        if ($action.type -ne 'send') {
            continue
        }

        try {
            $result = Invoke-PlannedFirstReviewSend -Action $action -FreshPayload $fixtureFreshPayload `
                -Project $Project -DryRunMode:$DryRunMode -UseFixtureSnapshot:$useFixtureSnapshot
        }
        catch {
            Write-ReviewSendLog "send error run=$($action.runId): $_"
            continue
        }

        if ($result.sent) {
            if (-not $DryRunMode -and $result.reason -eq 'sent') {
                $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                $sentRecords[[string]$action.dedupeKey] = @{
                    runId     = [string]$action.runId
                    targetSha = [string]$action.targetSha
                    sessionId = [string]$action.sessionId
                    sentAtMs  = $nowMs
                }
                Save-PartialReviewSendTracking -Path $partialStatePath -Sent $sentRecords -DryRunMode:$DryRunMode
            }
            $sent++
        }
    }

    $merged = @{
        sent       = $sentRecords
        lastTickMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    if (-not $DryRunMode) {
        Set-ReviewSendState -Path $StatePath -State $merged
    }

    return $sent
}

$intervalMinutes = Get-ReviewSendIntervalMinutes
$intervalMs = [Math]::Max(1, $intervalMinutes) * 60 * 1000
$pollMs = [Math]::Max(5, $PollSeconds) * 1000
$statePath = Get-ReviewSendStatePath -CliPath $StateFile

Write-ReviewSendLog "starting (project=$ProjectId, interval=${intervalMinutes}m, state=$statePath, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"
Write-ReviewSendLog "additive path: LLM-turn first-send and heartbeat backstop remain; #171 owns re-delivery after send"

if ($FixturePath) {
    if (-not $DryRun) {
        Write-ReviewSendLog 'fixture mode: enforcing dry-run (no live ao/gh)'
    }
    $count = Invoke-ReviewSendTick -Project $ProjectId -StatePath $statePath -DryRunMode -Fixture $FixturePath
    Write-ReviewSendLog "fixture tick complete (sent=$count)"
    exit 0
}

try {
    do {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $state = Get-ReviewSendState -Path $statePath
        $lastTickMs = $null
        if ($state.lastTickMs) {
            $lastTickMs = [long]$state.lastTickMs
        }

        $gate = Invoke-ReviewSendFilterCli -Subcommand 'interval' -Payload @{
            nowMs      = $nowMs
            lastTickMs = $lastTickMs
            intervalMs = $intervalMs
        }

        Write-OrchestratorSideProcessProgress -ChildId 'review-send-reconcile' -Phase 'poll'
        if (-not $gate.ok) {
            Write-ReviewSendLog "tick skipped: $($gate.reason)"
        }
        else {
            try {
                $count = Invoke-ReviewSendTick -Project $ProjectId -StatePath $statePath -DryRunMode:$DryRun
                Write-ReviewSendLog "tick complete (sent=$count)"
                Write-OrchestratorSideProcessTickSuccess -ChildId 'review-send-reconcile'
            }
            catch {
                Write-ReviewSendLog "tick error: $_"
                Write-OrchestratorSideProcessTickError -ChildId 'review-send-reconcile' -ErrorMessage "$_"
            }
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-ReviewSendLog 'stopped'
}
