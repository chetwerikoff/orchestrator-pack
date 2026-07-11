#requires -Version 5.1
<#
.SYNOPSIS
  Durable orchestrator escalation publication contract (Issue #641).
#>

$Script:OrchestratorEscalationRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$Script:OrchestratorEscalationCatalogPath = Join-Path $Script:OrchestratorEscalationRepoRoot 'scripts/orchestrator-message-catalog.json'
$Script:OrchestratorEscalationJournaledSend = Join-Path $Script:OrchestratorEscalationRepoRoot 'scripts/journaled-worker-send.ps1'
$Script:OrchestratorEscalationDefaultState = @{
    schemaVersion = 2
    records       = @{}
    wakeWindows   = @{}
    audit         = @{}
}
$Script:OrchestratorEscalationSchemaVersion = 2
$Script:OrchestratorEscalationSupportedSchemaVersion = 2
$Script:OrchestratorEscalationMinBackoffMs = 30000
$Script:OrchestratorEscalationMaxAttempts = 8
$Script:OrchestratorEscalationMaxElapsedMs = 30 * 60 * 1000
$Script:OrchestratorEscalationCapacityWindowMs = 15 * 60 * 1000
$Script:OrchestratorEscalationTerminalStates = @('acked', 'dead_lettered', 'resolved', 'quarantined')

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Set-OpkVitestHarnessEnv.ps1')

function Test-OpkVitestHarnessActive {
    return $env:OPK_VITEST_HARNESS -eq '1'
}

function Assert-OrchestratorEscalationPathNotSharedDefault {
    param(
        [Parameter(Mandatory = $true)][string]$ResolvedPath,
        [Parameter(Mandatory = $true)][ValidateSet('state', 'operator_inbox', 'health_spool')][string]$Surface
    )
    if (-not (Test-OpkVitestHarnessActive)) { return }

    $shared = switch ($Surface) {
        'state' { Get-OrchestratorEscalationSharedDefaultStatePath }
        'operator_inbox' { Get-OrchestratorEscalationSharedDefaultOperatorInboxDir }
        'health_spool' { Get-OrchestratorEscalationSharedDefaultHealthSpoolDir }
    }

    $resolvedFull = [System.IO.Path]::GetFullPath($ResolvedPath)
    $sharedFull = [System.IO.Path]::GetFullPath($shared)
    if ($resolvedFull -eq $sharedFull) {
        throw "orchestrator escalation $Surface path resolves to shared production default under test harness: $ResolvedPath"
    }
}

function Get-OrchestratorEscalationStatePath {
    param([string]$StatePath = '')
    $resolved = if ($StatePath) {
        $StatePath
    }
    elseif ($env:AO_ORCHESTRATOR_ESCALATION_STATE) {
        $env:AO_ORCHESTRATOR_ESCALATION_STATE
    }
    else {
        Get-OrchestratorEscalationSharedDefaultStatePath
    }
    Assert-OrchestratorEscalationPathNotSharedDefault -ResolvedPath $resolved -Surface 'state'
    return $resolved
}

function Get-OrchestratorEscalationOperatorInboxDir {
    param([string]$OperatorInboxDir = '')
    $resolved = if ($OperatorInboxDir) {
        $OperatorInboxDir
    }
    elseif ($env:AO_OPERATOR_ESCALATION_INBOX) {
        $env:AO_OPERATOR_ESCALATION_INBOX
    }
    else {
        Get-OrchestratorEscalationSharedDefaultOperatorInboxDir
    }
    Assert-OrchestratorEscalationPathNotSharedDefault -ResolvedPath $resolved -Surface 'operator_inbox'
    return $resolved
}

function Get-OrchestratorEscalationHealthSpoolDir {
    param([string]$HealthSpoolDir = '')
    $resolved = if ($HealthSpoolDir) {
        $HealthSpoolDir
    }
    elseif ($env:AO_ESCALATION_HEALTH_SPOOL) {
        $env:AO_ESCALATION_HEALTH_SPOOL
    }
    else {
        Get-OrchestratorEscalationSharedDefaultHealthSpoolDir
    }
    Assert-OrchestratorEscalationPathNotSharedDefault -ResolvedPath $resolved -Surface 'health_spool'
    return $resolved
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


function Sync-OrchestratorEscalationMutableRecord {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$RecordKey
    )
    $record = ConvertTo-OrchestratorEscalationHashtable -Value $State.records[$RecordKey]
    $State.records[$RecordKey] = $record
    return $record
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

function Test-OrchestratorEscalationTerminalState {
    param([string]$TerminalState)
    return $Script:OrchestratorEscalationTerminalStates -contains [string]$TerminalState
}

function Get-OrchestratorEscalationPayloadValue {
    param($Payload, [string[]]$Names)
    foreach ($name in @($Names)) {
        if ($Payload -is [System.Collections.IDictionary] -and $Payload.Contains($name)) {
            $value = [string]$Payload[$name]
            if ($value) { return $value }
        }
        elseif ($null -ne $Payload -and ($Payload.PSObject.Properties.Name -contains $name)) {
            $value = [string]$Payload.$name
            if ($value) { return $value }
        }
    }
    return ''
}

function Get-OrchestratorEscalationConditionScope {
    param($Payload)
    $sessionId = Get-OrchestratorEscalationPayloadValue -Payload $Payload -Names @('session_id', 'sessionId', 'workerSessionId')
    if ($sessionId) { return "session:$sessionId" }
    $projectId = Get-OrchestratorEscalationPayloadValue -Payload $Payload -Names @('project_id', 'projectId')
    if ($projectId) { return "project:$projectId" }
    return 'project:global'
}

function Get-OrchestratorEscalationFailureKind {
    param($Payload)
    $failureKind = Get-OrchestratorEscalationPayloadValue -Payload $Payload -Names @('failure_kind', 'failureKind', 'reason')
    if ($failureKind) { return $failureKind }
    return 'generic'
}

function Get-OrchestratorEscalationConditionKey {
    param(
        [string]$EscalationClassId,
        [string]$CorrelationKey,
        $Payload
    )
    $scope = Get-OrchestratorEscalationConditionScope -Payload $Payload
    $failureKind = Get-OrchestratorEscalationFailureKind -Payload $Payload
    return Get-OrchestratorEscalationHash -Text "${EscalationClassId}`n${scope}`n${failureKind}"
}

function Get-OrchestratorEscalationEpochRecordKey {
    param([string]$ConditionKey, [int]$Epoch)
    return Get-OrchestratorEscalationHash -Text "${ConditionKey}`n${Epoch}"
}

function Get-OrchestratorEscalationOwnerProcess {
    param($Class, $Payload)
    $owner = Get-OrchestratorEscalationPayloadValue -Payload $Payload -Names @('source_process', 'sourceProcess')
    if ($owner) { return $owner }
    if ($Class.PSObject.Properties.Name -contains 'owning_process') {
        return [string]$Class.owning_process
    }
    return ''
}

function Initialize-OrchestratorEscalationRecord {
    param(
        [string]$EscalationClassId,
        [string]$CorrelationKey,
        [string]$RecordKey,
        [string]$ConditionKey,
        [int]$Epoch,
        [string]$Route,
        [string]$OwnerProcess,
        [long]$Now
    )
    return @{
        schemaVersion     = $Script:OrchestratorEscalationSchemaVersion
        escalationClassId = $EscalationClassId
        correlationKey    = $CorrelationKey
        escalationId      = $RecordKey
        recordKey         = $RecordKey
        conditionKey      = $ConditionKey
        epoch             = $Epoch
        ownerProcess      = $OwnerProcess
        ackToken          = ([guid]::NewGuid().ToString('n'))
        route             = $Route
        status            = 'pending'
        terminalState     = 'open'
        operatorStatus    = 'pending'
        operatorOutbox    = 'pending'
        attempts          = 0
        createdAtMs       = $Now
        updatedAtMs       = $Now
        autoRetryTicks    = 0
        deliveryFailures  = @()
        firstAttemptAtMs  = $null
    }
}

function Sync-OrchestratorEscalationRecordDefaults {
    param(
        [Parameter(Mandatory = $true)]$Record,
        [string]$EscalationClassId = '',
        [string]$CorrelationKey = '',
        $Payload = $null,
        [string]$Route = '',
        [string]$OwnerProcess = ''
    )
    if (-not $Record.schemaVersion) { $Record.schemaVersion = 1 }
    if (-not $Record.escalationId -and $Record.recordKey) { $Record.escalationId = [string]$Record.recordKey }
    if (-not $Record.recordKey -and $Record.escalationId) { $Record.recordKey = [string]$Record.escalationId }
    if (-not $Record.correlationKey -and $CorrelationKey) { $Record.correlationKey = $CorrelationKey }
    if (-not $Record.escalationClassId -and $EscalationClassId) { $Record.escalationClassId = $EscalationClassId }
    if (-not $Record.route -and $Route) { $Record.route = $Route }
    if (-not $Record.ownerProcess -and $OwnerProcess) { $Record.ownerProcess = $OwnerProcess }
    if (-not $Record.operatorOutbox) { $Record.operatorOutbox = 'pending' }
    if (-not $Record.terminalState) {
        $status = [string]$Record.status
        if ([string]$Record.operatorStatus -eq 'acked' -or $status -eq 'acked') {
            $Record.terminalState = 'acked'
        }
        elseif ($status -eq 'dead_lettered' -or $status -eq 'resolved' -or $status -eq 'quarantined') {
            $Record.terminalState = $status
        }
        else {
            $Record.terminalState = 'open'
        }
    }
    if (-not $Record.conditionKey) {
        $Record.conditionKey = Get-OrchestratorEscalationConditionKey -EscalationClassId ([string]$Record.escalationClassId) -CorrelationKey ([string]$Record.correlationKey) -Payload $(if ($Payload) { $Payload } else { $Record.lastPayload })
    }
    if (-not $Record.epoch) { $Record.epoch = 1 }
    if (-not $Record.recordKey) {
        $Record.recordKey = Get-OrchestratorEscalationEpochRecordKey -ConditionKey ([string]$Record.conditionKey) -Epoch ([int]$Record.epoch)
    }
    if (-not $Record.escalationId) { $Record.escalationId = [string]$Record.recordKey }
    if (-not $Record.failureKind) {
        $Record.failureKind = Get-OrchestratorEscalationFailureKind -Payload $(if ($Payload) { $Payload } else { $Record.lastPayload })
    }
    return $Record
}

function Find-OrchestratorEscalationOpenRecordKey {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$ConditionKey
    )
    foreach ($key in @($State.records.Keys)) {
        $record = Sync-OrchestratorEscalationMutableRecord -State $State -RecordKey $key
        Sync-OrchestratorEscalationRecordDefaults -Record $record | Out-Null
        if ([string]$record.conditionKey -eq $ConditionKey -and -not (Test-OrchestratorEscalationTerminalState -TerminalState ([string]$record.terminalState))) {
            return [string]$key
        }
    }
    return ''
}

function Get-OrchestratorEscalationNextEpoch {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$ConditionKey
    )
    $maxEpoch = 0
    foreach ($key in @($State.records.Keys)) {
        $record = Sync-OrchestratorEscalationMutableRecord -State $State -RecordKey $key
        Sync-OrchestratorEscalationRecordDefaults -Record $record | Out-Null
        if ([string]$record.conditionKey -ne $ConditionKey) { continue }
        $epoch = [int]($record.epoch ?? 0)
        if ($epoch -gt $maxEpoch) { $maxEpoch = $epoch }
    }
    return $maxEpoch + 1
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
        type                = 'orchestrator-escalation/v2'
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
        [Parameter(Mandatory = $true)]$Envelope,
        [string]$StableId = ''
    )
    if ($env:AO_ESCALATION_FORCE_INBOX_FAILURE -eq '1' -and $Prefix -eq 'operator') {
        throw 'forced operator inbox failure'
    }
    if ($env:AO_ESCALATION_FORCE_HEALTH_FAILURE -eq '1' -and $Prefix -eq 'health') {
        throw 'forced health spool failure'
    }
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $id = if ($StableId) { $StableId } else { [string]$Envelope.escalation_id }
    $path = if ($StableId) {
        Join-Path $Directory ("{0}-{1}.json" -f $Prefix, $id)
    }
    else {
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
        Join-Path $Directory ("{0}-{1}-{2}.json" -f $Prefix, $stamp, $id)
    }
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
        Write-Warning "orchestrator escalation health spool failed: $_"
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
            path = Write-OrchestratorEscalationJsonFile -Directory $dir -Prefix 'operator' -Envelope $operatorEnvelope -StableId ([string]$Envelope.escalation_id)
        }
    }
    catch {
        $spoolPath = Write-OrchestratorEscalationHealthSpool -Envelope $operatorEnvelope -HealthSpoolDir $HealthSpoolDir -Reason "operator_inbox_unwritable: $_"
        Write-Warning "orchestrator escalation operator inbox failed: $_"
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
    return ([string]$Record.terminalState -eq 'acked' -or [string]$Record.status -eq 'acked' -or [string]$Record.operatorStatus -eq 'acked')
}

