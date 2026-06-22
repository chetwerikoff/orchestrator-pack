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

function Get-ReviewReadyReportStateSeedTerminalClaimKeys {
    param(
        [string]$Namespace,
        [array]$OpenPrs
    )

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

function Invoke-ReviewReadyReportStateSeedTick {
    param(
        [string]$StateRoot,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$RepoRoot = '',
        [string]$ReviewCommand = '',
        [string]$SupervisedRepoSlug = '',
        [hashtable]$FixturePayload,
        [switch]$DryRun,
        [scriptblock]$LogWriter = { param([string]$Message) Write-Host $Message }
    )

    $seedStatePath = Get-ReviewReadyReportStateSeedStatePath -StateRoot $StateRoot
    $watchPath = Get-ReviewTriggerReevalWatchPath -StateRoot $StateRoot
    $nowMs = if ($FixturePayload -and $FixturePayload.nowMs) {
        [long]$FixturePayload.nowMs
    }
    else {
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    if ($FixturePayload) {
        $openPrs = @($FixturePayload.openPrs)
        $sessions = @($FixturePayload.sessions)
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
        $openPrs = @(Invoke-GhOpenPrList -RepoRoot $RepoRoot)
        $sessions = @(Get-AoStatusSessionsIncludingTerminated)
        $reviewRuns = @(Get-AoReviewRuns -Project $ProjectId)
        $checksBundle = Get-GhChecksBundleByPr -RepoRoot $RepoRoot -OpenPrs $openPrs -MergeRequiredNames {
            param($payload)
            Invoke-MechanicalNodeFilterCli -FilterCliPath (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/ci-green-wake-reconcile.mjs') `
                -Subcommand 'merge-required-names' -Payload $payload -Label 'review-ready-report-state-seed' -JsonDepth 20
        }
        $seedState = Get-ReviewReadyReportStateSeedState -Path $seedStatePath
        $handoffPath = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
        $handoffState = Get-ReviewHandoffWakeAdmissionState -Path $handoffPath
        $handoffRecords = $handoffState.records
        $namespace = Resolve-ReviewStartClaimNamespace -ProjectId $ProjectId
        $terminalClaimKeys = Get-ReviewReadyReportStateSeedTerminalClaimKeys -Namespace $namespace -OpenPrs $openPrs
        $watchState = Get-ReviewTriggerReevalWatchState -Path $watchPath
        $watchMap = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $watchState.watchEntries
    }

    if (-not $SupervisedRepoSlug) {
        $SupervisedRepoSlug = 'chetwerikoff/orchestrator-pack'
    }

    $watchEntriesForPlan = @{}
    foreach ($entry in $watchMap.GetEnumerator()) {
        $watchEntriesForPlan[[string]$entry.Key] = $entry.Value
    }

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
            }
        }
        Update-ReviewTriggerReevalWatchStateMerged -Path $watchPath -IncomingWatchEntries $watchMap -NowMs $nowMs
    }

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
            $plannedRunParams['FixtureSnapshot'] = @{
                openPrs                       = $openPrs
                reviewRuns                    = $reviewRuns
                sessions                      = $sessions
                ciChecksByPr                  = $checksBundle.ciChecksByPr
                requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
                requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
            }
        }
        else {
            $plannedRunParams['ResolveFreshSnapshot'] = {
                param($planned)
                $freshOpenPrs = @(Invoke-GhOpenPrList -RepoRoot $RepoRoot)
                $scoped = @($freshOpenPrs | Where-Object { [int]$_.number -eq $planned.prNumber })
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
                }
            }
        }
        $result = Invoke-ReviewTriggerReevalPlannedRun @plannedRunParams
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
    }
}
