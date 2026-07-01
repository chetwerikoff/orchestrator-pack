#requires -Version 5.1
<#
.SYNOPSIS
  Cross-process read-through cache for wake-supervisor fleet GitHub inventory (Issue #453).
#>

. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'Get-SupervisedRepoSlug.ps1')

$Script:GhFleetOpenPrListTtlSeconds = 15
$Script:GhFleetPrViewTtlSeconds = 15
$Script:GhFleetCiChecksTtlSeconds = 15
$Script:GhFleetBranchProtectionTtlSeconds = 300
$Script:GhFleetNegativeLookupTtlSeconds = 30
$Script:GhFleetReviewFreshnessTtlSeconds = 30
$Script:GhFleetCommitMemoTtlSeconds = 2592000
$Script:GhFleetCommitNegativeTtlSeconds = 60
$Script:GhFleetPopulateWaitSeconds = 30
$Script:GhFleetPopulatePollMilliseconds = 50
$Script:GhFleetPopulateLockMaxAgeSeconds = 120
$Script:GhFleetRepoSlugByRoot = @{}

function Format-GhFleetOpenPrListFailure {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('snapshot_populate_failed', 'child_list_bypass')]
        [string]$Kind,
        [Parameter(Mandatory = $true)]
        [string]$InnerMessage
    )

    return "${Kind}: $InnerMessage"
}

function Write-GhFleetInventoryCacheAudit {
    param(
        [string]$Event,
        [hashtable]$Fields = @{}
    )

    if (-not $env:GH_FLEET_CACHE_AUDIT) { return }
    $root = Get-GhFleetInventoryCacheRoot
    if (-not $root) { return }

    $auditPath = Join-Path $root 'audit.jsonl'
    $dir = Split-Path -Parent $auditPath
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $payload = @{
        at    = (Get-Date).ToString('o')
        event = $Event
    }
    foreach ($key in $Fields.Keys) {
        $payload[$key] = $Fields[$key]
    }
    Add-Content -LiteralPath $auditPath -Value ($payload | ConvertTo-Json -Compress)
}

function Get-GhFleetInventoryCacheRoot {
    if ($env:AO_SIDE_PROCESS_STATE_DIR) {
        return Join-Path $env:AO_SIDE_PROCESS_STATE_DIR.Trim() 'github-fleet-cache'
    }
    return ''
}

function Get-GhFleetInventoryCacheTtlSeconds {
    param([string]$Name)

    $envName = switch ($Name) {
        'openPrList' { 'GH_FLEET_OPEN_PR_LIST_TTL_SECONDS' }
        'prView' { 'GH_FLEET_PR_VIEW_TTL_SECONDS' }
        'ciChecks' { 'GH_FLEET_CI_CHECKS_TTL_SECONDS' }
        'branchProtection' { 'GH_FLEET_BRANCH_PROTECTION_TTL_SECONDS' }
        'negativeLookup' { 'GH_FLEET_NEGATIVE_LOOKUP_TTL_SECONDS' }
        'reviewFreshness' { 'GH_FLEET_REVIEW_FRESHNESS_TTL_SECONDS' }
        'commitMemo' { 'GH_FLEET_COMMIT_MEMO_TTL_SECONDS' }
        'commitNegative' { 'GH_FLEET_COMMIT_NEGATIVE_TTL_SECONDS' }
        default { $null }
    }
    if ($envName) {
        $raw = [Environment]::GetEnvironmentVariable($envName)
        $parsed = 0
        if ($raw -and [int]::TryParse([string]$raw, [ref]$parsed) -and $parsed -gt 0) {
            return $parsed
        }
    }

    switch ($Name) {
        'openPrList' { return $Script:GhFleetOpenPrListTtlSeconds }
        'prView' { return $Script:GhFleetPrViewTtlSeconds }
        'ciChecks' { return $Script:GhFleetCiChecksTtlSeconds }
        'branchProtection' { return $Script:GhFleetBranchProtectionTtlSeconds }
        'negativeLookup' { return $Script:GhFleetNegativeLookupTtlSeconds }
        'reviewFreshness' { return $Script:GhFleetReviewFreshnessTtlSeconds }
        'commitMemo' { return $Script:GhFleetCommitMemoTtlSeconds }
        'commitNegative' { return $Script:GhFleetCommitNegativeTtlSeconds }
        default { return 0 }
    }
}

function Get-GhFleetCacheKeyHash {
    param([string]$Text)

    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Text)
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant().Substring(0, 16)
}

function Get-GhFleetRepoSlugCachePaths {
    param([string]$RepoRoot)

    $cacheRoot = Get-GhFleetInventoryCacheRoot
    if (-not $cacheRoot) {
        return $null
    }

    $normalizedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
    $rootKey = Get-GhFleetCacheKeyHash -Text $normalizedRoot
    $dir = Join-Path $cacheRoot 'repo-slug'
    return @{
        Dir          = $dir
        SlugPath     = Join-Path $dir "$rootKey.json"
        TempPath     = Join-Path $dir "$rootKey.tmp"
        NormalizedRoot = $normalizedRoot
    }
}

function Read-GhFleetRepoSlugCache {
    param([string]$RepoRoot)

    $paths = Get-GhFleetRepoSlugCachePaths -RepoRoot $RepoRoot
    if (-not $paths -or -not (Test-Path -LiteralPath $paths.SlugPath -PathType Leaf)) {
        return $null
    }

    try {
        $record = Get-Content -LiteralPath $paths.SlugPath -Raw | ConvertFrom-Json
        if ($record.slug) {
            return [string]$record.slug
        }
    }
    catch {
        return $null
    }

    return $null
}