function Resolve-OrchestratorEscalationTerminalState {
    param(
        [Parameter(Mandatory = $true)]$Record,
        [Parameter(Mandatory = $true)][ValidateSet('acked', 'dead_lettered', 'resolved', 'quarantined')][string]$TerminalState,
        [long]$Now = 0,
        [string]$Reason = ''
    )
    if ($Now -le 0) { $Now = Get-OrchestratorEscalationNowMs }
    $Record.terminalState = $TerminalState
    $Record.status = $TerminalState
    $Record.updatedAtMs = $Now
    switch ($TerminalState) {
        'acked' { $Record.ackedAtMs = $Now }
        'dead_lettered' { $Record.deadLetteredAtMs = $Now }
        'resolved' { $Record.resolvedAtMs = $Now }
        'quarantined' { $Record.quarantinedAtMs = $Now }
    }
    if ($Reason) {
        $Record.terminalReason = $Reason
    }
    return $Record
}

function Test-OrchestratorEscalationCapacityFailureKind {
    param([string]$FailureKind)
    return [string]$FailureKind -like '*capacity*'
}

function Test-OrchestratorEscalationSourceRateLimited {
    param($Record, [long]$Now)
    if (-not (Test-OrchestratorEscalationCapacityFailureKind -FailureKind ([string]$Record.failureKind))) {
        return $false
    }
    $lastSourceEmitAtMs = [long]($Record.lastSourceEmitAtMs ?? 0)
    return $lastSourceEmitAtMs -gt 0 -and ($Now - $lastSourceEmitAtMs) -lt $Script:OrchestratorEscalationCapacityWindowMs
}

