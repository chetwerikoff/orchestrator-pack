#requires -Version 5.1
<#
.SYNOPSIS
  Pack-derived worker-status store PowerShell bridge (Issue #720).
#>

$Script:WorkerStatusStoreCli = Join-Path $PSScriptRoot 'worker-status-store.mjs'
$Script:PackWorkerStatusStoreSurface = 'pack-worker-status-store'
$Script:WorkerStatusKillSwitchEnv = 'PACK_WORKER_STATUS_STORE_DISABLED'

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Get-WorkerOsLiveness.ps1')

function Import-WorkerStatusGithubDependencies {
    if ($script:WorkerStatusGithubDependenciesLoaded) {
        return
    }
    . (Join-Path $PSScriptRoot 'Autonomous-GateCommon.ps1')
    . (Join-Path $PSScriptRoot 'Gh-PrChecks.ps1')
    . (Join-Path $PSScriptRoot 'Get-ReconcileChecksByPr.ps1')
    . (Join-Path $PSScriptRoot 'Review-PostRunRetry.ps1')
    $script:WorkerStatusGithubDependenciesLoaded = $true
}

function New-WorkerStatusEmptyGithubSnapshot {
    param([string]$RepoRoot = '')

    return @{
        openPrs                       = @()
        reviewRuns                    = @()
        ciChecksByPr                  = @{}
        requiredCheckNamesByPr        = @{}
        requiredCheckLookupFailedByPr = @{}
        repoRoot                      = $RepoRoot
        degraded                      = $true
    }
}

function Get-WorkerStatusTrackedPrNumbers {
    param([object[]]$Sessions = @())

    $tracked = @()
    foreach ($session in @($Sessions)) {
        if ($null -ne $session.prNumber) {
            $pr = 0
            if ([int]::TryParse([string]$session.prNumber, [ref]$pr) -and $pr -gt 0) {
                $tracked += $pr
            }
        }
        foreach ($report in @($session.reports)) {
            if ($null -eq $report) { continue }
            $reportPr = 0
            if ([int]::TryParse([string]$report.prNumber, [ref]$reportPr) -and $reportPr -gt 0) {
                $tracked += $reportPr
            }
        }
    }
    return @($tracked | Sort-Object -Unique)
}


function Test-WorkerStatusSessionsNeedPackBindingResolution {
    param([object[]]$Sessions = @())

    foreach ($session in @($Sessions)) {
        if ($null -ne $session.prNumber) {
            $pr = 0
            if ([int]::TryParse([string]$session.prNumber, [ref]$pr) -and $pr -gt 0) {
                continue
            }
        }
        $hasReportPr = $false
        foreach ($report in @($session.reports)) {
            if ($null -eq $report) { continue }
            $reportPr = 0
            if ([int]::TryParse([string]$report.prNumber, [ref]$reportPr) -and $reportPr -gt 0) {
                $hasReportPr = $true
                break
            }
        }
        if ($hasReportPr) { continue }
        if ($null -ne $session.issueId -or $null -ne $session.issueNumber) {
            return $true
        }
        $displayName = [string]$session.displayName
        if ($displayName -and $displayName -match '^\d+$') {
            return $true
        }
    }
    return $false
}

function Resolve-WorkerStatusSessionBinding {
    param(
        [object]$Session,
        [object]$GithubSnapshot,
        [int]$PrNumber = 0,
        [string]$HeadSha = ''
    )

    if ($PrNumber -gt 0) {
        return @{ ok = $true; prNumber = $PrNumber; headSha = $HeadSha }
    }
    $openPrPayload = @()
    if ($GithubSnapshot -and $GithubSnapshot.openPrs) {
        foreach ($pr in @($GithubSnapshot.openPrs)) {
            $openPrPayload += (ConvertTo-MechanicalJsonStateHashtable -Value $pr)
        }
    }
    $sessionPayload = ConvertTo-MechanicalJsonStateHashtable -Value $Session
    return Invoke-WorkerStatusStoreCli -Subcommand 'resolveSessionBinding' -Payload @{
        session  = $sessionPayload
        openPrs  = $openPrPayload
        headSha  = $HeadSha
        prNumber = $PrNumber
    }
}

function Get-WorkerStatusRecomputeGithubSnapshot {
    param(
        [string]$RepoRoot = '',
        [string]$Project = 'orchestrator-pack',
        [object[]]$Sessions = @()
    )

    Import-WorkerStatusGithubDependencies
    $repoRoot = Resolve-PackGateRepoRoot -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot
    $empty = New-WorkerStatusEmptyGithubSnapshot -RepoRoot $repoRoot
    try {
        $tracked = @(Get-WorkerStatusTrackedPrNumbers -Sessions $Sessions)
        $needsPackBinding = Test-WorkerStatusSessionsNeedPackBindingResolution -Sessions $Sessions
        $openPrs = if ($needsPackBinding) {
            @(Invoke-GhOpenPrList -RepoRoot $repoRoot -Consumer 'worker-status-recompute')
        }
        elseif ($tracked.Count -gt 0) {
            @(Invoke-GhOpenPrListForNumbers -RepoRoot $repoRoot -PrNumbers $tracked -Consumer 'worker-status-recompute')
        }
        else {
            @()
        }
        $checksBundle = Get-ReconcileChecksByPr -RepoRoot $repoRoot -OpenPrs $openPrs
        $reviewRuns = @()
        try {
            $reviewRuns = @(Get-EnrichedAoReviewRuns -Project $Project -RepoRoot $repoRoot)
        }
        catch {
            $reviewRuns = @()
        }
        return @{
            openPrs                       = @($openPrs)
            reviewRuns                    = @($reviewRuns)
            ciChecksByPr                  = $checksBundle.ciChecksByPr
            requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
            repoRoot                      = $repoRoot
            degraded                      = $false
        }
    }
    catch {
        return $empty
    }
}

function Resolve-WorkerStatusSessionGithubBlock {
    param(
        [object]$Session,
        [hashtable]$Snapshot,
        [int]$PrNumber = 0,
        [string]$HeadSha = ''
    )

    if (-not $Snapshot) {
        return $null
    }
    if (-not $PrNumber) {
        if ($null -ne $Session.prNumber) {
            $PrNumber = [int]$Session.prNumber
        }
        else {
            foreach ($report in @($Session.reports)) {
                if ($null -eq $report) { continue }
                $reportPr = 0
                if ([int]::TryParse([string]$report.prNumber, [ref]$reportPr) -and $reportPr -gt 0) {
                    $PrNumber = $reportPr
                    break
                }
            }
        }
    }
    $openPr = $null
    if ($PrNumber -gt 0) {
        $openPr = $Snapshot.openPrs | Where-Object { [int]$_.number -eq $PrNumber } | Select-Object -First 1
    }
    $prOpen = ($null -ne $openPr)
    $resolvedHead = $HeadSha
    if ($openPr -and $openPr.headRefOid) {
        $resolvedHead = [string]$openPr.headRefOid
    }
    $prKey = if ($PrNumber -gt 0) { [string]$PrNumber } else { '' }
    $snapshotDegraded = [bool]$Snapshot.degraded
    return @{
        prOpen                    = $prOpen
        headSha                   = $resolvedHead
        reviewRuns                = @($Snapshot.reviewRuns)
        ciChecks                  = if ($prKey) { @($Snapshot.ciChecksByPr[$prKey]) } else { @() }
        requiredCheckNames        = if ($prKey) { @($Snapshot.requiredCheckNamesByPr[$prKey]) } else { @() }
        requiredCheckLookupFailed = if ($snapshotDegraded) { $true } elseif ($prKey) { [bool]$Snapshot.requiredCheckLookupFailedByPr[$prKey] } else { $false }
        unavailable               = $snapshotDegraded
        degraded                  = $snapshotDegraded
    }
}

function Get-WorkerStatusStorePath {
    if ($env:AO_WORKER_STATUS_STORE) {
        return $env:AO_WORKER_STATUS_STORE
    }
    if ($env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR) {
        return Join-Path $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR 'worker-status-store.json'
    }
    $stateRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.local/state/orchestrator-pack-wake-supervisor'
    return Join-Path $stateRoot 'worker-status-store.json'
}

function Get-WorkerStatusStoreLockPath {
    param([string]$StorePath = '')

    $path = if ($StorePath) { $StorePath } else { Get-WorkerStatusStorePath }
    $dir = Split-Path -Parent $path
    if (-not $dir) {
        return Join-Path ([System.IO.Path]::GetTempPath()) 'worker-status-store.lock'
    }
    return Join-Path $dir 'worker-status-store.lock'
}

function Invoke-WorkerStatusStoreCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerStatusStoreCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'worker-status-store' -JsonDepth 30
}

