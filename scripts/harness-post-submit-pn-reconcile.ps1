#requires -Version 5.1
<#
.SYNOPSIS
  Harness post-submit [Pn] content-shape reconcile (Issue #683).

.DESCRIPTION
  Extends the #669 post-submit poll loop with a content-shape stage on the same
  latestRun snapshot. Invalid harness bodies trigger bounded re-trigger through
  fail-stale + review trigger recovery lineage (#624/#539). Never posts synthetic reviews.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$RunId,
    [string]$BatchId = '',
    [Parameter(Mandatory = $true)][int]$PrNumber,
    [Parameter(Mandatory = $true)][string]$TargetSha,
    [Parameter(Mandatory = $true)][ValidateSet('approved', 'changes_requested')][string]$Verdict = 'changes_requested',
    [string]$Reason = '',
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [int]$PollWindowSeconds = 0,
    [int]$PollIntervalSeconds = 0,
    [int]$RetriggerCount = 0,
    [string]$DeliveryMessage = '',
    [string]$FixtureReviewsPath = '',
    [string]$FixtureSessionsPath = '',
    [string]$FixtureOpenPrsPath = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Script:ReconcileLogPrefix = 'harness-post-submit-pn-reconcile'
$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = $PackRoot }

. (Join-Path $PSScriptRoot 'lib/Invoke-AoReviewApi.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-ReviewStuckRunReaper.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-ScriptedReviewDeliveryEscalation.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessSupervisor.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-OpenPrList.ps1')
. (Join-Path $PSScriptRoot 'lib/Resolve-ScriptedReviewInitialObservedRunId.ps1')
. (Join-Path $PSScriptRoot 'lib/Harness-PnRetriggerState.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-AutonomousNudgeGate.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeAudit.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-ScriptedReviewDeliveryExplicitSend.ps1')

$GateFilterCli = Join-Path $PackRoot 'docs/scripted-review-confirmed-delivery-gate.mjs'
$ContentShapeCli = Join-Path $PackRoot 'docs/harness-post-submit-pn-content-shape.mjs'
$PostSubmitDeliveryCli = Join-Path $PackRoot 'docs/scripted-review-post-submit-delivery.mjs'
$HarnessPnMaxRetriggerCount = 3

function Write-HarnessPnReconcileLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] ${Script:ReconcileLogPrefix}: $Message"
}

function Invoke-HarnessPnReconcileGateCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $GateFilterCli `
        -Subcommand $Subcommand -Payload $Payload -Label $Script:ReconcileLogPrefix -JsonDepth 30
}

function Get-HarnessPnReconcileFixtureJson {
    param([string]$Path)
    if (-not $Path) { return $null }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-HarnessPnReconcileReviewsPayload {
    if ($FixtureReviewsPath) {
        return Get-HarnessPnReconcileFixtureJson -Path $FixtureReviewsPath
    }
    return Get-AoSessionReviewsJson -SessionId $SessionId
}

function Get-HarnessPnReconcileSessions {
    if ($FixtureSessionsPath) {
        $fixture = Get-HarnessPnReconcileFixtureJson -Path $FixtureSessionsPath
        return @($fixture.sessions)
    }
    return @(Get-AoStatusSessionsWithReports)
}

function Get-HarnessPnReconcileOpenPrs {
    if ($FixtureOpenPrsPath) {
        $fixture = Get-HarnessPnReconcileFixtureJson -Path $FixtureOpenPrsPath
        return @($fixture.openPrs)
    }
    return @(ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot))
}

function Find-HarnessPnReconcileSession {
    param([array]$Sessions)
    foreach ($session in @($Sessions)) {
        $ids = @([string]$session.sessionId, [string]$session.id, [string]$session.name) | Where-Object { $_ }
        if ($ids -contains $SessionId) { return $session }
    }
    return $null
}

function Invoke-HarnessPnReconcileEscalation {
    param([string]$Reason, [string]$Detail = '')
    return Invoke-ScriptedReviewDeliveryEscalationEmit -Reason $Reason -Detail $Detail `
        -RunId $RunId -SessionId $SessionId -PrNumber $PrNumber `
        -SourceProcess $Script:ReconcileLogPrefix -GateFilterCli $GateFilterCli -DryRun:$DryRun `
        -ExtraDiagnosis @{ targetSha = $TargetSha; verdict = $Verdict; retriggerCount = $RetriggerCount } `
        -WriteLog { param($Message) Write-HarnessPnReconcileLog $Message }
}

function Invoke-HarnessPnInvalidContentRetrigger {
    param([hashtable]$ContentShape)

    if ($DryRun) {
        Write-HarnessPnReconcileLog "dry-run would re-trigger harness review PR #$PrNumber run=$RunId ($($ContentShape.reason))"
        return @{ ok = $true; dryRun = $true }
    }

    $baseUrl = ''
    try { $baseUrl = Get-AoDaemonApiBaseUrl } catch { }

    if (Test-AoReviewFailStaleSurfaceAvailable) {
        try {
            $failPath = "/api/v1/sessions/$([uri]::EscapeDataString($SessionId))/reviews/runs/$([uri]::EscapeDataString($RunId))/fail-stale"
            Invoke-AoDaemonHttpJson -Method POST -Path $failPath -Body @{} -BaseUrl $baseUrl -AllowedStatus @(200, 204) | Out-Null
        }
        catch {
            Write-HarnessPnReconcileLog "fail-stale skipped: $($_.Exception.Message)"
        }
    }

    $trigger = Invoke-AoReviewTriggerForWorker -SessionId $SessionId -ProjectId $ProjectId -BaseUrl $baseUrl -SkipHarnessGuard
    if (-not $trigger.ok) {
        return @{ ok = $false; reason = [string]$trigger.reason }
    }
    return @{ ok = $true; trigger = $trigger }
}

function New-HarnessPnReconcilePollStepBase {
    return @{
        runId               = $RunId
        batchId             = $BatchId
        prNumber            = $PrNumber
        targetSha           = $TargetSha
        verdict             = $Verdict
        harnessContentShape = $true
        retriggerCount      = $currentRetriggerCount
        maxRetriggerCount   = $HarnessPnMaxRetriggerCount
    }
}

function Invoke-HarnessPnReconcileEscalationResult {
    param([string]$Reason, [string]$Detail = '')
    Invoke-HarnessPnReconcileEscalation -Reason $Reason -Detail $Detail | Out-Null
    return @{ action = 'escalate'; reason = $Reason; detail = $Detail }
}

function Resolve-HarnessPnReconcileDeliveryMessage {
    $messageText = [string]$DeliveryMessage
    if ($messageText.Trim()) {
        return $messageText.Trim()
    }
    $built = Invoke-MechanicalNodeFilterCli -FilterCliPath $PostSubmitDeliveryCli -Subcommand 'build-delivery-message' `
        -Payload @{
            prNumber    = $PrNumber
            runId       = $RunId
            gateVerdict = $Verdict
        } -Label $Script:ReconcileLogPrefix -JsonDepth 20
    if (-not $built.ok) {
        return $null
    }
    return [string]$built.message
}