function Write-GhFleetRepoSlugCache {
    param(
        [string]$RepoRoot,
        [string]$Slug
    )

    $paths = Get-GhFleetRepoSlugCachePaths -RepoRoot $RepoRoot
    if (-not $paths) {
        return
    }

    if (Test-Path -LiteralPath $paths.SlugPath -PathType Leaf) {
        return
    }

    $dir = $paths.Dir
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $envelope = @{
        repoRoot = $paths.NormalizedRoot
        slug     = [string]$Slug
        storedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $json = $envelope | ConvertTo-Json -Depth 30 -Compress

    try {
        $stream = [System.IO.FileStream]::new(
            $paths.SlugPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $writer = New-Object System.IO.StreamWriter($stream, [System.Text.UTF8Encoding]::new($false))
            $writer.Write($json)
            $writer.Flush()
        }
        finally {
            $stream.Dispose()
        }
    }
    catch [System.IO.IOException] {
        return
    }
}

function Resolve-GhFleetRepoSlug {
    param([string]$RepoRoot)

    if ($Script:GhFleetRepoSlugByRoot.ContainsKey($RepoRoot)) {
        return $Script:GhFleetRepoSlugByRoot[$RepoRoot]
    }

    $cached = Read-GhFleetRepoSlugCache -RepoRoot $RepoRoot
    if ($cached) {
        $Script:GhFleetRepoSlugByRoot[$RepoRoot] = $cached
        return $cached
    }

    $slug = Get-SupervisedRepoSlug -RepoRoot $RepoRoot
    if (-not $slug) {
        $slug = (Resolve-Path -LiteralPath $RepoRoot).Path
    }
    $slug = [string]$slug
    Write-GhFleetRepoSlugCache -RepoRoot $RepoRoot -Slug $slug
    $cachedAfterWrite = Read-GhFleetRepoSlugCache -RepoRoot $RepoRoot
    if ($cachedAfterWrite) {
        $slug = $cachedAfterWrite
    }
    $Script:GhFleetRepoSlugByRoot[$RepoRoot] = $slug
    return $slug
}

function Get-GhFleetOpenPrListQueryIdentity {
    return 'open:state=open:json=number,headRefOid,baseRefName:limit=200'
}

function Get-GhFleetOpenPrListSnapshotPaths {
    param(
        [string]$CacheRoot,
        [string]$CacheKey
    )

    $dir = Join-Path $CacheRoot 'open-pr-list'
    return @{
        Dir          = $dir
        SnapshotPath = Join-Path $dir "$CacheKey.json"
        LockPath     = Join-Path $dir "$CacheKey.populate.lock"
        TempPath     = Join-Path $dir "$CacheKey.tmp"
    }
}

function Get-GhFleetCommitMemoPaths {
    param(
        [string]$CacheRoot,
        [string]$RepoKey,
        [string]$HeadSha
    )

    $dir = Join-Path (Join-Path $CacheRoot 'commit-memo') $RepoKey
    return @{
        Dir          = $dir
        MemoPath     = Join-Path $dir "$HeadSha.json"
        LockPath     = Join-Path $dir "$HeadSha.lookup.lock"
        TempPath     = Join-Path $dir "$HeadSha.tmp"
    }
}

function Read-GhFleetCacheEnvelope {
    param(
        [string]$Path,
        [int]$TtlSeconds
    )

    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    try {
        $envelope = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }

    if (-not $envelope.expiresAt) {
        return $null
    }

    try {
        $expiresAt = [datetimeoffset]::Parse([string]$envelope.expiresAt).UtcDateTime
    }
    catch {
        return $null
    }

    if ((Get-Date).ToUniversalTime() -gt $expiresAt) {
        return $null
    }

    if ($envelope.error) {
        return @{ kind = 'error'; message = [string]$envelope.error }
    }

    return @{ kind = 'data'; envelope = $envelope; ttlSeconds = $TtlSeconds }
}

function Write-GhFleetCacheEnvelopeAtomic {
    param(
        [string]$TargetPath,
        [string]$TempPath,
        [hashtable]$Envelope
    )

    $dir = Split-Path -Parent $TargetPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $json = $Envelope | ConvertTo-Json -Depth 30 -Compress
    [System.IO.File]::WriteAllText($TempPath, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $TempPath -Destination $TargetPath -Force
}

function Clear-GhFleetStalePopulateLockIfNeeded {
    param([string]$LockPath)

    return Clear-OrchestratorStaleSideEffectLockIfNeeded `
        -LockPath $LockPath `
        -MaxAgeSeconds $Script:GhFleetPopulateLockMaxAgeSeconds
}

function Enter-GhFleetPopulateLock {
    param([string]$LockPath)

    Clear-GhFleetStalePopulateLockIfNeeded -LockPath $LockPath | Out-Null
    return Enter-OrchestratorSideEffectFence -LockPath $LockPath
}

function Exit-GhFleetPopulateLock {
    param([string]$LockPath)

    Exit-OrchestratorSideEffectFence -LockPath $LockPath
}

function Wait-GhFleetSnapshotEnvelope {
    param(
        [string]$SnapshotPath,
        [string]$LockPath,
        [int]$TtlSeconds
    )

    $deadline = (Get-Date).AddSeconds($Script:GhFleetPopulateWaitSeconds)
    while ((Get-Date) -lt $deadline) {
        $entry = Read-GhFleetCacheEnvelope -Path $SnapshotPath -TtlSeconds $TtlSeconds
        if ($entry) {
            return $entry
        }

        if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
            return $null
        }

        Clear-GhFleetStalePopulateLockIfNeeded -LockPath $LockPath | Out-Null
        Start-Sleep -Milliseconds $Script:GhFleetPopulatePollMilliseconds
    }

    return $null
}

function Invoke-GhFleetCachedOpenPrListRaw {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $cacheRoot = Get-GhFleetInventoryCacheRoot
    if (-not $cacheRoot) {
        Push-Location -LiteralPath $RepoRoot
        try {
            return Invoke-GhFleetFetchOpenPrListUpstream
        }
        finally {
            Pop-Location
        }
    }

    $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $queryId = Get-GhFleetOpenPrListQueryIdentity
    $cacheKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|$queryId"
    $paths = Get-GhFleetOpenPrListSnapshotPaths -CacheRoot $cacheRoot -CacheKey $cacheKey
    $ttl = Get-GhFleetInventoryCacheTtlSeconds -Name 'openPrList'

    $warm = Read-GhFleetCacheEnvelope -Path $paths.SnapshotPath -TtlSeconds $ttl
    if ($warm) {
        if ($warm.kind -eq 'error') {
            throw [string]$warm.message
        }
        Write-GhFleetInventoryCacheAudit -Event 'open_pr_list_hit' -Fields @{ key = $cacheKey }
        return @($warm.envelope.prs)
    }

    for ($populatePass = 0; $populatePass -lt 2; $populatePass++) {
        $acquired = Enter-GhFleetPopulateLock -LockPath $paths.LockPath
        if ($acquired) {
            try {
                $warmAfterLock = Read-GhFleetCacheEnvelope -Path $paths.SnapshotPath -TtlSeconds $ttl
                if ($warmAfterLock) {
                    if ($warmAfterLock.kind -eq 'error') {
                        throw [string]$warmAfterLock.message
                    }
                    Write-GhFleetInventoryCacheAudit -Event 'open_pr_list_hit' -Fields @{ key = $cacheKey; afterLock = $true }
                    return @($warmAfterLock.envelope.prs)
                }

                Push-Location -LiteralPath $RepoRoot
                try {
                    $prs = Invoke-GhFleetFetchOpenPrListUpstream -FailureKind 'snapshot_populate_failed'
                }
                catch {
                    $failureMessage = Format-GhFleetOpenPrListFailure -Kind 'snapshot_populate_failed' -InnerMessage $_.Exception.Message
                    $expiresAt = (Get-Date).ToUniversalTime().AddSeconds($ttl).ToString('o')
                    Write-GhFleetCacheEnvelopeAtomic -TargetPath $paths.SnapshotPath -TempPath $paths.TempPath -Envelope @{
                        storedAt  = (Get-Date).ToUniversalTime().ToString('o')
                        expiresAt = $expiresAt
                        error     = $failureMessage
                    }
                    Write-GhFleetInventoryCacheAudit -Event 'snapshot_populate_failed' -Fields @{ key = $cacheKey; message = $failureMessage }
                    throw $failureMessage
                }
                finally {
                    Pop-Location
                }

                $expiresAt = (Get-Date).ToUniversalTime().AddSeconds($ttl).ToString('o')
                Write-GhFleetCacheEnvelopeAtomic -TargetPath $paths.SnapshotPath -TempPath $paths.TempPath -Envelope @{
                    storedAt  = (Get-Date).ToUniversalTime().ToString('o')
                    expiresAt = $expiresAt
                    prs       = @($prs)
                }
                Write-GhFleetInventoryCacheAudit -Event 'open_pr_list_populate' -Fields @{ key = $cacheKey; count = @($prs).Count }
                return @($prs)
            }
            finally {
                Exit-GhFleetPopulateLock -LockPath $paths.LockPath
            }
        }

        $waited = Wait-GhFleetSnapshotEnvelope -SnapshotPath $paths.SnapshotPath -LockPath $paths.LockPath -TtlSeconds $ttl
        if ($waited) {
            if ($waited.kind -eq 'error') {
                throw [string]$waited.message
            }
            Write-GhFleetInventoryCacheAudit -Event 'open_pr_list_wait_hit' -Fields @{ key = $cacheKey }
            return @($waited.envelope.prs)
        }

        if (Test-Path -LiteralPath $paths.LockPath -PathType Leaf) {
            break
        }
    }

    Write-GhFleetInventoryCacheAudit -Event 'child_list_bypass' -Fields @{ key = $cacheKey }
    throw (Format-GhFleetOpenPrListFailure -Kind 'child_list_bypass' -InnerMessage "open-PR list must read shared snapshot (key=$cacheKey)")
}

function Invoke-GhFleetFetchOpenPrListUpstream {
    param(
        [ValidateSet('snapshot_populate_failed', 'gh_pr_list_failed')]
        [string]$FailureKind = 'gh_pr_list_failed'
    )

    $raw = gh pr list --state open --json number,headRefOid,baseRefName --limit 200 2>&1
    if ($LASTEXITCODE -ne 0) {
        $detail = "gh pr list failed (exit $LASTEXITCODE): $raw"
        if ($FailureKind -eq 'snapshot_populate_failed') {
            throw (Format-GhFleetOpenPrListFailure -Kind 'snapshot_populate_failed' -InnerMessage $detail)
        }
        throw $detail
    }

    if (-not $raw) {
        return @()
    }

    return @($raw | ConvertFrom-Json)
}

function Invoke-GhFleetResolveCommitDate {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [string]$HeadSha
    )

    if (-not $HeadSha) { return $null }

    $cacheRoot = Get-GhFleetInventoryCacheRoot
    if (-not $cacheRoot) {
        return Invoke-GhFleetFetchCommitDateUpstream -RepoRoot $RepoRoot -HeadSha $HeadSha
    }

    $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $repoKey = Get-GhFleetCacheKeyHash -Text $repoSlug
    $paths = Get-GhFleetCommitMemoPaths -CacheRoot $cacheRoot -RepoKey $repoKey -HeadSha $HeadSha
    $memoTtl = Get-GhFleetInventoryCacheTtlSeconds -Name 'commitMemo'
    $negativeTtl = Get-GhFleetInventoryCacheTtlSeconds -Name 'commitNegative'

    $warm = Read-GhFleetCacheEnvelope -Path $paths.MemoPath -TtlSeconds $memoTtl
    if (-not $warm) {
        $warm = Read-GhFleetCacheEnvelope -Path $paths.MemoPath -TtlSeconds $negativeTtl
    }
    if ($warm) {
        if ($warm.kind -eq 'error') {
            return $null
        }
        if ($warm.envelope.negative) {
            return $null
        }
        Write-GhFleetInventoryCacheAudit -Event 'commit_memo_hit' -Fields @{ sha = $HeadSha }
        return [string]$warm.envelope.committedDate
    }

    for ($populatePass = 0; $populatePass -lt 2; $populatePass++) {
        $acquired = Enter-GhFleetPopulateLock -LockPath $paths.LockPath
        if ($acquired) {
            try {
                $warmAfterLock = Read-GhFleetCacheEnvelope -Path $paths.MemoPath -TtlSeconds $memoTtl
                if (-not $warmAfterLock) {
                    $warmAfterLock = Read-GhFleetCacheEnvelope -Path $paths.MemoPath -TtlSeconds $negativeTtl
                }
                if ($warmAfterLock) {
                    if ($warmAfterLock.kind -eq 'error' -or $warmAfterLock.envelope.negative) {
                        return $null
                    }
                    return [string]$warmAfterLock.envelope.committedDate
                }

                $committedDate = Invoke-GhFleetFetchCommitDateUpstream -RepoRoot $RepoRoot -HeadSha $HeadSha
                if ($committedDate) {
                    $expiresAt = (Get-Date).ToUniversalTime().AddSeconds($memoTtl).ToString('o')
                    Write-GhFleetCacheEnvelopeAtomic -TargetPath $paths.MemoPath -TempPath $paths.TempPath -Envelope @{
                        storedAt       = (Get-Date).ToUniversalTime().ToString('o')
                        expiresAt      = $expiresAt
                        committedDate  = $committedDate
                        negative       = $false
                    }
                    Write-GhFleetInventoryCacheAudit -Event 'commit_memo_populate' -Fields @{ sha = $HeadSha }
                    return $committedDate
                }

                $expiresAt = (Get-Date).ToUniversalTime().AddSeconds($negativeTtl).ToString('o')
                Write-GhFleetCacheEnvelopeAtomic -TargetPath $paths.MemoPath -TempPath $paths.TempPath -Envelope @{
                    storedAt  = (Get-Date).ToUniversalTime().ToString('o')
                    expiresAt = $expiresAt
                    negative  = $true
                }
                return $null
            }
            finally {
                Exit-GhFleetPopulateLock -LockPath $paths.LockPath
            }
        }

        $waited = Wait-GhFleetSnapshotEnvelope -SnapshotPath $paths.MemoPath -LockPath $paths.LockPath -TtlSeconds $memoTtl
        if (-not $waited) {
            $waited = Wait-GhFleetSnapshotEnvelope -SnapshotPath $paths.MemoPath -LockPath $paths.LockPath -TtlSeconds $negativeTtl
        }
        if ($waited) {
            if ($waited.kind -eq 'error' -or $waited.envelope.negative) {
                return $null
            }
            Write-GhFleetInventoryCacheAudit -Event 'commit_memo_wait_hit' -Fields @{ sha = $HeadSha }
            return [string]$waited.envelope.committedDate
        }

        if (Test-Path -LiteralPath $paths.LockPath -PathType Leaf) {
            break
        }
    }

    return Invoke-GhFleetFetchCommitDateUpstream -RepoRoot $RepoRoot -HeadSha $HeadSha
}

