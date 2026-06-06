#requires -Version 5.1
<#
.SYNOPSIS
  Sender-side review-finding delivery confirmation (Issue #171).

.DESCRIPTION
  Low-frequency mechanical loop: observes run-level state from ao review list --json
  and worker reports from ao status --reports full. Confirms delivery only when the
  linked worker reports addressing_reviews (or equivalent) after send; on timeout
  re-delivers via ao review send to the same live session (bounded); when re-deliveries
  are exhausted escalates; draft submit is owned by worker-message-submit-reconcile.ps1
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
$Script:DefaultIntervalMinutes = 5
$Script:DefaultConfirmationWindowMinutes = 5
$Script:DefaultMaxRedeliveries = 2
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')

$FloodDetectCli = Join-Path $PackRoot 'docs/terminal-flood-detect.mjs'

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

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @{ runs = @{}; lastTickMs = $null }
    }

    try {
        $raw = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        if (-not $raw.runs) {
            $raw | Add-Member -NotePropertyName runs -NotePropertyValue @{} -Force
        }
        return $raw
    }
    catch {
        return @{ runs = @{}; lastTickMs = $null }
    }
}

function Set-DeliveryState {
    param(
        [string]$Path,
        [object]$State
    )

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $State | ConvertTo-Json -Depth 30 -Compress | Set-Content -LiteralPath $Path -Encoding utf8
}

function Copy-DeliveryTrackingRuns {
    param([object]$Tracking)

    $runs = @{}
    if ($Tracking -and $Tracking.runs) {
        foreach ($prop in $Tracking.runs.PSObject.Properties) {
            $runs[$prop.Name] = $prop.Value
        }
    }
    return $runs
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
    $output = gh pr list --state open --json number,headRefOid --limit 200 2>&1
    if ($LASTEXITCODE -ne 0) {
        $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
        throw "gh pr list failed (exit ${LASTEXITCODE}): $text"
    }
    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    if (-not $text.Trim()) {
        return @()
    }
    return @($text | ConvertFrom-Json)
}

function Get-FixtureDeliveryPayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    return @{
        reviewRuns          = @($fixture.reviewRuns)
        sessions            = @($fixture.sessions)
        openPrs             = @($fixture.openPrs)
        tracking            = $fixture.tracking
        nowMs               = [long]$fixture.nowMs
        config              = $fixture.config
        aoEvents            = @($fixture.aoEvents)
        floodActiveSessions = $fixture.floodActiveSessions
    }
}

function Invoke-FloodDetectCli {
    param(
        [array]$Events,
        [long]$NowMs
    )

    $json = @{
        events = @($Events)
        nowMs  = $NowMs
    } | ConvertTo-Json -Depth 30 -Compress
    $output = $json | & node $FloodDetectCli detect 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "terminal-flood-detect.mjs detect exited ${LASTEXITCODE}: $output"
    }
    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    return $text | ConvertFrom-Json
}

function Get-FloodActiveSessionMap {
    param(
        [array]$Events,
        [long]$NowMs
    )

    $map = @{}
    if (-not $Events -or $Events.Count -eq 0) {
        return $map
    }
    $result = Invoke-FloodDetectCli -Events $Events -NowMs $NowMs
    foreach ($row in @($result.flaggedSessions)) {
        if ($row.sessionId) {
            $map[[string]$row.sessionId] = $true
        }
    }
    return $map
}

function Invoke-PlannedReviewSend {
    param(
        [string]$RunId,
        [int]$PrNumber,
        [string]$SessionId,
        [int]$Attempt,
        [switch]$DryRunMode
    )

    $sendArgs = @('review', 'send', $RunId)
    $commandLine = "ao $($sendArgs -join ' ')"
    Test-ReviewMechanicalForbiddenCommand -CommandLine $commandLine

    if ($DryRunMode) {
        Write-DeliveryLog "dry-run would redeliver: $commandLine (PR #$PrNumber session=$SessionId attempt=$Attempt)"
        return @{ sent = $true; reason = 'dry_run' }
    }

    Write-DeliveryLog "re-delivering findings: run=$RunId PR #$PrNumber session=$SessionId attempt=$Attempt"
    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'delivery-confirm-side-effect.lock'
    Write-OrchestratorSideProcessProgress -ChildId 'review-finding-delivery-confirm' -Phase 'side_effect'
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        & ao @sendArgs
        if ($LASTEXITCODE -ne 0) {
            throw "ao review send failed (exit $LASTEXITCODE) for run $RunId"
        }
    }
    if (-not $fenced.ok) {
        Write-DeliveryLog "redelivery skipped (side-effect busy) run=$RunId"
        return @{ sent = $false; reason = 'side_effect_busy' }
    }

    return @{ sent = $true; reason = 'sent' }
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
        $openPrs = @($payload.openPrs)
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
        $openPrs = Get-OpenPrList
        $tracking = $TrackingState
        $now = $NowMs
        $tickConfig = $Config
        $aoEvents = Get-AoEventsSince -SinceMinutes 30
        $floodActiveSessions = Get-FloodActiveSessionMap -Events $aoEvents -NowMs $now
    }

    $plan = Invoke-DeliveryFilterCli -Subcommand 'plan' -Payload @{
        reviewRuns          = @($reviewRuns)
        sessions            = @($sessions)
        openPrs             = @($openPrs)
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
                $sendResult = Invoke-PlannedReviewSend -RunId $action.runId -PrNumber $action.prNumber `
                    -SessionId $action.sessionId -Attempt $action.attempt -DryRunMode:$DryRunMode
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
            }
            catch {
                $tickFailed = $true
                Write-DeliveryLog "tick error: $_"
            }
            finally {
                Write-OrchestratorSideProcessProgress -ChildId 'review-finding-delivery-confirm' -Phase 'tick_complete'
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
