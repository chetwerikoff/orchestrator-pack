#requires -Version 5.1
<#
.SYNOPSIS
  Scoped deferred-head review re-evaluation loop (Issue #235).

.DESCRIPTION
  Supervised side-effecting child. Watches recently-deferred-not-ready PR heads and
  issues ao review run seconds-scale when #195 readiness lands — never a full open-PR sweep.
  Independent from review-trigger-reconcile.ps1 (#163) backstop.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [string]$StateDir = '',
    [int]$PollSeconds = 5,
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'
$Script:ReevalLogPrefix = 'review-trigger-reeval'

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) {
    $RepoRoot = $PackRoot
}

$ReevalFilterCli = Join-Path $PackRoot 'docs/review-trigger-reeval.mjs'
$CiGreenWakeFilterCli = Join-Path $PackRoot 'docs/ci-green-wake-reconcile.mjs'

. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-ReviewerWorkspacePreflight.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-ReviewTriggerReevalWatch.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-ReviewTriggerReeval.ps1')

function Write-ReviewTriggerReevalLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReevalLogPrefix): $Message"
}

$Script:GhPrChecksLogWriter = { param([string]$Message) Write-ReviewTriggerReevalLog $Message }

function Get-ReviewTriggerReevalStateRoot {
    if ($StateDir) { return $StateDir }
    if ($env:AO_SIDE_PROCESS_STATE_DIR) { return $env:AO_SIDE_PROCESS_STATE_DIR.Trim() }
    return ''
}