function Invoke-GhFleetFetchCommitDateUpstream {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [string]$HeadSha
    )

    Push-Location -LiteralPath $RepoRoot
    try {
        $committedDate = gh api "repos/{owner}/{repo}/commits/$HeadSha" --jq '.commit.committer.date' 2>$null
        if ($LASTEXITCODE -eq 0 -and $committedDate) {
            return ([string]$committedDate).Trim()
        }
        return $null
    }
    finally {
        Pop-Location
    }
}

function Add-GhPrHeadCommittedAtFromFleetMemo {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [object]$Pr
    )

    $headSha = [string]$pr.headRefOid
    if (-not $headSha) { return }

    $committedDate = Invoke-GhFleetResolveCommitDate -RepoRoot $RepoRoot -HeadSha $headSha
    if ($committedDate) {
        $pr | Add-Member -NotePropertyName headCommittedAt -NotePropertyValue $committedDate -Force
    }
}

function Format-GhFleetCacheFailure {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Kind,
        [Parameter(Mandatory = $true)]
        [string]$InnerMessage
    )

    return "${Kind}: $InnerMessage"
}

function Get-GhFleetDatumSnapshotPaths {
    param(
        [string]$CacheRoot,
        [string]$Category,
        [string]$CacheKey
    )

    $dir = Join-Path $CacheRoot $Category
    return @{
        Dir          = $dir
        SnapshotPath = Join-Path $dir "$CacheKey.json"
        LockPath     = Join-Path $dir "$CacheKey.populate.lock"
        TempPath     = Join-Path $dir "$CacheKey.tmp"
    }
}

