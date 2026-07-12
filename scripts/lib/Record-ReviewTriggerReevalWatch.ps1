#requires -Version 5.1
<#
.SYNOPSIS
  Persist scoped deferred-head watch entries (Issues #235, #748).
#>

. (Join-Path $PSScriptRoot 'Review-TriggerReeval-Common.ps1')

$Script:ReviewTriggerReevalWatchDefaultState = @{
    watchEntries       = @{}
    terminalTombstones = @{}
    lastUpdatedMs      = $null
}
$Script:ReviewTriggerReevalCorruptRetentionCount = 3
$Script:ReviewTriggerReevalTerminalTombstoneRetentionMs = 86400000
$Script:ReviewTriggerReevalTerminalTombstoneMaxCount = 1024

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
            return $fenced
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline)

    throw 'timed out acquiring review-trigger-reeval watch lock'
}

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

function Get-ReviewTriggerReevalObjectValue {
    param(
        [object]$Value,
        [string]$Name
    )

    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        if ($Value.Contains($Name)) { return $Value[$Name] }
        return $null
    }
    $property = $Value.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Get-ReviewTriggerReevalWatchGenerationMs {
    param([object]$Watch)

    $generation = [long]0
    foreach ($name in @('seedMs', 'lastEvaluatedMs', 'lastObservedReadyMs')) {
        $raw = Get-ReviewTriggerReevalObjectValue -Value $Watch -Name $name
        if ($null -eq $raw) { continue }
        $candidate = [long]0
        if ([long]::TryParse([string]$raw, [ref]$candidate) -and $candidate -gt $generation) {
            $generation = $candidate
        }
    }
    return $generation
}

function Get-ReviewTriggerReevalTombstoneObservedAtMs {
    param([object]$Tombstone)

    $raw = Get-ReviewTriggerReevalObjectValue -Value $Tombstone -Name 'observedAtMs'
    $value = [long]0
    if ($null -ne $raw) {
        [void][long]::TryParse([string]$raw, [ref]$value)
    }
    return $value
}

function ConvertTo-ReviewTriggerReevalTombstoneMap {
    param([object]$TerminalTombstones)

    if (-not $TerminalTombstones) { return @{} }
    return Copy-MechanicalJsonMap -Map $TerminalTombstones
}

function Limit-ReviewTriggerReevalTerminalTombstones {
    param(
        [object]$TerminalTombstones,
        [long]$NowMs,
        [long]$RetentionMs = $Script:ReviewTriggerReevalTerminalTombstoneRetentionMs,
        [int]$MaxCount = $Script:ReviewTriggerReevalTerminalTombstoneMaxCount
    )

    $entries = @()
    $map = ConvertTo-ReviewTriggerReevalTombstoneMap -TerminalTombstones $TerminalTombstones
    foreach ($entry in $map.GetEnumerator()) {
        $observedAtMs = Get-ReviewTriggerReevalTombstoneObservedAtMs -Tombstone $entry.Value
        if ($observedAtMs -le 0) { continue }
        if ($NowMs -gt $observedAtMs -and ($NowMs - $observedAtMs) -gt $RetentionMs) { continue }
        $entries += [pscustomobject]@{
            key          = [string]$entry.Key
            observedAtMs = $observedAtMs
            value        = $entry.Value
        }
    }

    $bounded = @{}
    foreach ($entry in @($entries | Sort-Object observedAtMs -Descending | Select-Object -First ([Math]::Max(1, $MaxCount)))) {
        $bounded[[string]$entry.key] = $entry.value
    }
    return $bounded
}

function Remove-ReviewTriggerReevalTombstonedWatches {
    param(
        [object]$WatchEntries,
        [hashtable]$TerminalTombstones,
        [ref]$SuppressedKeys
    )

    $next = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $WatchEntries
    foreach ($key in @($next.Keys)) {
        $normalizedKey = [string]$key
        if (-not $TerminalTombstones.ContainsKey($normalizedKey)) { continue }
        # A terminal observation wins for this exact PR/head key for the bounded
        # tombstone lifetime. Record planning happens outside this lock, so its
        # local timestamp cannot prove a newer lifecycle and must never resurrect
        # a key terminalized by a concurrent authoritative snapshot.
        $next.Remove($normalizedKey)
        $SuppressedKeys.Value = @($SuppressedKeys.Value) + @($normalizedKey)
    }
    return $next
}

function Invoke-ReviewTriggerReevalCorruptFileCleanup {
    param(
        [string]$Path,
        [int]$RetainCount = $Script:ReviewTriggerReevalCorruptRetentionCount
    )

    $retain = [Math]::Max(1, $RetainCount)
    $dir = Split-Path -Parent $Path
    if (-not $dir -or -not (Test-Path -LiteralPath $dir -PathType Container)) {
        return @{ observed = 0; retained = 0; removed = 0 }
    }
    $leaf = Split-Path -Leaf $Path
    $artifacts = @(
        Get-ChildItem -LiteralPath $dir -File -Filter "${leaf}.corrupt-*" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending
    )
    $removed = 0
    for ($index = $retain; $index -lt $artifacts.Count; $index++) {
        try {
            Remove-Item -LiteralPath $artifacts[$index].FullName -Force -ErrorAction Stop
            $removed++
        }
        catch {
            # Cleanup is bounded and best-effort; mutation safety does not depend on deletion.
        }
    }
    return @{
        observed = $artifacts.Count
        retained = [Math]::Min($retain, $artifacts.Count)
        removed  = $removed
    }
}

