#requires -Version 5.1
<#
.SYNOPSIS
  Seed-specific bounded GitHub read economy when shared fleet snapshots degrade (Issue #609).
#>

. (Join-Path $PSScriptRoot 'Gh-FleetRepoTickSnapshot.ps1')

$Script:GhFleetSeedSnapshotRepairWindowSeconds = 3600
$Script:GhFleetSeedSnapshotHourlyReadBudget = 150
$Script:GhFleetSeedSnapshotOpenPrListStaleServeSeconds = 30

function Get-GhFleetSeedSnapshotRepairWindowSeconds {
    $raw = [Environment]::GetEnvironmentVariable('GH_FLEET_SEED_SNAPSHOT_REPAIR_WINDOW_SECONDS')
    $parsed = 0
    if ($raw -and [int]::TryParse([string]$raw, [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return $Script:GhFleetSeedSnapshotRepairWindowSeconds
}

function Get-GhFleetSeedSnapshotHourlyReadBudget {
    $raw = [Environment]::GetEnvironmentVariable('GH_FLEET_SEED_SNAPSHOT_HOURLY_READ_BUDGET')
    $parsed = 0
    if ($raw -and [int]::TryParse([string]$raw, [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return $Script:GhFleetSeedSnapshotHourlyReadBudget
}

function Get-GhFleetSeedSnapshotOpenPrListStaleServeSeconds {
    $raw = [Environment]::GetEnvironmentVariable('GH_FLEET_SEED_SNAPSHOT_OPEN_PR_LIST_STALE_SERVE_SECONDS')
    $parsed = 0
    if ($raw -and [int]::TryParse([string]$raw, [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return $Script:GhFleetSeedSnapshotOpenPrListStaleServeSeconds
}

function Get-GhFleetSeedSnapshotRepairPaths {
    param([string]$RepoRoot)

    $cacheRoot = Get-GhFleetInventoryCacheRoot
    if (-not $cacheRoot) { return $null }

    $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $repoKey = Get-GhFleetCacheKeyHash -Text $repoSlug
    $dir = Join-Path $cacheRoot "seed-snapshot-repair/$repoKey"
    return @{
        Dir       = $dir
        StatePath = Join-Path $dir 'repair-state.json'
        TempPath  = Join-Path $dir 'repair-state.tmp'
        LockPath  = Join-Path $dir 'repair-state.reserve.lock'
        RepoSlug  = $repoSlug
        RepoKey   = $repoKey
    }
}

function Read-GhFleetSeedSnapshotRepairState {
    param([string]$StatePath)

    if (-not $StatePath -or -not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
        return @{
            cooldownUntilMs   = 0
            hourlyWindowStart = 0
            hourlyReadCount   = 0
            lastOutcome       = ''
            lastAttemptMs     = 0
        }
    }

    try {
        $raw = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
        return @{
            cooldownUntilMs   = [long]($raw.cooldownUntilMs)
            hourlyWindowStart = [long]($raw.hourlyWindowStart)
            hourlyReadCount   = [int]($raw.hourlyReadCount)
            lastOutcome       = [string]($raw.lastOutcome)
            lastAttemptMs     = [long]($raw.lastAttemptMs)
        }
    }
    catch {
        return @{
            cooldownUntilMs   = 0
            hourlyWindowStart = 0
            hourlyReadCount   = 0
            lastOutcome       = ''
            lastAttemptMs     = 0
        }
    }
}

function Write-GhFleetSeedSnapshotRepairState {
    param(
        [hashtable]$Paths,
        [hashtable]$State
    )

    if (-not $Paths) { return }
    $dir = $Paths.Dir
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $payload = @{
        cooldownUntilMs   = [long]$State.cooldownUntilMs
        hourlyWindowStart = [long]$State.hourlyWindowStart
        hourlyReadCount   = [int]$State.hourlyReadCount
        lastOutcome       = [string]$State.lastOutcome
        lastAttemptMs     = [long]$State.lastAttemptMs
        storedAt          = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-GhFleetCacheEnvelopeAtomic -TargetPath $Paths.StatePath -TempPath $Paths.TempPath -Envelope $payload
}

function Resolve-GhFleetSeedSnapshotRateLimitCooldownMs {
    param([string]$Message)

    if (-not $Message) { return 0 }
    if ($Message -match 'x-ratelimit-reset[=:\s]+(\d+)') {
        $resetSec = [long]$Matches[1]
        if ($resetSec -gt 0) {
            return ($resetSec * 1000)
        }
    }
    if ($Message -match 'retry.after[=:\s]+(\d+)') {
        $retrySec = [long]$Matches[1]
        if ($retrySec -gt 0) {
            return ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ($retrySec * 1000))
        }
    }
    if ($Message -match 'rate limit|secondary rate|403') {
        return ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + (60 * 1000))
    }
    return 0
}

function Test-GhFleetSeedSnapshotRepairAllowed {
    param(
        [string]$RepoRoot,
        [long]$NowMs,
        [int]$RequestedReads = 1
    )

    $paths = Get-GhFleetSeedSnapshotRepairPaths -RepoRoot $RepoRoot
    if (-not $paths) {
        return @{ allowed = $true; reason = 'no_cache_root'; state = $null; paths = $null }
    }

    $state = Read-GhFleetSeedSnapshotRepairState -StatePath $paths.StatePath
    if ($state.cooldownUntilMs -gt $NowMs) {
        return @{ allowed = $false; reason = 'cooldown'; state = $state; paths = $paths }
    }

    $windowMs = (Get-GhFleetSeedSnapshotRepairWindowSeconds) * 1000
    $hourlyBudget = Get-GhFleetSeedSnapshotHourlyReadBudget
    $windowStart = [long]$state.hourlyWindowStart
    $readCount = [int]$state.hourlyReadCount
    if ($windowStart -le 0 -or ($NowMs - $windowStart) -ge $windowMs) {
        $windowStart = $NowMs
        $readCount = 0
    }
    if (($readCount + $RequestedReads) -gt $hourlyBudget) {
        return @{ allowed = $false; reason = 'hourly_budget'; state = $state; paths = $paths }
    }

    return @{
        allowed = $true
        reason  = 'ok'
        state   = @{
            cooldownUntilMs   = [long]$state.cooldownUntilMs
            hourlyWindowStart = $windowStart
            hourlyReadCount   = $readCount
            lastOutcome       = [string]$state.lastOutcome
            lastAttemptMs     = [long]$state.lastAttemptMs
        }
        paths = $paths
    }
}

function Reserve-GhFleetSeedSnapshotRepairRead {
    param(
        [string]$RepoRoot,
        [long]$NowMs,
        [int]$RequestedReads = 1
    )

    $paths = Get-GhFleetSeedSnapshotRepairPaths -RepoRoot $RepoRoot
    if (-not $paths) {
        return @{ allowed = $true; reason = 'no_cache_root'; reserved = $false; state = $null; paths = $null }
    }

    if (-not (Enter-GhFleetPopulateLock -LockPath $paths.LockPath)) {
        return @{ allowed = $false; reason = 'repair_lock_busy'; reserved = $false; state = $null; paths = $paths }
    }

    try {
        $state = Read-GhFleetSeedSnapshotRepairState -StatePath $paths.StatePath
        if ($state.cooldownUntilMs -gt $NowMs) {
            return @{ allowed = $false; reason = 'cooldown'; reserved = $false; state = $state; paths = $paths }
        }

        $windowMs = (Get-GhFleetSeedSnapshotRepairWindowSeconds) * 1000
        $hourlyBudget = Get-GhFleetSeedSnapshotHourlyReadBudget
        $windowStart = [long]$state.hourlyWindowStart
        $readCount = [int]$state.hourlyReadCount
        if ($windowStart -le 0 -or ($NowMs - $windowStart) -ge $windowMs) {
            $windowStart = $NowMs
            $readCount = 0
        }
        if (($readCount + $RequestedReads) -gt $hourlyBudget) {
            return @{ allowed = $false; reason = 'hourly_budget'; reserved = $false; state = $state; paths = $paths }
        }

        $readCount += [Math]::Max(1, $RequestedReads)
        $reservedState = @{
            cooldownUntilMs   = [long]$state.cooldownUntilMs
            hourlyWindowStart = $windowStart
            hourlyReadCount   = $readCount
            lastOutcome       = [string]$state.lastOutcome
            lastAttemptMs     = $NowMs
        }
        Write-GhFleetSeedSnapshotRepairState -Paths $paths -State $reservedState

        return @{
            allowed  = $true
            reason   = 'reserved'
            reserved = $true
            state    = $reservedState
            paths    = $paths
        }
    }
    finally {
        Exit-GhFleetPopulateLock -LockPath $paths.LockPath
    }
}

function Set-GhFleetSeedSnapshotRepairOutcome {
    param(
        [hashtable]$Paths,
        [long]$NowMs,
        [string]$Outcome,
        [string]$FailureMessage = ''
    )

    if (-not $Paths) { return }

    if (-not (Enter-GhFleetPopulateLock -LockPath $Paths.LockPath)) {
        return
    }

    try {
        $state = Read-GhFleetSeedSnapshotRepairState -StatePath $Paths.StatePath
        $cooldownUntilMs = [long]$state.cooldownUntilMs
        $rateCooldown = Resolve-GhFleetSeedSnapshotRateLimitCooldownMs -Message $FailureMessage
        if ($rateCooldown -gt $cooldownUntilMs) {
            $cooldownUntilMs = $rateCooldown
        }
        elseif ($Outcome -match 'populate_failed|rate_limited|transport') {
            $cooldownUntilMs = [Math]::Max($cooldownUntilMs, $NowMs + (60 * 1000))
        }

        Write-GhFleetSeedSnapshotRepairState -Paths $Paths -State @{
            cooldownUntilMs   = $cooldownUntilMs
            hourlyWindowStart = [long]$state.hourlyWindowStart
            hourlyReadCount   = [int]$state.hourlyReadCount
            lastOutcome       = $Outcome
            lastAttemptMs     = $NowMs
        }
    }
    finally {
        Exit-GhFleetPopulateLock -LockPath $Paths.LockPath
    }
}

function Record-GhFleetSeedSnapshotRepairAttempt {
    param(
        [hashtable]$Paths,
        [hashtable]$State,
        [long]$NowMs,
        [string]$Outcome,
        [int]$ReadCount = 1,
        [string]$FailureMessage = ''
    )

    if (-not $Paths) { return }
    Set-GhFleetSeedSnapshotRepairOutcome -Paths $Paths -NowMs $NowMs -Outcome $Outcome -FailureMessage $FailureMessage
}

function Read-GhFleetOpenPrListEnvelopeWithStaleServe {
    param(
        [string]$SnapshotPath,
        [int]$TtlSeconds,
        [int]$StaleServeSeconds
    )

    if (-not $SnapshotPath -or -not (Test-Path -LiteralPath $SnapshotPath -PathType Leaf)) {
        return $null
    }

    try {
        $envelope = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }

    if (-not $envelope.expiresAt -or -not $envelope.storedAt) {
        return $null
    }

    try {
        $expiresAt = [datetimeoffset]::Parse([string]$envelope.expiresAt).UtcDateTime
        $storedAt = [datetimeoffset]::Parse([string]$envelope.storedAt).UtcDateTime
    }
    catch {
        return $null
    }

    $now = (Get-Date).ToUniversalTime()
    if ($now -le $expiresAt) {
        if ($envelope.error) {
            return @{ kind = 'error'; message = [string]$envelope.error; stale = $false }
        }
        return @{ kind = 'data'; envelope = $envelope; stale = $false }
    }

    if ($StaleServeSeconds -le 0) {
        return $null
    }

    $staleUpper = $expiresAt.AddSeconds($StaleServeSeconds)
    if ($now -gt $staleUpper) {
        return $null
    }

    if ($envelope.error) {
        return @{ kind = 'error'; message = [string]$envelope.error; stale = $true }
    }
    return @{ kind = 'data'; envelope = $envelope; stale = $true }
}

function Get-ReviewReadyReportStateSeedFleetSnapshotClassification {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [string]$Consumer = ''
    )

    $auditBase = @{
        repo     = (Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot)
        consumer = $Consumer
        route    = 'seed_snapshot_state'
    }

    if (-not (Test-GhFleetRepoTickEnabled)) {
        Write-GhFleetCacheAuditLine -Event 'seed_snapshot_state' -Fields ($auditBase + @{ state = 'absent'; reason = 'repo_tick_disabled' })
        return @{ state = 'absent'; reason = 'repo_tick_disabled' }
    }

    $paths = Get-GhFleetRepoTickPaths -RepoRoot $RepoRoot
    if (-not $paths) {
        Write-GhFleetCacheAuditLine -Event 'seed_snapshot_state' -Fields ($auditBase + @{ state = 'absent'; reason = 'no_cache_root' })
        return @{ state = 'absent'; reason = 'no_cache_root' }
    }

    $interval = Get-GhFleetRepoTickIntervalSeconds
    $staleServe = Get-GhFleetRepoTickStaleServeSeconds
    $recordEntry = Read-GhFleetRepoTickGenerationRecord -GenerationPath $paths.GenerationPath

    if ($recordEntry -and $recordEntry.kind -eq 'error') {
        Write-GhFleetCacheAuditLine -Event 'seed_snapshot_state' -Fields ($auditBase + @{
            state   = 'populate-failing'
            reason  = 'generation_error'
            message = [string]$recordEntry.message
        })
        return @{ state = 'populate-failing'; reason = 'generation_error'; message = [string]$recordEntry.message }
    }

    $record = if ($recordEntry -and $recordEntry.record) { $recordEntry.record } else { $null }
    if ($record -and (Test-GhFleetRepoTickGenerationFresh -Record $record -IntervalSeconds $interval)) {
        Write-GhFleetCacheAuditLine -Event 'seed_snapshot_state' -Fields ($auditBase + @{ state = 'fresh'; generation = [string]$record.generation })
        return @{ state = 'fresh'; generation = [string]$record.generation }
    }

    if ($record -and (Test-GhFleetRepoTickGenerationStaleServable -Record $record -IntervalSeconds $interval -StaleServeSeconds $staleServe)) {
        Write-GhFleetCacheAuditLine -Event 'seed_snapshot_state' -Fields ($auditBase + @{
            state      = 'stale'
            generation = [string]$record.generation
            reason     = 'repo_tick_stale_servable'
        })
        return @{ state = 'stale'; generation = [string]$record.generation; reason = 'repo_tick_stale_servable' }
    }

    $cacheRoot = Get-GhFleetInventoryCacheRoot
    $queryId = Get-GhFleetOpenPrListQueryIdentity
    $cacheKey = Get-GhFleetCacheKeyHash -Text "$($paths.RepoSlug)|$queryId"
    $openListPaths = Get-GhFleetOpenPrListSnapshotPaths -CacheRoot $cacheRoot -CacheKey $cacheKey
    $openListTtl = Get-GhFleetInventoryCacheTtlSeconds -Name 'openPrList'
    $openListEntry = Read-GhFleetOpenPrListEnvelopeWithStaleServe `
        -SnapshotPath $openListPaths.SnapshotPath `
        -TtlSeconds $openListTtl `
        -StaleServeSeconds (Get-GhFleetSeedSnapshotOpenPrListStaleServeSeconds)

    if ($openListEntry -and $openListEntry.kind -eq 'error') {
        Write-GhFleetCacheAuditLine -Event 'seed_snapshot_state' -Fields ($auditBase + @{
            state   = 'populate-failing'
            reason  = 'open_pr_list_error'
            message = [string]$openListEntry.message
            stale   = [bool]$openListEntry.stale
        })
        return @{
            state   = 'populate-failing'
            reason  = 'open_pr_list_error'
            message = [string]$openListEntry.message
            stale   = [bool]$openListEntry.stale
        }
    }

    if ($openListEntry -and $openListEntry.kind -eq 'data') {
        $listState = if ($openListEntry.stale) { 'stale' } else { 'fresh' }
        Write-GhFleetCacheAuditLine -Event 'seed_snapshot_state' -Fields ($auditBase + @{ state = $listState; reason = 'open_pr_list_cache' })
        return @{ state = $listState; reason = 'open_pr_list_cache' }
    }

    Write-GhFleetCacheAuditLine -Event 'seed_snapshot_state' -Fields ($auditBase + @{ state = 'absent'; reason = 'no_generation_or_cache' })
    return @{ state = 'absent'; reason = 'no_generation_or_cache' }
}

function Select-GhOpenPrRowsForTrackedNumbers {
    param(
        [array]$OpenPrs,
        [int[]]$TrackedPrNumbers
    )

    $tracked = @($TrackedPrNumbers | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    if ($tracked.Count -eq 0) { return @() }
    $trackedSet = @{}
    foreach ($n in $tracked) { $trackedSet[[int]$n] = $true }
    return @($OpenPrs | Where-Object { $trackedSet[[int]$_.number] })
}


function Repair-ReviewReadyReportStateSeedOpenPrListSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$TrackedPrNumbers,
        [string]$Consumer = '',
        [scriptblock]$ProgressWriter = $null
    )

    if ($ProgressWriter) {
        & $ProgressWriter 'open_pr_list_repair' 1
    }
    $allOpen = @(Invoke-GhFleetCachedOpenPrListRaw -RepoRoot $RepoRoot -Consumer $Consumer -BoundedListOnly)
    $rows = @(Select-GhOpenPrRowsForTrackedNumbers -OpenPrs $allOpen -TrackedPrNumbers $TrackedPrNumbers)
    foreach ($pr in @($rows)) {
        Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
    }
    return $rows
}

function Invoke-GhOpenPrListForTrackedNumbersListShaped {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$TrackedPrNumbers,
        [string]$Consumer = '',
        [scriptblock]$ProgressWriter = $null
    )

    if ($ProgressWriter) {
        & $ProgressWriter 'open_pr_list' 1
    }
    $allOpen = @(Invoke-GhFleetCachedOpenPrListRaw -RepoRoot $RepoRoot -Consumer $Consumer -BoundedListOnly)
    $rows = @(Select-GhOpenPrRowsForTrackedNumbers -OpenPrs $allOpen -TrackedPrNumbers $TrackedPrNumbers)
    foreach ($pr in @($rows)) {
        Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
    }
    return $rows
}

function Resolve-ReviewReadyReportStateSeedOpenPrsFromStaleCache {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int[]]$TrackedPrNumbers
    )

    $cacheRoot = Get-GhFleetInventoryCacheRoot
    if (-not $cacheRoot) { return $null }

    $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $queryId = Get-GhFleetOpenPrListQueryIdentity
    $cacheKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|$queryId"
    $paths = Get-GhFleetOpenPrListSnapshotPaths -CacheRoot $cacheRoot -CacheKey $cacheKey
    $ttl = Get-GhFleetInventoryCacheTtlSeconds -Name 'openPrList'
    $entry = Read-GhFleetOpenPrListEnvelopeWithStaleServe `
        -SnapshotPath $paths.SnapshotPath `
        -TtlSeconds $ttl `
        -StaleServeSeconds (Get-GhFleetSeedSnapshotOpenPrListStaleServeSeconds)

    if (-not $entry -or $entry.kind -ne 'data') {
        return $null
    }

    $rows = @(Select-GhOpenPrRowsForTrackedNumbers -OpenPrs @($entry.envelope.prs) -TrackedPrNumbers $TrackedPrNumbers)
    foreach ($pr in @($rows)) {
        Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
    }
    return ,@($rows)
}

function Resolve-ReviewReadyReportStateSeedOpenPrs {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$TrackedPrNumbers,
        [string]$Consumer = 'review-ready-report-state-seed',
        [scriptblock]$ProgressWriter = $null,
        [long]$NowMs = 0
    )

    if ($NowMs -le 0) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    $tracked = @($TrackedPrNumbers | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    if ($tracked.Count -eq 0) {
        return @()
    }

    $null = Get-GhFleetRepoTickSnapshotIfConsumable -RepoRoot $RepoRoot -Consumer $Consumer -DataClass 'github_snapshot'
    $classification = Get-ReviewReadyReportStateSeedFleetSnapshotClassification -RepoRoot $RepoRoot -Consumer $Consumer
    $state = [string]$classification.state

    if ($state -eq 'fresh') {
        return @(Invoke-GhOpenPrListForTrackedNumbersListShaped `
            -RepoRoot $RepoRoot `
            -TrackedPrNumbers $tracked `
            -Consumer $Consumer `
            -ProgressWriter $ProgressWriter)
    }

    if ($state -eq 'stale') {
        $staleRows = Resolve-ReviewReadyReportStateSeedOpenPrsFromStaleCache -RepoRoot $RepoRoot -TrackedPrNumbers $tracked
        if ($null -ne $staleRows) {
            Write-GhFleetCacheAuditLine -Event 'seed_snapshot_degraded_serve' -Fields @{
                consumer = $Consumer
                state    = 'stale'
                mode     = 'stale_cache'
                count    = @($staleRows).Count
            }
            return @($staleRows)
        }

        $repairGate = Reserve-GhFleetSeedSnapshotRepairRead -RepoRoot $RepoRoot -NowMs $NowMs -RequestedReads 1
        if ($repairGate.allowed) {
            try {
                $repaired = @(Repair-ReviewReadyReportStateSeedOpenPrListSnapshot `
                    -RepoRoot $RepoRoot `
                    -TrackedPrNumbers $tracked `
                    -Consumer $Consumer `
                    -ProgressWriter $ProgressWriter)
                Set-GhFleetSeedSnapshotRepairOutcome -Paths $repairGate.paths -NowMs $NowMs -Outcome 'stale_repair_ok' -ReadCount 1
                return $repaired
            }
            catch {
                Set-GhFleetSeedSnapshotRepairOutcome -Paths $repairGate.paths -NowMs $NowMs -Outcome 'stale_repair_failed' -ReadCount 1 -FailureMessage $_.Exception.Message
            }
        }
        else {
            Write-GhFleetCacheAuditLine -Event 'seed_snapshot_degraded_serve' -Fields @{
                consumer = $Consumer
                state    = 'stale'
                mode     = 'repair_suppressed'
                reason   = [string]$repairGate.reason
            }
        }

        $staleFallbackRows = Resolve-ReviewReadyReportStateSeedOpenPrsFromStaleCache -RepoRoot $RepoRoot -TrackedPrNumbers $tracked
        if ($null -ne $staleFallbackRows) {
            return @($staleFallbackRows)
        }
        return @()
    }

    $repairGate = Reserve-GhFleetSeedSnapshotRepairRead -RepoRoot $RepoRoot -NowMs $NowMs -RequestedReads 1
    if ($repairGate.allowed) {
        try {
            $repaired = @(Repair-ReviewReadyReportStateSeedOpenPrListSnapshot `
                -RepoRoot $RepoRoot `
                -TrackedPrNumbers $tracked `
                -Consumer $Consumer `
                -ProgressWriter $ProgressWriter)
            Set-GhFleetSeedSnapshotRepairOutcome -Paths $repairGate.paths -NowMs $NowMs -Outcome "${state}_repair_ok" -ReadCount 1
            return $repaired
        }
        catch {
            Set-GhFleetSeedSnapshotRepairOutcome -Paths $repairGate.paths -NowMs $NowMs -Outcome "${state}_repair_failed" -ReadCount 1 -FailureMessage $_.Exception.Message
            Write-GhFleetCacheAuditLine -Event 'seed_snapshot_degraded_serve' -Fields @{
                consumer = $Consumer
                state    = $state
                mode     = 'repair_failed'
                message  = [string]$_.Exception.Message
            }
        }
    }
    else {
        Write-GhFleetCacheAuditLine -Event 'seed_snapshot_degraded_serve' -Fields @{
            consumer = $Consumer
            state    = $state
            mode     = 'repair_suppressed'
            reason   = [string]$repairGate.reason
        }
    }

    $fallbackRows = Resolve-ReviewReadyReportStateSeedOpenPrsFromStaleCache -RepoRoot $RepoRoot -TrackedPrNumbers $tracked
    if ($null -ne $fallbackRows) {
        return @($fallbackRows)
    }
    return @()
}

function Get-GhFleetSeedSnapshotReadEconomyContract {
    return [ordered]@{
        repairWindowSeconds          = Get-GhFleetSeedSnapshotRepairWindowSeconds
        hourlyReadBudget             = Get-GhFleetSeedSnapshotHourlyReadBudget
        openPrListStaleServeSeconds  = Get-GhFleetSeedSnapshotOpenPrListStaleServeSeconds
    }
}
