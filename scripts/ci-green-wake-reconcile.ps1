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

function Get-CiGreenWakeState {
    param([string]$Path)

    $default = @{ heads = @{}; nudged = @{}; pendingJournal = @{}; lastTickMs = $null }
    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $default
}

function Set-CiGreenWakeState {
    param(
        [string]$Path,
        [object]$State
    )

    Set-MechanicalJsonStateFile -Path $Path -State $State -JsonDepth 30
}

function Save-PartialCiGreenWakeTracking {
    param(
        [string]$Path,
        [hashtable]$HeadRecords,
        [hashtable]$Nudged,
        [hashtable]$PendingJournal,
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
        lastTickMs     = $existing.lastTickMs
    }
    Set-CiGreenWakeState -Path $Path -State $merged
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

function Get-CiGreenWakePreSendSnapshot {
    param(
        [int]$PrNumber,
        [string]$Project
    )

    $openPrs = Invoke-GhOpenPrList -RepoRoot $RepoRoot
    $sessions = Get-AoStatusSessions
    $checksBundle = Get-CiGreenWakeChecksByPr -OpenPrs @(
        @($openPrs | Where-Object { [int]$_.number -eq $PrNumber })
    )

    return @{
        openPrs                         = @($openPrs)
        sessions                        = @($sessions)
        ciChecksByPr                    = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr          = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr   = $checksBundle.requiredCheckLookupFailedByPr
    }
}

function Get-FixtureCiGreenWakePayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    return @{
        openPrs                         = @($fixture.openPrs)
        sessions                        = @($fixture.sessions)
        ciChecksByPr                    = $fixture.ciChecksByPr
        requiredCheckNamesByPr          = $fixture.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr   = $fixture.requiredCheckLookupFailedByPr
        tracking                        = $fixture.tracking
    }
}