function Get-ReviewTriggerReevalChecksByPr {
    param([array]$OpenPrs)

    return Get-GhChecksBundleByPr -RepoRoot $RepoRoot -OpenPrs @($OpenPrs) `
        -MergeRequiredNames {
            param($payload)
            Invoke-MechanicalNodeFilterCli -FilterCliPath $CiGreenWakeFilterCli -Subcommand 'merge-required-names' `
                -Payload $payload -Label 'review-trigger-reeval' -JsonDepth 20
        } `
        -ProtectionLookupWarningTemplate 'warn: branch protection lookup failed PR #{0} (exit {1}); treating required CI as degraded'
}

function Get-ReviewTriggerReevalSnapshot {
    param(
        [array]$OpenPrs = @(),
        [switch]$ScopedOnly
    )

    if ($ScopedOnly -and $OpenPrs.Count -eq 0) {
        return @{
            openPrs                       = @()
            reviewRuns                    = @()
            sessions                      = @()
            ciChecksByPr                  = @{}
            requiredCheckNamesByPr        = @{}
            requiredCheckLookupFailedByPr = @{}
        }
    }

    $resolvedOpenPrs = if ($OpenPrs.Count -gt 0) {
        @($OpenPrs)
    }
    else {
        @((Invoke-GhOpenPrList -RepoRoot $RepoRoot))
    }

    $reviewRuns = Get-AoReviewRuns -Project $ProjectId
    $sessions = Get-AoStatusSessions
    $checksBundle = Get-ReviewTriggerReevalChecksByPr -OpenPrs $resolvedOpenPrs

    return @{
        openPrs                       = @($resolvedOpenPrs)
        reviewRuns                    = @($reviewRuns)
        sessions                      = @($sessions)
        ciChecksByPr                  = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
    }
}

function Get-FixtureReviewTriggerReevalPayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $payload = @{
        openPrs       = @($fixture.openPrs)
        reviewRuns    = @($fixture.reviewRuns)
        sessions      = @($fixture.sessions)
        reviewCommand = [string]$fixture.reviewCommand
    }
    foreach ($name in @('ciChecksByPr', 'requiredCheckNamesByPr', 'requiredCheckLookupFailedByPr', 'watchEntries', 'snapshotErrorsByKey')) {
        if ($fixture.$name) {
            $payload[$name] = $fixture.$name
        }
    }
    if ($fixture.nowMs) {
        $payload.nowMs = [long]$fixture.nowMs
    }
    return $payload
}

function Invoke-ReviewTriggerReevalPlannedRunLive {
    param(
        [object]$Action,
        [string]$ReviewCommand,
        [string]$StateRoot,
        [hashtable]$FixtureSnapshot,
        [switch]$DryRunMode
    )

    $planned = @{
        prNumber  = [int]$Action.prNumber
        headSha   = [string]$Action.headSha
        sessionId = [string]$Action.sessionId
    }

    $runArgs = @('review', 'run', $planned.sessionId, '--execute', '--command', $ReviewCommand)
    $commandLine = "ao $($runArgs -join ' ')"
    Test-ReviewMechanicalForbiddenCommand -CommandLine $commandLine

    $fresh = if ($FixtureSnapshot) {
        $FixtureSnapshot
    }
    else {
        $openPrs = Invoke-GhOpenPrList -RepoRoot $RepoRoot
        $targetPr = @($openPrs | Where-Object { [int]$_.number -eq $planned.prNumber })
        Get-ReviewTriggerReevalSnapshot -OpenPrs $targetPr -ScopedOnly
    }

    $prKey = [string]$planned.prNumber
    $recheck = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'preRunRecheck' -Payload @{
        planned = $planned
        fresh   = @{
            openPrs                     = @($fresh.openPrs)
            reviewRuns                  = @($fresh.reviewRuns)
            sessions                    = @($fresh.sessions)
            ciChecks                    = @($fresh.ciChecksByPr[$prKey])
            requiredCheckNames          = @($fresh.requiredCheckNamesByPr[$prKey])
            requiredCheckLookupFailed   = [bool]$fresh.requiredCheckLookupFailedByPr[$prKey]
        }
    }

    if (-not $recheck.emitReviewRun) {
        Write-ReviewTriggerReevalLog "pre-run re-check aborted PR #$($planned.prNumber) ($($recheck.reason))"
        return @{ triggered = $false; reason = [string]$recheck.reason; retainWatch = $true }
    }

    if ($DryRunMode) {
        Write-ReviewTriggerReevalLog "dry-run would run: $commandLine (PR #$($planned.prNumber) head=$($planned.headSha))"
        return @{ triggered = $true; reason = 'dry_run'; planned = $planned }
    }

    $lockPath = Get-ReviewTriggerReevalSideEffectLockPath -StateRoot $StateRoot
    Write-OrchestratorSideProcessProgress -ChildId 'review-trigger-reeval' -Phase 'side_effect'
    Invoke-ReviewerWorkspacePreflight -RepoRoot $RepoRoot
    Write-ReviewTriggerReevalLog "starting review PR #$($planned.prNumber) head=$($planned.headSha) session=$($planned.sessionId)"
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        & ao @runArgs
        if ($LASTEXITCODE -ne 0) {
            throw "ao review run failed (exit $LASTEXITCODE) for PR #$($planned.prNumber)"
        }
    }

    if (-not $fenced.ok) {
        Write-ReviewTriggerReevalLog "review run skipped (side-effect busy) PR #$($planned.prNumber)"
        return @{ triggered = $false; reason = 'side_effect_in_flight'; retainWatch = $true }
    }

    return @{ triggered = $true; reason = 'head_ready_for_review'; planned = $planned }
}

function Invoke-ReviewTriggerReevalTick {
    param(
        [string]$StateRoot,
        [string]$ReviewCommand,
        [switch]$DryRunMode,
        [hashtable]$FixturePayload
    )

    $watchPath = Get-ReviewTriggerReevalWatchPath -StateRoot $StateRoot
    $state = Get-ReviewTriggerReevalWatchState -Path $watchPath
    $watchMap = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $state.watchEntries
    $nowMs = if ($FixturePayload -and $FixturePayload.nowMs) {
        [long]$FixturePayload.nowMs
    }
    else {
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    $scopedPrs = @()
    foreach ($entry in $watchMap.Values) {
        if (-not $entry) { continue }
        if ($entry.status -eq 'expired' -or $entry.status -eq 'discarded' -or $entry.status -eq 'triggered') {
            continue
        }
        $scopedPrs += @{
            number     = [int]$entry.prNumber
            headRefOid = [string]$entry.headSha
        }
    }

    if ($FixturePayload) {
        $snapshot = @{
            openPrs                       = @($FixturePayload.openPrs)
            reviewRuns                    = @($FixturePayload.reviewRuns)
            sessions                      = @($FixturePayload.sessions)
            ciChecksByPr                  = $FixturePayload.ciChecksByPr
            requiredCheckNamesByPr        = $FixturePayload.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $FixturePayload.requiredCheckLookupFailedByPr
        }
        if ($FixturePayload.watchEntries) {
            $watchMap = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $FixturePayload.watchEntries
        }
    }
    else {
        $snapshot = Get-ReviewTriggerReevalSnapshot -OpenPrs $scopedPrs -ScopedOnly
        if ($watchMap.Count -eq 0) {
            $seed = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'seedFromInProgress' -Payload @{
                openPrs         = @($snapshot.openPrs)
                reviewRuns      = @($snapshot.reviewRuns)
                sessions        = @($snapshot.sessions)
                existingWatches = $watchMap
                nowMs           = $nowMs
            }
            if ($seed.seededKeys -and @($seed.seededKeys).Count -gt 0) {
                $watchMap = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $seed.watchEntries
                Write-ReviewTriggerReevalLog "recovery seeded $($seed.seededKeys.Count) in-progress watch(es)"
            }
        }
    }

    $plan = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'planTick' -Payload @{
        watchEntries                  = $watchMap
        openPrs                       = @($snapshot.openPrs)
        reviewRuns                    = @($snapshot.reviewRuns)
        sessions                      = @($snapshot.sessions)
        ciChecksByPr                  = $snapshot.ciChecksByPr
        requiredCheckNamesByPr        = $snapshot.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $snapshot.requiredCheckLookupFailedByPr
        nowMs                         = $nowMs
        snapshotErrorsByKey           = if ($FixturePayload.snapshotErrorsByKey) { $FixturePayload.snapshotErrorsByKey } else { @{} }
    }

    $started = 0
    foreach ($action in @($plan.actions)) {
        switch ($action.type) {
            'start_review' {
                $result = Invoke-ReviewTriggerReevalPlannedRunLive -Action $action -ReviewCommand $ReviewCommand `
                    -StateRoot $StateRoot -FixtureSnapshot $snapshot -DryRunMode:$DryRunMode
                if ($result.triggered) {
                    $started++
                }
                elseif ($result.retainWatch) {
                    Write-ReviewTriggerReevalLog "retain watch PR #$($action.prNumber): $($result.reason)"
                }
            }
            'retain_watch' {
                Write-ReviewTriggerReevalLog "retain watch PR #$($action.prNumber): $($action.reason)"
            }
            'hand_to_backstop' {
                Write-ReviewTriggerReevalLog "hand to backstop PR #$($action.prNumber): $($action.reason)"
            }
            'empty_review_trap' {
                Write-ReviewTriggerReevalLog "EMPTY REVIEW TRAP PR #$($action.prNumber) ($($action.terminationReason))"
            }
            'escalate_degraded_ci' {
                Write-ReviewTriggerReevalLog "ESCALATE PR #$($action.prNumber): $($action.reason)"
            }
            'skip' {
                Write-ReviewTriggerReevalLog "skip PR #$($action.prNumber): $($action.reason)"
            }
        }
    }

    if (-not $DryRunMode) {
        Set-ReviewTriggerReevalWatchState -Path $watchPath -State @{
            watchEntries  = $plan.watchEntries
            lastUpdatedMs = $nowMs
        }
    }

    return @{
        started      = $started
        actions      = @($plan.actions)
        watchEntries = $plan.watchEntries
    }
}

