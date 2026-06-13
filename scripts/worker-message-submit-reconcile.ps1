#requires -Version 5.1
<#
.SYNOPSIS
  Source-agnostic worker message submit reconciliation (Issue #232).

.DESCRIPTION
  Unified submit arbiter: presses Enter for AO-delivered pending-draft worker messages
  regardless of sender. Observes AO events, pack dispatch journal, and review-run
  state — never pane text. Folds in Issue #216 submit (review-finding path).

  Split-brain safe: observe and submit only; never spawn, kill, --claim-pr, or send.
  Runs under orchestrator-wake-supervisor (#205).

  See docs/migration_notes.md and docs/orchestrator-recovery-runbook.md.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [int]$IntervalSeconds = 0,
    [int]$PollSeconds = 15,
    [string]$StateFile = '',
    [string]$DispatchJournalPath = '',
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'
$Script:ReconcileLogPrefix = 'worker-message-submit-reconcile'

$PackRoot = Split-Path -Parent $PSScriptRoot
$SubmitFilterCli = Join-Path $PackRoot 'docs/worker-message-submit-reconcile.mjs'
$Script:DefaultIntervalSeconds = 30

. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-FloodActiveSessionMap.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Submit-WorkerInputDraft.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-WorkerMessageDispatch.ps1')

function Get-SubmitReconcileIntervalSeconds {
    if ($IntervalSeconds -gt 0) { return $IntervalSeconds }
    $envSeconds = $env:AO_WORKER_MESSAGE_SUBMIT_INTERVAL_SECONDS
    if ($envSeconds -and [int]::TryParse($envSeconds, [ref]$null)) {
        return [int]$envSeconds
    }
    return $Script:DefaultIntervalSeconds
}

function Get-SubmitReconcileStatePath {
    param([string]$CliPath)
    if ($CliPath) { return $CliPath }
    if ($env:AO_WORKER_MESSAGE_SUBMIT_STATE) { return $env:AO_WORKER_MESSAGE_SUBMIT_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-worker-message-submit-state.json'
}

function Write-SubmitReconcileLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReconcileLogPrefix): $Message"
}

$Script:SubmitReconcileDefaultState = @{ deliveries = @{}; failedDeliveries = @{}; audit = @(); lastTickMs = $null }

function Get-SubmitReconcileState {
    param([string]$Path)

    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $Script:SubmitReconcileDefaultState -ActionTracking
}

function Set-SubmitReconcileState {
    param(
        [string]$Path,
        [object]$State
    )

    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $Script:SubmitReconcileDefaultState -JsonDepth 30
}

function Get-FixtureSubmitPayload {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Fixture not found: $Path"
    }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Invoke-SubmitReconcileTick {
    param(
        [string]$Project,
        [string]$StatePath,
        [string]$JournalPath,
        [switch]$DryRunMode,
        [string]$Fixture,
        [long]$NowMs
    )

    if ($Fixture) {
        $fixture = Get-FixtureSubmitPayload -Path $Fixture
        $sessions = @($fixture.sessions)
        $aoEvents = @($fixture.aoEvents)
        $reviewRuns = @($fixture.reviewRuns)
        $dispatchJournal = @{}
        if ($fixture.dispatchJournal) {
            foreach ($prop in $fixture.dispatchJournal.PSObject.Properties) {
                $dispatchJournal[$prop.Name] = $prop.Value
            }
        }
        $tracking = if ($fixture.tracking) { $fixture.tracking } else { Get-SubmitReconcileState -Path $StatePath }
        $now = if ($fixture.nowMs) { [long]$fixture.nowMs } else { $NowMs }
        $tickConfig = if ($fixture.config) { $fixture.config } else { @{} }
        $reactionMessages = @{}
        if ($fixture.reactionMessages) {
            foreach ($prop in $fixture.reactionMessages.PSObject.Properties) {
                $reactionMessages[$prop.Name] = [string]$prop.Value
            }
        }
        if ($fixture.floodActiveSessions) {
            $floodActiveSessions = @{}
            foreach ($prop in $fixture.floodActiveSessions.PSObject.Properties) {
                $floodActiveSessions[$prop.Name] = [bool]$prop.Value
            }
        }
        else {
            $floodActiveSessions = Get-FloodActiveSessionMap -Events $aoEvents -NowMs $now
        }
    }
    else {
        $sessions = Get-AoStatusSessions
        $aoEvents = Get-AoEventsSince -SinceMinutes 30
        $reviewRuns = Get-AoReviewRuns -Project $Project
        $dispatchJournal = Get-WorkerMessageDispatchJournal -Path $JournalPath
        $tracking = Get-SubmitReconcileState -Path $StatePath
        Assert-MechanicalJsonStateFencesTrusted -State $tracking -Context 'side effects'
        $now = $NowMs
        $tickConfig = @{}
        $reactionMessages = @{
            'report-stale' = 'Agent report is stale (30 minutes since last report). Continue your task.'
            'ci-failed'    = 'Required CI failed for your PR. Fix failing checks and ao report fixing_ci.'
        }
        $floodActiveSessions = Get-FloodActiveSessionMap -Events $aoEvents -NowMs $now
    }

    $plan = Invoke-MechanicalNodeFilterCli -FilterCliPath $SubmitFilterCli -Subcommand 'plan' `
        -Payload @{
            sessions            = @($sessions)
            aoEvents            = @($aoEvents)
            reviewRuns          = @($reviewRuns)
            dispatchJournal     = $dispatchJournal
            reactionMessages    = $reactionMessages
            tracking            = $tracking
            floodActiveSessions = $floodActiveSessions
            nowMs               = $now
            config              = $tickConfig
        } -Label $Script:ReconcileLogPrefix -JsonDepth 30

    $submitted = 0
    $escalated = 0
    $noop = 0
    $submitOutcomes = @()
    $tracking = $plan.tracking

    foreach ($action in @($plan.actions)) {
        switch ($action.type) {
            'submit' {
                if (-not $DryRunMode -and -not $Fixture) {
                    Set-SubmitReconcileState -Path $StatePath -State $tracking
                }
                if ($DryRunMode -or $Fixture) {
                    $submitResult = Invoke-WorkerInputDraftSubmit `
                        -SessionId $action.sessionId `
                        -ExpectedSessionId $action.sessionId `
                        -DryRun
                }
                else {
                    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'worker-message-submit-side-effect.lock'
                    Write-OrchestratorSideProcessProgress -ChildId 'worker-message-submit-reconcile' -Phase 'side_effect'
                    $submitHolder = @{ result = $null }
                    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
                        $submitHolder.result = Invoke-WorkerInputDraftSubmit `
                            -SessionId $action.sessionId `
                            -ExpectedSessionId $action.sessionId
                    }
                    if (-not $fenced.ok) {
                        Write-SubmitReconcileLog "submit skipped (side-effect busy): delivery=$($action.deliveryId) session=$($action.sessionId)"
                        $submitResult = @{ submitted = $false; reason = 'side_effect_busy' }
                    }
                    elseif (-not $submitHolder.result) {
                        $submitResult = @{ submitted = $false; reason = 'submit_result_missing' }
                    }
                    else {
                        $submitResult = $submitHolder.result
                    }
                }
                if ($submitResult.submitted) {
                    Write-SubmitReconcileLog "submitted: delivery=$($action.deliveryId) session=$($action.sessionId) attempt=$($action.attempt) claim=$($action.claimKey)"
                    $submitted++
                    $submitOutcomes += @{
                        deliveryId = [string]$action.deliveryId
                        claimKey   = [string]$action.claimKey
                        outcome    = 'confirmed'
                    }
                }
                else {
                    Write-SubmitReconcileLog "submit failed (fail-closed): delivery=$($action.deliveryId) reason=$($submitResult.reason)"
                    $noop++
                    $submitOutcomes += @{
                        deliveryId = [string]$action.deliveryId
                        claimKey   = [string]$action.claimKey
                        outcome    = 'released'
                        reason     = [string]$submitResult.reason
                    }
                }
            }
            'escalate' {
                Write-SubmitReconcileLog $action.diagnosis
                $escalated++
            }
            'mark_consumed' {
                Write-SubmitReconcileLog "consumed: delivery=$($action.deliveryId) session=$($action.sessionId)"
            }
            'defer' {
                Write-SubmitReconcileLog "deferred: delivery=$($action.deliveryId) reason=$($action.reason)"
            }
            default {
                Write-SubmitReconcileLog "noop: delivery=$($action.deliveryId) reason=$($action.reason)"
                $noop++
            }
        }
    }

    if ($submitOutcomes.Count -gt 0) {
        $outcomeResult = Invoke-MechanicalNodeFilterCli -FilterCliPath $SubmitFilterCli -Subcommand 'outcome' `
            -Payload @{
                tracking = $tracking
                outcomes = @($submitOutcomes)
                nowMs    = $now
            } -Label $Script:ReconcileLogPrefix -JsonDepth 30
        $tracking = $outcomeResult.tracking
    }

    return @{
        tracking  = $tracking
        submitted = $submitted
        escalated = $escalated
        noop      = $noop
    }
}

$intervalSeconds = Get-SubmitReconcileIntervalSeconds
$intervalMs = [Math]::Max(1, $intervalSeconds) * 1000
$pollMs = [Math]::Max(5, $PollSeconds) * 1000
$statePath = Get-SubmitReconcileStatePath -CliPath $StateFile
$journalPath = if ($DispatchJournalPath) { $DispatchJournalPath } else { Get-WorkerMessageDispatchJournalPath }

Write-SubmitReconcileLog "starting (project=$ProjectId, interval=${intervalSeconds}s, state=$statePath, journal=$journalPath, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"

if ($FixturePath) {
    if (-not $DryRun) {
        Write-SubmitReconcileLog 'fixture mode: enforcing dry-run (no live submit side effects)'
    }
    $result = Invoke-SubmitReconcileTick -Project $ProjectId -StatePath $statePath -JournalPath $journalPath `
        -DryRunMode -Fixture $FixturePath -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    Write-SubmitReconcileLog "fixture tick complete (submitted=$($result.submitted) escalated=$($result.escalated) noop=$($result.noop))"
    exit 0
}

