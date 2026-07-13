#requires -Version 5.1
<#
.SYNOPSIS
  Record an AO-attributed worker message dispatch in the shared journal (Issue #232).

.DESCRIPTION
  Pack senders call this after a successful ao send / review delivery (automatic on 0.10) so the unified
  submit arbiter can derive pending-draft delivery path from message shape — never
  from pane text. Human keystrokes do not write journal entries.
#>

$PackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$DispatchCli = Join-Path $PackRoot 'docs/worker-message-dispatch-observe.mjs'

. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-WakeSupervisorStateRoot.ps1')

function Get-WorkerMessageDispatchJournalPath {
    if ($env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL) {
        return $env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL
    }
    $stateRoot = Get-OrchestratorWakeSupervisorStateRoot
    if (-not (Test-Path -LiteralPath $stateRoot)) {
        New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    }
    return Join-Path $stateRoot 'worker-message-dispatch-journal.json'
}

function Get-WorkerMessageDispatchJournalLockPath {
    param([string]$JournalPath = '')

    $journalPath = if ($JournalPath) { $JournalPath } else { Get-WorkerMessageDispatchJournalPath }
    return "${journalPath}.lock"
}

function Get-WorkerMessageDispatchJournal {
    param([string]$Path = '')

    $journalPath = if ($Path) { $Path } else { Get-WorkerMessageDispatchJournalPath }
    return Get-MechanicalJsonStateFile -Path $journalPath -DefaultState @{} -ActionTracking
}

function Set-WorkerMessageDispatchJournal {
    param(
        [string]$Path = '',
        [hashtable]$Journal
    )

    $journalPath = if ($Path) { $Path } else { Get-WorkerMessageDispatchJournalPath }
    $dir = Split-Path -Parent $journalPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Set-MechanicalJsonStateFile -Path $journalPath -State $Journal -DefaultState @{} -JsonDepth 20
}

function Invoke-DispatchShapeCli {
    param(
        [string]$Message,
        [string]$SenderSessionId = ''
    )

    $payload = @{
        message         = $Message
        senderSessionId = $SenderSessionId
    } | ConvertTo-Json -Compress
    $output = $payload | & node $DispatchCli classify 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "worker-message-dispatch-observe.mjs classify exited ${LASTEXITCODE}: $output"
    }
    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    return $text | ConvertFrom-Json
}


function Invoke-DispatchJournalCli {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Subcommand,
        [hashtable]$Payload
    )

    $tempPaths = New-MechanicalTransportTempPaths
    $inputPath = $tempPaths.InputPath
    $outputPath = $tempPaths.OutputPath
    try {
        $json = $Payload | ConvertTo-Json -Depth 20 -Compress
        Write-MechanicalTransportPrivateFile -Path $inputPath -Content $json
        $stderr = & node $DispatchCli $Subcommand --input-file $inputPath --output-file $outputPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "worker-message-dispatch-observe.mjs $Subcommand exited ${LASTEXITCODE}: $stderr"
        }
        return Read-MechanicalNodeFilterCliOutput -OutputPath $outputPath -Label 'worker-message-dispatch-observe' -Subcommand $Subcommand
    }
    finally {
        Remove-MechanicalTransportTempPaths -Paths @($inputPath, $outputPath)
    }
}


function ConvertTo-WorkerMessageSafeIdComponent {
    param([string]$Value)

    $text = [string]$Value
    if (-not $text.Trim()) { return '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($bytes)
    }
    finally {
        $sha.Dispose()
    }
    return 'sha256-' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 24)
}