function Invoke-HarnessPnReconcileExplicitSend {
    param([string]$MessageText)

    $pollStepBase = New-HarnessPnReconcilePollStepBase
    return Invoke-ScriptedReviewDeliveryExplicitSend `
        -SessionId $SessionId -RunId $RunId -PrNumber $PrNumber -TargetSha $TargetSha `
        -ProjectId $ProjectId -MessageText $MessageText -GateFilterCli $GateFilterCli `
        -LogPrefix $Script:ReconcileLogPrefix -ChildId $Script:ReconcileLogPrefix `
        -PollStepBase $pollStepBase `
        -GetOpenPrs { Get-HarnessPnReconcileOpenPrs } `
        -GetSessions { Get-HarnessPnReconcileSessions } `
        -FindSession { param($sessions) Find-HarnessPnReconcileSession -Sessions $sessions } `
        -WriteLog { param($Message) Write-HarnessPnReconcileLog $Message } `
        -OnEscalation { param($Reason, $Detail) Invoke-HarnessPnReconcileEscalationResult $Reason $Detail } `
        -DryRun:$DryRun
}

function Complete-HarnessPnReconcileAfterExplicitSend {
    param(
        [bool]$SendSucceeded,
        [bool]$DedupApplied = $false
    )

    return Complete-ScriptedReviewDeliveryExplicitSend `
        -SessionId $SessionId -RunId $RunId -BatchId $BatchId -PrNumber $PrNumber `
        -TargetSha $TargetSha -Verdict $Verdict -GateFilterCli $GateFilterCli `
        -LogPrefix $Script:ReconcileLogPrefix `
        -GetReviewsPayload { Get-HarnessPnReconcileReviewsPayload } `
        -WriteLog { param($Message) Write-HarnessPnReconcileLog $Message } `
        -OnEscalation { param($Reason, $Detail) Invoke-HarnessPnReconcileEscalationResult $Reason $Detail } `
        -SendSucceeded $SendSucceeded -DedupApplied $DedupApplied
}

$configPayload = @{ config = @{} }
if ($PollWindowSeconds -gt 0) { $configPayload.config.pollWindowSeconds = $PollWindowSeconds }
if ($PollIntervalSeconds -gt 0) { $configPayload.config.pollIntervalSeconds = $PollIntervalSeconds }
$config = Invoke-HarnessPnReconcileGateCli -Subcommand 'resolve-config' -Payload $configPayload
$pollWindowMs = [int]$config.pollWindowMs
$pollIntervalMs = [int]$config.pollIntervalMs
$startedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$initialObservedRunId = ''
$currentRetriggerCount = Resolve-HarnessPnRetriggerCount -SessionId $SessionId -PrNumber $PrNumber `
    -TargetSha $TargetSha -ExplicitCount $RetriggerCount

Write-HarnessPnReconcileLog "starting session=$SessionId PR #$PrNumber run=$RunId verdict=$Verdict reason=$Reason retriggerCount=$currentRetriggerCount"

while ($true) {
    Write-OrchestratorSideProcessProgress -ChildId $Script:ReconcileLogPrefix -Phase 'poll'
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $reviewsPayload = Get-HarnessPnReconcileReviewsPayload
    $sessions = @(Get-HarnessPnReconcileSessions)
    $openPrs = @(Get-HarnessPnReconcileOpenPrs)
    $session = Find-HarnessPnReconcileSession -Sessions $sessions

    $initialObservedRunId = Resolve-ScriptedReviewInitialObservedRunId `
        -CurrentInitialObservedRunId $initialObservedRunId `
        -Reviews @($reviewsPayload.reviews) `
        -PrNumber $PrNumber

    $step = Invoke-HarnessPnReconcileGateCli -Subcommand 'poll-step' -Payload @{
        reviews              = @($reviewsPayload.reviews)
        runId                = $RunId
        batchId              = $BatchId
        prNumber             = $PrNumber
        targetSha            = $TargetSha
        verdict              = $Verdict
        session              = $session
        openPrs              = @($openPrs)
        startedAtMs          = $startedAtMs
        nowMs                = $nowMs
        initialObservedRunId = $initialObservedRunId
        harnessContentShape  = $true
        retriggerCount       = $currentRetriggerCount
        maxRetriggerCount    = $HarnessPnMaxRetriggerCount
        config               = @{
            pollWindowSeconds   = [Math]::Ceiling($pollWindowMs / 1000.0)
            pollIntervalSeconds = [Math]::Ceiling($pollIntervalMs / 1000.0)
        }
    }

    $terminal = $step.terminal
    $action = [string]$terminal.action
    if ($action -eq 'reject_retrigger') {
        $retrigger = Invoke-HarnessPnInvalidContentRetrigger -ContentShape $step.contentShape
        if (-not $retrigger.ok) {
            Invoke-HarnessPnReconcileEscalation -Reason ([string]$retrigger.reason) | Out-Null
            exit 2
        }
        $currentRetriggerCount += 1
        Set-HarnessPnRetriggerCount -SessionId $SessionId -PrNumber $PrNumber -TargetSha $TargetSha `
            -Count $currentRetriggerCount
        Write-HarnessPnReconcileLog "re-trigger issued count=$currentRetriggerCount reason=$($terminal.reason)"
        Write-OrchestratorSideProcessProgress -ChildId $Script:ReconcileLogPrefix -Phase 'complete'
        exit 0
    }
    if ($action -eq 'escalate') {
        Invoke-HarnessPnReconcileEscalation -Reason ([string]$terminal.reason) | Out-Null
        exit 2
    }
    if ($action -eq 'suppress' -or ($null -eq $action -and -not $step.shouldContinuePolling)) {
        Clear-HarnessPnRetriggerCount -SessionId $SessionId -PrNumber $PrNumber -TargetSha $TargetSha
        Write-HarnessPnReconcileLog "terminal content-valid state action=$action"
        Write-OrchestratorSideProcessProgress -ChildId $Script:ReconcileLogPrefix -Phase 'complete'
        exit 0
    }
    if ($action -eq 'send') {
        $messageText = Resolve-HarnessPnReconcileDeliveryMessage
        if (-not $messageText) {
            Invoke-HarnessPnReconcileEscalation -Reason 'missing_delivery_message' | Out-Null
            exit 2
        }
        $send = Invoke-HarnessPnReconcileExplicitSend -MessageText $messageText
        if ([string]$send.action -eq 'escalate') {
            exit 2
        }
        if ($DryRun) {
            Clear-HarnessPnRetriggerCount -SessionId $SessionId -PrNumber $PrNumber -TargetSha $TargetSha
            Write-OrchestratorSideProcessProgress -ChildId $Script:ReconcileLogPrefix -Phase 'complete'
            exit 0
        }
        $postSend = Complete-HarnessPnReconcileAfterExplicitSend -SendSucceeded ([bool]$send.sent) `
            -DedupApplied ([bool]$send.dedupApplied)
        if (-not $postSend.ok) {
            exit 2
        }
        Clear-HarnessPnRetriggerCount -SessionId $SessionId -PrNumber $PrNumber -TargetSha $TargetSha
        Write-HarnessPnReconcileLog 'explicit delivery dispatched after content-valid reconcile'
        Write-OrchestratorSideProcessProgress -ChildId $Script:ReconcileLogPrefix -Phase 'complete'
        exit 0
    }

    if (-not $step.shouldContinuePolling) {
        Invoke-HarnessPnReconcileEscalation -Reason 'poll_loop_stalled' | Out-Null
        exit 2
    }

    Start-Sleep -Milliseconds $pollIntervalMs
}
