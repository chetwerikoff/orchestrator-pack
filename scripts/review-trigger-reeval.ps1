#requires -Version 5.1
<#
.SYNOPSIS
  Scoped deferred-head review re-evaluation loop (Issues #235, #748).

.DESCRIPTION
  Supervised side-effecting child. Watches recently-deferred-not-ready PR heads and
  issues ao-review run seconds-scale when #195 readiness lands — never a full open-PR sweep.
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
. (Join-Path $PSScriptRoot 'lib/Review-CycleCap.ps1')
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
    $sessions = Get-WorkerStatusDecisionSessions
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

function Get-ReviewTriggerReevalActiveWatchMap {
    param([hashtable]$WatchMap)

    $active = @{}
    foreach ($entry in $WatchMap.GetEnumerator()) {
        $watch = $entry.Value
        if (-not $watch) { continue }
        if ($watch.status -in @('expired', 'discarded', 'triggered')) { continue }
        $active[[string]$entry.Key] = $watch
    }
    return $active
}

function Get-ReviewTriggerReevalScopedOpenPrsFromGitHub {
    param([hashtable]$WatchMap)

    $active = Get-ReviewTriggerReevalActiveWatchMap -WatchMap $WatchMap
    if ($active.Count -eq 0) { return @() }

    $openPrList = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot `
            -Consumer 'review-trigger-reeval-terminal-classification')
    $trackedNumbers = @{}
    foreach ($entry in $active.GetEnumerator()) {
        $prNumber = [int]$entry.Value.prNumber
        if ($prNumber -gt 0) { $trackedNumbers[[string]$prNumber] = $true }
    }
    return @($openPrList | Where-Object { $trackedNumbers.ContainsKey([string][int]$_.number) })
}

function Get-ReviewTriggerReevalScopedPrStateSnapshot {
    param([hashtable]$WatchMap)

    $active = Get-ReviewTriggerReevalActiveWatchMap -WatchMap $WatchMap
    if ($active.Count -eq 0) {
        return @{
            authoritative     = $true
            reasonCode        = 'no_active_watches'
            openPrs           = @()
            terminalWatchKeys = @()
            unknownWatchKeys  = @()
        }
    }

    try {
        $repoTickRecord = $null
        if (Get-Command Ensure-GhFleetRepoTickSnapshot -ErrorAction SilentlyContinue) {
            $repoTickRecord = Ensure-GhFleetRepoTickSnapshot -RepoRoot $RepoRoot `
                -Consumer 'review-trigger-reeval-terminal-classification' -DataClass 'open_pr_list'
        }
        $openPrList = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot `
                -Consumer 'review-trigger-reeval-terminal-classification')
        $trackedNumbers = @{}
        foreach ($entry in $active.GetEnumerator()) {
            $prNumber = [int]$entry.Value.prNumber
            if ($prNumber -gt 0) { $trackedNumbers[[string]$prNumber] = $true }
        }
        $scopedOpenPrs = @($openPrList | Where-Object { $trackedNumbers.ContainsKey([string][int]$_.number) })

        if ($repoTickRecord) {
            $freshnessCommand = Get-Command Test-GhFleetRepoTickGenerationFresh -ErrorAction SilentlyContinue
            if (-not $freshnessCommand) {
                return @{
                    authoritative     = $false
                    reasonCode        = 'repo_tick_freshness_unknown'
                    openPrs           = $scopedOpenPrs
                    terminalWatchKeys = @()
                    unknownWatchKeys  = @($active.Keys | Sort-Object -Unique)
                }
            }
            $intervalSeconds = Get-GhFleetRepoTickIntervalSeconds
            if (-not (Test-GhFleetRepoTickGenerationFresh -Record $repoTickRecord -IntervalSeconds $intervalSeconds)) {
                return @{
                    authoritative     = $false
                    reasonCode        = 'repo_tick_snapshot_stale'
                    openPrs           = $scopedOpenPrs
                    terminalWatchKeys = @()
                    unknownWatchKeys  = @($active.Keys | Sort-Object -Unique)
                }
            }
        }

        $openNumbers = @{}
        foreach ($pr in @($openPrList)) {
            $number = [int]$pr.number
            if ($number -gt 0) { $openNumbers[[string]$number] = $true }
        }
        $terminalKeys = @()
        foreach ($entry in $active.GetEnumerator()) {
            $prNumber = [int]$entry.Value.prNumber
            if ($prNumber -le 0 -or -not $openNumbers.ContainsKey([string]$prNumber)) {
                $terminalKeys += [string]$entry.Key
            }
        }
        return @{
            authoritative     = $true
            reasonCode        = 'authoritative_open_pr_snapshot'
            openPrs           = $scopedOpenPrs
            terminalWatchKeys = @($terminalKeys | Sort-Object -Unique)
            unknownWatchKeys  = @()
        }
    }
    catch {
        return @{
            authoritative     = $false
            reasonCode        = 'github_snapshot_unknown'
            openPrs           = @()
            terminalWatchKeys = @()
            unknownWatchKeys  = @($active.Keys | Sort-Object -Unique)
        }
    }
}

function Get-ReviewTriggerReevalFixturePrStateSnapshot {
    param(
        [hashtable]$WatchMap,
        [hashtable]$FixturePayload
    )

    $active = Get-ReviewTriggerReevalActiveWatchMap -WatchMap $WatchMap
    $terminalKeys = if ($FixturePayload.ContainsKey('terminalWatchKeys')) { @($FixturePayload['terminalWatchKeys']) } else { @() }
    $unknownKeys = if ($FixturePayload.ContainsKey('unknownWatchKeys')) { @($FixturePayload['unknownWatchKeys']) } else { @() }
    $authoritativeSpecified = $FixturePayload.ContainsKey('prSnapshotAuthoritative')
    $authoritative = $authoritativeSpecified -and [bool]$FixturePayload['prSnapshotAuthoritative']
    if ($terminalKeys.Count -eq 0 -and $unknownKeys.Count -eq 0 -and $authoritativeSpecified) {
        if ($authoritative) {
            $openNumbers = @{}
            foreach ($pr in @($FixturePayload.openPrs)) {
                $number = [int]$pr.number
                if ($number -gt 0) { $openNumbers[[string]$number] = $true }
            }
            foreach ($entry in $active.GetEnumerator()) {
                $prNumber = [int]$entry.Value.prNumber
                if ($prNumber -le 0 -or -not $openNumbers.ContainsKey([string]$prNumber)) {
                    $terminalKeys += [string]$entry.Key
                }
            }
        }
        else {
            $unknownKeys = @($active.Keys)
        }
    }
    return @{
        authoritative     = $authoritative
        reasonCode        = if ($unknownKeys.Count -gt 0) { 'fixture_snapshot_unknown' } else { 'fixture_snapshot' }
        openPrs           = @($FixturePayload.openPrs)
        terminalWatchKeys = @($terminalKeys | Where-Object { $_ } | Sort-Object -Unique)
        unknownWatchKeys  = @($unknownKeys | Where-Object { $_ } | Sort-Object -Unique)
    }
}

function Remove-ReviewTriggerReevalWatchKeysFromMap {
    param(
        [hashtable]$WatchMap,
        [string[]]$Keys
    )

    $copy = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $WatchMap
    foreach ($key in @($Keys)) {
        $normalized = [string]$key
        if ($normalized -and $copy.ContainsKey($normalized)) {
            $copy.Remove($normalized)
        }
    }
    return $copy
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
    $terminalWatchKeys = @()
    $unknownWatchKeys = @()

    if ($FixturePayload) {
        if ($FixturePayload.watchEntries) {
            $watchMap = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $FixturePayload.watchEntries
        }
        $prStateSnapshot = Get-ReviewTriggerReevalFixturePrStateSnapshot -WatchMap $watchMap -FixturePayload $FixturePayload
        $terminalWatchKeys = @($prStateSnapshot.terminalWatchKeys)
        $unknownWatchKeys = @($prStateSnapshot.unknownWatchKeys)
        $watchMap = Remove-ReviewTriggerReevalWatchKeysFromMap -WatchMap $watchMap -Keys $terminalWatchKeys
        $snapshot = @{
            openPrs                       = @($FixturePayload.openPrs)
            reviewRuns                    = @($FixturePayload.reviewRuns)
            sessions                      = @($FixturePayload.sessions)
            ciChecksByPr                  = $FixturePayload.ciChecksByPr
            requiredCheckNamesByPr        = $FixturePayload.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $FixturePayload.requiredCheckLookupFailedByPr
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
            $prStateSnapshot = Get-ReviewTriggerReevalScopedPrStateSnapshot -WatchMap $watchMap
            $terminalWatchKeys = @($prStateSnapshot.terminalWatchKeys)
            $unknownWatchKeys = @($prStateSnapshot.unknownWatchKeys)
            $watchMap = Remove-ReviewTriggerReevalWatchKeysFromMap -WatchMap $watchMap -Keys $terminalWatchKeys
            if ($terminalWatchKeys.Count -gt 0) {
                Write-ReviewTriggerReevalLog "terminal watch eviction planned count=$($terminalWatchKeys.Count)"
            }
            if ($unknownWatchKeys.Count -gt 0) {
                Write-ReviewTriggerReevalLog "watch PR classification unknown; retaining count=$($unknownWatchKeys.Count) reason=$($prStateSnapshot.reasonCode)"
            }
            $snapshot = Get-ReviewTriggerReevalSnapshot -OpenPrs @($prStateSnapshot.openPrs) -ScopedOnly
        }
    }

    $fixtureSnapshot = $null
    if ($FixturePayload) {
        $fixtureSnapshot = @{}
        if ($FixturePayload.issueBodiesByPr) {
            $fixtureSnapshot.issueBodiesByPr = Copy-MechanicalJsonMap -Map $FixturePayload.issueBodiesByPr
        }
        if ($FixturePayload.issueBody) {
            $fixtureSnapshot.issueBody = [string]$FixturePayload.issueBody
        }
    }

    $snapshotErrorsByKey = @{}
    if ($FixturePayload -and $FixturePayload.snapshotErrorsByKey) {
        $snapshotErrorsByKey = Copy-MechanicalJsonMap -Map $FixturePayload.snapshotErrorsByKey
    }
    foreach ($key in @($unknownWatchKeys)) {
        $snapshotErrorsByKey[[string]$key] = $true
    }

    $capCycleState = Get-ReviewCycleCapState -Path (Get-ReviewCycleCapStatePath -ProjectId $ProjectId)
    $planPayload = @{
        watchEntries                  = $watchMap
        openPrs                       = @($snapshot.openPrs)
        reviewRuns                    = @($snapshot.reviewRuns)
        sessions                      = @($snapshot.sessions)
        ciChecksByPr                  = $snapshot.ciChecksByPr
        requiredCheckNamesByPr        = $snapshot.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $snapshot.requiredCheckLookupFailedByPr
        nowMs                         = $nowMs
        snapshotErrorsByKey           = $snapshotErrorsByKey
        capCycleState                 = $capCycleState
    }
    $issueBodiesByPr = Get-ReviewCycleCapIssueBodiesByPr -OpenPrs @($snapshot.openPrs) -RepoRoot $RepoRoot `
        -ProjectId $ProjectId -FixtureSnapshot $fixtureSnapshot
    if ($issueBodiesByPr.Count -gt 0) {
        $planPayload.issueBodiesByPr = $issueBodiesByPr
    }
    $plan = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'planTick' -Payload $planPayload

    if ($plan.capCycleState) {
        Set-ReviewCycleCapState -Path (Get-ReviewCycleCapStatePath -ProjectId $ProjectId) -State $plan.capCycleState
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
                        param($planned, $claimResult)
                        . (Join-Path $PSScriptRoot 'lib/Get-ClaimedReviewStartSnapshot.ps1')
                        Get-ClaimedReviewStartReevalFreshSnapshot -Planned $planned -ClaimResult $claimResult `
                            -Project $ProjectId -RepoRoot $RepoRoot
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
                Write-ReviewTriggerReevalLog "EMPTY REVIEW TRAP PR #$($action.prNumber) ($($action.failureDetail))"
            }
            'escalate_degraded_ci' {
                Write-ReviewTriggerReevalLog "ESCALATE PR #$($action.prNumber): $($action.reason)"
            }
            'skip' {
                Write-ReviewTriggerReevalLog "skip PR #$($action.prNumber): $($action.reason)"
            }
        }
    }

    $mutation = $null
    if (-not $DryRunMode) {
        if ($terminalWatchKeys.Count -gt 0) {
            $mutation = Update-ReviewTriggerReevalWatchStateMutation -Path $watchPath `
                -IncomingWatchEntries $watchEntriesToPersist -RemoveWatchKeys $terminalWatchKeys -NowMs $nowMs
        }
        else {
            $mutation = Update-ReviewTriggerReevalWatchStateMerged -Path $watchPath `
                -IncomingWatchEntries $watchEntriesToPersist -NowMs $nowMs
        }
        if ($mutation.corruptRemoved -gt 0) {
            Write-ReviewTriggerReevalLog "bounded corrupt watch cleanup removed=$($mutation.corruptRemoved) retained=$($mutation.corruptRetained)"
        }
    }

    $persistedWatchMap = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $watchEntriesToPersist
    $persistedCount = if ($mutation) { [int]$mutation.watchCount } else { $persistedWatchMap.Count }
    return @{
        started         = $started
        actions         = @($plan.actions)
        watchEntries    = $watchEntriesToPersist
        watchCount      = $persistedCount
        terminalEvicted = @($terminalWatchKeys).Count
        unknownRetained = @($unknownWatchKeys).Count
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
Write-ReviewTriggerReevalLog 'pollClass=scoped_deferred_head_watch windowMs=300000 incidentDelayMs=77000'

if ($FixturePath) {
    $payload = Get-FixtureReviewTriggerReevalPayload -Path $FixturePath
    if ($payload.reviewCommand) {
        $reviewCommand = $payload.reviewCommand
    }
    $result = Invoke-ReviewTriggerReevalTick -StateRoot $stateRoot -ReviewCommand $reviewCommand `
        -ProjectId $ProjectId -DryRunMode:$DryRun -FixturePayload $payload
    Write-ReviewTriggerReevalLog "fixture tick complete (started=$($result.started), terminalEvicted=$($result.terminalEvicted), unknownRetained=$($result.unknownRetained))"
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
            Write-ReviewTriggerReevalLog "tick complete (started=$($result.started), watches=$($result.watchCount), terminalEvicted=$($result.terminalEvicted), unknownRetained=$($result.unknownRetained))"
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
