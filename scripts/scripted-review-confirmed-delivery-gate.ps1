#requires -Version 5.1
<#
.SYNOPSIS
  Post-submit confirmed-delivery gate for the pack scripted PR-review flow (Issue #669).

.DESCRIPTION
  Polls GET /api/v1/sessions/{id}/reviews (via Get-AoSessionReviewsJson / ao-review list)
  after ao review submit and suppresses or fires exactly one explicit journaled-worker-send
  for changes_requested findings. Never reads ao.db directly.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$RunId,
    [string]$BatchId = '',
    [Parameter(Mandatory = $true)][int]$PrNumber,
    [Parameter(Mandatory = $true)][string]$TargetSha,
    [Parameter(Mandatory = $true)][ValidateSet('approved', 'changes_requested')][string]$Verdict,
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [int]$PollWindowSeconds = 0,
    [int]$PollIntervalSeconds = 0,
    [string]$FixtureReviewsPath = '',
    [string]$FixtureSessionsPath = '',
    [string]$FixtureOpenPrsPath = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Script:GateLogPrefix = 'scripted-review-confirmed-delivery-gate'
$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = $PackRoot }

. (Join-Path $PSScriptRoot 'lib/Invoke-AoReviewApi.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-AutonomousNudgeGate.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeAudit.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessSupervisor.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-OrchestratorEscalationEmit.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-OpenPrList.ps1')

$GateFilterCli = Join-Path $PackRoot 'docs/scripted-review-confirmed-delivery-gate.mjs'

function Write-ScriptedReviewDeliveryGateLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] ${Script:GateLogPrefix}: $Message"
}

function Invoke-ScriptedReviewDeliveryGateCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $GateFilterCli `
        -Subcommand $Subcommand -Payload $Payload -Label $Script:GateLogPrefix -JsonDepth 30
}

function Get-ScriptedReviewDeliveryGateConfig {
    $payload = @{
        config = @{
            pollWindowSeconds   = if ($PollWindowSeconds -gt 0) { $PollWindowSeconds } else { $null }
            pollIntervalSeconds = if ($PollIntervalSeconds -gt 0) { $PollIntervalSeconds } else { $null }
        }
    }
    if ($env:AO_SCRIPTED_REVIEW_DELIVERY_POLL_WINDOW_SECONDS) {
        $payload.config.pollWindowSeconds = [int]$env:AO_SCRIPTED_REVIEW_DELIVERY_POLL_WINDOW_SECONDS
    }
    if ($env:AO_SCRIPTED_REVIEW_DELIVERY_POLL_INTERVAL_SECONDS) {
        $payload.config.pollIntervalSeconds = [int]$env:AO_SCRIPTED_REVIEW_DELIVERY_POLL_INTERVAL_SECONDS
    }
    return Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'resolve-config' -Payload $payload
}

function Get-ScriptedReviewDeliveryGateFixtureJson {
    param([string]$Path)
    if (-not $Path) { return $null }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-ScriptedReviewDeliveryGateReviewsPayload {
    if ($FixtureReviewsPath) {
        return Get-ScriptedReviewDeliveryGateFixtureJson -Path $FixtureReviewsPath
    }
    return Get-AoSessionReviewsJson -SessionId $SessionId
}

function Get-ScriptedReviewDeliveryGateSessions {
    if ($FixtureSessionsPath) {
        $fixture = Get-ScriptedReviewDeliveryGateFixtureJson -Path $FixtureSessionsPath
        return @($fixture.sessions)
    }
    return @(Get-AoStatusSessionsWithReports)
}

function Get-ScriptedReviewDeliveryGateOpenPrs {
    if ($FixtureOpenPrsPath) {
        $fixture = Get-ScriptedReviewDeliveryGateFixtureJson -Path $FixtureOpenPrsPath
        return @($fixture.openPrs)
    }
    return @(ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot))
}

function Find-ScriptedReviewDeliveryGateSession {
    param([array]$Sessions)
    foreach ($session in @($Sessions)) {
        $ids = @(
            [string]$session.sessionId,
            [string]$session.id,
            [string]$session.name
        ) | Where-Object { $_ }
        if ($ids -contains $SessionId) {
            return $session
        }
    }
    return $null
}

function Invoke-ScriptedReviewDeliveryGateEscalation {
    param(
        [string]$Reason,
        [string]$Detail = ''
    )
    $builtResult = Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'build-escalation' -Payload @{
        runId     = $RunId
        sessionId = $SessionId
        prNumber  = $PrNumber
        reason    = $Reason
    }
    $built = [string]$builtResult.message
    if ($Detail) {
        $built = "$built Detail: $Detail"
    }
    Write-ScriptedReviewDeliveryGateLog $built
    $corr = "corr:scripted-review-delivery:$RunId"
    $dedupe = "dedupe:scripted-review-delivery:$RunId`:$Reason"
    Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-pipeline-failure' `
        -SourceProcess $Script:GateLogPrefix -CorrelationKey $corr -DedupeKey $dedupe `
        -Diagnosis @{
            runId      = $RunId
            sessionId  = $SessionId
            prNumber   = $PrNumber
            targetSha  = $TargetSha
            verdict    = $Verdict
            reason     = $Reason
            detail     = $Detail
            diagnosis  = $built
        } -Message $built -DryRun:$DryRun | Out-Null
    return @{ action = 'escalate'; reason = $Reason; message = $built }
}

function Invoke-ScriptedReviewDeliveryGateExplicitSend {
    param([string]$MessageText)

    $session = $null
    $openPrs = @(Get-ScriptedReviewDeliveryGateOpenPrs)
    $sessions = @(Get-ScriptedReviewDeliveryGateSessions)
    $session = Find-ScriptedReviewDeliveryGateSession -Sessions $sessions
    $step = Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'poll-step' -Payload @{
        reviews   = @()
        runId     = $RunId
        batchId   = $BatchId
        prNumber  = $PrNumber
        targetSha = $TargetSha
        verdict   = $Verdict
        session   = $session
        openPrs   = @($openPrs)
        startedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        nowMs     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $liveness = $step.liveness
    if ($liveness.liveness -ne 'live_head_owning') {
        return Invoke-ScriptedReviewDeliveryGateEscalation -Reason ([string]$liveness.reason)
    }

    if ($DryRun) {
        Write-ScriptedReviewDeliveryGateLog "dry-run would send explicit review findings to $SessionId (PR #$PrNumber run=$RunId)"
        return @{ action = 'send'; sent = $false; reason = 'dry_run' }
    }

    $cycleKey = "run:$RunId"
    $resolve = Resolve-WorkerNudgeTargetFromPrClaim -PrNumber $PrNumber -SessionId $SessionId `
        -HeadSha $TargetSha -ProjectId $ProjectId -OpenPrs $openPrs
    if (-not $resolve.ok) {
        return Invoke-ScriptedReviewDeliveryGateEscalation -Reason ([string]$resolve.reason)
    }
    $claim = Acquire-WorkerNudgeClaim -PrNumber $PrNumber -CycleKey $cycleKey -IntentClass 'review-findings' `
        -WorkerTarget $resolve.workerTarget -SessionId $SessionId `
        -Surface $Script:GateLogPrefix -ProjectId $ProjectId -Message $MessageText
    if (-not $claim.acquired) {
        return Invoke-ScriptedReviewDeliveryGateEscalation -Reason ([string]$claim.reason)
    }

    $hashResult = Invoke-WorkerNudgeFilterCli -Subcommand 'hashMessageContent' -Payload @{ message = $MessageText }
    $hashPersist = Set-WorkerNudgeClaimMessageContentHash -ClaimResult $claim -MessageContentHash ([string]$hashResult.messageContentHash)
    if (-not $hashPersist.ok) {
        Release-WorkerNudgeActiveClaim -ClaimResult $claim | Out-Null
        return Invoke-ScriptedReviewDeliveryGateEscalation -Reason 'message_hash_persist_failed' -Detail ([string]$hashPersist.reason)
    }
    $claimToken = New-WorkerNudgeClaimToken -ClaimResult $claim
    $journaledScript = Join-Path $PSScriptRoot 'journaled-worker-send.ps1'
    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'scripted-review-delivery-side-effect.lock'
    Write-OrchestratorSideProcessProgress -ChildId $Script:GateLogPrefix -Phase 'side_effect'
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
        return Invoke-ScriptedReviewDeliveryGateEscalation -Reason 'explicit_send_failed' -Detail "exit=$sendExitCode"
    }
    Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'SENT' | Out-Null
    Write-ScriptedReviewDeliveryGateLog "explicit send ok PR #$PrNumber session=$SessionId run=$RunId"
    return @{ action = 'send'; sent = $true; reason = 'explicit_send_dispatched' }
}

$messageText = [Console]::In.ReadToEnd()
if ($null -eq $messageText) { $messageText = '' }
$messageText = $messageText.Trim()

$config = Get-ScriptedReviewDeliveryGateConfig
$pollWindowMs = [int]$config.pollWindowMs
$pollIntervalMs = [int]$config.pollIntervalMs
$startedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$initialObservedRunId = ''

Write-ScriptedReviewDeliveryGateLog "starting session=$SessionId PR #$PrNumber run=$RunId verdict=$Verdict windowMs=$pollWindowMs intervalMs=$pollIntervalMs"