function New-WorkerMessageDispatchJournalRecord {
    param(
        [string]$DeliveryId,
        [string]$SessionId,
        [long]$DeliveredAtMs,
        [string]$Source,
        [string]$SourceKey = '',
        [string]$DeliveryPath,
        [object]$MessageShape,
        [string]$DispatchOutcome = 'dispatch_in_flight',
        [string]$DraftState = 'unknown',
        [switch]$RestoreRetry,
        [switch]$AdoptionProbe,
        [string]$AoEpochHash = '',
        [string]$ConfigPathHash = '',
        [string]$AdoptionProbeRunIdHash = ''
    )

    return @{
        deliveryId      = $DeliveryId
        sessionId       = $SessionId
        deliveredAtMs   = $DeliveredAtMs
        source          = $Source
        sourceKey       = $SourceKey
        deliveryPath    = $DeliveryPath
        messageShape    = @{
            charLength = [int]$MessageShape.charLength
            lineCount  = [int]$MessageShape.lineCount
        }
        dispatchOutcome = $DispatchOutcome
        draftState      = $DraftState
        restoreRetry    = [bool]$RestoreRetry
        adoptionProbe   = [bool]$AdoptionProbe
        aoEpochHash     = $AoEpochHash
        configPathHash  = $ConfigPathHash
        adoptionProbeRunIdHash = $AdoptionProbeRunIdHash
    }
}

function New-WorkerMessageDeliveryId {
    param(
        [string]$SessionId,
        [long]$DeliveredAtMs,
        [string]$Source,
        [string]$SourceKey = ''
    )

    $sid = $SessionId.Trim()
    $src = $Source.Trim()
    $key = $SourceKey.Trim()
    if (-not $sid -or -not $DeliveredAtMs -or -not $src) {
        return $null
    }
    if ($key) {
        return "${sid}:${DeliveredAtMs}:${src}:${key}"
    }
    return "${sid}:${DeliveredAtMs}:${src}"
}

