#requires -Version 5.1
<#
.SYNOPSIS
  Metadata-only journaled wrapper for orchestrator -> worker ao send (Issues #281 / #373).

.DESCRIPTION
  Reads the raw worker message from stdin, records a metadata-only outbox entry before
  invoking ao send via --file, then records a dispatch outcome after ao send. The raw
  payload is never written to the journal or logs; transport uses a user-private
  mechanical-transport file with stale-artifact recovery. If the local ao send does not
  advertise --file ingestion, this wrapper fails closed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$SessionId,
    [string]$Source = 'ao-send',
    [string]$SourceKey = '',
    [string]$AoPath = 'ao',
    [string]$JournalPath = '',
    [int]$TimeoutSeconds = 600,
    [switch]$DryRun,
    [switch]$AdoptionProbe,
    [string]$AoEpoch = '',
    [string]$ConfigPath = '',
    [string]$AoEpochHash = '',
    [string]$ConfigPathHash = '',
    [string]$AdoptionProbeRunIdHash = '',
    [string]$ClaimToken = '',
    [switch]$GatedNudge,
    [switch]$NoWait,
    [switch]$RegisterCapabilityOnly
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Record-WorkerMessageDispatch.ps1')
. (Join-Path $PSScriptRoot 'lib/QuotedProcessArguments.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-AutonomousReviewStartGate.ps1')
. (Join-Path $PSScriptRoot 'lib/Journaled-WorkerSendInternalCapability.ps1')

function Write-JournaledWorkerSendLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] journaled-worker-send: $Message"
}

function New-JournaledWorkerSendInternalCapability {
    $registered = Register-JournaledWorkerSendInternalCapability
    if (-not $registered.ok) {
        throw "journaled-worker-send: failed to register internal capability: $($registered.reason)"
    }
    return [string]$registered.capability
}

function Test-AoSendFileContract {
    param([string]$AoPath = 'ao')
    if ($env:AO_JOURNALED_SEND_ASSUME_FILE -eq '1') { return $true }
    $savedSentinel = [System.Environment]::GetEnvironmentVariable('AO_JOURNALED_SEND_INTERNAL', 'Process')
    try {
        [System.Environment]::SetEnvironmentVariable('AO_JOURNALED_SEND_INTERNAL', (New-JournaledWorkerSendInternalCapability), 'Process')
        $help = (& $AoPath send --help 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
    }
    catch {
        return $false
    }
    finally {
        [System.Environment]::SetEnvironmentVariable('AO_JOURNALED_SEND_INTERNAL', $savedSentinel, 'Process')
    }
    return ($help -match '(?im)(--file|\-f,\s*--file)')
}

function Update-JournaledWorkerSendOutcome {
    param(
        [string]$DeliveryId,
        [string]$DispatchOutcome,
        [string]$DraftState,
        [string]$JournalPath
    )

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $update = Update-WorkerMessageDispatchOutcome -DeliveryId $DeliveryId -DispatchOutcome $DispatchOutcome -DraftState $DraftState -JournalPath $JournalPath
        if ($update.ok -and $update.updated) { return @{ ok = $true; reason = 'updated' } }
        if ($attempt -lt 3) { Start-Sleep -Milliseconds (200 * $attempt) }
        $lastReason = if ($update.reason) { [string]$update.reason } else { 'outcome_update_failed' }
    }
    return @{ ok = $false; reason = $lastReason }
}

function Resolve-AoSendDispatchOutcome {
    param(
        [int]$ExitCode,
        [string]$Reason
    )

    if ($ExitCode -eq 0) {
        return @{ outcome = 'dispatched'; reason = $Reason }
    }
    if ($Reason -match '^(timeout_interrupted|interrupted)$') {
        return @{ outcome = 'dispatch_unknown'; reason = $Reason }
    }
    if ($Reason -match '^(process_not_started|session_not_found|arg_rejected|exception_before_send|payload_transport_not_private)$') {
        return @{ outcome = 'send_failed'; reason = $Reason }
    }
    if ($ExitCode -ge 64 -and $ExitCode -le 69) {
        return @{ outcome = 'send_failed'; reason = $Reason }
    }
    return @{ outcome = 'dispatch_unknown'; reason = $Reason }
}

