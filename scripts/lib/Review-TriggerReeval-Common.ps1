#requires -Version 5.1
<#
  Shared helpers for deferred-head review re-evaluation (Issue #235).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')

$Script:ReviewTriggerReevalFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-trigger-reeval.mjs'

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

function ConvertTo-ReviewTriggerReevalWatchMap {
    param([object]$WatchEntries)

    if (-not $WatchEntries) {
        return @{}
    }
    if ($WatchEntries -is [System.Collections.IDictionary]) {
        return Copy-MechanicalJsonMap -Map $WatchEntries
    }
    return Copy-MechanicalJsonMap -Map $WatchEntries
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