function Write-GhFleetCacheAuditLine {
    param(
        [string]$Event,
        [hashtable]$Fields = @{}
    )

    Write-GhFleetInventoryCacheAudit -Event $Event -Fields $Fields
    if (-not $env:GH_FLEET_TEST_AUDIT_FILE) { return }
    $parts = @("fleet-cache-audit event=$Event")
    foreach ($key in ($Fields.Keys | Sort-Object)) {
        $parts += "$key=$($Fields[$key])"
    }
    Add-Content -LiteralPath $env:GH_FLEET_TEST_AUDIT_FILE -Value ($parts -join ' ')
}

function Invoke-GhFleetCachedDatum {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [string]$Category,
        [Parameter(Mandatory = $true)]
        [string]$CacheKey,
        [Parameter(Mandatory = $true)]
        [string]$TtlName,
        [Parameter(Mandatory = $true)]
        [string]$BypassKind,
        [Parameter(Mandatory = $true)]
        [hashtable]$AuditEvents,
        [Parameter(Mandatory = $true)]
        [scriptblock]$PopulateUpstream,
        [Parameter(Mandatory = $true)]
        [scriptblock]$BuildSuccessEnvelope,
        [Parameter(Mandatory = $true)]
        [scriptblock]$ExtractFromEnvelope,
        [string]$Consumer = '',
        [switch]$AllowNegativeEnvelope
    )

    $cacheRoot = Get-GhFleetInventoryCacheRoot
    if (-not $cacheRoot) {
        Push-Location -LiteralPath $RepoRoot
        try {
            return & $PopulateUpstream
        }
        finally {
            Pop-Location
        }
    }

    $paths = Get-GhFleetDatumSnapshotPaths -CacheRoot $cacheRoot -Category $Category -CacheKey $CacheKey
    $ttl = Get-GhFleetInventoryCacheTtlSeconds -Name $TtlName
    $auditBase = @{ key = $CacheKey; ttlSeconds = $ttl; consumer = $Consumer }

    $readEnvelope = {
        param($Path, $Ttl)
        $entry = Read-GhFleetCacheEnvelope -Path $Path -TtlSeconds $Ttl
        if (-not $entry) { return $null }
        if ($entry.kind -eq 'error') {
            throw [string]$entry.message
        }
        if ($AllowNegativeEnvelope -and $entry.envelope.negative) {
            return @{ kind = 'negative'; envelope = $entry.envelope }
        }
        return @{ kind = 'data'; envelope = $entry.envelope }
    }

    $warm = & $readEnvelope $paths.SnapshotPath $ttl
    if ($warm) {
        $saved = if ($warm.kind -eq 'negative') { 1 } else { 1 }
        Write-GhFleetCacheAuditLine -Event $AuditEvents.hit -Fields ($auditBase + @{ savedDuplicateCalls = $saved })
        return & $ExtractFromEnvelope $warm.envelope
    }

    for ($populatePass = 0; $populatePass -lt 2; $populatePass++) {
        $acquired = Enter-GhFleetPopulateLock -LockPath $paths.LockPath
        if ($acquired) {
            try {
                $warmAfterLock = & $readEnvelope $paths.SnapshotPath $ttl
                if ($warmAfterLock) {
                    Write-GhFleetCacheAuditLine -Event $AuditEvents.hit -Fields ($auditBase + @{ afterLock = $true; savedDuplicateCalls = 1 })
                    return & $ExtractFromEnvelope $warmAfterLock.envelope
                }

                Push-Location -LiteralPath $RepoRoot
                try {
                    $data = & $PopulateUpstream
                }
                catch {
                    $failureMessage = Format-GhFleetCacheFailure -Kind 'snapshot_populate_failed' -InnerMessage $_.Exception.Message
                    $expiresAt = (Get-Date).ToUniversalTime().AddSeconds($ttl).ToString('o')
                    Write-GhFleetCacheEnvelopeAtomic -TargetPath $paths.SnapshotPath -TempPath $paths.TempPath -Envelope @{
                        storedAt  = (Get-Date).ToUniversalTime().ToString('o')
                        expiresAt = $expiresAt
                        error     = $failureMessage
                    }
                    Write-GhFleetCacheAuditLine -Event $AuditEvents.populateFailed -Fields ($auditBase + @{ message = $failureMessage })
                    throw $failureMessage
                }
                finally {
                    Pop-Location
                }

                $expiresAt = (Get-Date).ToUniversalTime().AddSeconds($ttl).ToString('o')
                $envelope = & $BuildSuccessEnvelope $data
                $envelope.storedAt = (Get-Date).ToUniversalTime().ToString('o')
                $envelope.expiresAt = $expiresAt
                Write-GhFleetCacheEnvelopeAtomic -TargetPath $paths.SnapshotPath -TempPath $paths.TempPath -Envelope $envelope
                Write-GhFleetCacheAuditLine -Event $AuditEvents.populate -Fields ($auditBase + @{ generation = $envelope.storedAt })
                return $data
            }
            finally {
                Exit-GhFleetPopulateLock -LockPath $paths.LockPath
            }
        }

        $waitedEntry = Wait-GhFleetSnapshotEnvelope -SnapshotPath $paths.SnapshotPath -LockPath $paths.LockPath -TtlSeconds $ttl
        if ($waitedEntry) {
            if ($waitedEntry.kind -eq 'error') {
                throw [string]$waitedEntry.message
            }
            if ($AllowNegativeEnvelope -and $waitedEntry.envelope.negative) {
                Write-GhFleetCacheAuditLine -Event $AuditEvents.waitHit -Fields ($auditBase + @{ savedDuplicateCalls = 1 })
                return & $ExtractFromEnvelope $waitedEntry.envelope
            }
            Write-GhFleetCacheAuditLine -Event $AuditEvents.waitHit -Fields ($auditBase + @{ savedDuplicateCalls = 1 })
            return & $ExtractFromEnvelope $waitedEntry.envelope
        }

        if (Test-Path -LiteralPath $paths.LockPath -PathType Leaf) {
            break
        }
    }

    Write-GhFleetCacheAuditLine -Event $AuditEvents.bypass -Fields $auditBase
    throw (Format-GhFleetCacheFailure -Kind $BypassKind -InnerMessage "shared snapshot bypass (key=$CacheKey)")
}

