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

. (Join-Path $PSScriptRoot 'lib/Ci-Failure-Notification-Common.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-ReconcileChecksByPr.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-WorkerMessageDispatch.ps1')

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
        [int]$PrNumber
    )

    $resolvedOpenPrs = @((Invoke-GhOpenPrList -RepoRoot $RepoRoot))
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
        [object]$Episode
    )

    $fresh = Get-CiFailurePreSendSnapshot -PrNumber ([int]$Episode.prNumber)
    return Invoke-CiFailureHelper -Mode 'pre-send-recheck' -Payload @{
        episode = $Episode
        fresh   = $fresh
    }
}


function Invoke-CiFailurePreSendRecheckFailure {
    param(
        [object]$Episode,
        [string]$StoreDir,
        [string]$Digest,
        [string]$Reason,
        [string]$ReadSource = 'pre_send_ci_recheck'
    )

    if ($Reason -match '^ci_not_red:') {
        Invoke-CiFailureTerminalizeCiRecovered -Episode $Episode -StoreDir $StoreDir -Reason $Reason
        return
    }
    $terminalReason = switch ($Reason) {
        'abandoned-superseded' { 'abandoned-superseded' }
        'abandoned-no-live-owner' { 'abandoned-no-live-owner' }
        default { 'abandoned-superseded' }
    }
    $null = Invoke-CiFailureHelper -Mode 'terminalize' -Payload @{
        storeDir       = $StoreDir
        episode        = $Episode
        terminalReason = $terminalReason
        terminalAction = 'SUPPRESS'
        readSource     = $ReadSource
        diagnostics    = @{ pre_send_recheck = $Reason }
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


function Get-CiFailureDispatchJournalEntry {
    param(
        [string]$SessionId,
        [string]$SourceKey
    )

    if (-not $SourceKey) { return $null }
    $journal = Get-WorkerMessageDispatchJournal
    foreach ($entry in @($journal.Values)) {
        if ([string]$entry.sessionId -eq $SessionId -and [string]$entry.sourceKey -eq $SourceKey) {
            return $entry
        }
    }
    return $null
}

function Test-CiFailureDispatchJournalDelivered {
    param(
        [string]$SessionId,
        [string]$SourceKey
    )

    $entry = Get-CiFailureDispatchJournalEntry -SessionId $SessionId -SourceKey $SourceKey
    if (-not $entry) { return $false }
    $outcome = [string]$entry.dispatchOutcome
    return $outcome -eq 'dispatched' -or $outcome -eq 'dispatch_unknown'
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
        Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "preflight hard_failure digest=$Digest reason=$($Preflight.reason)"
        return $false
    }
    if ($Preflight.action -eq 'suppressed') {
        Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "preflight suppressed digest=$Digest"
        return $false
    }
    if ($Preflight.action -ne 'send_allowed') {
        Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "preflight rejected malformed action=$($Preflight.action) digest=$Digest"
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

    # post-intent recovery must not run pre-send CI recheck; complete journal/ack only.
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

        $recheck = Invoke-CiFailurePreSendCiRecheck -Episode $Episode
        if (-not $recheck.ok) {
            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "pre-send recheck failed digest=$Digest reason=$($recheck.reason)"
            Invoke-CiFailurePreSendRecheckFailure -Episode $Episode -StoreDir $StoreDir -Digest $Digest -Reason ([string]$recheck.reason)
            return $false
        }
    }

    $intent = Invoke-CiFailureHelper -Mode 'reserve-intent' -Payload @{
        storeDir = $StoreDir
        episode  = $Episode
    }
    if ($intent.hard_failure) {
        Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "reserve-intent hard_failure digest=$Digest reason=$($intent.reason)"
        return $false
    }
    if (-not $intent.reserved) {
        Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "reserve-intent not reserved digest=$Digest reason=$($intent.reason)"
        return $false
    }

    $targetId = [string]$Episode.targetId
    $message = 'Required CI failed for your PR. Fix failing checks and ao report fixing_ci.'
    $recordState = [string]$intent.record.state
    $sendDelivered = $null -ne $intent.record.sendDeliveredAtMs
    $idempotencyKey = [string]$intent.idempotencyKey
    $dispatchDelivered = Test-CiFailureDispatchJournalDelivered -SessionId $targetId -SourceKey $idempotencyKey
    $skipSend = [bool]$intent.reentry -and (
        $recordState -eq 'submitted-unacked' -or
        $sendDelivered -or
        $dispatchDelivered
    )
    if ($DryRun) {
        $dryRunAction = if ($skipSend) { 'complete delivery without resend' } else { 'send ci-failed ping' }
        Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dry-run would $dryRunAction session=$targetId digest=$Digest phase=$Phase"
        return $true
    }

    if (-not $skipSend) {
        if ($Phase -eq 'full') {
            $sendSnapshot = Get-CiFailurePreSendSnapshot -PrNumber ([int]$Episode.prNumber)
            $sendRecheck = Invoke-CiFailureHelper -Mode 'pre-send-recheck' -Payload @{
                episode = $Episode
                fresh   = $sendSnapshot
            }
            if (-not $sendRecheck.ok) {
                Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "immediate pre-send recheck failed digest=$Digest reason=$($sendRecheck.reason)"
                Invoke-CiFailurePreSendRecheckFailure -Episode $Episode -StoreDir $StoreDir -Digest $Digest -Reason ([string]$sendRecheck.reason) -ReadSource 'pre_send_target_recheck'
                return $false
            }
        }
        $existingDispatch = Get-CiFailureDispatchJournalEntry -SessionId $targetId -SourceKey $idempotencyKey
        $dispatchDeliveryId = $null
        if ($existingDispatch -and [string]$existingDispatch.dispatchOutcome -eq 'dispatch_in_flight') {
            $dispatchDeliveryId = [string]$existingDispatch.deliveryId
        }
        else {
            $dispatchRegister = Register-WorkerMessageDispatch -SessionId $targetId -Message $message `
                -Source 'ci-failure-notification-reconcile' -SourceKey $idempotencyKey `
                -DeliveryPath 'pending-draft' -DispatchOutcome 'dispatch_in_flight'
            if (-not $dispatchRegister.recorded) {
                Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal pre-send record failed digest=$Digest reason=$($dispatchRegister.reason)"
                $null = Invoke-CiFailureHelper -Mode 'release-submit-intent' -Payload @{ storeDir = $StoreDir; episode = $Episode }
                return $false
            }
            $dispatchDeliveryId = [string]$dispatchRegister.deliveryId
        }

        try {
            Invoke-PlannedCiFailureReconcileSend -TargetId $targetId -Message $message `
                -IdempotencyKey $idempotencyKey
        }
        catch {
            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "ao send failed session=$targetId digest=$Digest error=$($_.Exception.Message) (releasing submit intent for retry)"
            $null = Invoke-CiFailureHelper -Mode 'release-submit-intent' -Payload @{ storeDir = $StoreDir; episode = $Episode }
            return $false
        }

        $null = Invoke-CiFailureHelper -Mode 'mark-send-delivered' -Payload @{ storeDir = $StoreDir; episode = $Episode }
        try {
            $update = Update-WorkerMessageDispatchOutcome -DeliveryId $dispatchDeliveryId -DispatchOutcome 'dispatched' -DraftState 'draft_present'
            if (-not $update.updated) {
                Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal outcome update failed digest=$Digest delivery=$dispatchDeliveryId (send delivered; journal will retry)"
            }
        }
        catch {
            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal outcome update failed digest=$Digest error=$($_.Exception.Message) (send delivered; journal will retry)"
        }
    }
    else {
        if (-not $sendDelivered -and $dispatchDelivered) {
            $null = Invoke-CiFailureHelper -Mode 'mark-send-delivered' -Payload @{ storeDir = $StoreDir; episode = $Episode }
        }
        Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "skip resend session=$targetId digest=$Digest phase=$Phase (durable delivery evidence)"
    }

    $null = Invoke-CiFailureHelper -Mode 'mark-submitted' -Payload @{ storeDir = $StoreDir; episode = $Episode }

    $journalRecorded = Test-CiFailureDispatchJournalDelivered -SessionId $targetId -SourceKey $idempotencyKey
    if (-not $journalRecorded) {
        Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "preserving submitted-unacked digest=$Digest phase=$Phase (journal retry pending)"
        return $true
    }

    $null = Invoke-CiFailureHelper -Mode 'resolve-delivery' -Payload @{
        storeDir     = $StoreDir
        episode      = $Episode
        acknowledged = $true
    }
    Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "sent ci-failed ping session=$targetId digest=$Digest phase=$Phase"
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
    if ($plan.hard_failure) {
        throw "ci-failure reconcile-plan hard_failure: $($plan.reason)"
    }

    foreach ($action in @($plan.actions)) {
        if ($action.type -eq 'expire') {
            $expirePayload = @{
                storeDir = $StoreDir
                episode  = $action.episode
            }
            if ($action.freshnessSla) { $expirePayload.freshnessSla = $true }
            $result = Invoke-CiFailureHelper -Mode 'expire' -Payload $expirePayload
            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "expired episode digest=$($action.digest) reason=$($result.audit.reason)"
            continue
        }
        if ($action.type -eq 'recover_in_flight') {
            $episode = $action.episode
            $phase = if ($action.state -eq 'claimed') { 'full' } else { 'post-intent' }
            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "recover_in_flight state=$($action.state) digest=$($action.digest) phase=$phase"
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
            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "claim hard_failure digest=$($action.digest) reason=$($claim.reason)"
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
    $store = Get-CiFailureNotificationStoreDir -ProjectIdOverride $ProjectId
    $tickId = "fixture-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    $null = Invoke-CiFailureNotificationTick -WorkerState @{
        sessions = @($fixture.sessions)
        openPrs  = @($fixture.openPrs)
    } -StoreDir $store -EnqueueTickId $tickId
    exit 0
}

$storeDir = Get-CiFailureNotificationStoreDir -ProjectIdOverride $ProjectId
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
