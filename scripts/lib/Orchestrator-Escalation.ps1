#requires -Version 5.1
<#
.SYNOPSIS
  Durable orchestrator escalation publication contract (Issue #641).
#>

$Script:OrchestratorEscalationRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$Script:OrchestratorEscalationCatalogPath = Join-Path $Script:OrchestratorEscalationRepoRoot 'scripts/orchestrator-message-catalog.json'
$Script:OrchestratorEscalationJournaledSend = Join-Path $Script:OrchestratorEscalationRepoRoot 'scripts/journaled-worker-send.ps1'
$Script:OrchestratorEscalationDefaultState = @{
    schemaVersion = 1
    records       = @{}
    wakeWindows   = @{}
    audit         = @{}
}

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

function Get-OrchestratorEscalationStatePath {
    param([string]$StatePath = '')
    if ($StatePath) { return $StatePath }
    if ($env:AO_ORCHESTRATOR_ESCALATION_STATE) { return $env:AO_ORCHESTRATOR_ESCALATION_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-escalation-state.json'
}

function Get-OrchestratorEscalationOperatorInboxDir {
    param([string]$OperatorInboxDir = '')
    if ($OperatorInboxDir) { return $OperatorInboxDir }
    if ($env:AO_OPERATOR_ESCALATION_INBOX) { return $env:AO_OPERATOR_ESCALATION_INBOX }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-operator-inbox'
}

function Get-OrchestratorEscalationHealthSpoolDir {
    param([string]$HealthSpoolDir = '')
    if ($HealthSpoolDir) { return $HealthSpoolDir }
    if ($env:AO_ESCALATION_HEALTH_SPOOL) { return $env:AO_ESCALATION_HEALTH_SPOOL }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-escalation-health'
}

function Get-OrchestratorEscalationNowMs {
    param([Nullable[long]]$NowMs = $null)
    if ($null -ne $NowMs) { return [long]$NowMs }
    return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function ConvertTo-OrchestratorEscalationHashtable {
    param($Value)
    return ConvertTo-MechanicalJsonStateHashtable -Value $Value
}

function Get-OrchestratorEscalationCatalog {
    param([string]$CatalogPath = '')
    $path = if ($CatalogPath) { $CatalogPath } else { $Script:OrchestratorEscalationCatalogPath }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "orchestrator escalation catalog missing: $path"
    }
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Resolve-OrchestratorEscalationClass {
    param(
        [Parameter(Mandatory = $true)][string]$EscalationClassId,
        [string]$CatalogPath = ''
    )
    $catalog = Get-OrchestratorEscalationCatalog -CatalogPath $CatalogPath
    foreach ($entry in @($catalog.escalationClasses)) {
        if ([string]$entry.escalation_class_id -eq $EscalationClassId) {
            return $entry
        }
    }
    throw "unknown escalation_class_id: $EscalationClassId"
}

function Get-OrchestratorEscalationHash {
    param([string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 24)
    }
    finally {
        $sha.Dispose()
    }
}

function Get-OrchestratorEscalationRecordKey {
    param([string]$EscalationClassId, [string]$CorrelationKey)
    return Get-OrchestratorEscalationHash -Text "${EscalationClassId}`n${CorrelationKey}"
}

function New-OrchestratorEscalationEnvelope {
    param(
        [Parameter(Mandatory = $true)]$Class,
        [Parameter(Mandatory = $true)][string]$EscalationClassId,
        [Parameter(Mandatory = $true)][string]$CorrelationKey,
        [Parameter(Mandatory = $true)][string]$RecordKey,
        [Parameter(Mandatory = $true)][string]$AckToken,
        [hashtable]$Payload = @{},
        [string]$Message = ''
    )
    $classSummary = ''
    if ($Class.PSObject.Properties.Name -contains 'summary') { $classSummary = [string]$Class.summary }
    elseif ($Class.trigger -and $Class.trigger.summary) { $classSummary = [string]$Class.trigger.summary }
    $body = if ($Message) { $Message } else { $classSummary }
    return @{
        type                = 'orchestrator-escalation/v1'
        escalation_class_id = $EscalationClassId
        code                = if ($Class.PSObject.Properties.Name -contains 'code') { [string]$Class.code } else { '' }
        name                = if ($Class.PSObject.Properties.Name -contains 'name') { [string]$Class.name } else { $EscalationClassId }
        route               = [string]$Class.route
        correlation_key     = $CorrelationKey
        escalation_id       = $RecordKey
        ack_token           = $AckToken
        message             = $body
        payload             = $Payload
    }
}

function Write-OrchestratorEscalationJsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Prefix,
        [Parameter(Mandatory = $true)]$Envelope
    )
    if ($env:AO_ESCALATION_FORCE_INBOX_FAILURE -eq '1' -and $Prefix -eq 'operator') {
        throw 'forced operator inbox failure'
    }
    if ($env:AO_ESCALATION_FORCE_HEALTH_FAILURE -eq '1' -and $Prefix -eq 'health') {
        throw 'forced health spool failure'
    }
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
    $id = [string]$Envelope.escalation_id
    $path = Join-Path $Directory ("{0}-{1}-{2}.json" -f $Prefix, $stamp, $id)
    $Envelope | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Write-OrchestratorEscalationHealthSpool {
    param(
        [Parameter(Mandatory = $true)]$Envelope,
        [string]$HealthSpoolDir = '',
        [string]$Reason = ''
    )
    $dir = Get-OrchestratorEscalationHealthSpoolDir -HealthSpoolDir $HealthSpoolDir
    $healthEnvelope = ConvertTo-OrchestratorEscalationHashtable -Value $Envelope
    $healthEnvelope['healthReason'] = $Reason
    try {
        return Write-OrchestratorEscalationJsonFile -Directory $dir -Prefix 'health' -Envelope $healthEnvelope
    }
    catch {
        Write-Error "orchestrator escalation health spool failed: $_"
        return $null
    }
}

function Write-OrchestratorEscalationOperatorInbox {
    param(
        [Parameter(Mandatory = $true)]$Envelope,
        [string]$OperatorInboxDir = '',
        [string]$HealthSpoolDir = '',
        [string]$Reason = ''
    )
    $dir = Get-OrchestratorEscalationOperatorInboxDir -OperatorInboxDir $OperatorInboxDir
    $operatorEnvelope = ConvertTo-OrchestratorEscalationHashtable -Value $Envelope
    if ($Reason) { $operatorEnvelope['failClosedReason'] = $Reason }
    try {
        return @{
            ok   = $true
            path = Write-OrchestratorEscalationJsonFile -Directory $dir -Prefix 'operator' -Envelope $operatorEnvelope
        }
    }
    catch {
        $spoolPath = Write-OrchestratorEscalationHealthSpool -Envelope $operatorEnvelope -HealthSpoolDir $HealthSpoolDir -Reason "operator_inbox_unwritable: $_"
        Write-Error "orchestrator escalation operator inbox failed: $_"
        return @{ ok = $false; reason = 'operator_inbox_unwritable'; healthSpoolPath = $spoolPath }
    }
}

function Invoke-OrchestratorEscalationLlmDelivery {
    param(
        [Parameter(Mandatory = $true)]$Envelope,
        [string]$OrchestratorSessionId = '',
        [string]$AoPath = 'ao',
        [switch]$DryRun
    )
    $session = if ($OrchestratorSessionId) { $OrchestratorSessionId } elseif ($env:AO_ORCHESTRATOR_SESSION_ID) { $env:AO_ORCHESTRATOR_SESSION_ID } else { '' }
    if (-not $session) { throw 'missing orchestrator session id' }
    if ($env:AO_ESCALATION_FORCE_SEND_FAILURE -eq '1') { throw 'forced llm delivery failure' }
    $json = $Envelope | ConvertTo-Json -Depth 30 -Compress
    if ($DryRun) { return @{ ok = $true; reason = 'dry_run'; session = $session } }
    $json | & pwsh -NoProfile -ExecutionPolicy Bypass -File $Script:OrchestratorEscalationJournaledSend `
        $session -Source 'orchestrator-escalation' -SourceKey ([string]$Envelope.escalation_id) -AoPath $AoPath -NoWait
    if ($LASTEXITCODE -ne 0) {
        throw "journaled-worker-send failed with exit code $LASTEXITCODE"
    }
    return @{ ok = $true; reason = 'sent'; session = $session }
}

function Test-OrchestratorEscalationAcked {
    param($Record)
    return ([string]$Record.status -eq 'acked' -or [string]$Record.operatorStatus -eq 'acked')
}

function Publish-OrchestratorEscalation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$EscalationClassId,
        [Parameter(Mandatory = $true)][string]$CorrelationKey,
        [hashtable]$Payload = @{},
        [string]$Message = '',
        [string]$StatePath = '',
        [string]$OperatorInboxDir = '',
        [string]$HealthSpoolDir = '',
        [string]$OrchestratorSessionId = '',
        [string]$CatalogPath = '',
        [string]$AoPath = 'ao',
        [Nullable[long]]$NowMs = $null,
        [switch]$DryRun
    )

    $class = Resolve-OrchestratorEscalationClass -EscalationClassId $EscalationClassId -CatalogPath $CatalogPath
    $route = [string]$class.route
    $now = Get-OrchestratorEscalationNowMs -NowMs $NowMs
    $path = Get-OrchestratorEscalationStatePath -StatePath $StatePath
    $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
    $recordKey = Get-OrchestratorEscalationRecordKey -EscalationClassId $EscalationClassId -CorrelationKey $CorrelationKey
    if (-not $state.records.ContainsKey($recordKey)) {
        $state.records[$recordKey] = @{
            escalationClassId = $EscalationClassId
            correlationKey    = $CorrelationKey
            escalationId      = $recordKey
            ackToken          = ([guid]::NewGuid().ToString('n'))
            route             = $route
            status            = 'pending'
            operatorStatus    = 'pending'
            attempts          = 0
            createdAtMs       = $now
            updatedAtMs       = $now
            autoRetryTicks    = 0
            deliveryFailures  = @()
        }
    }
    $record = $state.records[$recordKey]
    if (Test-OrchestratorEscalationAcked -Record $record) {
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        return @{ ok = $true; status = 'acked'; escalationId = $recordKey; delivered = $false; reason = 'already_acked' }
    }

    $record.updatedAtMs = $now
    $record.lastPayload = $Payload
    $record.lastMessage = $Message
    $envelope = New-OrchestratorEscalationEnvelope -Class $class -EscalationClassId $EscalationClassId `
        -CorrelationKey $CorrelationKey -RecordKey $recordKey -AckToken ([string]$record.ackToken) -Payload $Payload -Message $Message

    if ($route -eq 'auto-retry-only') {
        $record.autoRetryTicks = [int]$record.autoRetryTicks + 1
        $record.lastAutoRetryAtMs = $now
        $record.status = 'auto_retry_waiting'
        $promoteAfter = 0
        if ($class.PSObject.Properties.Name -contains 'promotion_after_ticks') {
            $promoteAfter = [int]$class.promotion_after_ticks
        }
        $promotedClass = ''
        if ($class.PSObject.Properties.Name -contains 'promotes_to') {
            $promotedClass = [string]$class.promotes_to
        }
        elseif ($class.PSObject.Properties.Name -contains 'promotion_target_class_id') {
            $promotedClass = [string]$class.promotion_target_class_id
        }
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        if ($promoteAfter -gt 0 -and $record.autoRetryTicks -ge $promoteAfter -and $promotedClass) {
            return Publish-OrchestratorEscalation -EscalationClassId $promotedClass -CorrelationKey $CorrelationKey `
                -Payload $Payload -Message $Message -StatePath $path -OperatorInboxDir $OperatorInboxDir `
                -HealthSpoolDir $HealthSpoolDir -OrchestratorSessionId $OrchestratorSessionId -CatalogPath $CatalogPath `
                -AoPath $AoPath -NowMs $now -DryRun:$DryRun
        }
        return @{ ok = $true; status = 'auto_retry_waiting'; escalationId = $recordKey; ticks = $record.autoRetryTicks; delivered = $false }
    }

    $wakeKey = "${EscalationClassId}|${CorrelationKey}"
    $lastWake = if ($state.wakeWindows.ContainsKey($wakeKey)) { [long]$state.wakeWindows[$wakeKey] } else { 0 }
    if ($lastWake -gt 0 -and ($now - $lastWake) -lt 30000) {
        $record.lastSuppressedWakeAtMs = $now
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        return @{ ok = $true; status = 'wake_suppressed'; escalationId = $recordKey; delivered = $false; reason = 'wake_storm_cap' }
    }

    $record.attempts = [int]$record.attempts + 1
    $record.lastAttemptAtMs = $now
    $state.wakeWindows[$wakeKey] = $now
    try {
        if ($route -eq 'llm-orchestrator') {
            $delivery = Invoke-OrchestratorEscalationLlmDelivery -Envelope $envelope -OrchestratorSessionId $OrchestratorSessionId -AoPath $AoPath -DryRun:$DryRun
            $record.status = 'delivered'
            $record.lastDelivery = $delivery
        }
        elseif ($route -eq 'operator') {
            $inbox = Write-OrchestratorEscalationOperatorInbox -Envelope $envelope -OperatorInboxDir $OperatorInboxDir -HealthSpoolDir $HealthSpoolDir
            if (-not $inbox.ok) { throw $inbox.reason }
            $record.status = 'operator_inbox'
            $record.operatorInboxPath = [string]$inbox.path
        }
        else {
            throw "unsupported escalation route: $route"
        }
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        return @{ ok = $true; status = [string]$record.status; escalationId = $recordKey; ackToken = [string]$record.ackToken; delivered = $true }
    }
    catch {
        $reason = [string]$_
        $record.status = 'fail_closed'
        $record.deliveryFailures = @($record.deliveryFailures) + @(@{ atMs = $now; reason = $reason })
        $fallback = Write-OrchestratorEscalationOperatorInbox -Envelope $envelope -OperatorInboxDir $OperatorInboxDir -HealthSpoolDir $HealthSpoolDir -Reason $reason
        $record.failClosedReason = $reason
        $record.operatorFallback = $fallback
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        return @{ ok = $false; status = 'fail_closed'; escalationId = $recordKey; reason = $reason; operatorFallback = $fallback }
    }
}

function Write-OrchestratorEscalationAck {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$EscalationId,
        [Parameter(Mandatory = $true)][string]$AckToken,
        [string]$StatePath = '',
        [Nullable[long]]$NowMs = $null
    )
    $path = Get-OrchestratorEscalationStatePath -StatePath $StatePath
    $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
    if (-not $state.records.ContainsKey($EscalationId)) {
        return @{ ok = $false; reason = 'unknown_escalation_id' }
    }
    $record = $state.records[$EscalationId]
    if ([string]$record.ackToken -ne $AckToken) {
        return @{ ok = $false; reason = 'invalid_ack_token' }
    }
    $record.status = 'acked'
    $record.ackedAtMs = Get-OrchestratorEscalationNowMs -NowMs $NowMs
    Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
    return @{ ok = $true; status = 'acked'; escalationId = $EscalationId }
}

function Write-OperatorEscalationAck {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$EscalationId,
        [Parameter(Mandatory = $true)][string]$AckToken,
        [string]$StatePath = '',
        [Nullable[long]]$NowMs = $null
    )
    $path = Get-OrchestratorEscalationStatePath -StatePath $StatePath
    $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
    if (-not $state.records.ContainsKey($EscalationId)) {
        return @{ ok = $false; reason = 'unknown_escalation_id' }
    }
    $record = $state.records[$EscalationId]
    if ([string]$record.ackToken -ne $AckToken) {
        return @{ ok = $false; reason = 'invalid_ack_token' }
    }
    $record.operatorStatus = 'acked'
    $record.operatorAckedAtMs = Get-OrchestratorEscalationNowMs -NowMs $NowMs
    Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
    return @{ ok = $true; status = 'operator_acked'; escalationId = $EscalationId }
}