function Invoke-GhFleetFetchPrViewUpstream {
    param(
        [int]$PrNumber
    )

    $raw = gh pr view $PrNumber --json number,headRefOid,baseRefName,state,isDraft,mergeable,headRefName 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "gh pr view failed (exit $LASTEXITCODE): $raw"
    }
    if (-not $raw) {
        return $null
    }
    return ($raw | ConvertFrom-Json)
}

function Invoke-GhFleetFetchChecksUpstream {
    param([int]$PrNumber)

    $raw = gh pr checks $PrNumber --json name,state,bucket,link,startedAt,completedAt,workflow,description 2>&1
    $exitCode = $LASTEXITCODE
    if (-not $raw) {
        if ($exitCode -ne 0) {
            throw "gh pr checks failed (exit $exitCode): no parseable JSON output"
        }
        return @()
    }
    $start = ([string]$raw).IndexOf('[')
    if ($start -lt 0) {
        if ($exitCode -ne 0) {
            throw "gh pr checks failed (exit $exitCode): $raw"
        }
        return @()
    }
    return @(([string]$raw).Substring($start) | ConvertFrom-Json)
}

function Invoke-GhFleetFetchBranchProtectionUpstream {
    param(
        [string]$RepoSlug,
        [string]$BaseBranch
    )

    $encodedBaseRef = [uri]::EscapeDataString([string]$BaseBranch)
    $protectionRaw = gh api "repos/$RepoSlug/branches/$encodedBaseRef/protection" 2>&1
    $protectionExit = $LASTEXITCODE
    if ($protectionExit -ne 0) {
        $protectionText = ($protectionRaw | ForEach-Object { $_.ToString() }) -join "`n"
        if ($protectionText -match 'Branch not protected|404') {
            return @{ lookupFailed = $false; unprotected = $true; protection = $null }
        }
        throw "branch protection lookup failed (exit $protectionExit): $protectionText"
    }
    return @{ lookupFailed = $false; unprotected = $false; protection = ($protectionRaw | ConvertFrom-Json) }
}

