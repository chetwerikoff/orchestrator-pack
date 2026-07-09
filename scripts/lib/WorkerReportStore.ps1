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


function Resolve-PackWorkerReportCallerSessionId {
    if ($env:AO_WORKER_SESSION_ID) {
        return [string]$env:AO_WORKER_SESSION_ID
    }
    if ($env:AO_SESSION_ID) {
        return [string]$env:AO_SESSION_ID
    }
    return ''
}


function Resolve-PackWorkerReportWorktreeHeadSha {
    param(
        [string]$RepoRoot = '',
        [string]$HeadSha = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($HeadSha)) {
        return [string]$HeadSha
    }
    if ($env:AO_HEAD_SHA) { return [string]$env:AO_HEAD_SHA }
    if ($env:GITHUB_SHA) { return [string]$env:GITHUB_SHA }

    $headCwd = if ($RepoRoot -and (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
        $RepoRoot
    }
    else {
        (Get-Location).Path
    }
    $previous = Get-Location
    try {
        Set-Location $headCwd
        return [string]((& git rev-parse HEAD 2>$null | Select-Object -First 1))
    }
    finally {
        Set-Location $previous
    }
}

function Resolve-PackWorkerReportTrustedBinding {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [string]$RepoRoot = '',
        [string]$RepoSlug = '',
        [string]$WorktreeHeadSha = ''
    )

    $headSha = Resolve-PackWorkerReportWorktreeHeadSha -RepoRoot $RepoRoot -HeadSha $WorktreeHeadSha
    $session = $null
    $sessionGetPayload = $null
    $openPrs = @()

    $aoCli = Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1'
    if (Test-Path -LiteralPath $aoCli) {
        . $aoCli
        try {
            $sessions = @(Get-AoStatusSessionsIncludingTerminated)
            foreach ($row in $sessions) {
                $id = Get-AoSessionRowIdentifier -Row $row
                if ($id -eq $SessionId) {
                    $session = $row
                    break
                }
            }
            if ($session -and (Get-Command Test-AoSessionRowNeedsSessionGetDetail -ErrorAction SilentlyContinue)) {
                if (Test-AoSessionRowNeedsSessionGetDetail -Row $session) {
                    try {
                        $sessionGetPayload = Get-AoSessionGetJson -SessionId $SessionId
                    }
                    catch {
                        $sessionGetPayload = $null
                    }
                }
            }
        }
        catch {
            $session = $null
        }
    }

    if (-not $session) {
        $envPr = 0
        if ($env:AO_PR_NUMBER) {
            [void][int]::TryParse([string]$env:AO_PR_NUMBER, [ref]$envPr)
        }
        if ($envPr -gt 0) {
            $session = @{
                id        = $SessionId
                name      = $SessionId
                sessionId = $SessionId
                prNumber  = $envPr
            }
        }
    }

    if (-not $session) {
        return @{ ok = $false; reason = 'trust_boundary_binding_unresolved' }
    }

    try {
        $ghPrChecks = Join-Path $PSScriptRoot 'Gh-PrChecks.ps1'
        if (Test-Path -LiteralPath $ghPrChecks) {
            . $ghPrChecks
        }
        $openPrs = @(Invoke-GhOpenPrList -RepoRoot $RepoRoot -Consumer 'pack-worker-report-trusted-binding')
    }
    catch {
        $openPrs = @()
    }

    if ($openPrs.Count -eq 0 -and $headSha) {
        $fallbackPr = 0
        if ($null -ne $session.prNumber) {
            [void][int]::TryParse([string]$session.prNumber, [ref]$fallbackPr)
        }
        if ($fallbackPr -le 0 -and $env:AO_PR_NUMBER) {
            [void][int]::TryParse([string]$env:AO_PR_NUMBER, [ref]$fallbackPr)
        }
        if ($fallbackPr -gt 0) {
            $openPrs = @(@{ number = $fallbackPr; headRefOid = $headSha; state = 'open' })
        }
    }

    $sessionPayload = ConvertTo-MechanicalJsonStateHashtable -Value $session
    $sessionGetHashtable = $null
    if ($sessionGetPayload) {
        $sessionGetHashtable = ConvertTo-MechanicalJsonStateHashtable -Value $sessionGetPayload
    }
    $openPrPayload = @()
    foreach ($pr in $openPrs) {
        $openPrPayload += (ConvertTo-MechanicalJsonStateHashtable -Value $pr)
    }

    return Invoke-WorkerReportStoreCli -Subcommand 'resolveTrustedBinding' -Payload @{
        session           = $sessionPayload
        openPrs           = $openPrPayload
        worktreeHeadSha   = $headSha
        sessionGetPayload = $sessionGetHashtable
    }
}



