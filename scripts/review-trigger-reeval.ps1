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
. (Join-Path $PSScriptRoot 'lib/Review-TriggerReeval-Common.ps1')
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
        ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot)
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

function Get-ReviewTriggerReevalScopedOpenPrsFromGitHub {
    param([hashtable]$WatchMap)

    $activePrNumbers = @{}
    foreach ($entry in $WatchMap.Values) {
        if (-not $entry) { continue }
        if ($entry.status -eq 'expired' -or $entry.status -eq 'discarded' -or $entry.status -eq 'triggered') {
            continue
        }
        $activePrNumbers[[string][int]$entry.prNumber] = $true
    }
    if ($activePrNumbers.Count -eq 0) {
        return @()
    }

    $openPrList = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot)
    return @($openPrList | Where-Object { $activePrNumbers.ContainsKey([string][int]$_.number) })
}

function Invoke-ReviewTriggerReevalTick {
    param(
        [string]$StateRoot,
        [string]$ReviewCommand,
        [string]$ProjectId = 'orchestrator-pack',
        [switch]$DryRunMode,
        [hashtable]$FixturePayload
    )

    $watchPath = Get-ReviewTriggerReevalWatchPath -StateRoot $StateRoot
    $state = Get-ReviewTriggerReevalWatchState -Path $watchPath
    Assert-MechanicalJsonStateFencesTrusted -State $state -Context 'review reeval side effects'
    $watchMap = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $state.watchEntries
    $nowMs = if ($FixturePayload -and $FixturePayload.nowMs) {
        [long]$FixturePayload.nowMs
    }
    else {
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
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
        if ($watchMap.Count -eq 0) {
            # Recovery seeding needs a full PR snapshot; scoped-only with zero watches is empty.
            $snapshot = Get-ReviewTriggerReevalSnapshot
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
        else {
            $scopedPrs = Get-ReviewTriggerReevalScopedOpenPrsFromGitHub -WatchMap $watchMap
            $snapshot = Get-ReviewTriggerReevalSnapshot -OpenPrs $scopedPrs -ScopedOnly
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
    $watchEntriesToPersist = $plan.watchEntries
    foreach ($action in @($plan.actions)) {
        switch ($action.type) {
            'start_review' {
                Write-OrchestratorSideProcessProgress -ChildId 'review-trigger-reeval' -Phase 'side_effect'
                $plannedRunParams = @{
                    Action               = $action
                    ReviewCommand        = $ReviewCommand
                    RepoRoot             = $RepoRoot
                    StateRoot            = $StateRoot
                    ProjectId            = $ProjectId
                    ResolveFreshSnapshot = {
                        param($planned)
                        $openPrs = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot)
                        $targetPr = @($openPrs | Where-Object { [int]$_.number -eq $planned.prNumber })
                        Get-ReviewTriggerReevalSnapshot -OpenPrs $targetPr -ScopedOnly
                    }
                    DryRun               = $DryRunMode
                    LogWriter            = { param([string]$Message) Write-ReviewTriggerReevalLog $Message }
                }
                if ($FixturePayload) {
                    $plannedRunParams['FixtureSnapshot'] = $snapshot
                }
                $result = Invoke-ReviewTriggerReevalPlannedRun @plannedRunParams
                if ($result.triggered) {
                    $started++
                }
                elseif ($result.retainWatch) {
                    Write-ReviewTriggerReevalLog "retain watch PR #$($action.prNumber): $($result.reason)"
                    $watchKey = [string]$action.watchKey
                    if ($watchKey) {
                        $revert = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'revertTriggeredWatchOnAbort' -Payload @{
                            watchEntries = $watchEntriesToPersist
                            watchKey     = $watchKey
                            nowMs        = $nowMs
                        }
                        $watchEntriesToPersist = $revert.watchEntries
                    }
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
        Update-ReviewTriggerReevalWatchStateMerged -Path $watchPath -IncomingWatchEntries $watchEntriesToPersist `
            -NowMs $nowMs
    }

    $persistedWatchMap = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $watchEntriesToPersist
    return @{
        started      = $started
        actions      = @($plan.actions)
        watchEntries = $watchEntriesToPersist
        watchCount   = $persistedWatchMap.Count
    }
}

$stateRoot = Get-ReviewTriggerReevalStateRoot
$pollMs = [Math]::Max(1, $PollSeconds) * 1000
$configYaml = Join-Path $PackRoot 'agent-orchestrator.yaml'
if (-not (Test-Path -LiteralPath $configYaml -PathType Leaf)) {
    $configYaml = Join-Path $PackRoot 'agent-orchestrator.yaml.example'
}
$reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $configYaml

$claimNamespace = Resolve-ReviewStartClaimNamespace -ProjectId $ProjectId
Get-ReviewStartClaimStaleMinutes -LogWriter { param($m) Write-ReviewTriggerReevalLog $m } | Out-Null
Write-ReviewTriggerReevalLog "starting (project=$ProjectId, poll=${PollSeconds}s, stateRoot=$stateRoot, claimNamespace=$claimNamespace, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"
Write-ReviewTriggerReevalLog "pollClass=scoped_deferred_head_watch windowMs=300000 incidentDelayMs=77000"

if ($FixturePath) {
    $payload = Get-FixtureReviewTriggerReevalPayload -Path $FixturePath
    if ($payload.reviewCommand) {
        $reviewCommand = $payload.reviewCommand
    }
    $result = Invoke-ReviewTriggerReevalTick -StateRoot $stateRoot -ReviewCommand $reviewCommand `
        -ProjectId $ProjectId -DryRunMode:$DryRun -FixturePayload $payload
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
                -ProjectId $ProjectId -DryRunMode:$DryRun
            Write-ReviewTriggerReevalLog "tick complete (started=$($result.started), watches=$($result.watchCount))"
            Write-OrchestratorSideProcessTickSuccess -ChildId 'review-trigger-reeval'
        }
        catch {
            Write-ReviewTriggerReevalLog "tick error: $_"
            Write-OrchestratorSideProcessTickError -ChildId 'review-trigger-reeval' -ErrorMessage "$_"
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-ReviewTriggerReevalLog 'stopped'
}