function Get-WorkerStatusStoreState {
    param([string]$Path = '')

    $storePath = if ($Path) { $Path } else { Get-WorkerStatusStorePath }
    if (-not (Test-Path -LiteralPath $storePath -PathType Leaf)) {
        return Invoke-WorkerStatusStoreCli -Subcommand 'migrate' -Payload @{}
    }
    try {
        $rawText = Get-Content -LiteralPath $storePath -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($rawText)) {
            throw 'empty_worker_status_store'
        }
        $raw = $rawText | ConvertFrom-Json
        $payload = ConvertTo-MechanicalJsonStateHashtable -Value $raw
        return Invoke-WorkerStatusStoreCli -Subcommand 'migrate' -Payload $payload
    }
    catch {
        return Invoke-WorkerStatusStoreCli -Subcommand 'migrate' -Payload @{ schemaRejected = $true }
    }
}

function Set-WorkerStatusStoreState {
    param(
        [string]$Path,
        [object]$State
    )

    $default = @{
        schemaVersion = 1
        lastUpdatedMs = $null
        generation    = 0
        records       = @{}
    }
    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $default -JsonDepth 30
}

function Update-WorkerStatusStoreStateLocked {
    param(
        [string]$Path,
        [scriptblock]$Mutator,
        [long]$NowMs
    )

    $lockPath = Get-WorkerStatusStoreLockPath -StorePath $Path
    return Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Metadata @{
        purpose = 'worker-status-store'
    } -Action {
        $current = Get-WorkerStatusStoreState -Path $Path
        $next = & $Mutator $current
        if (-not $next.lastUpdatedMs) {
            $next.lastUpdatedMs = $NowMs
        }
        Set-WorkerStatusStoreState -Path $Path -State $next
        return $next
    }
}

