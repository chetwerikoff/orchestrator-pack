#requires -Version 5.1
<#
.SYNOPSIS
  Pack-owned worker report store read/write helpers.
.DESCRIPTION
  Report authority is an exact adapter-produced runtime worker identity plus an
  exact GitHub PR/head binding. Pre-v3 session-keyed records are ignored by the
  mechanical store and are never migrated into authority.
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Gh-FleetInventoryCache.ps1')
. (Join-Path $PSScriptRoot 'Get-RuntimeWorkers.ps1')
. (Join-Path $PSScriptRoot 'Get-PackReviewRuns.ps1')

$Script:WorkerReportStoreCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/worker-report-store.mjs'
$Script:PackWorkerReportStoreSurface = 'pack-worker-report-store'

function Get-WorkerReportStorePath {
    if ($env:OPK_WORKER_REPORT_STORE) { return [string]$env:OPK_WORKER_REPORT_STORE }
    if ($env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR) {
        return Join-Path $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR 'worker-report-store.json'
    }
    if ($env:OPK_REPORT_STATE_SEED_STATE) {
        $dir = Split-Path -Parent $env:OPK_REPORT_STATE_SEED_STATE
        if ($dir) { return Join-Path $dir 'worker-report-store.json' }
    }
    return Join-Path ([Environment]::GetFolderPath('UserProfile')) '.local/state/orchestrator-pack-wake-supervisor/worker-report-store.json'
}

function Get-WorkerReportStoreLockPath {
    param([string]$StorePath = '')
    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $dir = Split-Path -Parent $path
    if (-not $dir) { return Join-Path ([System.IO.Path]::GetTempPath()) 'worker-report-store.lock' }
    return Join-Path $dir 'worker-report-store.lock'
}

function Invoke-WorkerReportStoreCli {
    param([Parameter(Mandatory = $true)][string]$Subcommand, [hashtable]$Payload)
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerReportStoreCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'worker-report-store' -JsonDepth 30
}

function Get-WorkerReportStoreState {
    param([string]$Path = '')
    $storePath = if ($Path) { $Path } else { Get-WorkerReportStorePath }
    if (-not (Test-Path -LiteralPath $storePath -PathType Leaf)) {
        return Invoke-WorkerReportStoreCli -Subcommand 'normalize' -Payload @{}
    }
    $raw = Get-Content -LiteralPath $storePath -Raw -Encoding UTF8 | ConvertFrom-Json
    return Invoke-WorkerReportStoreCli -Subcommand 'normalize' -Payload (ConvertTo-MechanicalJsonStateHashtable -Value $raw)
}

function Set-WorkerReportStoreState {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][object]$State)
    $default = @{
        schemaVersion = 3; lastUpdatedMs = $null; generation = 0; sourceRecords = @{};
        bindingByKey = @{}; seededKeys = @(); deferredScanKeys = @(); githubSnapshot = $null
    }
    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $default -JsonDepth 30
}

