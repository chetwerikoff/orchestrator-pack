#requires -Version 5.1
<#
.SYNOPSIS
  Cross-process read-through cache for wake-supervisor fleet GitHub inventory (Issue #453).
#>

. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'Get-SupervisedRepoSlug.ps1')

$Script:GhFleetOpenPrListTtlSeconds = 15
$Script:GhFleetCommitMemoTtlSeconds = 2592000
$Script:GhFleetCommitNegativeTtlSeconds = 60
$Script:GhFleetPopulateWaitSeconds = 30
$Script:GhFleetPopulatePollMilliseconds = 50
$Script:GhFleetPopulateLockMaxAgeSeconds = 120
$Script:GhFleetRepoSlugByRoot = @{}

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
                    $prs = Invoke-GhFleetFetchOpenPrListUpstream
                }
                catch {
                    $expiresAt = (Get-Date).ToUniversalTime().AddSeconds($ttl).ToString('o')
                    Write-GhFleetCacheEnvelopeAtomic -TargetPath $paths.SnapshotPath -TempPath $paths.TempPath -Envelope @{
                        storedAt  = (Get-Date).ToUniversalTime().ToString('o')
                        expiresAt = $expiresAt
                        error     = $_.Exception.Message
                    }
                    throw
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

    Push-Location -LiteralPath $RepoRoot
    try {
        Write-GhFleetInventoryCacheAudit -Event 'open_pr_list_failthrough' -Fields @{ key = $cacheKey }
        return Invoke-GhFleetFetchOpenPrListUpstream
    }
    finally {
        Pop-Location
    }
}

function Invoke-GhFleetFetchOpenPrListUpstream {
    $raw = gh pr list --state open --json number,headRefOid,baseRefName --limit 200 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "gh pr list failed (exit $LASTEXITCODE): $raw"
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