function Complete-OrchestratorEscalationDeadLetter {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Record,
        [Parameter(Mandatory = $true)]$Class,
        [string]$OperatorInboxDir = '',
        [string]$HealthSpoolDir = '',
        [long]$Now = 0
    )
    if ($Now -le 0) { $Now = Get-OrchestratorEscalationNowMs }
    $envelope = New-OrchestratorEscalationEnvelope -Class $Class -EscalationClassId ([string]$Record.escalationClassId) `
        -CorrelationKey ([string]$Record.correlationKey) -RecordKey ([string]$Record.recordKey) -AckToken ([string]$Record.ackToken) `
        -Payload (ConvertTo-OrchestratorEscalationHashtable -Value $Record.lastPayload) -Message ([string]$Record.lastMessage)
    $inbox = Write-OrchestratorEscalationOperatorInbox -Envelope $envelope -OperatorInboxDir $OperatorInboxDir -HealthSpoolDir $HealthSpoolDir -Reason ([string]$Record.lastDeliveryFailure)
    $Record.operatorFallback = $inbox
    $Record.operatorOutbox = if ($inbox.ok) { 'published' } else { 'failed' }
    $Record.operatorInboxPath = if ($inbox.ok) { [string]$inbox.path } else { [string]$inbox.healthSpoolPath }
    Resolve-OrchestratorEscalationTerminalState -Record $Record -TerminalState 'dead_lettered' -Now $Now -Reason 'retry_cap_exhausted' | Out-Null
    return $Record
}