function Test-WorkerStatusKillSwitchActive {
    $result = Invoke-WorkerStatusStoreCli -Subcommand 'evaluateKillSwitch' -Payload @{
        env = @{ PACK_WORKER_STATUS_STORE_DISABLED = $env:PACK_WORKER_STATUS_STORE_DISABLED }
    }
    return [bool]$result.disabled
}

function Test-WorkerStatusSiblingReadiness {
    $result = Invoke-WorkerStatusStoreCli -Subcommand 'testSiblingReadiness' -Payload @{
        env = @{
            AO_WORKER_REPORT_STORE                      = $env:AO_WORKER_REPORT_STORE
            ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR = $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR
        }
    }
    return $result
}

function Write-WorkerStatusRow {
    param(
        [hashtable]$Input,
        [hashtable]$RecomputeInput = $null,
        [string]$StorePath = '',
        [long]$NowMs = 0
    )

    $payload = if ($RecomputeInput) { $RecomputeInput } else { $Input }
    if (-not $payload) {
        return @{ ok = $false; reason = 'missing_input' }
    }

    if (-not $NowMs) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $path = if ($StorePath) { $StorePath } else { Get-WorkerStatusStorePath }

    $session = $payload.session
    $sessionId = [string]$(
        if ($payload.sessionId) { $payload.sessionId }
        elseif ($session.id) { $session.id }
        elseif ($session.name) { $session.name }
        else { $session.sessionId }
    )
    if (-not $sessionId) {
        return @{ ok = $false; reason = 'missing_session_id' }
    }

    $writerVector = $payload.writerGenerationVector
    if (-not $writerVector) {
        $writerVector = $payload.sourceGeneration
    }
    if (-not $writerVector) {
        $writerVector = @{}
    }

    $report = $null
    $reports = @($payload.reports)
    if ($reports.Count -gt 0) {
        $report = $reports[0]
    }

    $prNumber = 0
    if ($null -ne $session.prNumber) {
        $prNumber = [int]$session.prNumber
    }
    elseif ($report -and $null -ne $report.prNumber) {
        $prNumber = [int]$report.prNumber
    }
    else {
        foreach ($candidate in $reports) {
            if ($null -eq $candidate) { continue }
            $candidatePr = 0
            if ([int]::TryParse([string]$candidate.prNumber, [ref]$candidatePr) -and $candidatePr -gt 0) {
                $prNumber = $candidatePr
                break
            }
        }
    }
    $headSha = ''
    if ($session.ownedHeadSha) { $headSha = [string]$session.ownedHeadSha }
    elseif ($session.headRefOid) { $headSha = [string]$session.headRefOid }
    elseif ($report -and $report.headSha) { $headSha = [string]$report.headSha }

    $repoTickGen = 0
    if ($writerVector.repoTickGeneration) { $repoTickGen = [int]$writerVector.repoTickGeneration }
    $reportStoreGen = 0
    if ($writerVector.reportStoreGeneration) { $reportStoreGen = [int]$writerVector.reportStoreGeneration }
    $journalCursor = 0
    if ($writerVector.journalCursor) { $journalCursor = [int]$writerVector.journalCursor }
    $bindingGen = 0
    if ($writerVector.bindingCacheGeneration) { $bindingGen = [int]$writerVector.bindingCacheGeneration }

    $sessionActivity = ''
    if ($session.activity) { $sessionActivity = [string]$session.activity }
    elseif ($session.state) { $sessionActivity = [string]$session.state }

    $githubSnapshot = $payload.githubSnapshot

    $binding = Resolve-WorkerStatusSessionBinding -Session $session -GithubSnapshot $githubSnapshot `
        -PrNumber $prNumber -HeadSha $headSha
    if ($binding.ok) {
        $prNumber = [int]$binding.prNumber
        if ($binding.headSha) { $headSha = [string]$binding.headSha }
    }
    else {
        $bindingReason = 'binding_miss'
        if ($binding.reason) { $bindingReason = [string]$binding.reason }
        $binding = @{
            ok       = $false
            reason   = $bindingReason
            prNumber = $prNumber
            headSha  = $headSha
        }
    }

    $githubBlock = $payload.github
    if (-not $githubBlock) {
        $githubBlock = Resolve-WorkerStatusSessionGithubBlock -Session $session -Snapshot $githubSnapshot `
            -PrNumber $prNumber -HeadSha $headSha
    }
    if (-not $githubBlock) {
        $githubBlock = @{
            prOpen                    = $false
            headSha                   = $headSha
            reviewRuns                = @()
            ciChecks                  = @()
            requiredCheckNames        = @()
            requiredCheckLookupFailed = $false
        }
    }
    $githubBlock['repoTickGeneration'] = $repoTickGen

    $osLiveness = $payload.osLiveness
    if (-not $osLiveness) {
        $osLiveness = Get-WorkerOsLiveness -SessionId $sessionId
    }

    $recomputePayload = @{
        sessionId        = $sessionId
        binding          = $binding
        github           = $githubBlock
        report           = $report
        osLiveness       = $osLiveness
        sessionActivity  = $sessionActivity
        sourceGeneration = @{
            repoTickGeneration     = $repoTickGen
            reportStoreGeneration  = $reportStoreGen
            journalCursor          = $journalCursor
            bindingCacheGeneration = $bindingGen
        }
        nowMs            = $NowMs
    }

    $captured = @{}
    Update-WorkerStatusStoreStateLocked -Path $path -NowMs $NowMs -Mutator {
        param($current)
        $cliPayload = @{ store = $current }
        foreach ($key in $recomputePayload.Keys) {
            $cliPayload[$key] = $recomputePayload[$key]
        }
        $result = Invoke-WorkerStatusStoreCli -Subcommand 'recompute' -Payload $cliPayload
        $captured.result = $result
        return $result.store
    } | Out-Null
    return $captured.result
}