function Register-WorkerMessageDispatch {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [string]$SourceKey = '',
        [string]$JournalPath = '',
        [string]$DeliveryPath = '',
        [switch]$RestoreRetry,
        [long]$DeliveredAtMs = 0,
        [string]$DispatchOutcome = 'dispatched',
        [string]$DraftState = '',
        [switch]$HashIdentity,
        [switch]$AdoptionProbe,
        [string]$AoEpoch = '',
        [string]$ConfigPath = '',
        [string]$AoEpochHash = '',
        [string]$ConfigPathHash = '',
        [string]$AdoptionProbeRunIdHash = '',
        [string]$DeliveryId = '',
        [string]$DeterministicDeliveryKey = '',
        [string]$FindingsHash = ''
    )

    $deliveredMs = if ($DeliveredAtMs -gt 0) { $DeliveredAtMs } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $senderSessionId = $env:AO_SESSION_ID
    if (-not $senderSessionId) { $senderSessionId = '' }

    $shape = Invoke-DispatchShapeCli -Message $Message -SenderSessionId $senderSessionId
    $resolvedDeliveryPath = if ($DeliveryPath.Trim()) {
        $DeliveryPath.Trim()
    }
    else {
        [string]$shape.deliveryPath
    }
    $safeSourceKey = if ($HashIdentity) { ConvertTo-WorkerMessageSafeIdComponent -Value $SourceKey } else { $SourceKey }
    $resolvedDeliveryId = $DeliveryId.Trim()
    if (-not $resolvedDeliveryId) {
        $resolvedDeliveryId = New-WorkerMessageDeliveryId -SessionId $SessionId -DeliveredAtMs $deliveredMs -Source $Source -SourceKey $safeSourceKey
    }
    if (-not $resolvedDeliveryId) {
        return @{ recorded = $false; reason = 'invalid_delivery_id' }
    }

    $aoEpochHash = if ($AoEpochHash) { $AoEpochHash } elseif ($AoEpoch) { ConvertTo-WorkerMessageSafeIdComponent -Value $AoEpoch } else { '' }
    $configPathHash = if ($ConfigPathHash) { $ConfigPathHash } elseif ($ConfigPath) { ConvertTo-WorkerMessageSafeIdComponent -Value $ConfigPath } else { '' }

    $lockPath = Get-WorkerMessageDispatchJournalLockPath -JournalPath $JournalPath
    $recorded = $false
    $lastFailureReason = 'journal_write_failed'
    $maxJournalAttempts = 3
    for ($attempt = 1; $attempt -le $maxJournalAttempts; $attempt++) {
        $recordHolder = @{ recorded = $false }
        $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Metadata @{
            kind = 'worker-message-dispatch-journal'
        } -Action {
            $journal = Get-WorkerMessageDispatchJournal -Path $JournalPath
            if (-not (Test-MechanicalJsonStateFencesTrusted -State $journal)) {
                $recordHolder.reason = 'journal_untrusted'
                return
            }
            $candidate = @{
                deliveryId    = $resolvedDeliveryId
                sessionId     = $SessionId
                deliveredAtMs = $deliveredMs
                source        = $Source
                sourceKey     = $safeSourceKey
                deliveryPath  = $resolvedDeliveryPath
                messageShape  = @{
                    charLength = [int]$shape.charLength
                    lineCount  = [int]$shape.lineCount
                }
                dispatchOutcome = $DispatchOutcome
                draftState    = if ($DraftState) { $DraftState } elseif ($resolvedDeliveryPath -eq 'self-submitted') { 'auto_submitted' } else { 'draft_present' }
                restoreRetry  = [bool]$RestoreRetry
                adoptionProbe = [bool]$AdoptionProbe
                aoEpochHash = $aoEpochHash
                configPathHash = $configPathHash
                adoptionProbeRunIdHash = $AdoptionProbeRunIdHash
            }
            if ($DeterministicDeliveryKey) {
                $candidate.deterministicKey = $DeterministicDeliveryKey
            }
            if ($FindingsHash) {
                $candidate.findingsHash = $FindingsHash
            }
            if ($DeterministicDeliveryKey) {
                $dedup = Invoke-DispatchJournalCli -Subcommand 'deterministic-admit' -Payload @{
                    journal  = $journal
                    incoming = $candidate
                }
                if ($dedup.action -eq 'no_op_terminal') {
                    $recordHolder.recorded = $true
                    $recordHolder.deliveryId = [string]$dedup.deliveryId
                    $recordHolder.duplicateNoOp = $true
                    return
                }
                if ($dedup.action -eq 'resume') {
                    $recordHolder.recorded = $true
                    $recordHolder.deliveryId = [string]$dedup.deliveryId
                    $recordHolder.resume = $true
                    return
                }
                if (-not $dedup.ok) {
                    $recordHolder.reason = [string]$dedup.reason
                    return
                }
            }
            $admitted = Invoke-DispatchJournalCli -Subcommand 'journal-admit' -Payload @{
                journal = $journal
                record  = $candidate
                nowMs   = $deliveredMs
            }
            if (-not $admitted.ok) {
                $recordHolder.reason = [string]$admitted.reason
                if ($admitted.reason -eq 'over_capacity') {
                    $recordHolder.reason = 'journal_over_capacity'
                }
                return
            }
            Set-WorkerMessageDispatchJournal -Path $JournalPath -Journal (ConvertTo-MechanicalJsonMap -Value $admitted.journal)
            $recordHolder.recorded = $true
        }

        $recorded = [bool]$recordHolder.recorded
        if ($fenced.ok -and $recorded) {
            break
        }

        $lastFailureReason = if ($recordHolder.reason) { [string]$recordHolder.reason } elseif (-not $fenced.ok) { 'journal_busy' } else { 'journal_write_failed' }
        if ($attempt -lt $maxJournalAttempts) {
            Start-Sleep -Milliseconds 200
        }
    }

    if (-not $recorded) {
        return @{ recorded = $false; reason = $lastFailureReason }
    }

    return @{
        recorded     = $true
        deliveryId   = if ($recordHolder.deliveryId) { [string]$recordHolder.deliveryId } else { $resolvedDeliveryId }
        deliveryPath = $resolvedDeliveryPath
        dispatchOutcome = $DispatchOutcome
        duplicateNoOp = [bool]$recordHolder.duplicateNoOp
        resume       = [bool]$recordHolder.resume
    }
}

