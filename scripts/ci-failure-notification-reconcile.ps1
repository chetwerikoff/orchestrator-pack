#requires -Version 7.0
<#
.SYNOPSIS
  CI-failure notification episode reconcile loop (Issue #342).

.DESCRIPTION
  Evaluates pending red-CI episodes against live worker state at delivery time.
  Never ao spawn, --claim-pr, or ao session kill. Uses Register-WorkerMessageDispatch (#232).
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [string]$StateDir = '',
    [int]$IntervalMinutes = 1,
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'
$Script:ReconcileLogPrefix = 'ci-failure-notification-reconcile'

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = $PackRoot }

$HelperCli = Join-Path $PackRoot 'docs/ci-failure-notification.mjs'
$Wrapper = Join-Path $PackRoot 'scripts/ci-failure-notification.ps1'

. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-WorkerMessageDispatch.ps1')

function Write-CiFailureReconcileLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReconcileLogPrefix): $Message"
}

function Get-CiFailureNotificationStoreDir {
    if ($StateDir) { return Join-Path $StateDir 'ci-failure-notification' }
    if ($env:AO_CI_FAILURE_NOTIFICATION_STORE) { return $env:AO_CI_FAILURE_NOTIFICATION_STORE.Trim() }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-ci-failure-notification'
}

function Invoke-CiFailureHelper {
    param(
        [string]$Mode,
        [hashtable]$Payload
    )
    $json = $Payload | ConvertTo-Json -Compress -Depth 30
    $output = $json | pwsh -NoProfile -ExecutionPolicy Bypass -File $Wrapper -Mode $Mode 2>&1
    if ($LASTEXITCODE -ne 0) { throw "ci-failure-notification.ps1 -Mode $Mode exited $LASTEXITCODE`: $output" }
    return ($output | Out-String).Trim() | ConvertFrom-Json
}

function Invoke-PlannedCiFailureReconcileSend {
    param(
        [string]$TargetId,
        [string]$Message,
        [string]$IdempotencyKey
    )

    Write-OrchestratorSideProcessProgress -ChildId 'ci-failure-notification-reconcile' -Phase 'side_effect'
    $sendArgs = @('send', $TargetId, $Message)
    & ao @sendArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "ao send failed session=$TargetId exit=$LASTEXITCODE"
    }

    return Register-WorkerMessageDispatch -SessionId $TargetId -Message $Message `
        -Source 'ci-failure-notification-reconcile' -SourceKey $IdempotencyKey -DeliveryPath 'pending-draft'
}

function Get-CiFailureWorkerStateSnapshot {
    param([array]$OpenPrs = @())

    $resolvedOpenPrs = if ($OpenPrs.Count -gt 0) { @($OpenPrs) } else { @((Invoke-GhOpenPrList -RepoRoot $RepoRoot)) }
    $sessions = Get-AoStatusSessions
    return @{
        sessions = @($sessions)
        openPrs  = @($resolvedOpenPrs)
    }
}

function Invoke-CiFailureNotificationTick {
    param(
        [hashtable]$WorkerState,
        [string]$StoreDir,
        [string]$EnqueueTickId
    )

    $plan = Invoke-CiFailureHelper -Mode 'reconcile-plan' -Payload @{
        storeDir       = $StoreDir
        nowMs          = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        enqueueTickId  = $EnqueueTickId
        workerState    = $WorkerState
    }

    foreach ($action in @($plan.actions)) {
        if ($action.type -eq 'expire') {
            $result = Invoke-CiFailureHelper -Mode 'expire' -Payload @{
                storeDir = $StoreDir
                episode  = $action.episode
            }
            Write-CiFailureReconcileLog "expired episode digest=$($action.digest) reason=$($result.audit.reason)"
            continue
        }
        if ($action.type -ne 'evaluate') { continue }

        $episode = $action.episode
        $claim = Invoke-CiFailureHelper -Mode 'claim-preflight' -Payload @{
            storeDir    = $StoreDir
            episode     = $episode
            claimOwner  = $EnqueueTickId
        }
        if (-not $claim.claimed) { continue }

        $preflight = Invoke-CiFailureHelper -Mode 'preflight-revalidate' -Payload @{
            storeDir      = $StoreDir
            episode       = $episode
            workerState   = $WorkerState
            reactionEvents = @()
            intentTokens   = @()
        }
        if ($preflight.action -eq 'suppressed' -or $preflight.action -eq 'hard_failure') {
            Write-CiFailureReconcileLog "preflight $($preflight.action) digest=$($action.digest)"
            continue
        }

        $intent = Invoke-CiFailureHelper -Mode 'reserve-intent' -Payload @{
            storeDir = $StoreDir
            episode  = $episode
        }
        if (-not $intent.reserved) { continue }

        $targetId = [string]$episode.targetId
        $message = 'Required CI failed for your PR. Fix failing checks and ao report fixing_ci.'
        if ($DryRun) {
            Write-CiFailureReconcileLog "dry-run would send ci-failed ping session=$targetId digest=$($action.digest)"
            continue
        }

        try {
            $null = Invoke-PlannedCiFailureReconcileSend -TargetId $targetId -Message $message `
                -IdempotencyKey ([string]$intent.idempotencyKey)
        }
        catch {
            Write-CiFailureReconcileLog "ao send failed session=$targetId error=$($_.Exception.Message)"
            continue
        }
        $null = Invoke-CiFailureHelper -Mode 'mark-submitted' -Payload @{ storeDir = $StoreDir; episode = $episode }
        $null = Invoke-CiFailureHelper -Mode 'resolve-delivery' -Payload @{
            storeDir      = $StoreDir
            episode       = $episode
            acknowledged  = $true
        }
        Write-CiFailureReconcileLog "sent ci-failed ping session=$targetId digest=$($action.digest)"
    }

    return $plan
}

if ($FixturePath) {
    $fixture = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
    $store = Get-CiFailureNotificationStoreDir
    $tickId = "fixture-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    $null = Invoke-CiFailureNotificationTick -WorkerState @{
        sessions = @($fixture.sessions)
        openPrs  = @($fixture.openPrs)
    } -StoreDir $store -EnqueueTickId $tickId
    exit 0
}

$storeDir = Get-CiFailureNotificationStoreDir
if (-not (Test-Path -LiteralPath $storeDir)) {
    New-Item -ItemType Directory -Path $storeDir -Force | Out-Null
}

do {
    try {
        Write-OrchestratorSideProcessProgress -ChildId 'ci-failure-notification-reconcile' -Phase 'poll'
        $tickId = "tick-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        $workerState = Get-CiFailureWorkerStateSnapshot
        $null = Invoke-CiFailureNotificationTick -WorkerState $workerState -StoreDir $storeDir -EnqueueTickId $tickId
        Write-OrchestratorSideProcessTickSuccess -ChildId 'ci-failure-notification-reconcile'
    }
    catch {
        Write-OrchestratorSideProcessTickError -ChildId 'ci-failure-notification-reconcile' -ErrorMessage "$_"
        if ($Once) { exit 1 }
    }
    if ($Once) { break }
    Start-Sleep -Seconds ([Math]::Max(30, $IntervalMinutes * 60))
} while ($true)
