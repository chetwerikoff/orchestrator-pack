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
. (Join-Path $PSScriptRoot 'lib/Get-ReconcileChecksByPr.ps1')
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

function Get-CiFailureReactionEvents {
    return @(Get-AoEventsSince -SinceMinutes 120 | Where-Object {
            $type = [string]$_.type
            if ($type -ne 'reaction.action_succeeded') { return $false }
            $reactionKey = [string]($_.reactionKey ?? $_.reaction?.key ?? $_.metadata?.reactionKey ?? $_.details?.reactionKey ?? $_.data?.reactionKey ?? $_.data?.reaction?.key ?? '')
            return $reactionKey -eq 'ci-failed'
        })
}

function Get-CiFailureIntentTokens {
    param([string]$StoreDir)
    $result = Invoke-CiFailureHelper -Mode 'list-intent-tokens' -Payload @{ storeDir = $StoreDir }
    return @($result.tokens)
}

function Get-CiFailureDedupPayload {
    param([string]$StoreDir)
    return @{
        reactionEvents = @(Get-CiFailureReactionEvents)
        intentTokens   = @(Get-CiFailureIntentTokens -StoreDir $StoreDir)
    }
}

function Get-CiFailurePreSendSnapshot {
    param(
        [int]$PrNumber,
        [array]$OpenPrs = @()
    )

    $resolvedOpenPrs = if ($OpenPrs.Count -gt 0) { @($OpenPrs) } else { @((Invoke-GhOpenPrList -RepoRoot $RepoRoot)) }
    $sessions = @(Get-AoStatusSessions)
    $checksBundle = Get-ReconcileChecksByPr -RepoRoot $RepoRoot -OpenPrs @(
        @($resolvedOpenPrs | Where-Object { [int]$_.number -eq $PrNumber })
    )
    return @{
        openPrs                         = @($resolvedOpenPrs)
        sessions                        = @($sessions)
        ciChecksByPr                    = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr          = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr   = $checksBundle.requiredCheckLookupFailedByPr
        nowMs                           = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
}

function Invoke-CiFailurePreSendCiRecheck {
    param(
        [object]$Episode,
        [array]$OpenPrs = @()
    )

    $fresh = Get-CiFailurePreSendSnapshot -PrNumber ([int]$Episode.prNumber) -OpenPrs $OpenPrs
    return Invoke-CiFailureHelper -Mode 'pre-send-recheck' -Payload @{
        episode = $Episode
        fresh   = $fresh
    }
}

function Invoke-CiFailureTerminalizeCiRecovered {
    param(
        [object]$Episode,
        [string]$StoreDir,
        [string]$Reason
    )

    $null = Invoke-CiFailureHelper -Mode 'terminalize' -Payload @{
        storeDir       = $StoreDir
        episode        = $Episode
        terminalReason = 'abandoned-ci-recovered'
        terminalAction = 'SUPPRESS'
        readSource     = 'pre_send_ci_recheck'
        diagnostics    = @{ ci_recheck = $Reason }
    }
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
}

function Test-CiFailurePreflightOutcome {
    param(
        [object]$Preflight,
        [string]$Digest
    )
    if ($Preflight.hard_failure -or $Preflight.action -eq 'hard_failure') {
        Write-CiFailureReconcileLog "preflight hard_failure digest=$Digest reason=$($Preflight.reason)"
        return $false
    }
    if ($Preflight.action -eq 'suppressed') {
        Write-CiFailureReconcileLog "preflight suppressed digest=$Digest"
        return $false
    }
    if ($Preflight.action -ne 'send_allowed') {
        Write-CiFailureReconcileLog "preflight rejected malformed action=$($Preflight.action) digest=$Digest"
        return $false
    }
    return $true
}

function Invoke-CiFailureEpisodeDelivery {
    param(
        [object]$Episode,
        [hashtable]$WorkerState,
        [string]$StoreDir,
        [string]$Digest,
        [ValidateSet('full', 'post-intent')]
        [string]$Phase = 'full'
    )

    $dedup = Get-CiFailureDedupPayload -StoreDir $StoreDir

    if ($Phase -eq 'full') {
        $preflight = Invoke-CiFailureHelper -Mode 'preflight-revalidate' -Payload @{
            storeDir       = $StoreDir
            episode        = $Episode
            workerState    = $WorkerState
            reactionEvents = @($dedup.reactionEvents)
            intentTokens   = @($dedup.intentTokens)
        }
        if (-not (Test-CiFailurePreflightOutcome -Preflight $preflight -Digest $Digest)) {
            return $false
        }
    }

    $recheck = Invoke-CiFailurePreSendCiRecheck -Episode $Episode -OpenPrs @($WorkerState.openPrs)
    if (-not $recheck.ok) {
        Write-CiFailureReconcileLog "pre-send CI recheck failed digest=$Digest reason=$($recheck.reason)"
        Invoke-CiFailureTerminalizeCiRecovered -Episode $Episode -StoreDir $StoreDir -Reason ([string]$recheck.reason)
        return $false
    }

    $intent = Invoke-CiFailureHelper -Mode 'reserve-intent' -Payload @{
        storeDir = $StoreDir
        episode  = $Episode
    }
    if ($intent.hard_failure) {
        Write-CiFailureReconcileLog "reserve-intent hard_failure digest=$Digest reason=$($intent.reason)"
        return $false
    }
    if (-not $intent.reserved) {
        Write-CiFailureReconcileLog "reserve-intent not reserved digest=$Digest reason=$($intent.reason)"
        return $false
    }

    $targetId = [string]$Episode.targetId
    $message = 'Required CI failed for your PR. Fix failing checks and ao report fixing_ci.'
    if ($DryRun) {
        Write-CiFailureReconcileLog "dry-run would send ci-failed ping session=$targetId digest=$Digest phase=$Phase"
        return $true
    }

    try {
        Invoke-PlannedCiFailureReconcileSend -TargetId $targetId -Message $message `
            -IdempotencyKey ([string]$intent.idempotencyKey)
    }
    catch {
        Write-CiFailureReconcileLog "ao send failed session=$targetId digest=$Digest error=$($_.Exception.Message)"
        return $false
    }

    $null = Invoke-CiFailureHelper -Mode 'mark-submitted' -Payload @{ storeDir = $StoreDir; episode = $Episode }

    try {
        $dispatchResult = Register-WorkerMessageDispatch -SessionId $targetId -Message $message `
            -Source 'ci-failure-notification-reconcile' -SourceKey ([string]$intent.idempotencyKey) -DeliveryPath 'pending-draft'
        $outcome = Resolve-DispatchJournalSendOutcomeAfterDelivered -DispatchResult $dispatchResult
        if (-not $outcome.journalRecorded) {
            Write-CiFailureReconcileLog "dispatch journal record failed digest=$Digest reason=$($outcome.journalFailureReason) (send delivered; deduped, journal will retry)"
        }
    }
    catch {
        Write-CiFailureReconcileLog "dispatch journal record failed digest=$Digest error=$($_.Exception.Message) (send delivered; preserving submitted-unacked)"
    }

    $null = Invoke-CiFailureHelper -Mode 'resolve-delivery' -Payload @{
        storeDir     = $StoreDir
        episode      = $Episode
        acknowledged = $true
    }
    Write-CiFailureReconcileLog "sent ci-failed ping session=$targetId digest=$Digest phase=$Phase"
    return $true
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
        if ($action.type -eq 'recover_in_flight') {
            $episode = $action.episode
            $phase = if ($action.state -eq 'claimed') { 'full' } else { 'post-intent' }
            Write-CiFailureReconcileLog "recover_in_flight state=$($action.state) digest=$($action.digest) phase=$phase"
            $null = Invoke-CiFailureEpisodeDelivery -Episode $episode -WorkerState $WorkerState `
                -StoreDir $StoreDir -Digest ([string]$action.digest) -Phase $phase
            continue
        }
        if ($action.type -ne 'evaluate') { continue }

        $episode = $action.episode
        $claim = Invoke-CiFailureHelper -Mode 'claim-preflight' -Payload @{
            storeDir    = $StoreDir
            episode     = $episode
            claimOwner  = $EnqueueTickId
        }
        if ($claim.hard_failure) {
            Write-CiFailureReconcileLog "claim hard_failure digest=$($action.digest) reason=$($claim.reason)"
            continue
        }
        if (-not $claim.claimed) { continue }

        $null = Invoke-CiFailureEpisodeDelivery -Episode $episode -WorkerState $WorkerState `
            -StoreDir $StoreDir -Digest ([string]$action.digest) -Phase 'full'
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
