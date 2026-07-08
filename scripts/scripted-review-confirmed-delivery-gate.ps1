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
    [string]$DeliveryMessage = '',
    [int]$HarnessPnRetriggerCount = 0,
    [int]$HarnessPnMaxRetriggerCount = 3,
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
. (Join-Path $PSScriptRoot 'lib/Invoke-ScriptedReviewDeliveryEscalation.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-OpenPrList.ps1')
. (Join-Path $PSScriptRoot 'lib/Resolve-ScriptedReviewInitialObservedRunId.ps1')
. (Join-Path $PSScriptRoot 'lib/Harness-PnRetriggerState.ps1')

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


function New-ScriptedReviewDeliveryGatePollStepBase {
    return @{
        runId               = $RunId
        batchId             = $BatchId
        prNumber            = $PrNumber
        targetSha           = $TargetSha
        verdict             = $Verdict
        harnessContentShape = $true
        retriggerCount      = $HarnessPnRetriggerCount
        maxRetriggerCount   = $HarnessPnMaxRetriggerCount
    }
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
    return Invoke-ScriptedReviewDeliveryEscalationEmit -Reason $Reason -Detail $Detail `
        -RunId $RunId -SessionId $SessionId -PrNumber $PrNumber `
        -SourceProcess $Script:GateLogPrefix -GateFilterCli $GateFilterCli -DryRun:$DryRun `
        -ExtraDiagnosis @{ targetSha = $TargetSha; verdict = $Verdict } `
        -WriteLog { param($Message) Write-ScriptedReviewDeliveryGateLog $Message }
}

function Invoke-ScriptedReviewDeliveryGateExplicitSend {
    param([string]$MessageText)

    $session = $null
    $openPrs = @(Get-ScriptedReviewDeliveryGateOpenPrs)
    $sessions = @(Get-ScriptedReviewDeliveryGateSessions)
    $session = Find-ScriptedReviewDeliveryGateSession -Sessions $sessions
    $step = Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'poll-step' -Payload (New-ScriptedReviewDeliveryGatePollStepBase + @{
        reviews     = @()
        session     = $session
        openPrs     = @($openPrs)
        startedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        nowMs       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    })
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
    return @{ action = 'send'; sent = $true; reason = 'explicit_send_dispatched'; dedupApplied = $true }
}

function Complete-ScriptedReviewDeliveryGateAfterExplicitSend {
    param(
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
            $reviewsPayload = Get-ScriptedReviewDeliveryGateReviewsPayload
            $classifyInput.reviews = @($reviewsPayload.reviews)
        }
        catch {
            Write-ScriptedReviewDeliveryGateLog "post-send reviews read failed: $($_.Exception.Message)"
        }
    }

    $classified = Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'classify-post-send' -Payload $classifyInput
    $composition = Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'post-send' -Payload @{
        explicitSendOutcome         = [string]$classified.explicitSendOutcome
        lateAutoDeliveryConfirmed   = [bool]$classified.lateAutoDeliveryConfirmed
        dedupApplied                = $DedupApplied
        dedupFailed                 = $false
    }

    $terminal = [string]$composition.terminal
    if ($terminal -eq 'escalate') {
        Invoke-ScriptedReviewDeliveryGateEscalation -Reason ([string]$composition.reason) | Out-Null
        return @{ ok = $false }
    }
    if ($terminal -eq 'dedup_or_escalate') {
        Write-ScriptedReviewDeliveryGateLog "post-send late auto-delivery race; dedup applied ($($composition.reason))"
    }
    Write-ScriptedReviewDeliveryGateLog "post-send complete: $terminal ($($composition.reason))"
    return @{ ok = $true; terminal = $terminal }
}

function Exit-ScriptedReviewDeliveryGateAfterExplicitSend {
    param(
        [hashtable]$SendResult
    )

    $sent = [bool]$SendResult.sent
    $dedupApplied = [bool]$SendResult.dedupApplied
    if ([string]$SendResult.action -eq 'escalate') {
        exit 2
    }
    if (-not $sent) {
        Clear-HarnessPnRetriggerCount -SessionId $SessionId -PrNumber $PrNumber -TargetSha $TargetSha
        Write-OrchestratorSideProcessProgress -ChildId $Script:GateLogPrefix -Phase 'complete'
        exit 0
    }

    Write-OrchestratorSideProcessProgress -ChildId $Script:GateLogPrefix -Phase 'side_effect'
    $postSend = Complete-ScriptedReviewDeliveryGateAfterExplicitSend -SendSucceeded $true -DedupApplied $dedupApplied
    if (-not $postSend.ok) { exit 2 }
    Clear-HarnessPnRetriggerCount -SessionId $SessionId -PrNumber $PrNumber -TargetSha $TargetSha
    Write-OrchestratorSideProcessProgress -ChildId $Script:GateLogPrefix -Phase 'complete'
    exit 0
}