function Invoke-GhFleetFetchPrListByHeadUpstream {
    param([string]$HeadBranch)

    $raw = gh pr list --head $HeadBranch --json number,url --limit 1 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "gh pr list --head failed (exit $LASTEXITCODE): $raw"
    }
    if (-not $raw) {
        return $null
    }
    $rows = @($raw | ConvertFrom-Json)
    if ($rows.Count -eq 0) {
        return $null
    }
    $n = [int]$rows[0].number
    if ($n -le 0) { return $null }
    return $n
}

function Invoke-GhFleetFetchReviewFreshnessUpstream {
    param(
        [string]$RepoSlug,
        [int]$PrNumber
    )

    $raw = gh api "repos/$RepoSlug/pulls/$PrNumber/reviews" --jq 'length' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "review freshness lookup failed (exit $LASTEXITCODE): $raw"
    }
    $etag = [string](Get-Date).ToUniversalTime().Ticks
    return @{ etag = $etag; reviewCount = [int]$raw; fresh = $true }
}

function Invoke-GhFleetCachedPrView {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber,
        [string]$Consumer = ''
    )

    if ($PrNumber -le 0) { return $null }

    $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $cacheKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|pr|$PrNumber"
    return Invoke-GhFleetCachedDatum `
        -RepoRoot $RepoRoot `
        -Category 'pr-view' `
        -CacheKey $cacheKey `
        -TtlName 'prView' `
        -BypassKind 'child_view_bypass' `
        -Consumer $Consumer `
        -AuditEvents @{
            populate       = 'pr_view_populate'
            hit            = 'pr_view_hit'
            waitHit        = 'pr_view_wait_hit'
            bypass         = 'child_view_bypass'
            populateFailed = 'snapshot_populate_failed'
        } `
        -PopulateUpstream { Invoke-GhFleetFetchPrViewUpstream -PrNumber $PrNumber } `
        -BuildSuccessEnvelope {
            param($Data)
            return @{ pr = $Data; negative = $false }
        } `
        -ExtractFromEnvelope {
            param($Envelope)
            return $Envelope.pr
        }
}

