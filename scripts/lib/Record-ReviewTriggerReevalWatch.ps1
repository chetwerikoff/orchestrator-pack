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

function Get-ReviewTriggerReevalWatchLockPath {
    param([string]$WatchPath)

    $dir = Split-Path -Parent $WatchPath
    if (-not $dir) {
        return Join-Path ([System.IO.Path]::GetTempPath()) 'review-trigger-reeval-watch.lock'
    }
    return Join-Path $dir 'review-trigger-reeval-watch.lock'
}

function Invoke-ReviewTriggerReevalWatchStateLocked {
    param(
        [string]$LockPath,
        [scriptblock]$Action,
        [int]$MaxWaitMs = 5000
    )

    $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $MaxWaitMs
    do {
        $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $LockPath -Metadata @{
            purpose = 'review-trigger-reeval-watch-state'
        } -Action $Action
        if ($fenced.ok) {
            return
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline)

    throw "timed out acquiring review-trigger-reeval watch lock: $LockPath"
}

function Update-ReviewTriggerReevalWatchStateMerged {
    param(
        [string]$Path,
        [object]$IncomingWatchEntries,
        [long]$NowMs
    )

    $lockPath = Get-ReviewTriggerReevalWatchLockPath -WatchPath $Path
    Invoke-ReviewTriggerReevalWatchStateLocked -LockPath $lockPath -Action {
        $current = Get-ReviewTriggerReevalWatchState -Path $Path
        Assert-MechanicalJsonStateFencesTrusted -State $current -Context 'watch state merge'
        $existing = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $current.watchEntries
        $incoming = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $IncomingWatchEntries
        $merged = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'mergeWatchState' -Payload @{
            existingWatches = $existing
            incomingWatches = $incoming
            nowMs           = $NowMs
        }
        Set-ReviewTriggerReevalWatchState -Path $Path -State @{
            watchEntries  = $merged.watchEntries
            lastUpdatedMs = $NowMs
        }
    }
}

$Script:ReviewTriggerReevalWatchDefaultState = @{ watchEntries = @{}; lastUpdatedMs = $null }

function Get-ReviewTriggerReevalWatchState {
    param([string]$Path)

    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $Script:ReviewTriggerReevalWatchDefaultState -ActionTracking
}

function Set-ReviewTriggerReevalWatchState {
    param(
        [string]$Path,
        [object]$State
    )

    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $Script:ReviewTriggerReevalWatchDefaultState -JsonDepth 30
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
    Assert-MechanicalJsonStateFencesTrusted -State $state -Context 'watch state recording'
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
        Update-ReviewTriggerReevalWatchStateMerged -Path $path -IncomingWatchEntries $seed.watchEntries `
            -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    }

    return @{
        recorded = $true
        watchKey = [string]$seed.watchKey
        path     = $path
    }
}