$tickFailed = $false

try {
    do {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $state = Get-SubmitReconcileState -Path $statePath
        $lastTickMs = $null
        if ($state.lastTickMs) {
            $lastTickMs = [long]$state.lastTickMs
        }

        $gate = Invoke-MechanicalNodeFilterCli -FilterCliPath $SubmitFilterCli -Subcommand 'interval' `
            -Payload @{
                nowMs      = $nowMs
                lastTickMs = $lastTickMs
                intervalMs = $intervalMs
            } -Label $Script:ReconcileLogPrefix

        Write-OrchestratorSideProcessProgress -ChildId 'worker-message-submit-reconcile' -Phase 'poll'
        if (-not $gate.ok) {
            Write-SubmitReconcileLog "tick skipped: $($gate.reason)"
        }
        else {
            try {
                $result = Invoke-SubmitReconcileTick -Project $ProjectId -StatePath $statePath `
                    -JournalPath $journalPath -DryRunMode:$DryRun -NowMs $nowMs
                if (-not $DryRun) {
                    Set-SubmitReconcileState -Path $statePath -State $result.tracking
                }
                Write-SubmitReconcileLog "tick complete (submitted=$($result.submitted) escalated=$($result.escalated) noop=$($result.noop))"
                Write-OrchestratorSideProcessTickSuccess -ChildId 'worker-message-submit-reconcile'
            }
            catch {
                $tickFailed = $true
                Write-SubmitReconcileLog "tick failed: $_"
                Write-OrchestratorSideProcessTickError -ChildId 'worker-message-submit-reconcile' -ErrorMessage "$_"
                if ($Once) { throw }
            }
        }
        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    if ($Once -and $tickFailed) {
        exit 1
    }
}
