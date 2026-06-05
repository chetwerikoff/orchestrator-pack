#requires -Version 5.1
<#
.SYNOPSIS
  Event-driven review run on completion wakes (Issue #207).
#>

$Script:ReviewWakeTriggerFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-wake-trigger.mjs'

. (Join-Path $PSScriptRoot 'Invoke-ReviewerWorkspacePreflight.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')

function Test-ReviewWakeTriggerForbiddenCommand {
    param([string]$CommandLine)

    Test-ReviewMechanicalForbiddenCommand -CommandLine $CommandLine

    if ($CommandLine -match '\bgh\s+pr\s+merge\b') {
        throw 'forbidden merge fragment in review wake command: gh pr merge'
    }
}

function Get-ReviewWakeTriggerSideEffectLockPath {
    param([string]$StateRoot = '')
    if ($StateRoot) {
        return Join-Path $StateRoot 'listener-side-effect.lock'
    }
    $fromEnv = $env:AO_WAKE_LISTENER_SIDE_EFFECT_LOCK
    if ($fromEnv) { return $fromEnv }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-wake-listener-side-effect.lock'
}

function Test-ReviewWakeTriggerSideEffectInFlight {
    param([string]$LockPath)
    return Test-OrchestratorSideEffectInFlight -LockPath $LockPath
}

function Enter-ReviewWakeTriggerSideEffectFence {
    param(
        [string]$LockPath,
        [hashtable]$Metadata = @{}
    )
    return Enter-OrchestratorSideEffectFence -LockPath $LockPath -Metadata $Metadata
}

function Exit-ReviewWakeTriggerSideEffectFence {
    param([string]$LockPath)
    Exit-OrchestratorSideEffectFence -LockPath $LockPath
}

function Invoke-ReviewWakeTriggerFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewWakeTriggerFilterCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-wake-trigger' -JsonDepth 30
}

function Get-ReviewWakeTriggerMergeEval {
    param(
        [int]$PrNumber,
        [hashtable]$Snapshot,
        [string]$HeadSha = '',
        [array]$ExtraReviewRuns = @()
    )

    $resolvedHeadSha = $HeadSha
    if (-not $resolvedHeadSha) {
        foreach ($pr in @($Snapshot.openPrs)) {
            if ([int]$pr.number -eq $PrNumber) {
                $resolvedHeadSha = [string]$pr.headRefOid
                break
            }
        }
    }
    if (-not $resolvedHeadSha) {
        return $null
    }

    return Invoke-ReviewWakeTriggerFilterCli -Subcommand 'mergeIntent' -Payload @{
        prNumber   = $PrNumber
        headSha    = $resolvedHeadSha
        reviewRuns = @($Snapshot.reviewRuns) + @($ExtraReviewRuns)
    }
}

