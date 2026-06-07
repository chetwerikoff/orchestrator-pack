#requires -Version 5.1
<#
.SYNOPSIS
  Invoke deferred-head review re-evaluation filter CLI and run review with fence (Issue #235).
#>

$Script:ReviewTriggerReevalFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-trigger-reeval.mjs'

. (Join-Path $PSScriptRoot 'Invoke-ReviewerWorkspacePreflight.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'Review-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Record-ReviewTriggerReevalWatch.ps1')

function Get-ReviewTriggerReevalSideEffectLockPath {
    param([string]$StateRoot = '')

    if ($StateRoot) {
        return Join-Path $StateRoot 'review-trigger-reeval-side-effect.lock'
    }
    return Get-OrchestratorSideEffectLockPath -LockFileName 'review-trigger-reeval-side-effect.lock'
}

function Invoke-ReviewTriggerReevalFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewTriggerReevalFilterCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-trigger-reeval' -JsonDepth 30
}

function Invoke-ReviewTriggerReevalPlannedRun {
    param(
        [object]$Action,
        [string]$ReviewCommand,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$RepoRoot = '',
        [string]$StateRoot = '',
        [hashtable]$FixtureSnapshot,
        [switch]$DryRun,
        [scriptblock]$LogWriter = { param([string]$Message) Write-Host $Message }
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
        throw 'FixtureSnapshot required for Invoke-ReviewTriggerReevalPlannedRun in tests; live path uses review-trigger-reeval.ps1 snapshot helpers'
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
        & $LogWriter "review-trigger-reeval: pre-run re-check aborted PR #$($planned.prNumber) ($($recheck.reason))"
        return @{
            triggered = $false
            reason    = [string]$recheck.reason
            retainWatch = $true
        }
    }

    if ($DryRun) {
        & $LogWriter "review-trigger-reeval: dry-run would run: $commandLine (PR #$($planned.prNumber) head=$($planned.headSha))"
        return @{
            triggered = $true
            reason    = 'dry_run'
            planned   = $planned
        }
    }

    $lockPath = Get-ReviewTriggerReevalSideEffectLockPath -StateRoot $StateRoot
    if (-not (Enter-OrchestratorSideEffectFence -LockPath $lockPath -Metadata @{
            prNumber  = $planned.prNumber
            headSha   = $planned.headSha
            sessionId = $planned.sessionId
        })) {
        & $LogWriter "review-trigger-reeval: side-effect fence busy; skip duplicate run PR #$($planned.prNumber)"
        return @{
            triggered = $false
            reason    = 'side_effect_in_flight'
            retainWatch = $true
        }
    }

    try {
        & $LogWriter "review-trigger-reeval: starting review PR #$($planned.prNumber) head=$($planned.headSha) session=$($planned.sessionId)"
        Invoke-ReviewerWorkspacePreflight -RepoRoot $RepoRoot
        & ao @runArgs
        if ($LASTEXITCODE -ne 0) {
            throw "ao review run failed (exit $LASTEXITCODE) for PR #$($planned.prNumber)"
        }
    }
    finally {
        Exit-OrchestratorSideEffectFence -LockPath $lockPath
    }

    return @{
        triggered = $true
        reason    = 'head_ready_for_review'
        planned   = $planned
    }
}