function Resolve-DispatchJournalSendOutcome {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$DispatchResult
    )

    if ($DispatchResult.recorded) {
        return @{ sent = $true; reason = 'sent'; journalRecorded = $true }
    }

    $dispatchReason = if ($DispatchResult.reason) {
        [string]$DispatchResult.reason
    }
    else {
        'journal_record_failed'
    }

    return @{
        sent                 = $false
        reason               = $dispatchReason
        journalRecorded      = $false
        journalFailureReason = $dispatchReason
    }
}

function Resolve-DispatchJournalSendOutcomeAfterDelivered {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$DispatchResult
    )

    $outcome = Resolve-DispatchJournalSendOutcome -DispatchResult $DispatchResult
    if ($outcome.journalRecorded) {
        return $outcome
    }

    $dispatchReason = if ($outcome.journalFailureReason) {
        [string]$outcome.journalFailureReason
    }
    elseif ($outcome.reason) {
        [string]$outcome.reason
    }
    else {
        'journal_record_failed'
    }

    return @{
        sent                 = $true
        reason               = 'sent'
        journalRecorded      = $false
        journalFailureReason = $dispatchReason
    }
}



function Compact-WorkerMessageDispatchJournal {
    param(
        [string]$JournalPath = '',
        [long]$NowMs = 0
    )

    $journalPath = if ($JournalPath) { $JournalPath } else { Get-WorkerMessageDispatchJournalPath }
    $nowMs = if ($NowMs -gt 0) { $NowMs } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $lockPath = Get-WorkerMessageDispatchJournalLockPath -JournalPath $journalPath
    $resultHolder = @{ ok = $false; reason = 'compact_failed' }
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Metadata @{
        kind = 'worker-message-dispatch-journal-compact'
    } -Action {
        $journal = Get-WorkerMessageDispatchJournal -Path $journalPath
        if (-not (Test-MechanicalJsonStateFencesTrusted -State $journal)) {
            $resultHolder.reason = 'journal_untrusted'
            return
        }
        $compacted = Invoke-DispatchJournalCli -Subcommand 'journal-compact' -Payload @{
            journal = $journal
            nowMs   = $nowMs
        }
        Set-WorkerMessageDispatchJournal -Path $journalPath -Journal (ConvertTo-MechanicalJsonMap -Value $compacted.journal)
        $resultHolder.ok = $true
        $resultHolder.reason = 'compacted'
        $resultHolder.evicted = @($compacted.evicted)
    }

    if (-not $fenced.ok) {
        return @{ ok = $false; reason = 'journal_busy' }
    }
    return @{
        ok      = [bool]$resultHolder.ok
        reason  = [string]$resultHolder.reason
        evicted = @($resultHolder.evicted)
    }
}

function Update-WorkerMessageDispatchOutcome {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DeliveryId,
        [Parameter(Mandatory = $true)]
        [string]$DispatchOutcome,
        [string]$DraftState = '',
        [string]$JournalPath = ''
    )

    $lockPath = Get-WorkerMessageDispatchJournalLockPath -JournalPath $JournalPath
    $updateHolder = @{ updated = $false }
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Metadata @{ kind = 'worker-message-dispatch-journal-outcome' } -Action {
        $journal = Get-WorkerMessageDispatchJournal -Path $JournalPath
        if (-not $journal.ContainsKey($DeliveryId)) { return }
        $finalized = Invoke-DispatchJournalCli -Subcommand 'journal-finalize' -Payload @{
            journal         = $journal
            deliveryId      = $DeliveryId
            dispatchOutcome = $DispatchOutcome
            draftState      = $DraftState
            nowMs           = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        if (-not $finalized.ok) {
            return
        }
        Set-WorkerMessageDispatchJournal -Path $JournalPath -Journal (ConvertTo-MechanicalJsonMap -Value $finalized.journal)
        $updateHolder.updated = $true
    }
    $updated = [bool]$updateHolder.updated
    return @{ updated = $updated; ok = [bool]$fenced.ok; reason = if ($fenced.ok) { if ($updated) { 'updated' } else { 'not_found' } } else { 'journal_busy' } }
}
