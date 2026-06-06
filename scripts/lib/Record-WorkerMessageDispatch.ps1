#requires -Version 5.1
<#
.SYNOPSIS
  Record an AO-attributed worker message dispatch in the shared journal (Issue #232).

.DESCRIPTION
  Pack senders call this after a successful ao send / ao review send so the unified
  submit arbiter can derive pending-draft delivery path from message shape — never
  from pane text. Human keystrokes do not write journal entries.
#>

$PackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$DispatchCli = Join-Path $PackRoot 'docs/worker-message-dispatch-observe.mjs'

. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')

function Get-WorkerMessageDispatchJournalPath {
    if ($env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL) {
        return $env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL
    }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-worker-message-dispatch-journal.json'
}

function Get-WorkerMessageDispatchJournalLockPath {
    param([string]$JournalPath = '')

    $journalPath = if ($JournalPath) { $JournalPath } else { Get-WorkerMessageDispatchJournalPath }
    return "${journalPath}.lock"
}

function Get-WorkerMessageDispatchJournal {
    param([string]$Path = '')

    $journalPath = if ($Path) { $Path } else { Get-WorkerMessageDispatchJournalPath }
    if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) {
        return @{}
    }
    try {
        $raw = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
        $map = @{}
        foreach ($prop in $raw.PSObject.Properties) {
            $map[$prop.Name] = $prop.Value
        }
        return $map
    }
    catch {
        return @{}
    }
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
    $Journal | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $journalPath -Encoding utf8
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
        [switch]$RestoreRetry,
        [long]$DeliveredAtMs = 0
    )

    $deliveredMs = if ($DeliveredAtMs -gt 0) { $DeliveredAtMs } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $senderSessionId = $env:AO_SESSION_ID
    if (-not $senderSessionId) { $senderSessionId = '' }

    $shape = Invoke-DispatchShapeCli -Message $Message -SenderSessionId $senderSessionId
    $deliveryId = New-WorkerMessageDeliveryId -SessionId $SessionId -DeliveredAtMs $deliveredMs -Source $Source -SourceKey $SourceKey
    if (-not $deliveryId) {
        return @{ recorded = $false; reason = 'invalid_delivery_id' }
    }

    $lockPath = Get-WorkerMessageDispatchJournalLockPath -JournalPath $JournalPath
    $recorded = $false
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Metadata @{
        kind = 'worker-message-dispatch-journal'
    } -Action {
        $journal = Get-WorkerMessageDispatchJournal -Path $JournalPath
        $journal[$deliveryId] = @{
            deliveryId    = $deliveryId
            sessionId     = $SessionId
            deliveredAtMs = $deliveredMs
            source        = $Source
            sourceKey     = $SourceKey
            deliveryPath  = [string]$shape.deliveryPath
            messageShape  = @{
                charLength = [int]$shape.charLength
                lineCount  = [int]$shape.lineCount
            }
            restoreRetry  = [bool]$RestoreRetry
        }
        Set-WorkerMessageDispatchJournal -Path $JournalPath -Journal $journal
        $recorded = $true
    }

    if (-not $fenced.ok) {
        return @{ recorded = $false; reason = 'journal_busy' }
    }
    if (-not $recorded) {
        return @{ recorded = $false; reason = 'journal_write_failed' }
    }

    return @{
        recorded     = $true
        deliveryId   = $deliveryId
        deliveryPath = [string]$shape.deliveryPath
    }
}