function Resolve-OrchestratorEscalationCondition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$EscalationClassId,
        [Parameter(Mandatory = $true)]$Payload,
        [string]$StatePath = '',
        [Nullable[long]]$NowMs = $null
    )
    $path = Get-OrchestratorEscalationStatePath -StatePath $StatePath
    $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
    $conditionKey = Get-OrchestratorEscalationConditionKey -EscalationClassId $EscalationClassId -CorrelationKey '' -Payload $Payload
    $recordKey = Find-OrchestratorEscalationOpenRecordKey -State $state -ConditionKey $conditionKey
    if (-not $recordKey) {
        return @{ ok = $true; status = 'not_found'; conditionKey = $conditionKey }
    }
    $record = Sync-OrchestratorEscalationMutableRecord -State $state -RecordKey $recordKey
    Resolve-OrchestratorEscalationTerminalState -Record $record -TerminalState 'resolved' -Now (Get-OrchestratorEscalationNowMs -NowMs $NowMs) -Reason 'condition_cleared' | Out-Null
    Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
    return @{ ok = $true; status = 'resolved'; escalationId = [string]$record.recordKey; conditionKey = $conditionKey }
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
        [string]$ReplayEscalationId = '',
        [switch]$SkipWakeSuppression,
        [switch]$DryRun
    )

    $class = Resolve-OrchestratorEscalationClass -EscalationClassId $EscalationClassId -CatalogPath $CatalogPath
    $route = [string]$class.route
    $now = Get-OrchestratorEscalationNowMs -NowMs $NowMs
    $path = Get-OrchestratorEscalationStatePath -StatePath $StatePath
    $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
    $state.schemaVersion = $Script:OrchestratorEscalationSchemaVersion
    $ownerProcess = Get-OrchestratorEscalationOwnerProcess -Class $class -Payload $Payload
    $recordKey = ''
    if ($ReplayEscalationId) {
        $recordKey = $ReplayEscalationId
        if (-not $state.records.ContainsKey($recordKey)) {
            throw "unknown escalation replay id: $ReplayEscalationId"
        }
    }
    else {
        $conditionKey = Get-OrchestratorEscalationConditionKey -EscalationClassId $EscalationClassId -CorrelationKey $CorrelationKey -Payload $Payload
        $recordKey = Find-OrchestratorEscalationOpenRecordKey -State $state -ConditionKey $conditionKey
        if (-not $recordKey) {
            $epoch = Get-OrchestratorEscalationNextEpoch -State $state -ConditionKey $conditionKey
            $recordKey = Get-OrchestratorEscalationEpochRecordKey -ConditionKey $conditionKey -Epoch $epoch
            $state.records[$recordKey] = Initialize-OrchestratorEscalationRecord `
                -EscalationClassId $EscalationClassId -CorrelationKey $CorrelationKey -RecordKey $recordKey `
                -ConditionKey $conditionKey -Epoch $epoch -Route $route -OwnerProcess $ownerProcess -Now $now
        }
    }
    $record = Sync-OrchestratorEscalationMutableRecord -State $state -RecordKey $recordKey
    Sync-OrchestratorEscalationRecordDefaults -Record $record -EscalationClassId $EscalationClassId -CorrelationKey $CorrelationKey -Payload $Payload -Route $route -OwnerProcess $ownerProcess | Out-Null
    if (Test-OrchestratorEscalationAcked -Record $record) {
        Resolve-OrchestratorEscalationTerminalState -Record $record -TerminalState 'acked' -Now $now | Out-Null
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        return @{ ok = $true; status = 'acked'; escalationId = $recordKey; delivered = $false; reason = 'already_acked' }
    }
    if (Test-OrchestratorEscalationTerminalState -TerminalState ([string]$record.terminalState)) {
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        return @{ ok = $true; status = [string]$record.terminalState; escalationId = $recordKey; delivered = $false; reason = 'already_terminal' }
    }

    $record.updatedAtMs = $now
    $record.lastPayload = $Payload
    $record.lastMessage = $Message
    $record.correlationKey = $CorrelationKey
    $record.failureKind = Get-OrchestratorEscalationFailureKind -Payload $Payload
    $record.lastSourceEmitAtMs = $now
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

    if (-not $ReplayEscalationId -and $record.attempts -gt 0) {
        if (Test-OrchestratorEscalationSourceRateLimited -Record $record -Now $now) {
            Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
            return @{ ok = $true; status = 'source_rate_limited'; escalationId = $recordKey; delivered = $false; reason = 'source_rate_limited' }
        }
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        return @{ ok = $true; status = 'open_existing'; escalationId = $recordKey; delivered = $false; reason = 'condition_open' }
    }

    $wakeKey = "${EscalationClassId}|${CorrelationKey}"
    $lastWake = if ($state.wakeWindows.ContainsKey($wakeKey)) { [long]$state.wakeWindows[$wakeKey] } else { 0 }
    if (-not $SkipWakeSuppression -and $lastWake -gt 0 -and ($now - $lastWake) -lt $Script:OrchestratorEscalationMinBackoffMs) {
        $record.lastSuppressedWakeAtMs = $now
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        return @{ ok = $true; status = 'wake_suppressed'; escalationId = $recordKey; delivered = $false; reason = 'wake_storm_cap' }
    }

    $record.attempts = [int]$record.attempts + 1
    if (-not $record.firstAttemptAtMs) { $record.firstAttemptAtMs = $now }
    $record.lastAttemptAtMs = $now
    $state.wakeWindows[$wakeKey] = $now
    try {
        if ($route -eq 'llm-orchestrator') {
            $delivery = Invoke-OrchestratorEscalationLlmDelivery -Envelope $envelope -OrchestratorSessionId $OrchestratorSessionId -AoPath $AoPath -DryRun:$DryRun
            $record.status = 'delivered'
            $record.terminalState = 'open'
            $record.lastDelivery = $delivery
        }
        elseif ($route -eq 'operator') {
            $inbox = Write-OrchestratorEscalationOperatorInbox -Envelope $envelope -OperatorInboxDir $OperatorInboxDir -HealthSpoolDir $HealthSpoolDir
            if (-not $inbox.ok) { throw $inbox.reason }
            $record.status = 'operator_inbox'
            $record.terminalState = 'open'
            $record.operatorOutbox = 'published'
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
        $record.status = 'pending'
        $record.terminalState = 'open'
        $record.deliveryFailures = @($record.deliveryFailures) + @(@{ atMs = $now; reason = $reason })
        $record.lastDeliveryFailure = $reason
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        return @{ ok = $false; status = 'pending'; escalationId = $recordKey; reason = $reason; delivered = $false }
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
    $record = Sync-OrchestratorEscalationMutableRecord -State $state -RecordKey $EscalationId
    if ([string]$record.ackToken -ne $AckToken) {
        return @{ ok = $false; reason = 'invalid_ack_token' }
    }
    Resolve-OrchestratorEscalationTerminalState -Record $record -TerminalState 'acked' -Now (Get-OrchestratorEscalationNowMs -NowMs $NowMs) | Out-Null
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
    $record = Sync-OrchestratorEscalationMutableRecord -State $state -RecordKey $EscalationId
    if ([string]$record.ackToken -ne $AckToken) {
        return @{ ok = $false; reason = 'invalid_ack_token' }
    }
    Sync-OrchestratorEscalationRecordDefaults -Record $record | Out-Null
    $record.operatorStatus = 'acked'
    $record.operatorAckedAtMs = Get-OrchestratorEscalationNowMs -NowMs $NowMs
    Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
    return @{ ok = $true; status = 'operator_acked'; escalationId = $EscalationId }
}
