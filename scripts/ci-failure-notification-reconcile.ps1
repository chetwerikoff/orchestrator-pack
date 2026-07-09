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
. (Join-Path $PSScriptRoot 'lib/Invoke-OrchestratorEscalationEmit.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-WorkerMessageDispatch.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-AutonomousNudgeGate.ps1')

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

    $resolvedOpenPrs = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot)
    $sessions = @(Get-AoStatusSessions)
    $sessionDetailsById = Build-AoSessionDetailsById -Sessions $sessions -Project $ProjectId
    $checksBundle = Get-ReconcileChecksByPr -RepoRoot $RepoRoot -OpenPrs @(
        @($resolvedOpenPrs | Where-Object { [int]$_.number -eq $PrNumber })
    )
    return @{
        openPrs                         = @($resolvedOpenPrs)
        sessions                        = @($sessions)
        sessionDetailsById              = $sessionDetailsById
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


function Test-CiFailureTransientPreSendHelperFailure {
    param(
        [object]$Recheck
    )

    if ($Recheck.hard_failure) { return $true }
    $reason = [string]$Recheck.reason
    return $reason -in @('helper_timeout', 'helper_error', 'wrapper_error')
}

function Test-CiFailurePreSendRecheckOutcome {
    param(
        [object]$Recheck,
        [string]$Digest,
        [string]$LogLabel,
        [object]$Episode,
        [string]$StoreDir,
        [string]$ReadSource = 'pre_send_ci_recheck'
    )

    if ($Recheck.ok -eq $true) { return $true }
    if (Test-CiFailureTransientPreSendHelperFailure -Recheck $Recheck) {
        Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "$LogLabel transient helper failure digest=$Digest reason=$($Recheck.reason) (episode remains claimed for retry)"
        return $false
    }
    Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "$LogLabel failed digest=$Digest reason=$($Recheck.reason)"
    Invoke-CiFailurePreSendRecheckFailure -Episode $Episode -StoreDir $StoreDir -Digest $Digest -Reason ([string]$Recheck.reason) -ReadSource $ReadSource
    return $false
}

function Test-CiFailureEpisodeDeliveryEvidence {
    param(
        [object]$IntentRecord,
        [bool]$DispatchDelivered,
        [bool]$DispatchInFlight
    )

    $sendDelivered = $null -ne $IntentRecord.sendDeliveredAtMs
    $sendIssued = $null -ne $IntentRecord.sendIssuedAtMs
    $ambiguousPostSend = $DispatchInFlight -and $sendIssued
    return $sendDelivered -or $DispatchDelivered -or $ambiguousPostSend
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
    $matches = @()
    foreach ($entry in @($journal.Values)) {
        if ([string]$entry.sessionId -eq $SessionId -and [string]$entry.sourceKey -eq $SourceKey) {
            $matches += $entry
        }
    }
    if ($matches.Count -eq 0) { return $null }
    return $matches | Sort-Object { [long]$_.deliveredAtMs } -Descending | Select-Object -First 1
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
        [object]$Episode,
        [string]$Message,
        [string]$IdempotencyKey,
        [string]$ProjectId = 'orchestrator-pack',
        [hashtable]$SendSnapshot = $null,
        [string]$DeliveryId = ''
    )

    $prNumber = [int]$Episode.prNumber
    $headSha = [string]$Episode.headSha
    $sessionId = [string]$Episode.targetId
    $redPeriod = [string]$Episode.redPeriod
    if (-not $redPeriod) {
        throw 'ci-failure episode missing redPeriod'
    }
    $cycleKey = "episode:$redPeriod"

    $openPrs = @()
    if ($SendSnapshot -and $SendSnapshot.openPrs) {
        $openPrs = @($SendSnapshot.openPrs)
    }

    $targetResolution = Resolve-WorkerNudgeTargetFromPrClaim -PrNumber $prNumber -SessionId $sessionId `
        -HeadSha $headSha -ProjectId $ProjectId -OpenPrs $openPrs
    if (-not $targetResolution.ok) {
        throw "PR-claim target unresolved: $($targetResolution.reason)"
    }
    $targetId = [string]$targetResolution.targetId
    $targetGeneration = [string]$targetResolution.targetGeneration
    $workerTarget = [string]$targetResolution.workerTarget
    if (-not $workerTarget) { $workerTarget = "$targetId`:$targetGeneration" }
    $sendSessionId = [string]$targetResolution.ownerSessionId
    if (-not $sendSessionId) { $sendSessionId = $sessionId }
    $tupleKey = "$prNumber|$cycleKey|ci-failure|$workerTarget"

    $claim = Acquire-WorkerNudgeClaim -PrNumber $prNumber -CycleKey $cycleKey -IntentClass 'ci-failure' `
        -WorkerTarget $workerTarget -SessionId $sendSessionId -TargetId $targetId -TargetGeneration $targetGeneration `
        -TupleKey $tupleKey -Surface 'ci-failure-notification-reconcile' -ProjectId $ProjectId -Message $Message
    if (-not $claim.acquired) {
        $claimPhase = if ($claim.phase) { [string]$claim.phase } elseif ($claim.claim -and $claim.claim.phase) { [string]$claim.claim.phase } else { '' }
        if ($claim.escalate) {
            $corr = "corr:ci-failure:${prNumber}:${headSha}"
            $dedupe = "dedupe:ci-failure:${prNumber}:${headSha}`:notify"
            Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-ci-failure-notify' `
                -SourceProcess 'ci-failure-notification-reconcile' -CorrelationKey $corr -DedupeKey $dedupe `
                -Diagnosis @{ prNumber = $prNumber; headSha = $headSha; reason = $claim.reason; diagnosis = $claim.diagnosis } | Out-Null
        }
        return @{
            ok           = $false
            reason       = [string]$claim.reason
            claimSkipped = $true
            claimPhase   = $claimPhase
            escalate     = [bool]$claim.escalate
            diagnosis    = [string]$claim.diagnosis
        }
    }

    $messageHashResult = Invoke-WorkerNudgeFilterCli -Subcommand 'hashMessageContent' -Payload @{ message = $Message }
    $messageContentHash = [string]$messageHashResult.messageContentHash
    $hashPersist = Set-WorkerNudgeClaimMessageContentHash -ClaimResult $claim -MessageContentHash $messageContentHash
    if (-not $hashPersist.ok) {
        Release-WorkerNudgeActiveClaim -ClaimResult $claim | Out-Null
        return @{ ok = $false; reason = 'message_hash_persist_failed'; detail = [string]$hashPersist.reason }
    }

    $claimToken = New-WorkerNudgeClaimToken -ClaimResult $claim
    Write-OrchestratorSideProcessProgress -ChildId 'ci-failure-notification-reconcile' -Phase 'side_effect'
    $journaledScript = Join-Path $PSScriptRoot 'journaled-worker-send.ps1'
    $sourceKey = if ($IdempotencyKey) { $IdempotencyKey } else { "ci-failure:$redPeriod" }
    $journaledArgs = @(
        $sendSessionId,
        '-Source', 'ci-failure-notification-reconcile',
        '-SourceKey', $sourceKey,
        '-ClaimToken', $claimToken,
        '-GatedNudge',
        '-NoWait'
    )
    if ($DeliveryId) {
        $journaledArgs += @('-DeliveryId', $DeliveryId)
    }
    $Message | pwsh -NoProfile -File $journaledScript @journaledArgs
    if ($LASTEXITCODE -ne 0) {
        throw "journaled worker send failed session=$sendSessionId exit=$LASTEXITCODE"
    }
    return @{ ok = $true; reason = 'sent' }
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


function Invoke-CiFailureDispatchJournalFinalize {
    param(
        [string]$DeliveryId,
        [string]$Digest
    )

    if (-not $DeliveryId) { return $false }
    try {
        $update = Update-WorkerMessageDispatchOutcome -DeliveryId $DeliveryId -DispatchOutcome 'dispatched' -DraftState 'draft_present'
        if (-not $update.updated) {
            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal finalize failed digest=$Digest delivery=$DeliveryId (will retry)"
            return $false
        }
        return $true
    }
    catch {
        Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal finalize failed digest=$Digest delivery=$DeliveryId error=$($_.Exception.Message) (will retry)"
        return $false
    }
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

        if (-not (Test-CiFailurePreSendRecheckOutcome -Recheck (Invoke-CiFailurePreSendCiRecheck -Episode $Episode) `
                -Digest $Digest -LogLabel 'pre-send recheck' -Episode $Episode -StoreDir $StoreDir)) {
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
    $idempotencyKey = [string]$intent.idempotencyKey
    $sendSnapshot = $null
    if ($Phase -eq 'full') {
        $sendSnapshot = Get-CiFailurePreSendSnapshot -PrNumber ([int]$Episode.prNumber)
    }
    $journalOpenPrs = @()
    if ($sendSnapshot -and $sendSnapshot.openPrs) {
        $journalOpenPrs = @($sendSnapshot.openPrs)
    }
    $journalTargetResolution = Resolve-WorkerNudgeTargetFromPrClaim -PrNumber ([int]$Episode.prNumber) `
        -SessionId $targetId -HeadSha ([string]$Episode.headSha) -ProjectId $ProjectId -OpenPrs $journalOpenPrs
    $journalSessionId = $targetId
    if ($journalTargetResolution.ok) {
        $resolvedOwner = [string]$journalTargetResolution.ownerSessionId
        if ($resolvedOwner) { $journalSessionId = $resolvedOwner }
    }
    $existingDispatch = Get-CiFailureDispatchJournalEntry -SessionId $journalSessionId -SourceKey $idempotencyKey
    $dispatchInFlight = $existingDispatch -and [string]$existingDispatch.dispatchOutcome -eq 'dispatch_in_flight'
    $dispatchDelivered = Test-CiFailureDispatchJournalDelivered -SessionId $journalSessionId -SourceKey $idempotencyKey
    $deliveryEvidence = Test-CiFailureEpisodeDeliveryEvidence -IntentRecord $intent.record `
        -DispatchDelivered $dispatchDelivered -DispatchInFlight ([bool]$dispatchInFlight)
    $sendDelivered = $null -ne $intent.record.sendDeliveredAtMs
    $skipSend = [bool]$intent.reentry -and $deliveryEvidence
    $dispatchDeliveryId = if ($existingDispatch) { [string]$existingDispatch.deliveryId } else { $null }

    if (-not $skipSend) {
        if ($Phase -eq 'full') {
            $sendRecheck = Invoke-CiFailureHelper -Mode 'pre-send-recheck' -Payload @{
                episode = $Episode
                fresh   = $sendSnapshot
            }
            if (-not (Test-CiFailurePreSendRecheckOutcome -Recheck $sendRecheck -Digest $Digest `
                    -LogLabel 'immediate pre-send recheck' -Episode $Episode -StoreDir $StoreDir -ReadSource 'pre_send_target_recheck')) {
                return $false
            }
        }
        if (-not $dispatchInFlight) {
            $dispatchRegister = Register-WorkerMessageDispatch -SessionId $journalSessionId -Message $message `
                -Source 'ci-failure-notification-reconcile' -SourceKey $idempotencyKey `
                -DeliveryPath 'pending-draft' -DispatchOutcome 'dispatch_in_flight'
            if (-not $dispatchRegister.recorded) {
                Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal pre-send record failed digest=$Digest reason=$($dispatchRegister.reason)"
                $null = Invoke-CiFailureHelper -Mode 'release-submit-intent' -Payload @{ storeDir = $StoreDir; episode = $Episode }
                return $false
            }
            $dispatchDeliveryId = [string]$dispatchRegister.deliveryId
        }

        $issued = Invoke-CiFailureHelper -Mode 'mark-send-issued' -Payload @{ storeDir = $StoreDir; episode = $Episode }
        if (-not $issued.ok) {
            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "mark-send-issued failed digest=$Digest reason=$($issued.reason)"
            $null = Invoke-CiFailureHelper -Mode 'release-submit-intent' -Payload @{ storeDir = $StoreDir; episode = $Episode }
            return $false
        }

        try {
            $sendResult = Invoke-PlannedCiFailureReconcileSend -Episode $Episode -Message $message `
                -IdempotencyKey $idempotencyKey -ProjectId $ProjectId -SendSnapshot $sendSnapshot -DeliveryId $dispatchDeliveryId
            if (-not $sendResult.ok) {
                if ($sendResult.claimSkipped) {
                    $claimSkipReason = [string]$sendResult.reason
                    Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "nudge suppressed by claim gate session=$targetId digest=$Digest reason=$claimSkipReason"
                    if ($claimSkipReason -eq 'already_served') {
                        $claimPhase = if ($sendResult.claimPhase) { [string]$sendResult.claimPhase } else { 'SENT' }
                        if ($claimPhase -eq 'UNCERTAIN') {
                            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "prior nudge claim uncertain; converging terminal delivery session=$targetId digest=$Digest"
                            try {
                                $update = Update-WorkerMessageDispatchOutcome -DeliveryId $dispatchDeliveryId -DispatchOutcome 'dispatch_unknown' -DraftState 'unknown'
                                if (-not $update.updated) {
                                    Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal dispatch_unknown update failed digest=$Digest delivery=$dispatchDeliveryId"
                                }
                            }
                            catch {
                                Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal dispatch_unknown update failed digest=$Digest error=$($_.Exception.Message)"
                            }
                        }
                        else {
                            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "prior nudge claim served; converging delivery session=$targetId digest=$Digest phase=$claimPhase"
                        }
                    }
                    else {
                        try {
                            $update = Update-WorkerMessageDispatchOutcome -DeliveryId $dispatchDeliveryId -DispatchOutcome 'send_failed' -DraftState 'unknown'
                            if (-not $update.updated) {
                                Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal send_failed update failed digest=$Digest delivery=$dispatchDeliveryId"
                            }
                        }
                        catch {
                            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal send_failed update failed digest=$Digest error=$($_.Exception.Message)"
                        }
                        $null = Invoke-CiFailureHelper -Mode 'release-submit-intent' -Payload @{ storeDir = $StoreDir; episode = $Episode }
                        return $false
                    }
                }
                else {
                    throw "planned ci-failure send failed digest=$Digest reason=$($sendResult.reason) detail=$($sendResult.detail)"
                }
            }
        }
        catch {
            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "planned worker ping failed session=$targetId digest=$Digest error=$($_.Exception.Message) (releasing submit intent for bounded retry)"
            try {
                $update = Update-WorkerMessageDispatchOutcome -DeliveryId $dispatchDeliveryId -DispatchOutcome 'send_failed' -DraftState 'unknown'
                if (-not $update.updated) {
                    Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal send_failed update failed digest=$Digest delivery=$dispatchDeliveryId"
                }
            }
            catch {
                Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dispatch journal send_failed update failed digest=$Digest error=$($_.Exception.Message)"
            }
            $null = Invoke-CiFailureHelper -Mode 'release-submit-intent' -Payload @{ storeDir = $StoreDir; episode = $Episode }
            return $false
        }

        $null = Invoke-CiFailureHelper -Mode 'mark-send-delivered' -Payload @{ storeDir = $StoreDir; episode = $Episode }
        $sendDelivered = $true
    }
    else {
        if (-not $sendDelivered -and $dispatchDelivered) {
            $null = Invoke-CiFailureHelper -Mode 'mark-send-delivered' -Payload @{ storeDir = $StoreDir; episode = $Episode }
        }
        Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "skip resend session=$targetId digest=$Digest phase=$Phase (durable delivery evidence)"
    }

    if (-not $dispatchDelivered -and $dispatchDeliveryId -and ($sendDelivered -or ($skipSend -and $dispatchInFlight))) {
        $null = Invoke-CiFailureDispatchJournalFinalize -DeliveryId $dispatchDeliveryId -Digest $Digest
        $dispatchDelivered = Test-CiFailureDispatchJournalDelivered -SessionId $journalSessionId -SourceKey $idempotencyKey
    }

    $null = Invoke-CiFailureHelper -Mode 'mark-submitted' -Payload @{ storeDir = $StoreDir; episode = $Episode }

    $journalRecorded = Test-CiFailureDispatchJournalDelivered -SessionId $journalSessionId -SourceKey $idempotencyKey
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

    $resolvedOpenPrs = if ($OpenPrs.Count -gt 0) { @($OpenPrs) } else { ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot) }
    $sessions = Get-AoStatusSessions
    $sessionDetailsById = Build-AoSessionDetailsById -Sessions @($sessions) -Project $ProjectId
    return @{
        sessions             = @($sessions)
        sessionDetailsById   = $sessionDetailsById
        openPrs              = @($resolvedOpenPrs)
    }
}

function Invoke-CiFailureNotificationTick {
    param(
        [hashtable]$WorkerState,
        [string]$StoreDir,
        [string]$EnqueueTickId
    )

    $repo = Get-RepoIdentity
    $openPrs = @($WorkerState.openPrs)
    if ($openPrs.Count -gt 0 -and -not $DryRun) {
        $checksBundle = Get-ReconcileChecksByPr -RepoRoot $RepoRoot -OpenPrs $openPrs
        $null = Invoke-CiFailureHelper -Mode 'sync-red-period-trackers' -Payload @{
            storeDir                      = $StoreDir
            repo                          = $repo
            openPrs                       = $openPrs
            ciChecksByPr                  = $checksBundle.ciChecksByPr
            requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
        }
    }

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
            if ($DryRun) {
                Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dry-run would expire episode digest=$($action.digest)"
                continue
            }
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
            if ($DryRun) {
                Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dry-run would recover_in_flight state=$($action.state) digest=$($action.digest)"
                continue
            }
            $episode = $action.episode
            $phase = if ($action.state -eq 'claimed') { 'full' } else { 'post-intent' }
            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "recover_in_flight state=$($action.state) digest=$($action.digest) phase=$phase"
            $null = Invoke-CiFailureEpisodeDelivery -Episode $episode -WorkerState $WorkerState `
                -StoreDir $StoreDir -Digest ([string]$action.digest) -Phase $phase
            continue
        }
        if ($action.type -ne 'evaluate') { continue }

        $episode = $action.episode
        if ($DryRun) {
            $dedup = Get-CiFailureDedupPayload -StoreDir $StoreDir
            $preview = Invoke-CiFailureHelper -Mode 'preflight-revalidate' -Payload @{
                storeDir       = $StoreDir
                episode        = $episode
                workerState    = $WorkerState
                reactionEvents = @($dedup.reactionEvents)
                intentTokens   = @($dedup.intentTokens)
            }
            $previewAction = if ($preview.action -eq 'send_allowed') { 'send ci-failed ping' } else { "skip ($($preview.action))" }
            Write-CiFailureNotificationLog -Prefix $Script:ReconcileLogPrefix -Message "dry-run would evaluate digest=$($action.digest) -> $previewAction"
            continue
        }
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