if ($Verdict -eq 'approved') {
    Write-OrchestratorSideProcessProgress -ChildId $Script:GateLogPrefix -Phase 'poll'
    Write-ScriptedReviewDeliveryGateLog 'approved verdict: skip daemon reviews poll'
    $sessions = @(Get-ScriptedReviewDeliveryGateSessions)
    $openPrs = @(Get-ScriptedReviewDeliveryGateOpenPrs)
    $session = Find-ScriptedReviewDeliveryGateSession -Sessions $sessions
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $step = Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'poll-step' -Payload @{
        reviews              = @()
        runId                = $RunId
        batchId              = $BatchId
        prNumber             = $PrNumber
        targetSha            = $TargetSha
        verdict              = $Verdict
        session              = $session
        openPrs              = @($openPrs)
        startedAtMs          = $startedAtMs
        nowMs                = $nowMs
        initialObservedRunId = ''
        config               = @{
            pollWindowSeconds   = [Math]::Ceiling($pollWindowMs / 1000.0)
            pollIntervalSeconds = [Math]::Ceiling($pollIntervalMs / 1000.0)
        }
    }

    $terminal = $step.terminal
    $action = [string]$terminal.action
    if ($action -eq 'escalate') {
        Invoke-ScriptedReviewDeliveryGateEscalation -Reason ([string]$terminal.reason) | Out-Null
        exit 2
    }
    if ($action -eq 'send') {
        if (-not $messageText) {
            Invoke-ScriptedReviewDeliveryGateEscalation -Reason 'missing_delivery_message' | Out-Null
            exit 2
        }
        $send = Invoke-ScriptedReviewDeliveryGateExplicitSend -MessageText $messageText
        if ([string]$send.action -eq 'escalate') { exit 2 }
        Write-OrchestratorSideProcessProgress -ChildId $Script:GateLogPrefix -Phase 'complete'
        exit 0
    }

    Invoke-ScriptedReviewDeliveryGateEscalation -Reason 'approved_unexpected_terminal' | Out-Null
    exit 2
}

while ($true) {
    Write-OrchestratorSideProcessProgress -ChildId $Script:GateLogPrefix -Phase 'poll'
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $reviewsPayload = Get-ScriptedReviewDeliveryGateReviewsPayload
    $sessions = @(Get-ScriptedReviewDeliveryGateSessions)
    $openPrs = @(Get-ScriptedReviewDeliveryGateOpenPrs)
    $session = Find-ScriptedReviewDeliveryGateSession -Sessions $sessions

    if (-not $initialObservedRunId -and $reviewsPayload.reviews) {
        foreach ($entry in @($reviewsPayload.reviews)) {
            if ([int]$entry.prNumber -eq $PrNumber) {
                $lr = $entry.latestRun
                if ($lr -and [string]$lr.id) {
                    $initialObservedRunId = [string]$lr.id
                    break
                }
            }
        }
    }

    $step = Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'poll-step' -Payload @{
        reviews             = @($reviewsPayload.reviews)
        runId               = $RunId
        batchId             = $BatchId
        prNumber            = $PrNumber
        targetSha           = $TargetSha
        verdict             = $Verdict
        session             = $session
        openPrs             = @($openPrs)
        startedAtMs         = $startedAtMs
        nowMs               = $nowMs
        initialObservedRunId = $initialObservedRunId
        config              = @{
            pollWindowSeconds   = [Math]::Ceiling($pollWindowMs / 1000.0)
            pollIntervalSeconds = [Math]::Ceiling($pollIntervalMs / 1000.0)
        }
    }

    $terminal = $step.terminal
    $action = [string]$terminal.action
    if ($action -eq 'suppress') {
        Write-ScriptedReviewDeliveryGateLog "suppress explicit send (daemon delivery confirmed) PR #$PrNumber run=$RunId"
        Write-OrchestratorSideProcessProgress -ChildId $Script:GateLogPrefix -Phase 'complete'
        exit 0
    }
    if ($action -eq 'escalate') {
        Invoke-ScriptedReviewDeliveryGateEscalation -Reason ([string]$terminal.reason) | Out-Null
        exit 2
    }
    if ($action -eq 'send') {
        if (-not $messageText) {
            Invoke-ScriptedReviewDeliveryGateEscalation -Reason 'missing_delivery_message' | Out-Null
            exit 2
        }
        $send = Invoke-ScriptedReviewDeliveryGateExplicitSend -MessageText $messageText
        if ([string]$send.action -eq 'escalate') { exit 2 }
        Write-OrchestratorSideProcessProgress -ChildId $Script:GateLogPrefix -Phase 'complete'
        exit 0
    }

    if (-not $step.shouldContinuePolling) {
        Invoke-ScriptedReviewDeliveryGateEscalation -Reason 'poll_loop_stalled' | Out-Null
        exit 2
    }

    Start-Sleep -Milliseconds $pollIntervalMs
}