function Get-ReviewWakeTriggerSnapshot {
    param(
        [int]$PrNumber,
        [string]$Project,
        [string]$RepoRoot,
        [hashtable]$FixtureSnapshot
    )

    if ($FixtureSnapshot) {
        return $FixtureSnapshot
    }

    $openPrs = Invoke-GhOpenPrList -RepoRoot $RepoRoot
    $reviewRuns = Get-AoReviewRuns -Project $Project
    $sessions = Get-AoStatusSessions
    $checksBundle = Get-GhChecksBundleByPr -RepoRoot $RepoRoot -OpenPrs @(
        @($openPrs | Where-Object { [int]$_.number -eq $PrNumber })
    ) -MergeRequiredNames {
        param($payload)
        Invoke-MechanicalNodeFilterCli -FilterCliPath (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/ci-green-wake-reconcile.mjs') `
            -Subcommand 'merge-required-names' -Payload $payload -Label 'review-wake-trigger' -JsonDepth 20
    } -ProtectionLookupWarningTemplate 'warn: branch protection lookup failed PR #{0} (exit {1}); treating required CI as degraded'

    $prKey = [string]$PrNumber
    return @{
        openPrs                       = @($openPrs)
        reviewRuns                    = @($reviewRuns)
        sessions                      = @($sessions)
        ciChecksByPr                  = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
        prKey                         = $prKey
    }
}

function Invoke-ReviewWakeTriggerOnCompletionWake {
    param(
        [object]$FilterResult,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$RepoRoot = '',
        [string]$ReviewCommand = '',
        [string]$SideEffectLockPath = '',
        [hashtable]$FixtureSnapshot,
        [switch]$DryRun,
        [scriptblock]$LogWriter = { param([string]$Message) Write-Host $Message }
    )

    if (-not $FilterResult.ok) {
        return @{ triggered = $false; reason = 'filter_not_ok' }
    }

    if ($FilterResult.wakeKind -ne 'merge.ready') {
        return @{ triggered = $false; reason = 'not_completion_wake' }
    }

    $prNumber = [int]$FilterResult.prNumber
    if ($prNumber -le 0) {
        & $LogWriter 'review-wake-trigger: skip (no pr number on completion wake)'
        return @{ triggered = $false; reason = 'missing_pr_number' }
    }

    $snapshot = Get-ReviewWakeTriggerSnapshot -PrNumber $prNumber -Project $ProjectId `
        -RepoRoot $RepoRoot -FixtureSnapshot $FixtureSnapshot

    # Bound listener-local processing only — exclude gh/ao snapshot latency.
    $wakeReceivedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    $prKey = if ($snapshot.prKey) { $snapshot.prKey } else { [string]$prNumber }
    $evaluation = Invoke-ReviewWakeTriggerFilterCli -Subcommand 'evaluate' -Payload @{
        wakeKind                    = $FilterResult.wakeKind
        sessionId                   = [string]$FilterResult.sessionId
        prNumber                    = $prNumber
        wakeReceivedMs              = $wakeReceivedMs
        nowMs                       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        openPrs                     = @($snapshot.openPrs)
        reviewRuns                  = @($snapshot.reviewRuns)
        sessions                    = @($snapshot.sessions)
        ciChecks                    = @($snapshot.ciChecksByPr[$prKey])
        requiredCheckNames          = @($snapshot.requiredCheckNamesByPr[$prKey])
        requiredCheckLookupFailed   = [bool]$snapshot.requiredCheckLookupFailedByPr[$prKey]
    }

    if (-not $evaluation.withinLatencyBound) {
        throw "review-wake-trigger exceeded wake-to-run decision bound (${evaluation.processingMs}ms)"
    }

    if ($evaluation.route -eq 'empty_review_trap') {
        $term = [string]$evaluation.terminationReason
        & $LogWriter "review-wake-trigger: EMPTY REVIEW TRAP PR #$prNumber ($term)"
        return @{
            triggered = $false
            reason    = $evaluation.reason
            route     = $evaluation.route
            mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $prNumber -Snapshot $snapshot
        }
    }

    if (-not $evaluation.triggerReviewRun) {
        & $LogWriter "review-wake-trigger: defer PR #$prNumber ($($evaluation.reason))"
        return @{
            triggered = $false
            reason    = $evaluation.reason
            mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $prNumber -Snapshot $snapshot
        }
    }

    $planned = $evaluation.planned
    $runArgs = @('review', 'run', $planned.sessionId, '--execute', '--command', $ReviewCommand)
    $commandLine = "ao $($runArgs -join ' ')"
    Test-ReviewWakeTriggerForbiddenCommand -CommandLine $commandLine

    $lockPath = if ($SideEffectLockPath) { $SideEffectLockPath } else { Get-ReviewWakeTriggerSideEffectLockPath }
    if (Test-ReviewWakeTriggerSideEffectInFlight -LockPath $lockPath) {
        & $LogWriter "review-wake-trigger: side-effect fence busy; skip duplicate run PR #$($planned.prNumber)"
        return @{
            triggered = $false
            reason    = 'side_effect_in_flight'
            mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $planned.prNumber -Snapshot $snapshot `
                -HeadSha $planned.headSha -ExtraReviewRuns @(@{
                    prNumber  = $planned.prNumber
                    targetSha = $planned.headSha
                    status    = 'queued'
                })
        }
    }

    $fresh = if ($FixtureSnapshot) {
        $FixtureSnapshot
    }
    else {
        Get-ReviewWakeTriggerSnapshot -PrNumber $planned.prNumber -Project $ProjectId -RepoRoot $RepoRoot
    }
    $freshPrKey = if ($fresh.prKey) { $fresh.prKey } else { [string]$planned.prNumber }
    $recheck = Invoke-ReviewWakeTriggerFilterCli -Subcommand 'preRunRecheck' -Payload @{
        planned = @{
            prNumber  = $planned.prNumber
            headSha   = $planned.headSha
            sessionId = $planned.sessionId
        }
        fresh   = @{
            openPrs                     = @($fresh.openPrs)
            reviewRuns                  = @($fresh.reviewRuns)
            sessions                    = @($fresh.sessions)
            ciChecks                    = @($fresh.ciChecksByPr[$freshPrKey])
            requiredCheckNames          = @($fresh.requiredCheckNamesByPr[$freshPrKey])
            requiredCheckLookupFailed   = [bool]$fresh.requiredCheckLookupFailedByPr[$freshPrKey]
        }
    }

    if (-not $recheck.emitReviewRun) {
        & $LogWriter "review-wake-trigger: pre-run re-check aborted PR #$($planned.prNumber) ($($recheck.reason))"
        return @{
            triggered = $false
            reason    = $recheck.reason
            mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $planned.prNumber -Snapshot $fresh
        }
    }

    if ($DryRun) {
        & $LogWriter "review-wake-trigger: dry-run would run: $commandLine (PR #$($planned.prNumber) head=$($planned.headSha))"
    }
    else {
        if (-not (Enter-ReviewWakeTriggerSideEffectFence -LockPath $lockPath -Metadata @{
                prNumber  = $planned.prNumber
                headSha   = $planned.headSha
                sessionId = $planned.sessionId
            })) {
            & $LogWriter "review-wake-trigger: side-effect fence busy; skip duplicate run PR #$($planned.prNumber)"
            return @{
                triggered = $false
                reason    = 'side_effect_in_flight'
                mergeEval = Get-ReviewWakeTriggerMergeEval -PrNumber $planned.prNumber -Snapshot $snapshot `
                    -HeadSha $planned.headSha -ExtraReviewRuns @(@{
                        prNumber  = $planned.prNumber
                        targetSha = $planned.headSha
                        status    = 'queued'
                    })
            }
        }
        try {
            & $LogWriter "review-wake-trigger: starting review PR #$($planned.prNumber) head=$($planned.headSha) session=$($planned.sessionId)"
            Invoke-ReviewerWorkspacePreflight -RepoRoot $RepoRoot
            & ao @runArgs
            if ($LASTEXITCODE -ne 0) {
                throw "ao review run failed (exit $LASTEXITCODE) for PR #$($planned.prNumber)"
            }
        }
        finally {
            Exit-ReviewWakeTriggerSideEffectFence -LockPath $lockPath
        }
    }

    $postRuns = if ($DryRun -and $FixtureSnapshot) {
        @($FixtureSnapshot.reviewRuns) + @(@{
                prNumber   = $planned.prNumber
                targetSha  = $planned.headSha
                status     = 'queued'
                linkedSessionId = $planned.sessionId
            })
    }
    elseif ($DryRun) {
        @($snapshot.reviewRuns) + @(@{
                prNumber   = $planned.prNumber
                targetSha  = $planned.headSha
                status     = 'queued'
                linkedSessionId = $planned.sessionId
            })
    }
    else {
        @(Get-AoReviewRuns -Project $ProjectId)
    }

    $mergeEval = Invoke-ReviewWakeTriggerFilterCli -Subcommand 'mergeIntent' -Payload @{
        prNumber   = $planned.prNumber
        headSha    = $planned.headSha
        reviewRuns = @($postRuns)
    }

    return @{
        triggered = $true
        reason    = 'head_ready_for_review'
        planned   = $planned
        mergeEval = $mergeEval
        postReviewRuns = @($postRuns)
    }
}

function Resolve-ReviewWakeMergeMessage {
    param(
        [string]$WakeMessage,
        [object]$MergeEval
    )

    if (-not $MergeEval -or $MergeEval.mergeable -ne $false) {
        return $WakeMessage
    }
    $reason = [string]$MergeEval.reason
    if (-not $reason) {
        return $WakeMessage
    }
    return "$WakeMessage mergeable=false reason=$reason"
}