function Invoke-AoSendViaFile {
    param(
        [string]$AoPath,
        [string]$SessionId,
        [string]$Payload,
        [int]$TimeoutSeconds,
        [switch]$NoWait
    )

    Remove-StaleMechanicalTransportFiles
    $payloadFile = New-MechanicalWorkerMessagePayloadTempPath
    try {
        try {
            Write-MechanicalWorkerMessagePayloadFile -Path $payloadFile -Content $Payload
        }
        catch {
            return Resolve-AoSendDispatchOutcome -ExitCode 1 -Reason 'payload_transport_not_private'
        }

        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $AoPath
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $psi.EnvironmentVariables['AO_JOURNALED_SEND_INTERNAL'] = New-JournaledWorkerSendInternalCapability
        $aoArgs = @('send', $SessionId, '--file', $payloadFile)
        if ($NoWait) { $aoArgs += '--no-wait' }
        if ($TimeoutSeconds -gt 0) {
            $aoArgs += '--timeout'
            $aoArgs += [string]$TimeoutSeconds
        }
        $psi.Arguments = Join-QuotedProcessArguments -Arguments $aoArgs

        $proc = [System.Diagnostics.Process]::new()
        $proc.StartInfo = $psi
        try {
            if (-not $proc.Start()) {
                return Resolve-AoSendDispatchOutcome -ExitCode 1 -Reason 'process_not_started'
            }
            $stdoutDrain = $proc.StandardOutput.ReadToEndAsync()
            $stderrDrain = $proc.StandardError.ReadToEndAsync()
            $limitMs = [Math]::Max(1, $TimeoutSeconds) * 1000
            if (-not $proc.WaitForExit($limitMs)) {
                try { $proc.Kill() } catch { }
                try { $proc.WaitForExit(1000) | Out-Null } catch { }
                return Resolve-AoSendDispatchOutcome -ExitCode 1 -Reason 'timeout_interrupted'
            }
            try { $stdoutDrain.Wait(1000) | Out-Null; $stderrDrain.Wait(1000) | Out-Null } catch { }
            return Resolve-AoSendDispatchOutcome -ExitCode $proc.ExitCode -Reason "exit_$($proc.ExitCode)"
        }
        catch [System.Management.Automation.PipelineStoppedException] {
            return Resolve-AoSendDispatchOutcome -ExitCode 1 -Reason 'interrupted'
        }
        catch {
            return Resolve-AoSendDispatchOutcome -ExitCode 1 -Reason 'exception_before_send'
        }
        finally {
            if ($proc) { $proc.Dispose() }
        }
    }
    finally {
        Remove-MechanicalTransportTempPaths -Paths @($payloadFile)
    }
}

if ($RegisterCapabilityOnly) {
    Write-Output (New-JournaledWorkerSendInternalCapability)
    exit 0
}

$payload = [Console]::In.ReadToEnd()
if ($null -eq $payload) { $payload = '' }

if ($payload -match '^(?s)AO_WORKER_MESSAGE_ADOPTION_PROBE_V1(?:\s|$)') {
    $AdoptionProbe = $true
    $Source = 'adoption-probe'
    foreach ($line in ($payload -split "`r?`n")) {
        if ($line -match '^branch=(.+)$' -and -not $SourceKey) { $SourceKey = $Matches[1] }
        elseif ($line -match '^aoEpochHash=(sha256-[0-9a-f]{24})$' -and -not $AoEpochHash) { $AoEpochHash = $Matches[1] }
        elseif ($line -match '^configPathHash=(sha256-[0-9a-f]{24})$' -and -not $ConfigPathHash) { $ConfigPathHash = $Matches[1] }
        elseif ($line -match '^adoptionProbeRunIdHash=(sha256-[0-9a-f]{24})$' -and -not $AdoptionProbeRunIdHash) { $AdoptionProbeRunIdHash = $Matches[1] }
    }
    if ($payload -match '(?:^|\s)b=([^\s]+)' -and -not $SourceKey) { $SourceKey = $Matches[1] }
    if ($payload -match '(?:^|\s)e=(sha256-[0-9a-f]{24})(?:\s|$)' -and -not $AoEpochHash) { $AoEpochHash = $Matches[1] }
    if ($payload -match '(?:^|\s)c=(sha256-[0-9a-f]{24})(?:\s|$)' -and -not $ConfigPathHash) { $ConfigPathHash = $Matches[1] }
    if ($payload -match '(?:^|\s)r=(sha256-[0-9a-f]{24})(?:\s|$)' -and -not $AdoptionProbeRunIdHash) { $AdoptionProbeRunIdHash = $Matches[1] }
}