function Resolve-PackWorkerReportDeliveryRunId {
    param(
        [string]$ReportState = '',
        [string]$SessionId = '',
        [int]$PrNumber = 0,
        [string]$HeadSha = '',
        [string]$DeliveryRunId = '',
        [string]$ProjectId = ''
    )

    if ([string]::IsNullOrWhiteSpace($ReportState) -or $ReportState -ne 'addressing_reviews') {
        return ''
    }
    if (-not [string]::IsNullOrWhiteSpace($DeliveryRunId)) {
        return [string]$DeliveryRunId
    }
    foreach ($envName in @('AO_DELIVERY_RUN_ID', 'AO_REVIEW_RUN_ID', 'AO_REVIEW_START_RUN_ID')) {
        $fromEnv = [Environment]::GetEnvironmentVariable($envName)
        if (-not [string]::IsNullOrWhiteSpace($fromEnv)) {
            return [string]$fromEnv
        }
    }
    if ([string]::IsNullOrWhiteSpace($SessionId) -or $PrNumber -le 0) {
        return ''
    }

    $reviewRuns = @()
    $aoCli = Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1'
    if (Test-Path -LiteralPath $aoCli) {
        . $aoCli
        $project = $ProjectId
        if ([string]::IsNullOrWhiteSpace($project)) {
            if ($env:AO_PROJECT_ID) { $project = [string]$env:AO_PROJECT_ID }
            else { $project = 'orchestrator-pack' }
        }
        try {
            $reviewRuns = @(Get-AoReviewRuns -Project $project)
        }
        catch {
            $reviewRuns = @()
        }
    }

    $runPayload = @()
    foreach ($run in $reviewRuns) {
        if ($null -eq $run) { continue }
        $runPayload += (ConvertTo-MechanicalJsonStateHashtable -Value $run)
    }
    $resolved = Invoke-WorkerReportStoreCli -Subcommand 'resolveDeliveryRunId' -Payload @{
        reportState   = [string]$ReportState
        sessionId     = [string]$SessionId
        prNumber      = [int]$PrNumber
        headSha       = [string]$HeadSha
        deliveryRunId = ''
        reviewRuns    = $runPayload
    }
    if ($resolved -and $resolved.deliveryRunId) {
        return [string]$resolved.deliveryRunId
    }
    return ''
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
        [long]$NowMs = 0,
        [string]$CallerSessionId = '',
        [string]$RepoRoot = '',
        [object]$TrustedBinding = $null,
        [string]$DeliveryRunId = ''
    )

    if (-not $NowMs) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $callerSessionId = $CallerSessionId
    if ([string]::IsNullOrWhiteSpace($callerSessionId)) {
        $callerSessionId = Resolve-PackWorkerReportCallerSessionId
    }
    if ([string]::IsNullOrWhiteSpace($callerSessionId)) {
        throw 'worker-report-store upsert failed: trust_boundary_session_mismatch'
    }
    if (-not [string]::IsNullOrWhiteSpace($SessionId) -and $SessionId -ne $callerSessionId) {
        throw 'worker-report-store upsert failed: trust_boundary_session_mismatch'
    }
    $trustedBinding = $TrustedBinding
    if (-not $trustedBinding) {
        $trustedBinding = Resolve-PackWorkerReportTrustedBinding -SessionId $callerSessionId `
            -RepoRoot $RepoRoot -RepoSlug $RepoSlug -WorktreeHeadSha $HeadSha
    }
    if ($trustedBinding -is [pscustomobject]) {
        $trustedBinding = ConvertTo-MechanicalJsonStateHashtable -Value $trustedBinding
    }
    if (-not $trustedBinding -or -not $trustedBinding.ok) {
        $reason = if ($trustedBinding.reason) { [string]$trustedBinding.reason } else { 'trust_boundary_binding_unresolved' }
        throw "worker-report-store upsert failed: $reason"
    }
    $SessionId = [string]$callerSessionId
    $PrNumber = [int]$trustedBinding.prNumber
    $HeadSha = [string]$trustedBinding.headSha
    if ([string]::IsNullOrWhiteSpace($RepoSlug)) {
        $RepoSlug = Resolve-WorkerReportStoreRepoSlug -RepoSlug '' -RepoRoot $RepoRoot
    }
    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $resolvedDeliveryRunId = Resolve-PackWorkerReportDeliveryRunId -ReportState $ReportState `
        -SessionId $SessionId -PrNumber $PrNumber -HeadSha $HeadSha -DeliveryRunId $DeliveryRunId
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
    if ($resolvedDeliveryRunId) {
        $recordPayload.deliveryRunId = $resolvedDeliveryRunId
    }
    $writeResult = $null
    $captured = @{}
    Update-WorkerReportStoreStateLocked -Path $path -NowMs $NowMs -Mutator {
        param($current)
        $applied = Invoke-WorkerReportStoreCli -Subcommand 'upsertRecord' -Payload @{
            store           = $current
            callerSessionId = $callerSessionId
            nowMs           = $NowMs
            record          = $recordPayload
            trustedBinding  = $trustedBinding
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
    if ($env:AO_REPO_SLUG) {
        return [string]$env:AO_REPO_SLUG
    }
    if ($env:GITHUB_REPOSITORY) {
        return [string]$env:GITHUB_REPOSITORY
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
        [long]$NonterminalMaxAgeMs = 0,
        [switch]$OpenListAuthoritative,
        [string]$RepoSlug = '',
        [string]$RepoRoot = ''
    )

    if (-not $NowMs) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $slug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug -RepoRoot $RepoRoot
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
        if ($OpenListAuthoritative) { $payload.openListAuthoritative = $true }
        if ($slug) { $payload.repoSlug = [string]$slug }
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
    param(
        [string]$StorePath = '',
        [string]$RepoRoot = '',
        [string]$RepoSlug = ''
    )

    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $store = Get-WorkerReportStoreState -Path $path
    $repoKey = ''
    if ($RepoSlug -or $RepoRoot) {
        $repoKey = [string](Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug -RepoRoot $RepoRoot)
        if ($repoKey) {
            $repoKey = $repoKey.Trim().ToLowerInvariant()
        }
    }
    $records = @($store.sourceRecords.PSObject.Properties | ForEach-Object { $_.Value })
    $candidates = @()
    foreach ($record in $records) {
        if (-not $record) { continue }
        if ($repoKey) {
            $recordSlug = [string]$record.repoSlug
            if ($recordSlug) {
                $recordSlug = $recordSlug.Trim().ToLowerInvariant()
            }
            if ($recordSlug -and $recordSlug -ne $repoKey) {
                continue
            }
        }
        $candidates += @{
            sessionId   = [string]$record.sessionId
            issueNumber = 0
            prNumber    = [int]$record.prNumber
        }
    }
    return @($candidates)
}
