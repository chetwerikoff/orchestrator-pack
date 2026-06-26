#requires -Version 5.1
<#
.SYNOPSIS
  Report-state poll tick: scan ao status, seed #235 watches, invoke scoped reeval (Issue #391).
#>

. (Join-Path $PSScriptRoot 'Record-ReviewReadyReportStateSeed.ps1')
. (Join-Path $PSScriptRoot 'Record-ReviewTriggerReevalWatch.ps1')
. (Join-Path $PSScriptRoot 'Record-ReviewHandoffWakeAdmission.ps1')
. (Join-Path $PSScriptRoot 'Review-TriggerReeval-Common.ps1')
. (Join-Path $PSScriptRoot 'Invoke-ReviewTriggerReeval.ps1')
. (Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Review-StartClaim.ps1')
. (Join-Path $PSScriptRoot 'Get-SupervisedRepoSlug.ps1')

function Get-ReviewReadyReportStateSeedTerminalClaimKeys {
    param(
        [string]$Namespace,
        [array]$OpenPrs
    )

    $OpenPrs = ConvertTo-GhOpenPrArray -OpenPrs $OpenPrs

    $keys = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($pr in @($OpenPrs)) {
        $prNumber = [int]$pr.number
        $headSha = [string]$pr.headRefOid
        if (-not $prNumber -or -not $headSha) { continue }
        $claimPath = Get-ReviewStartClaimPath -Namespace $Namespace -PrNumber $prNumber -HeadSha $headSha
        if (Test-Path -LiteralPath $claimPath -PathType Leaf) {
            [void]$keys.Add("${prNumber}:$headSha")
            continue
        }
        $terminalDir = Get-ReviewStartClaimTerminalDir -Namespace $Namespace
        if (Test-Path -LiteralPath $terminalDir -PathType Container) {
            $pattern = "*${prNumber}*${headSha}*"
            $terminal = Get-ChildItem -LiteralPath $terminalDir -File -Filter $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($terminal) {
                [void]$keys.Add("${prNumber}:$headSha")
            }
        }
    }
    return @($keys)
}

function Get-ReviewReadyReportStateSeedGitHubRefreshIntervalMs {
    # Issue #391: CI-defer recovery must observe green within <=30s; keep refresh below that bound.
    $seconds = 20
    if ($env:AO_REPORT_STATE_SEED_GITHUB_REFRESH_SECONDS) {
        $seconds = [int]$env:AO_REPORT_STATE_SEED_GITHUB_REFRESH_SECONDS
    }
    if ($seconds -lt 5) {
        $seconds = 5
    }
    if ($seconds -gt 29) {
        $seconds = 29
    }
    return $seconds * 1000
}

function Get-ReviewReadyReportStateSeedTrackedPrNumbers {
    param(
        [array]$Sessions,
        [string]$SupervisedProject = ''
    )

    $numbers = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($session in @($Sessions)) {
        if ($SupervisedProject) {
            $project = [string]($session.project)
            if (-not $project) { $project = [string]($session.projectId) }
            if ($project -and $project -ne $SupervisedProject) {
                continue
            }
        }

        $prNumber = 0
        if ($null -ne $session.prNumber) {
            $prNumber = [int]$session.prNumber
        }
        if ($prNumber -le 0) {
            $prUrl = [string]($session.pr)
            if (-not $prUrl) { $prUrl = [string]($session.prUrl) }
            if ($prUrl -match '/pull/(\d+)') {
                $prNumber = [int]$Matches[1]
            }
        }
        if ($prNumber -gt 0) {
            [void]$numbers.Add($prNumber)
        }
    }

    return @($numbers | Sort-Object)
}

function Test-ReviewReadyReportStateSeedGitHubSnapshotStale {
    param(
        $Snapshot,
        [array]$TrackedPrNumbers,
        [long]$NowMs,
        [long]$RefreshIntervalMs
    )

    if (-not $Snapshot -or -not $Snapshot.fetchedAtMs) {
        return $true
    }

    $age = $NowMs - [long]$Snapshot.fetchedAtMs
    if ($age -ge $RefreshIntervalMs) {
        return $true
    }

    $cached = @($Snapshot.trackedPrNumbers | ForEach-Object { [int]$_ } | Sort-Object)
    $tracked = @($TrackedPrNumbers | ForEach-Object { [int]$_ } | Sort-Object)
    return (($cached -join ',') -ne ($tracked -join ','))
}

function New-ReviewReadyReportStateSeedGitHubSnapshot {
    param(
        [string]$RepoRoot,
        [array]$TrackedPrNumbers,
        [long]$NowMs
    )

    $openPrs = if (@($TrackedPrNumbers).Count -gt 0) {
        @(Invoke-GhOpenPrListForNumbers -RepoRoot $RepoRoot -PrNumbers @($TrackedPrNumbers))
    }
    else {
        @()
    }

    $checksBundle = Get-GhChecksBundleByPr -RepoRoot $RepoRoot -OpenPrs $openPrs -MergeRequiredNames {
        param($payload)
        Invoke-MechanicalNodeFilterCli -FilterCliPath (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/ci-green-wake-reconcile.mjs') `
            -Subcommand 'merge-required-names' -Payload $payload -Label 'review-ready-report-state-seed' -JsonDepth 20
    }

    return @{
        fetchedAtMs                   = $NowMs
        trackedPrNumbers              = @($TrackedPrNumbers)
        openPrs                       = @($openPrs)
        ciChecksByPr                  = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
    }
}

function Resolve-ReviewReadyReportStateSeedGitHubSnapshot {
    param(
        [string]$RepoRoot,
        [array]$Sessions,
        [string]$SupervisedProject,
        $CachedSnapshot,
        [long]$NowMs
    )

    $trackedPrNumbers = @(Get-ReviewReadyReportStateSeedTrackedPrNumbers -Sessions $Sessions -SupervisedProject $SupervisedProject)
    $refreshIntervalMs = Get-ReviewReadyReportStateSeedGitHubRefreshIntervalMs
    if (Test-ReviewReadyReportStateSeedGitHubSnapshotStale -Snapshot $CachedSnapshot -TrackedPrNumbers $trackedPrNumbers -NowMs $NowMs -RefreshIntervalMs $refreshIntervalMs) {
        return (New-ReviewReadyReportStateSeedGitHubSnapshot -RepoRoot $RepoRoot -TrackedPrNumbers $trackedPrNumbers -NowMs $NowMs)
    }

    return $CachedSnapshot
}

function Invoke-ReviewReadyReportStateSeedTick {
    param(
        [string]$StateRoot,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$RepoRoot = '',
        [string]$ReviewCommand = '',
        [string]$SupervisedRepoSlug = '',
        [hashtable]$FixturePayload,
        [switch]$DryRun,
        [scriptblock]$LogWriter = { param([string]$Message) Write-Host $Message },
        [scriptblock]$ProgressWriter = $null,
        [string]$TickId = ''
    )

    $emitProgress = {
        param([string]$Step)
        if ($ProgressWriter) {
            & $ProgressWriter $Step
        }
    }

    $seedStatePath = Get-ReviewReadyReportStateSeedStatePath -StateRoot $StateRoot
    $watchPath = Get-ReviewTriggerReevalWatchPath -StateRoot $StateRoot
    $githubSnapshot = $null
    $nowMs = if ($FixturePayload -and $FixturePayload.nowMs) {
        [long]$FixturePayload.nowMs
    }
    else {
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    if ($FixturePayload) {
        & $emitProgress 'load_status'
        $openPrs = ConvertTo-GhOpenPrArray -OpenPrs $FixturePayload.openPrs
        $sessions = @($FixturePayload.sessions)
        & $emitProgress 'load_review_runs'
        $reviewRuns = @($FixturePayload.reviewRuns)
        $checksBundle = @{
            ciChecksByPr                  = $FixturePayload.ciChecksByPr
            requiredCheckNamesByPr        = $FixturePayload.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $FixturePayload.requiredCheckLookupFailedByPr
        }
        $seedState = @{
            bindingByKey     = $FixturePayload.bindingByKey
            seededKeys       = @($FixturePayload.seededKeys)
            deferredScanKeys = @($FixturePayload.deferredScanKeys)
        }
        $handoffRecords = $FixturePayload.handoffRecords
        $terminalClaimKeys = @($FixturePayload.terminalClaimKeys)
        $watchMap = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $(if ($FixturePayload.watchEntries) { $FixturePayload.watchEntries } else { @{} })
    }
    else {
        & $emitProgress 'load_status'
        $sessions = @(Get-AoStatusSessionsIncludingTerminated)
        $seedState = Get-ReviewReadyReportStateSeedState -Path $seedStatePath
        & $emitProgress 'load_review_runs'
        & $emitProgress 'refresh_github'
        $githubSnapshot = Resolve-ReviewReadyReportStateSeedGitHubSnapshot `
            -RepoRoot $RepoRoot `
            -Sessions $sessions `
            -SupervisedProject $ProjectId `
            -CachedSnapshot $seedState.githubSnapshot `
            -NowMs $nowMs
        $openPrs = ConvertTo-GhOpenPrArray -OpenPrs $githubSnapshot.openPrs
        $checksBundle = @{
            ciChecksByPr                  = $githubSnapshot.ciChecksByPr
            requiredCheckNamesByPr        = $githubSnapshot.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $githubSnapshot.requiredCheckLookupFailedByPr
        }
        $reviewRuns = @(Get-AoReviewRuns -Project $ProjectId)
        $handoffPath = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
        $handoffState = Get-ReviewHandoffWakeAdmissionState -Path $handoffPath
        $handoffRecords = $handoffState.records
        $namespace = Resolve-ReviewStartClaimNamespace -ProjectId $ProjectId
        $terminalClaimKeys = Get-ReviewReadyReportStateSeedTerminalClaimKeys -Namespace $namespace -OpenPrs $openPrs
        $watchState = Get-ReviewTriggerReevalWatchState -Path $watchPath
        $watchMap = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $watchState.watchEntries
    }

    if (-not $SupervisedRepoSlug) {
        if ($FixturePayload -and $FixturePayload.supervisedRepoSlug) {
            $SupervisedRepoSlug = [string]$FixturePayload.supervisedRepoSlug
        }
        elseif ($RepoRoot) {
            $SupervisedRepoSlug = Get-SupervisedRepoSlug -RepoRoot $RepoRoot
        }
    }

    $watchEntriesForPlan = @{}
    foreach ($entry in $watchMap.GetEnumerator()) {
        $watchEntriesForPlan[[string]$entry.Key] = $entry.Value
    }

    & $emitProgress 'plan_seed'
    $plan = Invoke-ReviewReadyReportStateSeedCli -Subcommand 'planTick' -Payload @{
        sessions               = $sessions
        openPrs                = $openPrs
        reviewRuns             = $reviewRuns
        bindingByKey           = $seedState.bindingByKey
        handoffRecords         = $handoffRecords
        terminalClaimKeys      = $terminalClaimKeys
        existingSeedKeys       = @($seedState.seededKeys)
        supervisedProject      = $ProjectId
        fallbackRepoSlug       = $SupervisedRepoSlug
        nowMs                  = $nowMs
        tickCapacity           = if ($FixturePayload.tickCapacity) { [int]$FixturePayload.tickCapacity } else { 20 }
        deferredScanKeys       = @($seedState.deferredScanKeys)
        watchEntries           = $watchEntriesForPlan
    }

    $seedResult = @{ seededKeys = @() }
    & $emitProgress 'apply_seed'
    if ($plan.candidates -and @($plan.candidates).Count -gt 0) {
        $seedResult = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'seedFromReportStatePoll' -Payload @{
            candidates      = @($plan.candidates)
            existingWatches = $watchMap
            nowMs           = $nowMs
        }
        $watchMap = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $seedResult.watchEntries
        & $LogWriter "report-state-seed: seeded $(@($seedResult.seededKeys).Count) watch(es)"
    }

    if (-not $DryRun) {
        Update-ReviewReadyReportStateSeedStateLocked -Path $seedStatePath -NowMs $nowMs -Mutator {
            param($current)
            $mergedSeeds = @{}
            $released = @{}
            foreach ($key in @($plan.releasedSeedKeys)) {
                if ($key) { $released[[string]$key] = $true }
            }
            foreach ($key in @($current.seededKeys)) {
                if (-not $key) { continue }
                if ($released.ContainsKey([string]$key)) { continue }
                $mergedSeeds[[string]$key] = $true
            }
            foreach ($key in @($seedResult.seededKeys)) {
                if ($key) { $mergedSeeds[[string]$key] = $true }
            }
            return @{
                bindingByKey     = $plan.bindingByKey
                seededKeys       = @($mergedSeeds.Keys)
                deferredScanKeys = @($plan.deferredScanKeys)
                githubSnapshot   = if ($null -ne $githubSnapshot) { $githubSnapshot } else { $current.githubSnapshot }
            }
        }
        Update-ReviewTriggerReevalWatchStateMerged -Path $watchPath -IncomingWatchEntries $watchMap -NowMs $nowMs
    }

    & $emitProgress 'plan_reeval'
    $reevalPlan = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'planTick' -Payload @{
        watchEntries                  = $watchMap
        openPrs                       = @($openPrs)
        reviewRuns                    = @($reviewRuns)
        sessions                      = @($sessions)
        ciChecksByPr                  = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
        nowMs                         = $nowMs
    }

    $started = 0
    $revalidations = @()
    $watchEntriesToPersist = $reevalPlan.watchEntries
    foreach ($action in @($reevalPlan.actions)) {
        if ($action.type -ne 'start_review') { continue }
        if ($action.startReason -ne 'report_state_seed') { continue }

        $plannedRunParams = @{
            Action               = $action
            ReviewCommand        = $ReviewCommand
            RepoRoot             = $RepoRoot
            StateRoot            = $StateRoot
            ProjectId            = $ProjectId
            DryRun               = $DryRun
            LogWriter            = $LogWriter
        }
        if ($FixturePayload) {
            if ($FixturePayload.freshSnapshot) {
                $plannedRunParams['ResolveFreshSnapshot'] = {
                    param($planned)
                    $fs = $FixturePayload.freshSnapshot
                    $prKey = [string]$planned.prNumber
                    @{
                        openPrs                       = @($(if ($null -ne $fs.openPrs) { $fs.openPrs } else { $openPrs }))
                        reviewRuns                    = @($(if ($null -ne $fs.reviewRuns) { $fs.reviewRuns } else { $reviewRuns }))
                        sessions                      = @($(if ($null -ne $fs.sessions) { $fs.sessions } else { $sessions }))
                        ciChecksByPr                  = $(if ($null -ne $fs.ciChecksByPr) { $fs.ciChecksByPr } else { $checksBundle.ciChecksByPr })
                        requiredCheckNamesByPr        = $(if ($null -ne $fs.requiredCheckNamesByPr) { $fs.requiredCheckNamesByPr } else { $checksBundle.requiredCheckNamesByPr })
                        requiredCheckLookupFailedByPr = $(if ($null -ne $fs.requiredCheckLookupFailedByPr) { $fs.requiredCheckLookupFailedByPr } else { $checksBundle.requiredCheckLookupFailedByPr })
                        nowMs                         = $(if ($fs.nowMs) { [long]$fs.nowMs } else { $nowMs })
                    }
                }
            }
            else {
                $plannedRunParams['FixtureSnapshot'] = @{
                    openPrs                       = $openPrs
                    reviewRuns                    = $reviewRuns
                    sessions                      = $sessions
                    ciChecksByPr                  = $checksBundle.ciChecksByPr
                    requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
                    requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
                }
            }
        }
        else {
            $plannedRunParams['ResolveFreshSnapshot'] = {
                param($planned)
                $freshOpenPrs = @(Invoke-GhOpenPrListForNumbers -RepoRoot $RepoRoot -PrNumbers @([int]$planned.prNumber))
                $scoped = @($freshOpenPrs)
                $freshChecks = Get-GhChecksBundleByPr -RepoRoot $RepoRoot -OpenPrs $scoped -MergeRequiredNames {
                    param($payload)
                    Invoke-MechanicalNodeFilterCli -FilterCliPath (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/ci-green-wake-reconcile.mjs') `
                        -Subcommand 'merge-required-names' -Payload $payload -Label 'review-ready-report-state-seed' -JsonDepth 20
                }
                @{
                    openPrs                       = $scoped
                    reviewRuns                    = @(Get-AoReviewRuns -Project $ProjectId)
                    sessions                      = @(Get-AoStatusSessionsIncludingTerminated)
                    ciChecksByPr                  = $freshChecks.ciChecksByPr
                    requiredCheckNamesByPr        = $freshChecks.requiredCheckNamesByPr
                    requiredCheckLookupFailedByPr = $freshChecks.requiredCheckLookupFailedByPr
                    nowMs                         = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                }
            }
        }
        $result = Invoke-ReviewTriggerReevalPlannedRun @plannedRunParams
        $classified = Invoke-ReviewReadyReportStateSeedCli -Subcommand 'classifySideEffectOutcome' -Payload @{
            triggered         = [bool]$result.triggered
            sideEffectReason  = [string]$result.reason
            boundaryRace      = [bool]($FixturePayload -and $FixturePayload.boundaryRace)
        }
        $revalidations += @{
            prNumber  = [int]$action.prNumber
            headSha   = [string]$action.headSha
            outcome   = [string]$classified.outcome
            reason    = [string]$classified.reason
            triggered = [bool]$result.triggered
        }
        if ($result.triggered) { $started++ }
        elseif ($result.retainWatch -and $action.watchKey) {
            $revert = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'revertTriggeredWatchOnAbort' -Payload @{
                watchEntries = $watchEntriesToPersist
                watchKey     = [string]$action.watchKey
                nowMs        = $nowMs
            }
            $watchEntriesToPersist = $revert.watchEntries
        }
    }

    foreach ($action in @($reevalPlan.actions)) {
        if ($action.type -ne 'start_review') { continue }
        if ($action.startReason -eq 'report_state_seed') { continue }
        $watchKey = [string]$action.watchKey
        if (-not $watchKey) { continue }
        $revert = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'revertTriggeredWatchOnAbort' -Payload @{
            watchEntries = $watchEntriesToPersist
            watchKey     = $watchKey
            nowMs        = $nowMs
        }
        $watchEntriesToPersist = $revert.watchEntries
    }

    if (-not $DryRun -and $started -gt 0) {
        Update-ReviewTriggerReevalWatchStateMerged -Path $watchPath -IncomingWatchEntries $watchEntriesToPersist -NowMs $nowMs
    }

    return @{
        started          = $started
        seeded           = @($seedResult.seededKeys).Count
        candidates       = @($plan.candidates).Count
        deferredScanKeys = @($plan.deferredScanKeys)
        actions          = @($reevalPlan.actions)
        revalidations    = @($revalidations)
    }
}
