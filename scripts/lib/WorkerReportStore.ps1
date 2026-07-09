#requires -Version 5.1
<#
.SYNOPSIS
  Pack-owned worker report store read/write helpers (Issue #717).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Gh-FleetInventoryCache.ps1')

$Script:WorkerReportStoreCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/worker-report-store.mjs'
$Script:PackWorkerReportStoreSurface = 'pack-worker-report-store'

function Get-WorkerReportStorePath {
    if ($env:AO_WORKER_REPORT_STORE) {
        return $env:AO_WORKER_REPORT_STORE
    }
    if ($env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR) {
        return Join-Path $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR 'worker-report-store.json'
    }
    if ($env:AO_REPORT_STATE_SEED_STATE) {
        $dir = Split-Path -Parent $env:AO_REPORT_STATE_SEED_STATE
        if ($dir) {
            return Join-Path $dir 'worker-report-store.json'
        }
    }
    $stateRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.local/state/orchestrator-pack-wake-supervisor'
    return Join-Path $stateRoot 'worker-report-store.json'
}

function Get-WorkerReportStoreLockPath {
    param([string]$StorePath = '')

    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $dir = Split-Path -Parent $path
    if (-not $dir) {
        return Join-Path ([System.IO.Path]::GetTempPath()) 'worker-report-store.lock'
    }
    return Join-Path $dir 'worker-report-store.lock'
}

function Invoke-WorkerReportStoreCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerReportStoreCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'worker-report-store' -JsonDepth 30
}

function Get-WorkerReportStoreState {
    param([string]$Path = '')

    $storePath = if ($Path) { $Path } else { Get-WorkerReportStorePath }
    if (-not (Test-Path -LiteralPath $storePath -PathType Leaf)) {
        return Invoke-WorkerReportStoreCli -Subcommand 'migrate' -Payload @{}
    }
    $raw = Get-Content -LiteralPath $storePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $payload = ConvertTo-MechanicalJsonStateHashtable -Value $raw
    return Invoke-WorkerReportStoreCli -Subcommand 'migrate' -Payload $payload
}

function Set-WorkerReportStoreState {
    param(
        [string]$Path,
        [object]$State
    )

    $default = @{
        schemaVersion   = 2
        lastUpdatedMs   = $null
        generation      = 0
        sourceRecords   = @{}
        bindingByKey    = @{}
        seededKeys      = @()
        deferredScanKeys = @()
        githubSnapshot  = $null
    }
    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $default -JsonDepth 30
}

function Update-WorkerReportStoreStateLocked {
    param(
        [string]$Path,
        [scriptblock]$Mutator,
        [long]$NowMs
    )

    $lockPath = Get-WorkerReportStoreLockPath -StorePath $Path
    return Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Metadata @{
        purpose = 'worker-report-store'
    } -Action {
        $current = Get-WorkerReportStoreState -Path $Path
        $next = & $Mutator $current
        if (-not $next.lastUpdatedMs) {
            $next.lastUpdatedMs = $NowMs
        }
        Set-WorkerReportStoreState -Path $Path -State $next
        return $next
    }
}

function Write-PackWorkerReportRecord {
    param(
        [string]$ReportState,
        [string]$SessionId,
        [string]$RepoSlug,
        [int]$PrNumber,
        [string]$HeadSha,
        [bool]$Accepted = $true,
        [string]$StorePath = '',
        [long]$NowMs = 0
    )

    if (-not $NowMs) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $recordPayload = @{
        reportState    = $ReportState
        accepted       = $Accepted
        sessionId      = $SessionId
        repoSlug       = $RepoSlug
        prNumber       = $PrNumber
        headSha        = $HeadSha
        reportedAtMs   = $NowMs
        lastObservedMs = $NowMs
    }
    $writeResult = $null
    $captured = @{}
    Update-WorkerReportStoreStateLocked -Path $path -NowMs $NowMs -Mutator {
        param($current)
        $applied = Invoke-WorkerReportStoreCli -Subcommand 'upsertRecord' -Payload @{
            store           = $current
            callerSessionId = $SessionId
            nowMs           = $NowMs
            record          = $recordPayload
        }
        if (-not $applied.ok) {
            throw "worker-report-store upsert failed: $($applied.reason)"
        }
        $captured.result = $applied
        return $applied.store
    } | Out-Null
    $writeResult = $captured.result
    return @{
        ok         = $true
        key        = $writeResult.key
        record     = $writeResult.record
        generation = $writeResult.generation
    }
}