function Update-WorkerReportStoreStateLocked {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][scriptblock]$Mutator,
        [Parameter(Mandatory = $true)][long]$NowMs
    )
    return Invoke-OrchestratorSideEffectFenced -LockPath (Get-WorkerReportStoreLockPath -StorePath $Path) `
        -Metadata @{ purpose = 'worker-report-store' } -Action {
            $current = Get-WorkerReportStoreState -Path $Path
            $next = & $Mutator $current
            if (-not $next.lastUpdatedMs) { $next.lastUpdatedMs = $NowMs }
            Set-WorkerReportStoreState -Path $Path -State $next
            return $next
        }
}

function ConvertTo-PackRuntimeWorkerIdentity {
    param([Parameter(Mandatory = $true)][object]$Worker)
    $identity = if ($Worker.PSObject.Properties.Name -contains 'identity') { $Worker.identity } else { $Worker }
    $runtime = [string]$identity.runtime
    $id = [string]$identity.id
    $generation = [string]$identity.generation
    if ([string]::IsNullOrWhiteSpace($runtime) -or [string]::IsNullOrWhiteSpace($id) -or [string]::IsNullOrWhiteSpace($generation)) {
        return $null
    }
    return @{ runtime = $runtime; id = $id; generation = $generation }
}

function Resolve-PackWorkerReportRuntimeWorker {
    param(
        [string]$RepoRoot = '',
        [string]$Runtime = '',
        [string]$WorkerId = '',
        [string]$Generation = '',
        [string]$Adapter = '',
        [int]$TimeoutMs = 5000
    )
    $hasAny = $Runtime -or $WorkerId -or $Generation
    if ($hasAny -and (-not $Runtime -or -not $WorkerId -or -not $Generation)) {
        return @{ ok = $false; reason = 'incomplete_runtime_worker_identity' }
    }
    try {
        if ($hasAny) {
            $result = Find-RuntimeWorker -Runtime $Runtime -Id $WorkerId -Generation $Generation `
                -Adapter $Adapter -Cwd $RepoRoot -TimeoutMs $TimeoutMs
            if ([string]$result.status -ne 'ok' -or -not $result.value) {
                return @{ ok = $false; reason = 'runtime_worker_not_current' }
            }
            $identity = ConvertTo-PackRuntimeWorkerIdentity -Worker $result.value
            if (-not $identity -or $identity.runtime -ne $Runtime -or $identity.id -ne $WorkerId -or $identity.generation -ne $Generation) {
                return @{ ok = $false; reason = 'runtime_worker_identity_mismatch' }
            }
            return @{ ok = $true; worker = $identity }
        }

        $result = Get-RuntimeWorkers -Adapter $Adapter -Cwd $RepoRoot -TimeoutMs $TimeoutMs `
            -Workspace ($(if ($RepoRoot) { $RepoRoot } else { 'active' }))
        if ([string]$result.status -ne 'ok') { return @{ ok = $false; reason = 'runtime_worker_list_failed' } }
        $workers = @($result.value)
        if ($workers.Count -ne 1) { return @{ ok = $false; reason = 'runtime_worker_not_unique' } }
        $identity = ConvertTo-PackRuntimeWorkerIdentity -Worker $workers[0]
        if (-not $identity) { return @{ ok = $false; reason = 'runtime_worker_identity_malformed' } }
        return @{ ok = $true; worker = $identity }
    }
    catch {
        return @{ ok = $false; reason = 'runtime_worker_resolution_failed'; detail = $_.Exception.Message }
    }
}

function Resolve-PackWorkerReportWorktreeHeadSha {
    param([string]$RepoRoot = '', [string]$HeadSha = '')
    if (-not [string]::IsNullOrWhiteSpace($HeadSha)) { return [string]$HeadSha }
    if ($env:GITHUB_SHA) { return [string]$env:GITHUB_SHA }
    $cwd = if ($RepoRoot) { $RepoRoot } else { (Get-Location).Path }
    $previous = Get-Location
    try {
        Set-Location $cwd
        return [string]((& git rev-parse HEAD 2>$null | Select-Object -First 1))
    }
    finally { Set-Location $previous }
}

function Resolve-PackWorkerReportTrustedBinding {
    param(
        [Parameter(Mandatory = $true)][object]$Worker,
        [string]$RepoRoot = '',
        [string]$WorktreeHeadSha = '',
        [int]$PrNumber = 0
    )
    $identity = ConvertTo-PackRuntimeWorkerIdentity -Worker $Worker
    if (-not $identity) { return @{ ok = $false; reason = 'missing_runtime_worker_identity' } }
    $headSha = Resolve-PackWorkerReportWorktreeHeadSha -RepoRoot $RepoRoot -HeadSha $WorktreeHeadSha
    if ([string]::IsNullOrWhiteSpace($headSha)) { return @{ ok = $false; reason = 'missing_head_sha' } }
    try {
        $ghPrChecks = Join-Path $PSScriptRoot 'Gh-PrChecks.ps1'
        if (Test-Path -LiteralPath $ghPrChecks) { . $ghPrChecks }
        $openPrs = @(Invoke-GhOpenPrList -RepoRoot $RepoRoot -Consumer 'pack-worker-report-trusted-binding')
    }
    catch { return @{ ok = $false; reason = 'github_pr_binding_unavailable' } }
    $payloadPrs = @($openPrs | ForEach-Object { ConvertTo-MechanicalJsonStateHashtable -Value $_ })
    return Invoke-WorkerReportStoreCli -Subcommand 'resolveTrustedBinding' -Payload @{
        worker = $identity; openPrs = $payloadPrs; worktreeHeadSha = $headSha; prNumber = $PrNumber
    }
}

function Resolve-PackWorkerReportDeliveryRunId {
    param(
        [string]$ReportState = '',
        [int]$PrNumber = 0,
        [string]$HeadSha = '',
        [string]$DeliveryRunId = '',
        [string]$ProjectId = 'orchestrator-pack'
    )
    if ($ReportState -ne 'addressing_reviews') { return '' }
    if (-not [string]::IsNullOrWhiteSpace($DeliveryRunId)) { return [string]$DeliveryRunId }
    foreach ($name in @('OPK_DELIVERY_RUN_ID', 'OPK_REVIEW_RUN_ID', 'OPK_REVIEW_START_RUN_ID')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if (-not [string]::IsNullOrWhiteSpace($value)) { return [string]$value }
    }
    if ($PrNumber -le 0 -or [string]::IsNullOrWhiteSpace($HeadSha)) { return '' }
    try {
        $payload = Get-PackReviewRuns -Project $ProjectId
        $runs = @(Get-PackReviewRunsFromPayload -Payload $payload -Project $ProjectId)
    }
    catch { $runs = @() }
    $resolved = Invoke-WorkerReportStoreCli -Subcommand 'resolveDeliveryRunId' -Payload @{
        reportState = $ReportState; prNumber = $PrNumber; headSha = $HeadSha;
        deliveryRunId = ''; reviewRuns = @($runs | ForEach-Object { ConvertTo-MechanicalJsonStateHashtable -Value $_ })
    }
    return $(if ($resolved.deliveryRunId) { [string]$resolved.deliveryRunId } else { '' })
}

function Write-PackWorkerReportRecord {
    param(
        [Parameter(Mandatory = $true)][string]$ReportState,
        [Parameter(Mandatory = $true)][object]$Worker,
        [string]$RepoSlug,
        [int]$PrNumber,
        [string]$HeadSha,
        [bool]$Accepted = $true,
        [string]$Note = '',
        [string]$Reason = '',
        [string]$HandoffKind = '',
        [bool]$DegradedCiEscalation = $false,
        [string]$StorePath = '',
        [long]$NowMs = 0,
        [string]$RepoRoot = '',
        [object]$TrustedBinding = $null,
        [string]$DeliveryRunId = ''
    )
    if (-not $NowMs) { $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $identity = ConvertTo-PackRuntimeWorkerIdentity -Worker $Worker
    if (-not $identity) { throw 'worker-report-store upsert failed: missing_runtime_worker_identity' }
    if (-not $TrustedBinding) {
        $TrustedBinding = Resolve-PackWorkerReportTrustedBinding -Worker $identity -RepoRoot $RepoRoot `
            -WorktreeHeadSha $HeadSha -PrNumber $PrNumber
    }
    if ($TrustedBinding -is [pscustomobject]) { $TrustedBinding = ConvertTo-MechanicalJsonStateHashtable -Value $TrustedBinding }
    if (-not $TrustedBinding -or -not $TrustedBinding.ok) {
        throw "worker-report-store upsert failed: $([string]$TrustedBinding.reason)"
    }
    $PrNumber = [int]$TrustedBinding.prNumber
    $HeadSha = [string]$TrustedBinding.headSha
    $RepoSlug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug -RepoRoot $RepoRoot
    if (-not $RepoSlug) { throw 'worker-report-store upsert failed: missing_repo_slug' }
    $resolvedRunId = Resolve-PackWorkerReportDeliveryRunId -ReportState $ReportState -PrNumber $PrNumber `
        -HeadSha $HeadSha -DeliveryRunId $DeliveryRunId
    $record = @{
        reportState = $ReportState; accepted = $Accepted; worker = $identity; repoSlug = $RepoSlug;
        prNumber = $PrNumber; headSha = $HeadSha; reportedAtMs = $NowMs; lastObservedMs = $NowMs
    }
    if ($resolvedRunId) { $record.deliveryRunId = $resolvedRunId }
    if ($Note) { $record.note = $Note }
    if ($Reason) { $record.reason = $Reason }
    if ($HandoffKind) { $record.handoffKind = $HandoffKind }
    if ($DegradedCiEscalation) { $record.degradedCiEscalation = $true }
    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $captured = @{}
    Update-WorkerReportStoreStateLocked -Path $path -NowMs $NowMs -Mutator {
        param($current)
        $applied = Invoke-WorkerReportStoreCli -Subcommand 'upsertRecord' -Payload @{
            store = $current; nowMs = $NowMs; record = $record; trustedBinding = $TrustedBinding
        }
        if (-not $applied.ok) { throw "worker-report-store upsert failed: $($applied.reason)" }
        $captured.result = $applied
        return $applied.store
    } | Out-Null
    return @{ ok = $true; key = $captured.result.key; record = $captured.result.record; generation = $captured.result.generation }
}

function Build-WorkerReportStoreCurrentHeadByPr {
    param([object[]]$OpenPrs = @(), [string]$RepoSlug = '', [string]$RepoRoot = '')
    $slug = [string](Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug -RepoRoot $RepoRoot)
    $repoKey = $slug.Trim().ToLowerInvariant()
    $map = @{}
    foreach ($pr in @($OpenPrs)) {
        if (-not $pr) { continue }
        $number = [int]$pr.number
        $head = [string]$pr.headRefOid
        if ($number -le 0 -or -not $head) { continue }
        $map[[string]$number] = $head
        if ($repoKey) { $map["$repoKey|$number"] = $head }
    }
    return $map
}

function Resolve-WorkerReportStoreRepoSlug {
    param([string]$RepoSlug = '', [string]$RepoRoot = '')
    if ($RepoSlug) { return $RepoSlug }
    if ($env:GITHUB_REPOSITORY) { return [string]$env:GITHUB_REPOSITORY }
    $root = if ($RepoRoot) { $RepoRoot } else { Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
    return Resolve-GhFleetRepoSlug -RepoRoot $root
}

function Merge-RuntimeWorkerRowsWithWorkerReportStore {
    param([object[]]$Sessions, [string]$RepoRoot = '', [string]$RepoSlug = '', [string]$StorePath = '')
    return Merge-RuntimeWorkerRowsWithPackWorkerReports -Workers $Sessions -RepoRoot $RepoRoot -RepoSlug $RepoSlug -StorePath $StorePath
}

function Merge-RuntimeWorkerRowsWithPackWorkerReports {
    param([object[]]$Workers, [string]$RepoRoot = '', [string]$RepoSlug = '', [string]$StorePath = '')
    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $slug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug -RepoRoot $RepoRoot
    return @(Invoke-WorkerReportStoreCli -Subcommand 'mergeIntoWorkers' -Payload @{
        workers = @($Workers); store = (Get-WorkerReportStoreState -Path $path); repoSlug = $slug
    })
}

function Invoke-WorkerReportStoreEviction {
    param(
        [object[]]$OpenPrs = @(), [hashtable]$CurrentHeadByPr = @{}, [string]$StorePath = '',
        [long]$NowMs = 0, [long]$MaxAgeMs = 0, [long]$NonterminalMaxAgeMs = 0,
        [switch]$OpenListAuthoritative, [string]$RepoSlug = '', [string]$RepoRoot = ''
    )
    if (-not $NowMs) { $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $slug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug -RepoRoot $RepoRoot
    $captured = @{}
    Update-WorkerReportStoreStateLocked -Path $path -NowMs $NowMs -Mutator {
        param($current)
        $payload = @{ store = $current; openPrs = @($OpenPrs); currentHeadByPr = $CurrentHeadByPr; nowMs = $NowMs }
        if ($MaxAgeMs -gt 0) { $payload.maxAgeMs = $MaxAgeMs }
        if ($NonterminalMaxAgeMs -gt 0) { $payload.nonterminalMaxAgeMs = $NonterminalMaxAgeMs }
        if ($OpenListAuthoritative) { $payload.openListAuthoritative = $true }
        if ($slug) { $payload.repoSlug = $slug }
        $result = Invoke-WorkerReportStoreCli -Subcommand 'evict' -Payload $payload
        $captured.summary = @{ removed = [int]$result.removed; recordCount = [int]$result.recordCount }
        return $result.store
    } | Out-Null
    return $captured.summary
}

function Get-PackWorkerReportDiscoveryCandidates {
    param([string]$StorePath = '', [string]$RepoRoot = '', [string]$RepoSlug = '')
    $path = if ($StorePath) { $StorePath } else { Get-WorkerReportStorePath }
    $store = Get-WorkerReportStoreState -Path $path
    $repoKey = [string](Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug -RepoRoot $RepoRoot)
    $repoKey = $repoKey.Trim().ToLowerInvariant()
    $candidates = @()
    foreach ($property in @($store.sourceRecords.PSObject.Properties)) {
        $record = $property.Value
        if (-not $record) { continue }
        if ($repoKey -and ([string]$record.repoSlug).Trim().ToLowerInvariant() -ne $repoKey) { continue }
        $candidates += @{ worker = $record.worker; issueNumber = 0; prNumber = [int]$record.prNumber }
    }
    return @($candidates)
}