function Invoke-WorkerStatusStoreEviction {
    param(
        [object[]]$Sessions = @(),
        [string]$StorePath = '',
        [long]$NowMs = 0
    )

    if (-not $NowMs) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $path = if ($StorePath) { $StorePath } else { Get-WorkerStatusStorePath }
    $captured = @{}
    Update-WorkerStatusStoreStateLocked -Path $path -NowMs $NowMs -Mutator {
        param($current)
        $result = Invoke-WorkerStatusStoreCli -Subcommand 'evict' -Payload @{
            store    = $current
            sessions = @($Sessions)
            nowMs    = $NowMs
        }
        $captured.summary = @{
            removed     = [int]$result.removed
            recordCount = [int]$result.recordCount
        }
        return $result.store
    } | Out-Null
    return $captured.summary
}

function Merge-SessionsWithWorkerStatusStore {
    param(
        [object[]]$Sessions,
        [string]$StorePath = '',
        [long]$NowMs = 0,
        [long]$RepoTickGeneration = 0
    )

    if (-not $NowMs) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $path = if ($StorePath) { $StorePath } else { Get-WorkerStatusStorePath }
    $store = Get-WorkerStatusStoreState -Path $path
    $result = Invoke-WorkerStatusStoreCli -Subcommand 'mergeIntoSessions' -Payload @{
        sessions           = @($Sessions)
        store              = $store
        nowMs              = $NowMs
        repoTickGeneration = $RepoTickGeneration
    }
    if ($result -is [array]) {
        return @($result)
    }
    return @($result.sessions)
}

function Merge-AoSessionRowsWithWorkerStatusStore {
    param(
        [object[]]$Sessions,
        [string]$StorePath = '',
        [long]$NowMs = 0,
        [long]$RepoTickGeneration = 0
    )

    return @(Merge-SessionsWithWorkerStatusStore -Sessions $Sessions -StorePath $StorePath `
            -NowMs $NowMs -RepoTickGeneration $RepoTickGeneration)
}