function Build-WorkerReportStoreCurrentHeadByPr {
    param(
        [object[]]$OpenPrs = @(),
        [string]$RepoSlug = '',
        [string]$RepoRoot = ''
    )

    $slug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug -RepoRoot $RepoRoot
    $repoKey = [string]$slug
    if ($repoKey) {
        $repoKey = $repoKey.Trim().ToLowerInvariant()
    }
    $map = @{}
    foreach ($pr in @($OpenPrs)) {
        if ($null -eq $pr) { continue }
        $num = [int]$pr.number
        $head = [string]$pr.headRefOid
        if ($num -le 0 -or [string]::IsNullOrWhiteSpace($head)) { continue }
        $map[[string]$num] = $head
        if ($repoKey) {
            $map["$repoKey|$num"] = $head
        }
    }
    return $map
}

function Resolve-WorkerReportStoreRepoSlug {
    param(
        [string]$RepoSlug = '',
        [string]$RepoRoot = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($RepoSlug)) {
        return $RepoSlug
    }
    if ($env:GITHUB_REPOSITORY) {
        return [string]$env:GITHUB_REPOSITORY
    }
    if ($env:AO_REPO_SLUG) {
        return [string]$env:AO_REPO_SLUG
    }

    $root = $RepoRoot
    if (-not $root) {
        $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    return Resolve-GhFleetRepoSlug -RepoRoot $root
}

function Merge-AoSessionRowsWithWorkerReportStore {
    param(
        [object[]]$Sessions,
        [string]$RepoRoot = '',
        [string]$RepoSlug = '',
        [string]$StorePath = ''
    )

    return Merge-AoSessionRowsWithPackWorkerReports -Sessions $Sessions -RepoRoot $RepoRoot `
        -RepoSlug $RepoSlug -StorePath $StorePath
}

function Merge-AoSessionRowsWithPackWorkerReports {
    param(
        [object[]]$Sessions,
        [string]$RepoRoot = '',
        [string]$RepoSlug = '',
        [string]$StorePath = ''
    )

    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $root = $RepoRoot
    if (-not $root) {
        $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    $slug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug -RepoRoot $root
    $store = Get-WorkerReportStoreState -Path $path
    $merged = Invoke-WorkerReportStoreCli -Subcommand 'mergeIntoSessions' -Payload @{
        sessions = @($Sessions)
        store    = $store
        repoSlug = $slug
    }
    return @($merged)
}

function Invoke-WorkerReportStoreEviction {
    param(
        [object[]]$OpenPrs = @(),
        [hashtable]$CurrentHeadByPr = @{},
        [string]$StorePath = '',
        [long]$NowMs = 0,
        [long]$MaxAgeMs = 0,
        [long]$NonterminalMaxAgeMs = 0
    )

    if (-not $NowMs) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $evictSummary = @{}
    $captured = @{}
    Update-WorkerReportStoreStateLocked -Path $path -NowMs $NowMs -Mutator {
        param($current)
        $payload = @{
            store           = $current
            openPrs         = @($OpenPrs)
            currentHeadByPr = $CurrentHeadByPr
            nowMs           = $NowMs
        }
        if ($MaxAgeMs -gt 0) { $payload.maxAgeMs = $MaxAgeMs }
        if ($NonterminalMaxAgeMs -gt 0) { $payload.nonterminalMaxAgeMs = $NonterminalMaxAgeMs }
        $result = Invoke-WorkerReportStoreCli -Subcommand 'evict' -Payload $payload
        $captured.summary = @{
            removed     = [int]$result.removed
            recordCount = [int]$result.recordCount
        }
        return $result.store
    } | Out-Null
    if ($captured.summary) {
        $evictSummary = $captured.summary
    }
    return @{
        removed     = [int]$evictSummary.removed
        recordCount = [int]$evictSummary.recordCount
    }
}

function Get-PackWorkerReportDiscoveryCandidates {
    param([string]$StorePath = '')

    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $store = Get-WorkerReportStoreState -Path $path
    $records = @($store.sourceRecords.PSObject.Properties | ForEach-Object { $_.Value })
    $candidates = @()
    foreach ($record in $records) {
        if (-not $record) { continue }
        $candidates += @{
            sessionId   = [string]$record.sessionId
            issueNumber = 0
            prNumber    = [int]$record.prNumber
        }
    }
    return @($candidates)
}