if ($env:AO_WORKER_MESSAGE_ADOPTION_PROBE -eq '1') {
    $AdoptionProbe = $true
    $Source = 'adoption-probe'
    if (-not $SourceKey -and $env:AO_WORKER_MESSAGE_ADOPTION_BRANCH) { $SourceKey = $env:AO_WORKER_MESSAGE_ADOPTION_BRANCH }
    if (-not $AoEpoch -and $env:AO_WORKER_MESSAGE_ADOPTION_EPOCH) { $AoEpoch = $env:AO_WORKER_MESSAGE_ADOPTION_EPOCH }
    if (-not $ConfigPath -and $env:AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH) { $ConfigPath = $env:AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH }
    if (-not $AoEpochHash -and $env:AO_WORKER_MESSAGE_ADOPTION_EPOCH_HASH) { $AoEpochHash = $env:AO_WORKER_MESSAGE_ADOPTION_EPOCH_HASH }
    if (-not $ConfigPathHash -and $env:AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH_HASH) { $ConfigPathHash = $env:AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH_HASH }
    if (-not $AdoptionProbeRunIdHash -and $env:AO_WORKER_MESSAGE_ADOPTION_RUN_ID_HASH) { $AdoptionProbeRunIdHash = $env:AO_WORKER_MESSAGE_ADOPTION_RUN_ID_HASH }
}

if (-not $SourceKey.Trim() -and $Source -eq 'ao-send' -and -not $AdoptionProbe) {
    $SourceKey = 'plain-send-' + [guid]::NewGuid().ToString('n')
}

$effectiveJournalPath = $JournalPath
if ($DryRun) {
    $dryRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'journaled-worker-send-dryrun'
    if (-not (Test-Path -LiteralPath $dryRoot)) { New-Item -ItemType Directory -Path $dryRoot -Force | Out-Null }
    $effectiveJournalPath = Join-Path $dryRoot 'orchestrator-worker-message-dispatch-journal.json'
}

if (-not (Test-AoSendFileContract -AoPath $AoPath)) {
    Write-JournaledWorkerSendLog 'ao send --file contract is unavailable; refusing transport'
    exit 42
}

$claimResult = $null
if (-not $AdoptionProbe -and -not $DryRun) {
    if ((Test-OrchestratorAutonomousSurfaceActive) -and (-not $GatedNudge -or -not $ClaimToken)) {
        Write-JournaledWorkerSendLog 'worker nudge rejected: autonomous surface requires gated claim token'
        exit 46
    }
    if ($GatedNudge -and -not $ClaimToken) {
        Write-JournaledWorkerSendLog 'worker nudge rejected: missing claim token'
        exit 46
    }
    if ($ClaimToken) {
        $tokenConsume = Invoke-ConsumeWorkerNudgeClaimTokenForSend -ClaimToken $ClaimToken -SendSessionId $SessionId
        if (-not $tokenConsume.ok) {
            Write-JournaledWorkerSendLog "worker nudge rejected: invalid claim token reason=$($tokenConsume.reason)"
            exit 46
        }
        $claimResult = $tokenConsume.claimResult
    }
}

