#requires -Version 5.1
<#
.SYNOPSIS
  Metadata-only journaled wrapper for orchestrator -> worker ao send (Issue #281).

.DESCRIPTION
  Reads the raw worker message from stdin only, records a metadata-only outbox
  entry before invoking ao send, then records a dispatch outcome after ao send.
  The raw payload is never accepted as an argv parameter and is never written to
  the journal or logs. If the local ao send does not advertise stdin/pipe
  ingestion, this wrapper fails closed: no argv fallback and no raw temp file.
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
    [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Record-WorkerMessageDispatch.ps1')

function Write-JournaledWorkerSendLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] journaled-worker-send: $Message"
}

function Test-AoSendStdinContract {
    param([string]$AoPath = 'ao')
    if ($env:AO_JOURNALED_SEND_ASSUME_STDIN -eq '1') { return $true }
    try {
        $help = (& $AoPath send --help 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
    }
    catch {
        return $false
    }
    return ($help -match '(?im)(--stdin|stdin|standard input|pipe)')
}

function Invoke-AoSendViaStdin {
    param(
        [string]$AoPath,
        [string]$SessionId,
        [string]$Payload,
        [int]$TimeoutSeconds,
        [switch]$NoWait
    )

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $AoPath
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.Environment['AO_JOURNALED_SEND_INTERNAL'] = [guid]::NewGuid().ToString('n')
    [void]$psi.ArgumentList.Add('send')
    [void]$psi.ArgumentList.Add($SessionId)
    [void]$psi.ArgumentList.Add('--stdin')
    if ($NoWait) { [void]$psi.ArgumentList.Add('--no-wait') }
    if ($TimeoutSeconds -gt 0) {
        [void]$psi.ArgumentList.Add('--timeout')
        [void]$psi.ArgumentList.Add([string]$TimeoutSeconds)
    }

    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    try {
        if (-not $proc.Start()) { return @{ outcome = 'send_failed'; reason = 'process_not_started' } }
        $proc.StandardInput.Write($Payload)
        $proc.StandardInput.Close()
        $limitMs = [Math]::Max(1, $TimeoutSeconds) * 1000
        if (-not $proc.WaitForExit($limitMs)) {
            try { $proc.Kill() } catch { }
            return @{ outcome = 'dispatch_unknown'; reason = 'timeout_interrupted' }
        }
        if ($proc.ExitCode -eq 0) { return @{ outcome = 'dispatched'; reason = 'sent' } }
        return @{ outcome = 'send_failed'; reason = "exit_$($proc.ExitCode)" }
    }
    catch [System.Management.Automation.PipelineStoppedException] {
        return @{ outcome = 'dispatch_unknown'; reason = 'interrupted' }
    }
    catch {
        return @{ outcome = 'send_failed'; reason = 'exception' }
    }
    finally {
        if ($proc) { $proc.Dispose() }
    }
}

$payload = [Console]::In.ReadToEnd()
if ($null -eq $payload) { $payload = '' }

$effectiveJournalPath = $JournalPath
if ($DryRun) {
    $dryRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'journaled-worker-send-dryrun'
    if (-not (Test-Path -LiteralPath $dryRoot)) { New-Item -ItemType Directory -Path $dryRoot -Force | Out-Null }
    $effectiveJournalPath = Join-Path $dryRoot 'orchestrator-worker-message-dispatch-journal.json'
}

if (-not (Test-AoSendStdinContract -AoPath $AoPath)) {
    Write-JournaledWorkerSendLog 'ao send stdin/pipe contract is unavailable; refusing argv/file payload fallback'
    exit 42
}

$draftState = 'unknown'
$dispatchOutcome = 'dispatch_unknown'
$register = Register-WorkerMessageDispatch `
    -SessionId $SessionId `
    -Message $payload `
    -Source $Source `
    -SourceKey $SourceKey `
    -JournalPath $effectiveJournalPath `
    -DispatchOutcome $dispatchOutcome `
    -DraftState $draftState `
    -HashIdentity `
    -AdoptionProbe:$AdoptionProbe

if (-not $register.recorded) {
    Write-JournaledWorkerSendLog "outbox journal write failed: reason=$($register.reason)"
    exit 43
}

if ($AdoptionProbe) {
    [void](Update-WorkerMessageDispatchOutcome -DeliveryId $register.deliveryId -DispatchOutcome 'dispatched' -DraftState 'auto_submitted' -JournalPath $effectiveJournalPath)
    Write-JournaledWorkerSendLog "adoption probe observed: delivery=$($register.deliveryId) journal=$effectiveJournalPath"
    exit 0
}

if ($DryRun) {
    $dryDraftState = if ($register.deliveryPath -eq 'self-submitted') { 'auto_submitted' } else { 'draft_present' }
    [void](Update-WorkerMessageDispatchOutcome -DeliveryId $register.deliveryId -DispatchOutcome 'dispatched' -DraftState $dryDraftState -JournalPath $effectiveJournalPath)
    Write-JournaledWorkerSendLog "dry-run recorded metadata-only delivery=$($register.deliveryId) journal=$effectiveJournalPath"
    exit 0
}

$result = Invoke-AoSendViaStdin -AoPath $AoPath -SessionId $SessionId -Payload $payload -TimeoutSeconds $TimeoutSeconds -NoWait:$NoWait
$shapeDraftState = if ($register.deliveryPath -eq 'self-submitted') { 'auto_submitted' } elseif ($result.outcome -eq 'dispatched') { 'draft_present' } else { 'unknown' }
[void](Update-WorkerMessageDispatchOutcome -DeliveryId $register.deliveryId -DispatchOutcome $result.outcome -DraftState $shapeDraftState -JournalPath $effectiveJournalPath)
Write-JournaledWorkerSendLog "dispatch outcome recorded: delivery=$($register.deliveryId) outcome=$($result.outcome) reason=$($result.reason)"
if ($result.outcome -eq 'dispatched') { exit 0 }
if ($result.outcome -eq 'dispatch_unknown') { exit 44 }
exit 45
