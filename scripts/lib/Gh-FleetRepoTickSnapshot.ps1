#requires -Version 5.1
<#
.SYNOPSIS
  Repo-tick inventory snapshot producer/consumer for wake-supervisor fleet (Issue #583).
  One refresh owner per repo per bounded interval; covered children consume the same generation.
#>

$Script:GhFleetRepoTickIntervalSeconds = 30
$Script:GhFleetRepoTickStaleServeSeconds = 30
$Script:GhFleetRepoTickPopulating = $false

function Get-GhFleetRepoTickIntervalSeconds {
    $raw = [Environment]::GetEnvironmentVariable('GH_FLEET_REPO_TICK_INTERVAL_SECONDS')
    $parsed = 0
    if ($raw -and [int]::TryParse([string]$raw, [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return $Script:GhFleetRepoTickIntervalSeconds
}

function Get-GhFleetRepoTickStaleServeSeconds {
    $raw = [Environment]::GetEnvironmentVariable('GH_FLEET_REPO_TICK_STALE_SERVE_SECONDS')
    $parsed = 0
    if ($raw -and [int]::TryParse([string]$raw, [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return $Script:GhFleetRepoTickStaleServeSeconds
}

function Test-GhFleetRepoTickEnabled {
    if ($env:GH_FLEET_REPO_TICK_DISABLED -eq '1') { return $false }
    return [bool](Get-GhFleetInventoryCacheRoot)
}

function Get-GhFleetRepoTickPaths {
    param([string]$RepoRoot)

    $cacheRoot = Get-GhFleetInventoryCacheRoot
    if (-not $cacheRoot) { return $null }

    $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $repoKey = Get-GhFleetCacheKeyHash -Text $repoSlug
    $dir = Join-Path $cacheRoot "repo-tick/$repoKey"
    return @{
        Dir            = $dir
        GenerationPath = Join-Path $dir 'generation.json'
        LockPath       = Join-Path $dir 'generation.populate.lock'
        TempPath       = Join-Path $dir 'generation.tmp'
        RepoSlug       = $repoSlug
        RepoKey        = $repoKey
    }
}

function Test-GhFleetRepoTickEnvelopeExpired {
    param($Envelope)

    if (-not $Envelope -or -not $Envelope.expiresAt) {
        return $false
    }

    try {
        $expiresAt = [datetimeoffset]::Parse([string]$Envelope.expiresAt).UtcDateTime
    }
    catch {
        return $false
    }

    return (Get-Date).ToUniversalTime() -gt $expiresAt
}

function Read-GhFleetRepoTickGenerationRecord {
    param([string]$GenerationPath)

    if (-not $GenerationPath -or -not (Test-Path -LiteralPath $GenerationPath -PathType Leaf)) {
        return $null
    }

    try {
        $record = Get-Content -LiteralPath $GenerationPath -Raw | ConvertFrom-Json
        if ($record.error) {
            if (Test-GhFleetRepoTickEnvelopeExpired -Envelope $record) {
                return $null
            }
            return @{ kind = 'error'; message = [string]$record.error; record = $record }
        }
        return @{ kind = 'data'; record = $record }
    }
    catch {
        return $null
    }
}

function Test-GhFleetRepoTickGenerationFresh {
    param(
        $Record,
        [int]$IntervalSeconds
    )

    $data = if ($Record.record) { $Record.record } elseif ($Record.generation) { $Record } else { $null }
    if (-not $data -or -not $data.storedAt) { return $false }
    try {
        $storedAt = [datetimeoffset]::Parse([string]$data.storedAt).UtcDateTime
    }
    catch {
        return $false
    }
    $ageSeconds = ((Get-Date).ToUniversalTime() - $storedAt).TotalSeconds
    return $ageSeconds -lt $IntervalSeconds
}

function Test-GhFleetRepoTickGenerationStaleServable {
    param(
        $Record,
        [int]$IntervalSeconds,
        [int]$StaleServeSeconds
    )

    if ($StaleServeSeconds -le 0) { return $false }

    $data = if ($Record.record) { $Record.record } elseif ($Record.generation) { $Record } else { $null }
    if (-not $data -or -not $data.storedAt) { return $false }
    try {
        $storedAt = [datetimeoffset]::Parse([string]$data.storedAt).UtcDateTime
    }
    catch {
        return $false
    }
    $ageSeconds = ((Get-Date).ToUniversalTime() - $storedAt).TotalSeconds
    $staleUpperBound = $IntervalSeconds + $StaleServeSeconds
    return ($ageSeconds -ge $IntervalSeconds) -and ($ageSeconds -lt $staleUpperBound)
}

function Get-GhFleetRepoTickGenerationAgeSeconds {
    param($Record)

    $data = if ($Record.record) { $Record.record } elseif ($Record.generation) { $Record } else { $null }
    if (-not $data -or -not $data.storedAt) { return $null }
    try {
        $storedAt = [datetimeoffset]::Parse([string]$data.storedAt).UtcDateTime
        return [math]::Round(((Get-Date).ToUniversalTime() - $storedAt).TotalSeconds, 3)
    }
    catch {
        return $null
    }
}

function Write-GhFleetRepoTickPopulateFailureAudit {
    param(
        [hashtable]$AuditBase,
        [string]$Route,
        [hashtable]$Extra = @{}
    )

    $fields = $AuditBase.Clone()
    $fields.failureKind = 'snapshot_populate_failed'
    $fields.route = $Route
    foreach ($key in $Extra.Keys) {
        $fields[$key] = $Extra[$key]
    }
    Write-GhFleetCacheAuditLine -Event 'repo_tick_populate_failed' -Fields $fields
}

function Write-GhFleetRepoTickDatumEnvelope {
    param(
        [hashtable]$Paths,
        [string]$Category,
        [string]$CacheKey,
        [hashtable]$Payload,
        [string]$Generation,
        [int]$TtlSeconds
    )

    $datumPaths = Get-GhFleetDatumSnapshotPaths -CacheRoot (Get-GhFleetInventoryCacheRoot) -Category $Category -CacheKey $CacheKey
    $expiresAt = (Get-Date).ToUniversalTime().AddSeconds($TtlSeconds).ToString('o')
    $envelope = $Payload.Clone()
    $envelope.storedAt = (Get-Date).ToUniversalTime().ToString('o')
    $envelope.expiresAt = $expiresAt
    $envelope.repoTickGeneration = $Generation
    Write-GhFleetCacheEnvelopeAtomic -TargetPath $datumPaths.SnapshotPath -TempPath $datumPaths.TempPath -Envelope $envelope
}

function Write-GhFleetRepoTickGenerationError {
    param(
        [hashtable]$Paths,
        [string]$FailureMessage,
        [int]$IntervalSeconds
    )

    $errorExpires = (Get-Date).ToUniversalTime().AddSeconds($IntervalSeconds).ToString('o')
    $dir = $paths.Dir
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Write-GhFleetCacheEnvelopeAtomic -TargetPath $paths.GenerationPath -TempPath $paths.TempPath -Envelope @{
        storedAt  = (Get-Date).ToUniversalTime().ToString('o')
        expiresAt = $errorExpires
        error     = $FailureMessage
    }
}

function Invoke-GhFleetRepoTickProducer {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [string]$Consumer = ''
    )

    $paths = Get-GhFleetRepoTickPaths -RepoRoot $RepoRoot
    if (-not $paths) { return $null }

    $interval = Get-GhFleetRepoTickIntervalSeconds
    $repoSlug = $paths.RepoSlug
    $generation = (Get-Date).ToUniversalTime().ToString('o')
    $auditBase = @{
        repo       = $repoSlug
        generation = $generation
        consumer   = $Consumer
    }

    $Script:GhFleetRepoTickPopulating = $true
    try {
        Push-Location -LiteralPath $RepoRoot
        try {
            $prs = @(Invoke-GhFleetFetchOpenPrListUpstream -FailureKind 'snapshot_populate_failed')
        }
        catch {
            $failureMessage = Format-GhFleetOpenPrListFailure -Kind 'snapshot_populate_failed' -InnerMessage $_.Exception.Message
            Write-GhFleetRepoTickGenerationError -Paths $paths -FailureMessage $failureMessage -IntervalSeconds $interval
            Write-GhFleetRepoTickPopulateFailureAudit -AuditBase $auditBase -Route 'open_pr_list'
            throw $failureMessage
        }
        finally {
            Pop-Location
        }

        $queryId = Get-GhFleetOpenPrListQueryIdentity
        $openListKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|$queryId"
        $openListPaths = Get-GhFleetOpenPrListSnapshotPaths -CacheRoot (Get-GhFleetInventoryCacheRoot) -CacheKey $openListKey
        $openListExpires = (Get-Date).ToUniversalTime().AddSeconds($interval).ToString('o')

        $baseBranches = @{}
        $upstreamCounts = @{
            prList     = 1
            prView     = 0
            prChecks   = 0
            protection = 0
        }
        $datumWrites = [System.Collections.Generic.List[object]]::new()

        foreach ($pr in $prs) {
            $prNumber = [int]$pr.number
            if ($prNumber -le 0) { continue }

            Push-Location -LiteralPath $RepoRoot
            try {
                $view = Invoke-GhFleetFetchPrViewUpstream -PrNumber $prNumber
            }
            catch {
                $failureMessage = Format-GhFleetCacheFailure -Kind 'snapshot_populate_failed' -InnerMessage $_.Exception.Message
                Write-GhFleetRepoTickGenerationError -Paths $paths -FailureMessage $failureMessage -IntervalSeconds $interval
                Write-GhFleetRepoTickPopulateFailureAudit -AuditBase $auditBase -Route 'pr_view' -Extra @{ pr = $prNumber }
                throw $failureMessage
            }
            finally {
                Pop-Location
            }
            $upstreamCounts.prView++

            $viewKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|pr|$prNumber"
            $datumWrites.Add(@{
                Category  = 'pr-view'
                CacheKey  = $viewKey
                Payload   = @{ pr = $view; negative = $false }
            })

            $headSha = [string]$view.headRefOid
            if ($headSha) {
                Push-Location -LiteralPath $RepoRoot
                try {
                    $checks = @(Invoke-GhFleetFetchChecksUpstream -PrNumber $prNumber)
                }
                catch {
                    $failureMessage = Format-GhFleetCacheFailure -Kind 'snapshot_populate_failed' -InnerMessage $_.Exception.Message
                    Write-GhFleetRepoTickGenerationError -Paths $paths -FailureMessage $failureMessage -IntervalSeconds $interval
                    Write-GhFleetRepoTickPopulateFailureAudit -AuditBase $auditBase -Route 'ci_checks' -Extra @{ pr = $prNumber }
                    throw $failureMessage
                }
                finally {
                    Pop-Location
                }
                $upstreamCounts.prChecks++

                $checksKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|checks|$headSha"
                $datumWrites.Add(@{
                    Category  = 'ci-checks'
                    CacheKey  = $checksKey
                    Payload   = @{ checks = @($checks); headSha = $headSha; negative = $false }
                })
            }

            $baseRef = [string]$view.baseRefName
            if ($baseRef -and -not $baseBranches.ContainsKey($baseRef)) {
                $baseBranches[$baseRef] = $true
                Push-Location -LiteralPath $RepoRoot
                try {
                    $protection = Invoke-GhFleetFetchBranchProtectionUpstream -RepoSlug $repoSlug -BaseBranch $baseRef
                }
                catch {
                    $failureMessage = Format-GhFleetCacheFailure -Kind 'snapshot_populate_failed' -InnerMessage $_.Exception.Message
                    Write-GhFleetRepoTickGenerationError -Paths $paths -FailureMessage $failureMessage -IntervalSeconds $interval
                    Write-GhFleetRepoTickPopulateFailureAudit -AuditBase $auditBase -Route 'branch_protection' -Extra @{ base = $baseRef }
                    throw $failureMessage
                }
                finally {
                    Pop-Location
                }
                $upstreamCounts.protection++

                $protectionKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|protection|$baseRef"
                $datumWrites.Add(@{
                    Category  = 'branch-protection'
                    CacheKey  = $protectionKey
                    Payload   = @{
                        lookupFailed = [bool]$protection.lookupFailed
                        unprotected  = [bool]$protection.unprotected
                        protection   = $protection.protection
                        negative     = $false
                    }
                })
            }
        }

        Write-GhFleetCacheEnvelopeAtomic -TargetPath $openListPaths.SnapshotPath -TempPath $openListPaths.TempPath -Envelope @{
            storedAt           = $generation
            expiresAt          = $openListExpires
            repoTickGeneration = $generation
            prs                = @($prs)
        }
        foreach ($datumWrite in $datumWrites) {
            Write-GhFleetRepoTickDatumEnvelope -Paths $paths -Category $datumWrite.Category -CacheKey $datumWrite.CacheKey -Payload $datumWrite.Payload -Generation $generation -TtlSeconds $interval
        }

        $generationEnvelope = @{
            storedAt       = $generation
            expiresAt      = (Get-Date).ToUniversalTime().AddSeconds($interval).ToString('o')
            generation     = $generation
            repoSlug       = $repoSlug
            openPrCount    = @($prs).Count
            upstreamCounts = $upstreamCounts
        }
        $dir = $paths.Dir
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        Write-GhFleetCacheEnvelopeAtomic -TargetPath $paths.GenerationPath -TempPath $paths.TempPath -Envelope $generationEnvelope

        $savedDuplicates = [math]::Max(0, (@($prs).Count * 3) - $upstreamCounts.prView - $upstreamCounts.prChecks - $upstreamCounts.protection)
        Write-GhFleetCacheAuditLine -Event 'repo_tick_populate' -Fields ($auditBase + @{
            openPrCount         = @($prs).Count
            savedDuplicateCalls = $savedDuplicates
            route               = 'repo_inventory'
        })

        return $generationEnvelope
    }
    finally {
        $Script:GhFleetRepoTickPopulating = $false
    }
}

function Resolve-GhFleetRepoTickSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [string]$Consumer = '',
        [string]$DataClass = '',
        [bool]$AllowPopulate = $true
    )

    if (-not (Test-GhFleetRepoTickEnabled)) { return $null }
    if ($Script:GhFleetRepoTickPopulating) { return $null }

    $paths = Get-GhFleetRepoTickPaths -RepoRoot $RepoRoot
    if (-not $paths) { return $null }

    $interval = Get-GhFleetRepoTickIntervalSeconds
    $staleServe = Get-GhFleetRepoTickStaleServeSeconds
    $repoSlug = $paths.RepoSlug
    $auditBase = @{
        repo      = $repoSlug
        consumer  = $Consumer
        dataClass = $DataClass
    }

    $recordEntry = Read-GhFleetRepoTickGenerationRecord -GenerationPath $paths.GenerationPath
    if ($recordEntry -and $recordEntry.kind -eq 'error') {
        if ($AllowPopulate) {
            throw [string]$recordEntry.message
        }
        return $null
    }
    $record = if ($recordEntry -and $recordEntry.record) { $recordEntry.record } else { $null }
    if ($record -and (Test-GhFleetRepoTickGenerationFresh -Record $record -IntervalSeconds $interval)) {
        Write-GhFleetCacheAuditLine -Event 'repo_tick_hit' -Fields ($auditBase + @{
            generation   = [string]$record.generation
            stalenessAge = (Get-GhFleetRepoTickGenerationAgeSeconds -Record $record)
        })
        return $record
    }

    $staleServable = $record -and (Test-GhFleetRepoTickGenerationStaleServable -Record $record -IntervalSeconds $interval -StaleServeSeconds $staleServe)
    $lockHeld = Test-Path -LiteralPath $paths.LockPath -PathType Leaf

    if ($staleServable -and $lockHeld) {
        Write-GhFleetCacheAuditLine -Event 'repo_tick_stale_hit' -Fields ($auditBase + @{
            generation   = [string]$record.generation
            stalenessAge = (Get-GhFleetRepoTickGenerationAgeSeconds -Record $record)
        })
        return $record
    }

    if (-not $AllowPopulate -and -not $lockHeld) {
        return $null
    }

    for ($populatePass = 0; $populatePass -lt 2; $populatePass++) {
        if ($AllowPopulate) {
            $acquired = Enter-GhFleetPopulateLock -LockPath $paths.LockPath
            if ($acquired) {
                try {
                    $recordAfterLockEntry = Read-GhFleetRepoTickGenerationRecord -GenerationPath $paths.GenerationPath
                    if ($recordAfterLockEntry -and $recordAfterLockEntry.kind -eq 'error') {
                        throw [string]$recordAfterLockEntry.message
                    }
                    $recordAfterLock = if ($recordAfterLockEntry -and $recordAfterLockEntry.record) { $recordAfterLockEntry.record } else { $null }
                    if ($recordAfterLock -and (Test-GhFleetRepoTickGenerationFresh -Record $recordAfterLock -IntervalSeconds $interval)) {
                        Write-GhFleetCacheAuditLine -Event 'repo_tick_hit' -Fields ($auditBase + @{
                            generation   = [string]$recordAfterLock.generation
                            afterLock    = $true
                            stalenessAge = (Get-GhFleetRepoTickGenerationAgeSeconds -Record $recordAfterLock)
                        })
                        return $recordAfterLock
                    }

                    return Invoke-GhFleetRepoTickProducer -RepoRoot $RepoRoot -Consumer $Consumer
                }
                finally {
                    Exit-GhFleetPopulateLock -LockPath $paths.LockPath
                }
            }
        }
        elseif (-not (Test-Path -LiteralPath $paths.LockPath -PathType Leaf)) {
            return $null
        }

        $deadline = (Get-Date).AddSeconds($Script:GhFleetPopulateWaitSeconds)
        while ((Get-Date) -lt $deadline) {
            $waitedEntry = Read-GhFleetRepoTickGenerationRecord -GenerationPath $paths.GenerationPath
            if ($waitedEntry -and $waitedEntry.kind -eq 'error') {
                if ($AllowPopulate) {
                    throw [string]$waitedEntry.message
                }
                return $null
            }
            $waited = if ($waitedEntry -and $waitedEntry.record) { $waitedEntry.record } else { $null }
            if ($waited -and (Test-GhFleetRepoTickGenerationFresh -Record $waited -IntervalSeconds $interval)) {
                Write-GhFleetCacheAuditLine -Event 'repo_tick_wait_hit' -Fields ($auditBase + @{
                    generation          = [string]$waited.generation
                    savedDuplicateCalls = 1
                })
                return $waited
            }
            if (-not (Test-Path -LiteralPath $paths.LockPath -PathType Leaf)) {
                break
            }
            Clear-GhFleetStalePopulateLockIfNeeded -LockPath $paths.LockPath | Out-Null
            Start-Sleep -Milliseconds $Script:GhFleetPopulatePollMilliseconds
        }

        if ($staleServable -and $record) {
            Write-GhFleetCacheAuditLine -Event 'repo_tick_stale_hit' -Fields ($auditBase + @{
                generation   = [string]$record.generation
                stalenessAge = (Get-GhFleetRepoTickGenerationAgeSeconds -Record $record)
                afterWait    = $true
            })
            return $record
        }

        if (Test-Path -LiteralPath $paths.LockPath -PathType Leaf) {
            break
        }
    }

    if ($staleServable -and $record) {
        Write-GhFleetCacheAuditLine -Event 'repo_tick_stale_hit' -Fields ($auditBase + @{
            generation   = [string]$record.generation
            stalenessAge = (Get-GhFleetRepoTickGenerationAgeSeconds -Record $record)
            fallback     = $true
        })
        return $record
    }

    if (-not $AllowPopulate) {
        return $null
    }

    Write-GhFleetCacheAuditLine -Event 'repo_tick_bypass_denied' -Fields $auditBase
    throw (Format-GhFleetCacheFailure -Kind 'repo_tick_bypass' -InnerMessage "repo-tick snapshot bypass denied for repo=$repoSlug")
}

function Ensure-GhFleetRepoTickSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [string]$Consumer = '',
        [string]$DataClass = ''
    )

    return Resolve-GhFleetRepoTickSnapshot -RepoRoot $RepoRoot -Consumer $Consumer -DataClass $DataClass -AllowPopulate $true
}

function Get-GhFleetRepoTickSnapshotIfConsumable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [string]$Consumer = '',
        [string]$DataClass = ''
    )

    return Resolve-GhFleetRepoTickSnapshot -RepoRoot $RepoRoot -Consumer $Consumer -DataClass $DataClass -AllowPopulate $false
}

function Get-GhFleetRepoTickGenerationContract {
    return [ordered]@{
        intervalSeconds   = Get-GhFleetRepoTickIntervalSeconds
        staleServeSeconds = Get-GhFleetRepoTickStaleServeSeconds
        enabled           = (Test-GhFleetRepoTickEnabled)
    }
}