$stateRoot = Get-ReviewTriggerReevalStateRoot
$pollMs = [Math]::Max(1, $PollSeconds) * 1000
$configYaml = Join-Path $PackRoot 'agent-orchestrator.yaml'
if (-not (Test-Path -LiteralPath $configYaml -PathType Leaf)) {
    $configYaml = Join-Path $PackRoot 'agent-orchestrator.yaml.example'
}
$reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $configYaml

Write-ReviewTriggerReevalLog "starting (project=$ProjectId, poll=${PollSeconds}s, stateRoot=$stateRoot, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"
Write-ReviewTriggerReevalLog "pollClass=scoped_deferred_head_watch windowMs=300000 incidentDelayMs=77000"

if ($FixturePath) {
    $payload = Get-FixtureReviewTriggerReevalPayload -Path $FixturePath
    if ($payload.reviewCommand) {
        $reviewCommand = $payload.reviewCommand
    }
    $result = Invoke-ReviewTriggerReevalTick -StateRoot $stateRoot -ReviewCommand $reviewCommand `
        -DryRunMode:$DryRun -FixturePayload $payload
    Write-ReviewTriggerReevalLog "fixture tick complete (started=$($result.started))"
    exit 0
}

if (-not $reviewCommand) {
    throw 'Could not resolve REVIEW_COMMAND from agent-orchestrator.yaml'
}

try {
    do {
        Write-OrchestratorSideProcessProgress -ChildId 'review-trigger-reeval' -Phase 'poll'
        try {
            $result = Invoke-ReviewTriggerReevalTick -StateRoot $stateRoot -ReviewCommand $reviewCommand `
                -DryRunMode:$DryRun
            Write-ReviewTriggerReevalLog "tick complete (started=$($result.started), watches=$(@($result.watchEntries.PSObject.Properties).Count))"
        }
        catch {
            Write-ReviewTriggerReevalLog "tick error: $_"
        }
        finally {
            Write-OrchestratorSideProcessProgress -ChildId 'review-trigger-reeval' -Phase 'tick_complete'
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-ReviewTriggerReevalLog 'stopped'
}