$draftState = 'unknown'
$dispatchOutcome = 'dispatch_in_flight'
$register = Register-WorkerMessageDispatch `
    -SessionId $SessionId `
    -Message $payload `
    -Source $Source `
    -SourceKey $SourceKey `
    -JournalPath $effectiveJournalPath `
    -DispatchOutcome $dispatchOutcome `
    -DraftState $draftState `
    -HashIdentity `
    -AdoptionProbe:$AdoptionProbe `
    -AoEpoch $AoEpoch `
    -ConfigPath $ConfigPath `
    -AoEpochHash $AoEpochHash `
    -ConfigPathHash $ConfigPathHash `
    -AdoptionProbeRunIdHash $AdoptionProbeRunIdHash

if (-not $register.recorded) {
    Write-JournaledWorkerSendLog "outbox journal write failed: reason=$($register.reason)"
    if ($claimResult) {
        Finalize-WorkerNudgeClaim -ClaimResult $claimResult -Outcome 'FAILED_DEFINITIVE' `
            -Extra @{ reason = 'journal_register_failed'; detail = [string]$register.reason } | Out-Null
    }
    exit 43
}

if ($claimResult) {
  # SEND_ATTEMPTED is recorded atomically during token consumption.
}

if ($AdoptionProbe) {
    $update = Update-JournaledWorkerSendOutcome -DeliveryId $register.deliveryId -DispatchOutcome 'dispatched' -DraftState 'auto_submitted' -JournalPath $effectiveJournalPath
    if (-not $update.ok) {
        Write-JournaledWorkerSendLog "adoption probe outcome update failed: delivery=$($register.deliveryId) reason=$($update.reason)"
        exit 47
    }
    Write-JournaledWorkerSendLog "adoption probe observed: delivery=$($register.deliveryId) journal=$effectiveJournalPath"
    exit 0
}

if ($DryRun) {
    $dryDraftState = if ($register.deliveryPath -eq 'self-submitted') { 'auto_submitted' } else { 'draft_present' }
    $update = Update-JournaledWorkerSendOutcome -DeliveryId $register.deliveryId -DispatchOutcome 'dispatched' -DraftState $dryDraftState -JournalPath $effectiveJournalPath
    if (-not $update.ok) {
        Write-JournaledWorkerSendLog "dry-run outcome update failed: delivery=$($register.deliveryId) reason=$($update.reason)"
        exit 47
    }
    Write-JournaledWorkerSendLog "dry-run recorded metadata-only delivery=$($register.deliveryId) journal=$effectiveJournalPath"
    exit 0
}

$result = Invoke-AoSendViaFile -AoPath $AoPath -SessionId $SessionId -Payload $payload -TimeoutSeconds $TimeoutSeconds -NoWait:$NoWait
$shapeDraftState = if ($register.deliveryPath -eq 'self-submitted') { 'auto_submitted' } elseif ($result.outcome -eq 'dispatched') { 'draft_present' } else { 'unknown' }
$update = Update-JournaledWorkerSendOutcome -DeliveryId $register.deliveryId -DispatchOutcome $result.outcome -DraftState $shapeDraftState -JournalPath $effectiveJournalPath
if (-not $update.ok) {
    Write-JournaledWorkerSendLog "dispatch outcome update failed: delivery=$($register.deliveryId) outcome=$($result.outcome) reason=$($update.reason)"
    exit 47
}
Write-JournaledWorkerSendLog "dispatch outcome recorded: delivery=$($register.deliveryId) outcome=$($result.outcome) reason=$($result.reason)"
if ($claimResult) {
    if ($result.outcome -eq 'dispatched') {
        Finalize-WorkerNudgeClaim -ClaimResult $claimResult -Outcome 'SENT' | Out-Null
    }
    elseif ($result.outcome -eq 'dispatch_unknown') {
        Finalize-WorkerNudgeClaim -ClaimResult $claimResult -Outcome 'UNCERTAIN' | Out-Null
    }
    else {
        Finalize-WorkerNudgeClaim -ClaimResult $claimResult -Outcome 'FAILED_DEFINITIVE' -Extra @{ dispatchReason = $result.reason } | Out-Null
    }
}
if ($result.outcome -eq 'dispatched') { exit 0 }
if ($result.outcome -eq 'dispatch_unknown') { exit 44 }
exit 45
