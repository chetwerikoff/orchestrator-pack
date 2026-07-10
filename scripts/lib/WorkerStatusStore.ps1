#requires -Version 5.1
<#
.SYNOPSIS
  Pack-derived worker-status store PowerShell bridge (Issue #720).
#>

$Script:WorkerStatusStoreCli = Join-Path $PSScriptRoot 'worker-status-store.mjs'
$Script:PackWorkerStatusStoreSurface = 'pack-worker-status-store'
$Script:WorkerStatusKillSwitchEnv = 'PACK_WORKER_STATUS_STORE_DISABLED'

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

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
    $raw = Get-Content -LiteralPath $storePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $payload = ConvertTo-MechanicalJsonStateHashtable -Value $raw
    return Invoke-WorkerStatusStoreCli -Subcommand 'migrate' -Payload $payload
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
    return [bool]$result.ready
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
        $report = $reports[$reports.Count - 1]
    }

    $prNumber = 0
    if ($session.prNumber) { $prNumber = [int]$session.prNumber }
    $headSha = ''
    if ($session.ownedHeadSha) { $headSha = [string]$session.ownedHeadSha }
    elseif ($session.headRefOid) { $headSha = [string]$session.headRefOid }

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

    $recomputePayload = @{
        sessionId        = $sessionId
        binding          = @{ ok = $true; prNumber = $prNumber; headSha = $headSha }
        github           = @{
            prOpen             = $true
            headSha            = $headSha
            reviewRuns         = @()
            ciChecks           = @()
            requiredCheckNames = @()
            repoTickGeneration = $repoTickGen
        }
        report           = $report
        osLiveness       = 'pane-alive'
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