function Invoke-GhFleetCachedChecksByHeadSha {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber,
        [Parameter(Mandatory = $true)]
        [string]$HeadSha,
        [string]$Consumer = ''
    )

    if ($PrNumber -le 0 -or -not $HeadSha) { return @() }

    $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $cacheKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|checks|$HeadSha"
    $checks = Invoke-GhFleetCachedDatum `
        -RepoRoot $RepoRoot `
        -Category 'ci-checks' `
        -CacheKey $cacheKey `
        -TtlName 'ciChecks' `
        -BypassKind 'child_checks_bypass' `
        -Consumer $Consumer `
        -AuditEvents @{
            populate       = 'ci_checks_populate'
            hit            = 'ci_checks_hit'
            waitHit        = 'ci_checks_wait_hit'
            bypass         = 'child_checks_bypass'
            populateFailed = 'snapshot_populate_failed'
        } `
        -PopulateUpstream { Invoke-GhFleetFetchChecksUpstream -PrNumber $PrNumber } `
        -BuildSuccessEnvelope {
            param($Data)
            return @{ checks = @($Data); headSha = $HeadSha; negative = $false }
        } `
        -ExtractFromEnvelope {
            param($Envelope)
            return @($Envelope.checks)
        }
    return @($checks)
}

function Invoke-GhFleetCachedBranchProtection {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [string]$BaseBranch,
        [string]$Consumer = ''
    )

    if (-not $BaseBranch) {
        return @{ lookupFailed = $true; unprotected = $false; protection = $null }
    }

    $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $cacheKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|protection|$BaseBranch"
    return Invoke-GhFleetCachedDatum `
        -RepoRoot $RepoRoot `
        -Category 'branch-protection' `
        -CacheKey $cacheKey `
        -TtlName 'branchProtection' `
        -BypassKind 'child_protection_bypass' `
        -Consumer $Consumer `
        -AuditEvents @{
            populate       = 'branch_protection_populate'
            hit            = 'branch_protection_hit'
            waitHit        = 'branch_protection_wait_hit'
            bypass         = 'child_protection_bypass'
            populateFailed = 'snapshot_populate_failed'
        } `
        -PopulateUpstream { Invoke-GhFleetFetchBranchProtectionUpstream -RepoSlug $repoSlug -BaseBranch $BaseBranch } `
        -BuildSuccessEnvelope {
            param($Data)
            return @{
                lookupFailed = [bool]$Data.lookupFailed
                unprotected  = [bool]$Data.unprotected
                protection   = $Data.protection
                negative     = $false
            }
        } `
        -ExtractFromEnvelope {
            param($Envelope)
            return @{
                lookupFailed = [bool]$Envelope.lookupFailed
                unprotected  = [bool]$Envelope.unprotected
                protection   = $Envelope.protection
            }
        }
}

function Invoke-GhFleetCachedNegativeLookup {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [string]$NegativeKind,
        [Parameter(Mandatory = $true)]
        [string]$IdentityKey,
        [Parameter(Mandatory = $true)]
        [scriptblock]$PopulateWhenMiss,
        [string]$Consumer = ''
    )

    $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $cacheKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|neg|$NegativeKind|$IdentityKey"
    return Invoke-GhFleetCachedDatum `
        -RepoRoot $RepoRoot `
        -Category 'negative-lookup' `
        -CacheKey $cacheKey `
        -TtlName 'negativeLookup' `
        -BypassKind 'child_negative_bypass' `
        -Consumer $Consumer `
        -AllowNegativeEnvelope `
        -AuditEvents @{
            populate       = 'negative_lookup_populate'
            hit            = 'negative_lookup_hit'
            waitHit        = 'negative_lookup_wait_hit'
            bypass         = 'child_negative_bypass'
            populateFailed = 'snapshot_populate_failed'
        } `
        -PopulateUpstream {
            $result = & $PopulateWhenMiss
            return $result
        } `
        -BuildSuccessEnvelope {
            param($Data)
            if ($Data.negative) {
                return @{ negative = $true; fact = $Data.fact }
            }
            return @{ negative = $false; fact = $Data.fact }
        } `
        -ExtractFromEnvelope {
            param($Envelope)
            if ($Envelope.negative) {
                return @{ negative = $true; fact = $Envelope.fact }
            }
            return @{ negative = $false; fact = $Envelope.fact }
        }
}

function Invoke-GhFleetCachedPrNumberByHeadBranch {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [string]$HeadBranch,
        [string]$Consumer = ''
    )

    $lookup = Invoke-GhFleetCachedNegativeLookup `
        -RepoRoot $RepoRoot `
        -NegativeKind 'no_pr_by_head' `
        -IdentityKey $HeadBranch `
        -Consumer $Consumer `
        -PopulateWhenMiss {
            $prNumber = Invoke-GhFleetFetchPrListByHeadUpstream -HeadBranch $HeadBranch
            if (-not $prNumber) {
                return @{ negative = $true; fact = 'no_pr' }
            }
            return @{ negative = $false; fact = $prNumber }
        }
    if ($lookup.negative) { return $null }
    return [int]$lookup.fact
}