function Invoke-HarnessPostSubmitPnReconcileFromGate {
    param([string]$Reason)

    $script = Join-Path $PSScriptRoot 'harness-post-submit-pn-reconcile.ps1'
    $args = @(
        '-NoProfile',
        '-File', $script,
        '-SessionId', $SessionId,
        '-RunId', $RunId,
        '-BatchId', $BatchId,
        '-PrNumber', $PrNumber,
        '-TargetSha', $TargetSha,
        '-Verdict', $Verdict,
        '-Reason', $Reason,
        '-ProjectId', $ProjectId,
        '-RetriggerCount', $HarnessPnRetriggerCount
    )
    if ($RepoRoot) { $args += '-RepoRoot', $RepoRoot }
    if ($PollWindowSeconds -gt 0) { $args += '-PollWindowSeconds', $PollWindowSeconds }
    if ($PollIntervalSeconds -gt 0) { $args += '-PollIntervalSeconds', $PollIntervalSeconds }
    if ($FixtureReviewsPath) { $args += '-FixtureReviewsPath', $FixtureReviewsPath }
    if ($FixtureSessionsPath) { $args += '-FixtureSessionsPath', $FixtureSessionsPath }
    if ($FixtureOpenPrsPath) { $args += '-FixtureOpenPrsPath', $FixtureOpenPrsPath }
    if ($DryRun) { $args += '-DryRun' }
    Write-ScriptedReviewDeliveryGateLog "invalid harness content; invoking post-submit [Pn] reconcile reason=$Reason"
    & pwsh @args
    if ($LASTEXITCODE -ne 0) {
        Invoke-ScriptedReviewDeliveryGateEscalation -Reason 'harness_pn_retrigger_failed' -Detail "exit=$LASTEXITCODE reason=$Reason" | Out-Null
        exit 2
    }
    Write-OrchestratorSideProcessProgress -ChildId $Script:GateLogPrefix -Phase 'complete'
    exit 0
}

$messageText = if ($DeliveryMessage) { $DeliveryMessage.Trim() } else { [Console]::In.ReadToEnd() }
if ($null -eq $messageText) { $messageText = '' }
$messageText = $messageText.Trim()

$HarnessPnRetriggerCount = Resolve-HarnessPnRetriggerCount -SessionId $SessionId -PrNumber $PrNumber `
    -TargetSha $TargetSha -ExplicitCount $HarnessPnRetriggerCount

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
    $step = Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'poll-step' -Payload (New-ScriptedReviewDeliveryGatePollStepBase + @{
        reviews              = @()
        session              = $session
        openPrs              = @($openPrs)
        startedAtMs          = $startedAtMs
        nowMs                = $nowMs
        initialObservedRunId = ''
        config               = @{
            pollWindowSeconds   = [Math]::Ceiling($pollWindowMs / 1000.0)
            pollIntervalSeconds = [Math]::Ceiling($pollIntervalMs / 1000.0)
        }
    })

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
        Exit-ScriptedReviewDeliveryGateAfterExplicitSend -SendResult $send
    }
    if ($action -eq 'reject_retrigger') {
        Invoke-HarnessPostSubmitPnReconcileFromGate -Reason ([string]$terminal.reason)
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

    $initialObservedRunId = Resolve-ScriptedReviewInitialObservedRunId `
        -CurrentInitialObservedRunId $initialObservedRunId `
        -Reviews @($reviewsPayload.reviews) `
        -PrNumber $PrNumber

    $step = Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'poll-step' -Payload (New-ScriptedReviewDeliveryGatePollStepBase + @{
        reviews              = @($reviewsPayload.reviews)
        session              = $session
        openPrs              = @($openPrs)
        startedAtMs          = $startedAtMs
        nowMs                = $nowMs
        initialObservedRunId = $initialObservedRunId
        config               = @{
            pollWindowSeconds   = [Math]::Ceiling($pollWindowMs / 1000.0)
            pollIntervalSeconds = [Math]::Ceiling($pollIntervalMs / 1000.0)
        }
    })

    $terminal = $step.terminal
    $action = [string]$terminal.action
    if ($action -eq 'suppress') {
        Write-ScriptedReviewDeliveryGateLog "suppress explicit send (daemon delivery confirmed) PR #$PrNumber run=$RunId"
        Clear-HarnessPnRetriggerCount -SessionId $SessionId -PrNumber $PrNumber -TargetSha $TargetSha
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
        Exit-ScriptedReviewDeliveryGateAfterExplicitSend -SendResult $send
    }
    if ($action -eq 'reject_retrigger') {
        Invoke-HarnessPostSubmitPnReconcileFromGate -Reason ([string]$terminal.reason)
    }

    if (-not $step.shouldContinuePolling) {
        Invoke-ScriptedReviewDeliveryGateEscalation -Reason 'poll_loop_stalled' | Out-Null
        exit 2
    }

    Start-Sleep -Milliseconds $pollIntervalMs
}