function Invoke-PlannedCiGreenWakeSend {
    param(
        [object]$Action,
        [object]$FreshPayload,
        [string]$Project,
        [switch]$DryRunMode,
        [switch]$UseFixtureSnapshot
    )

    if ($UseFixtureSnapshot) {
        if (-not $FreshPayload) {
            throw 'FreshPayload is required when UseFixtureSnapshot is set'
        }
    }
    else {
        $FreshPayload = Get-CiGreenWakePreSendSnapshot -PrNumber ([int]$Action.prNumber) -Project $Project
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

    Write-CiGreenWakeLog "nudging worker: PR #$($Action.prNumber) head=$($Action.headSha) session=$($Action.sessionId) transition=$($Action.transitionId)"
    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'ci-green-wake-side-effect.lock'
    Write-OrchestratorSideProcessProgress -ChildId 'ci-green-wake-reconcile' -Phase 'side_effect'
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        & ao @sendArgs
        if ($LASTEXITCODE -ne 0) {
            throw "ao send failed (exit $LASTEXITCODE) for PR #$($Action.prNumber)"
        }
    }
    if (-not $fenced.ok) {
        Write-CiGreenWakeLog "nudge skipped (side-effect busy) PR #$($Action.prNumber)"
        return @{ sent = $false; reason = 'side_effect_busy' }
    }

    $deliveredAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $dispatchResult = Register-WorkerMessageDispatch -SessionId $Action.sessionId -Message $Action.message `
        -Source 'pack-send' -SourceKey "ci-green:$($Action.transitionId)" `
        -DeliveredAtMs $deliveredAtMs
    $outcome = Resolve-DispatchJournalSendOutcome -DispatchResult $dispatchResult
    if ($outcome.journalRecorded) {
        return @{
            sent            = $true
            delivered       = $true
            journalRecorded = $true
            reason          = 'sent'
        }
    }

    $dispatchReason = if ($outcome.journalFailureReason) {
        [string]$outcome.journalFailureReason
    }
    else {
        [string]$outcome.reason
    }
    Write-CiGreenWakeLog "dispatch journal record failed PR #$($Action.prNumber): $dispatchReason (ao send delivered; journal pending retry)"
    return @{
        sent                 = $false
        delivered            = $true
        journalRecorded      = $false
        journalFailureReason = $dispatchReason
        reason               = 'journal_record_failed'
        sessionId            = [string]$Action.sessionId
        message              = [string]$Action.message
        transitionId         = [string]$Action.transitionId
        deliveredAtMs        = $deliveredAtMs
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
        $openPrs = Invoke-GhOpenPrList -RepoRoot $RepoRoot
        $sessions = Get-AoStatusSessions
        $checksBundle = Get-CiGreenWakeChecksByPr -OpenPrs @($openPrs)
        $ciChecksByPr = $checksBundle.ciChecksByPr
        $requiredCheckNamesByPr = $checksBundle.requiredCheckNamesByPr
        $requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
    }

    $nudged = @{}
    if ($tracking.nudged) {
        foreach ($prop in $tracking.nudged.PSObject.Properties) {
            $nudged[$prop.Name] = $prop.Value
        }
    }
    $pendingJournal = @{}
    if ($tracking.pendingJournal) {
        foreach ($prop in $tracking.pendingJournal.PSObject.Properties) {
            $pendingJournal[$prop.Name] = $prop.Value
        }
    }
    $journalRetries = Retry-PendingCiGreenDispatchJournals -PendingJournal $pendingJournal -Nudged $nudged `
        -DryRunMode:$DryRunMode
    if ($journalRetries -gt 0) {
        Write-CiGreenWakeLog "recovered $journalRetries pending dispatch journal record(s)"
    }
    $tracking = @{
        heads          = $tracking.heads
        nudged         = $nudged
        pendingJournal = $pendingJournal
        lastTickMs     = $tracking.lastTickMs
    }

    $planPayload = @{
        openPrs                         = @($openPrs)
        sessions                        = @($sessions)
        ciChecksByPr                    = $ciChecksByPr
        requiredCheckNamesByPr          = $requiredCheckNamesByPr
        requiredCheckLookupFailedByPr   = $requiredCheckLookupFailedByPr
        tracking                        = $tracking
    }

    $plan = Invoke-CiGreenWakeFilterCli -Subcommand 'plan' -Payload $planPayload
    $useFixtureSnapshot = [bool]$Fixture
    $fixtureFreshPayload = $null
    if ($useFixtureSnapshot) {
        $fixtureFreshPayload = @{
            openPrs                         = @($openPrs)
            sessions                        = @($sessions)
            ciChecksByPr                    = $ciChecksByPr
            requiredCheckNamesByPr          = $requiredCheckNamesByPr
            requiredCheckLookupFailedByPr   = $requiredCheckLookupFailedByPr
        }
    }

    $sent = 0
    $nudged = @{}
    if ($tracking.nudged) {
        foreach ($prop in $tracking.nudged.PSObject.Properties) {
            $nudged[$prop.Name] = $prop.Value
        }
    }
    $pendingJournal = @{}
    if ($tracking.pendingJournal) {
        foreach ($prop in $tracking.pendingJournal.PSObject.Properties) {
            $pendingJournal[$prop.Name] = $prop.Value
        }
    }

    $headRecords = @{}
    if ($plan.headRecords) {
        foreach ($prop in $plan.headRecords.PSObject.Properties) {
            $headRecords[$prop.Name] = $prop.Value
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
                -Project $Project -DryRunMode:$DryRunMode -UseFixtureSnapshot:$useFixtureSnapshot
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
                Save-PartialCiGreenWakeTracking -Path $partialStatePath -HeadRecords $headRecords `
                    -Nudged $nudged -PendingJournal $pendingJournal -DryRunMode:$DryRunMode
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
                Save-PartialCiGreenWakeTracking -Path $partialStatePath -HeadRecords $headRecords `
                    -Nudged $nudged -PendingJournal $pendingJournal -DryRunMode:$DryRunMode
            }
            $sent++
        }
    }

    $merged = @{
        heads          = $headRecords
        nudged         = $nudged
        pendingJournal = $pendingJournal
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
            }
            catch {
                Write-CiGreenWakeLog "tick error: $_"
            }
            finally {
                Write-OrchestratorSideProcessProgress -ChildId 'ci-green-wake-reconcile' -Phase 'tick_complete'
            }
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-CiGreenWakeLog 'stopped'
}