function Invoke-GhFleetCachedReviewFreshness {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber,
        [Parameter(Mandatory = $true)]
        [string]$HeadSha,
        [Parameter(Mandatory = $true)]
        [bool]$ReviewActive,
        [string]$Consumer = ''
    )

    if (-not $ReviewActive) {
        $neg = Invoke-GhFleetCachedNegativeLookup `
            -RepoRoot $RepoRoot `
            -NegativeKind 'no_review_active' `
            -IdentityKey "$PrNumber|$HeadSha" `
            -Consumer $Consumer `
            -PopulateWhenMiss { return @{ negative = $true; fact = 'no_review_active' } }
        return @{ active = $false; fresh = $true; etag = $null; upstreamCalls = 0; negative = $true }
    }

    $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $cacheKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|review|$PrNumber|$HeadSha"
    return Invoke-GhFleetCachedDatum `
        -RepoRoot $RepoRoot `
        -Category 'review-freshness' `
        -CacheKey $cacheKey `
        -TtlName 'reviewFreshness' `
        -BypassKind 'child_review_bypass' `
        -Consumer $Consumer `
        -AuditEvents @{
            populate       = 'review_freshness_populate'
            hit            = 'review_freshness_hit'
            waitHit        = 'review_freshness_wait_hit'
            bypass         = 'child_review_bypass'
            populateFailed = 'snapshot_populate_failed'
        } `
        -PopulateUpstream { Invoke-GhFleetFetchReviewFreshnessUpstream -RepoSlug $repoSlug -PrNumber $PrNumber } `
        -BuildSuccessEnvelope {
            param($Data)
            return @{ freshness = $Data; negative = $false }
        } `
        -ExtractFromEnvelope {
            param($Envelope)
            return @{ active = $true; fresh = $true; etag = $Envelope.freshness.etag; reviewCount = $Envelope.freshness.reviewCount }
        }
}

function Test-GhFleetPrHeadCurrent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedHeadSha,
        [string]$Consumer = ''
    )

    $view = Invoke-GhFleetCachedPrView -RepoRoot $RepoRoot -PrNumber $PrNumber -Consumer $Consumer
    if (-not $view) {
        return @{ current = $false; reason = 'no_pr_view' }
    }
    $cachedHead = [string]$view.headRefOid
    if ($cachedHead -ne $ExpectedHeadSha) {
        return @{
            current      = $false
            reason       = 'stale_head'
            cachedHead   = $cachedHead
            expectedHead = $ExpectedHeadSha
        }
    }
    return @{ current = $true; view = $view; cachedHead = $cachedHead }
}

function Get-GhFleetOpenPrIndexes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $prs = @(Invoke-GhFleetCachedOpenPrListRaw -RepoRoot $RepoRoot)
    $byNumber = @{}
    $byHeadRefName = @{}
    $byHeadSha = @{}
    foreach ($pr in $prs) {
        $n = [string]$pr.number
        if ($n) { $byNumber[$n] = $pr }
        $headName = [string]$pr.headRefName
        if ($headName) { $byHeadRefName[$headName] = $pr }
        $headSha = [string]$pr.headRefOid
        if ($headSha) { $byHeadSha[$headSha] = $pr }
    }
    return @{
        prs           = $prs
        byNumber      = $byNumber
        byHeadRefName = $byHeadRefName
        byHeadSha     = $byHeadSha
    }
}

function Test-GhFleetCiDeltaUnchanged {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [string]$HeadSha,
        [Parameter(Mandatory = $true)]
        [object[]]$Checks,
        [string]$Consumer = ''
    )

    $fingerprint = ($Checks | ForEach-Object { "$($_.name):$($_.state)" }) -join '|'
    $lookup = Invoke-GhFleetCachedNegativeLookup `
        -RepoRoot $RepoRoot `
        -NegativeKind 'no_ci_delta' `
        -IdentityKey "$HeadSha|$fingerprint" `
        -Consumer $Consumer `
        -PopulateWhenMiss {
            return @{ negative = $true; fact = 'no_ci_delta' }
        }
    return [bool]$lookup.negative
}

function Test-GhFleetHeadAlreadyCovered {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [string]$HeadSha,
        [string]$Consumer = ''
    )

    $lookup = Invoke-GhFleetCachedNegativeLookup `
        -RepoRoot $RepoRoot `
        -NegativeKind 'head_already_covered' `
        -IdentityKey $HeadSha `
        -Consumer $Consumer `
        -PopulateWhenMiss {
            return @{ negative = $true; fact = 'head_already_covered' }
        }
    return [bool]$lookup.negative
}

function Get-GhFleetInventoryCacheTtlContract {
  return [ordered]@{
    prView           = Get-GhFleetInventoryCacheTtlSeconds -Name 'prView'
    ciChecks         = Get-GhFleetInventoryCacheTtlSeconds -Name 'ciChecks'
    branchProtection = Get-GhFleetInventoryCacheTtlSeconds -Name 'branchProtection'
    negativeLookup   = Get-GhFleetInventoryCacheTtlSeconds -Name 'negativeLookup'
    reviewFreshness  = Get-GhFleetInventoryCacheTtlSeconds -Name 'reviewFreshness'
    openPrList       = Get-GhFleetInventoryCacheTtlSeconds -Name 'openPrList'
  }
}
