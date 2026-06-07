#requires -Version 5.1
<#
.SYNOPSIS
  Persist scoped deferred-head watch entries (Issue #235).
#>

. (Join-Path $PSScriptRoot 'Review-TriggerReeval-Common.ps1')

function Get-ReviewTriggerReevalWatchPath {
    param([string]$StateRoot = '')

    if ($StateRoot) {
        return Join-Path $StateRoot 'review-trigger-reeval-watch.json'
    }
    if ($env:AO_REVIEW_TRIGGER_REEVAL_WATCH_STATE) {
        return $env:AO_REVIEW_TRIGGER_REEVAL_WATCH_STATE
    }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-trigger-reeval-watch.json'
}

function Get-ReviewTriggerReevalWatchState {
    param([string]$Path)

    $default = @{ watchEntries = @{}; lastUpdatedMs = $null }
    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $default
}

function Set-ReviewTriggerReevalWatchState {
    param(
        [string]$Path,
        [object]$State
    )

    Set-MechanicalJsonStateFile -Path $Path -State $State -JsonDepth 30
}

function Record-ReviewTriggerReevalWatchFromWakeDefer {
    param(
        [string]$StateRoot = '',
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$SessionId,
        [string]$DeferReason,
        [object]$DeferRecord,
        [switch]$DryRun
    )

    if (-not $StateRoot) {
        return @{ recorded = $false; reason = 'missing_state_root' }
    }

    if ($DeferReason -ne 'uncovered_not_ready') {
        return @{ recorded = $false; reason = 'not_uncovered_not_ready' }
    }

    $path = Get-ReviewTriggerReevalWatchPath -StateRoot $StateRoot
    $state = Get-ReviewTriggerReevalWatchState -Path $path
    $existing = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $state.watchEntries

    $seed = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'seedFromWakeDefer' -Payload @{
        prNumber        = $PrNumber
        headSha         = $HeadSha
        sessionId       = $SessionId
        deferReason     = $DeferReason
        deferRecord     = $DeferRecord
        existingWatches = $existing
        nowMs           = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    if (-not $seed.seeded) {
        return @{ recorded = $false; reason = [string]$seed.reason }
    }

    if (-not $DryRun) {
        Set-ReviewTriggerReevalWatchState -Path $path -State @{
            watchEntries  = $seed.watchEntries
            lastUpdatedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
    }

    return @{
        recorded = $true
        watchKey = [string]$seed.watchKey
        path     = $path
    }
}