function Update-ReviewTriggerReevalWatchStateMutation {
    param(
        [string]$Path,
        [object]$IncomingWatchEntries,
        [string[]]$RemoveWatchKeys = @(),
        [long]$NowMs
    )

    $lockPath = Get-ReviewTriggerReevalWatchLockPath -WatchPath $Path
    $captured = @{}
    Invoke-ReviewTriggerReevalWatchStateLocked -LockPath $lockPath -Action {
        $current = Get-ReviewTriggerReevalWatchState -Path $Path
        $cleanup = Invoke-ReviewTriggerReevalCorruptFileCleanup -Path $Path
        Assert-MechanicalJsonStateFencesTrusted -State $current -Context 'watch state mutation'

        $tombstones = Limit-ReviewTriggerReevalTerminalTombstones `
            -TerminalTombstones $current.terminalTombstones -NowMs $NowMs
        $suppressedExistingKeys = @()
        $suppressedIncomingKeys = @()
        $existing = Remove-ReviewTriggerReevalTombstonedWatches `
            -WatchEntries $current.watchEntries -TerminalTombstones $tombstones `
            -SuppressedKeys ([ref]$suppressedExistingKeys)
        $incoming = Remove-ReviewTriggerReevalTombstonedWatches `
            -WatchEntries $IncomingWatchEntries -TerminalTombstones $tombstones `
            -SuppressedKeys ([ref]$suppressedIncomingKeys)

        $merged = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'mergeWatchState' -Payload @{
            existingWatches = $existing
            incomingWatches = $incoming
            nowMs           = $NowMs
        }
        $next = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $merged.watchEntries
        $removedKeys = @()
        $terminalizedKeys = @()
        foreach ($key in @($RemoveWatchKeys | Sort-Object -Unique)) {
            $normalizedKey = [string]$key
            if (-not $normalizedKey) { continue }
            if ($next.ContainsKey($normalizedKey)) {
                $next.Remove($normalizedKey)
                $removedKeys += $normalizedKey
            }
            $tombstones[$normalizedKey] = @{
                observedAtMs = $NowMs
            }
            $terminalizedKeys += $normalizedKey
        }
        $tombstones = Limit-ReviewTriggerReevalTerminalTombstones `
            -TerminalTombstones $tombstones -NowMs $NowMs

        Set-ReviewTriggerReevalWatchState -Path $Path -State @{
            watchEntries       = $next
            terminalTombstones = $tombstones
            lastUpdatedMs      = $NowMs
        }
        $postWriteCleanup = Invoke-ReviewTriggerReevalCorruptFileCleanup -Path $Path
        $captured.result = @{
            watchCount                  = $next.Count
            tombstoneCount              = $tombstones.Count
            removedWatchKeys            = @($removedKeys)
            terminalizedWatchKeys       = @($terminalizedKeys)
            suppressedExistingWatchKeys = @($suppressedExistingKeys | Sort-Object -Unique)
            suppressedIncomingWatchKeys = @($suppressedIncomingKeys | Sort-Object -Unique)
            corruptObserved             = [Math]::Max([int]$cleanup.observed, [int]$postWriteCleanup.observed)
            corruptRemoved              = [int]$cleanup.removed + [int]$postWriteCleanup.removed
            corruptRetained             = [int]$postWriteCleanup.retained
        }
    } | Out-Null
    return $captured.result
}

function Update-ReviewTriggerReevalWatchStateMerged {
    param(
        [string]$Path,
        [object]$IncomingWatchEntries,
        [long]$NowMs
    )

    return Update-ReviewTriggerReevalWatchStateMutation -Path $Path -IncomingWatchEntries $IncomingWatchEntries `
        -RemoveWatchKeys @() -NowMs $NowMs
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

    if ($DeferReason -notin @('uncovered_not_ready', 'ci_red_defer')) {
        return @{ recorded = $false; reason = 'not_deferred_reeval_seed' }
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

    $mutation = $null
    if (-not $DryRun) {
        $mutation = Update-ReviewTriggerReevalWatchStateMerged -Path $path -IncomingWatchEntries $seed.watchEntries `
            -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        if (@($mutation.suppressedIncomingWatchKeys) -contains [string]$seed.watchKey) {
            return @{
                recorded       = $false
                reason         = 'terminal_tombstone_newer'
                watchKey       = [string]$seed.watchKey
                path           = $path
                corruptRemoved = [int]$mutation.corruptRemoved
            }
        }
    }

    return @{
        recorded       = $true
        watchKey       = [string]$seed.watchKey
        path           = $path
        corruptRemoved = if ($mutation) { [int]$mutation.corruptRemoved } else { 0 }
    }
}
