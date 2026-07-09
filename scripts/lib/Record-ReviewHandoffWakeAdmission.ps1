#requires -Version 5.1
<#
.SYNOPSIS
  Durable ready_for_review hand-off admission records (Issue #381).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')

$Script:ReviewHandoffWakeAdmissionCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-handoff-wake-admission.mjs'

function Get-ReviewHandoffWakeAdmissionPath {
    param([string]$StateRoot = '')

    if ($StateRoot) {
        return Join-Path $StateRoot 'review-handoff-wake-admission.json'
    }
    if ($env:AO_REVIEW_HANDOFF_WAKE_ADMISSION_STATE) {
        return $env:AO_REVIEW_HANDOFF_WAKE_ADMISSION_STATE
    }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-handoff-wake-admission.json'
}

function Invoke-ReviewHandoffWakeAdmissionCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewHandoffWakeAdmissionCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-handoff-wake-admission' -JsonDepth 30
}

function Get-ReviewHandoffWakeAdmissionState {
    param([string]$Path)

    $default = @{ records = @{}; pendingRetries = @{}; actedOn = @{}; replayCursor = 0; lastUpdatedMs = $null }
    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $default -ActionTracking
}

function Set-ReviewHandoffWakeAdmissionState {
    param(
        [string]$Path,
        [hashtable]$State
    )

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $tmp = Join-Path $dir ".$(Split-Path -Leaf $Path).$PID.tmp"
    $json = ($State | ConvertTo-Json -Depth 30 -Compress)
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}


function Get-ReviewHandoffWakeAdmissionLockPath {
    param([string]$StatePath)

    $dir = Split-Path -Parent $StatePath
    if (-not $dir) {
        return Join-Path ([System.IO.Path]::GetTempPath()) 'review-handoff-wake-admission.lock'
    }
    return Join-Path $dir 'review-handoff-wake-admission.lock'
}


function ConvertTo-ReviewHandoffAdmissionHashtable {
    param([object]$Value)

    $copy = @{}
    if ($null -eq $Value) { return $copy }
    if ($Value -is [hashtable]) {
        foreach ($key in $Value.Keys) {
            $copy[[string]$key] = $Value[$key]
        }
        return $copy
    }
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($key in $Value.Keys) {
            $copy[[string]$key] = $Value[$key]
        }
        return $copy
    }
    foreach ($prop in $Value.PSObject.Properties) {
        $copy[$prop.Name] = $prop.Value
    }
    return $copy
}

function Copy-ReviewHandoffAdmissionHashtable {
    param([object]$Source)

    return (ConvertTo-ReviewHandoffAdmissionHashtable -Value $Source)
}

function Merge-ReviewHandoffAdmissionRecordMaps {
    param(
        [object]$Current,
        [object]$Desired,
        [object]$Baseline
    )

    $current = ConvertTo-ReviewHandoffAdmissionHashtable -Value $Current
    $desired = ConvertTo-ReviewHandoffAdmissionHashtable -Value $Desired
    $baseline = ConvertTo-ReviewHandoffAdmissionHashtable -Value $Baseline
    $merged = @{}

    foreach ($key in $current.Keys) {
        if ($desired.ContainsKey($key)) {
            $merged[$key] = $desired[$key]
        }
        elseif (-not $baseline.ContainsKey($key)) {
            $merged[$key] = $current[$key]
        }
    }
    foreach ($key in $desired.Keys) {
        if (-not $merged.ContainsKey($key)) {
            $merged[$key] = $desired[$key]
        }
    }
    return $merged
}

function Merge-ReviewHandoffActedOnMaps {
    param(
        [object]$Current,
        [object]$Desired,
        [object]$Baseline
    )

    $current = ConvertTo-ReviewHandoffAdmissionHashtable -Value $Current
    $desired = ConvertTo-ReviewHandoffAdmissionHashtable -Value $Desired
    $baseline = ConvertTo-ReviewHandoffAdmissionHashtable -Value $Baseline
    $merged = Copy-ReviewHandoffAdmissionHashtable -Source $current

    foreach ($key in $desired.Keys) {
        $merged[$key] = $desired[$key]
    }
    foreach ($key in $baseline.Keys) {
        if (-not $desired.ContainsKey($key)) {
            [void]$merged.Remove($key)
        }
    }
    return $merged
}

function Merge-ReviewHandoffWakeAdmissionWriteState {
    param(
        [hashtable]$Current,
        [hashtable]$Update,
        [hashtable]$Baseline
    )

    $baselineRecords = @{}
    $baselineActedOn = @{}
    $baselinePendingRetries = @{}
    if ($null -ne $Baseline) {
        if ($null -ne $Baseline.records) { $baselineRecords = $Baseline.records }
        if ($null -ne $Baseline.actedOn) { $baselineActedOn = $Baseline.actedOn }
        if ($null -ne $Baseline.pendingRetries) { $baselinePendingRetries = $Baseline.pendingRetries }
    }

    $merged = @{
        records        = $Current.records
        pendingRetries = $Current.pendingRetries
        actedOn        = $Current.actedOn
        replayCursor   = $Current.replayCursor
        lastUpdatedMs  = $Current.lastUpdatedMs
    }
    if ($null -ne $Update.records) {
        $merged.records = Merge-ReviewHandoffAdmissionRecordMaps -Current $Current.records -Desired $Update.records -Baseline $baselineRecords
    }
    if ($null -ne $Update.pendingRetries) {
        $merged.pendingRetries = Merge-ReviewHandoffAdmissionRecordMaps -Current $Current.pendingRetries -Desired $Update.pendingRetries -Baseline $baselinePendingRetries
    }
    if ($null -ne $Update.actedOn) {
        $merged.actedOn = Merge-ReviewHandoffActedOnMaps -Current $Current.actedOn -Desired $Update.actedOn -Baseline $baselineActedOn
    }
    if ($null -ne $Update.replayCursor) { $merged.replayCursor = [int]$Update.replayCursor }
    if ($null -ne $Update.lastUpdatedMs) { $merged.lastUpdatedMs = $Update.lastUpdatedMs }
    return $merged
}

function Invoke-ReviewHandoffWakeAdmissionStateLocked {
    param(
        [string]$Path,
        [scriptblock]$Mutator,
        [switch]$DryRun
    )

    if (-not $Path) {
        return @{ ok = $false; reason = 'missing_path' }
    }

    $lockPath = Get-ReviewHandoffWakeAdmissionLockPath -StatePath $Path
    $mutatorResult = $null
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Metadata @{
        purpose = 'review-handoff-wake-admission-state'
    } -Action {
        $current = Get-ReviewHandoffWakeAdmissionState -Path $Path
        Assert-MechanicalJsonStateFencesTrusted -State $current -Context 'handoff admission state'
        $next = & $Mutator $current
        if ($null -eq $next) {
            $script:mutatorResult = $current
            return
        }
        if (-not $DryRun) {
            Set-ReviewHandoffWakeAdmissionState -Path $Path -State $next
        }
        $script:mutatorResult = $next
    }

    if (-not $fenced.ok) {
        return @{ ok = $false; reason = 'admission_state_busy' }
    }
    return @{ ok = $true; state = $script:mutatorResult }
}

function Update-ReviewHandoffWakeAdmissionStateLocked {
    param(
        [string]$Path,
        [hashtable]$Update,
        [hashtable]$Baseline,
        [switch]$DryRun
    )

    return Invoke-ReviewHandoffWakeAdmissionStateLocked -Path $Path -DryRun:$DryRun -Mutator {
        param($current)
        return (Merge-ReviewHandoffWakeAdmissionWriteState -Current $current -Update $Update -Baseline $Baseline)
    }
}

function New-ReviewHandoffWakeFilterResultFromAdmissionRecord {
    param(
        [object]$Record,
        [string]$ProjectId = 'orchestrator-pack'
    )

    if (-not $Record) { return $null }
    $prNumber = [int]$Record.prNumber
    $sessionId = [string]$Record.sessionId
    if ($prNumber -le 0 -or -not $sessionId) { return $null }

    $repoSlug = [string]$Record.repoSlug
    $prUrl = if ($repoSlug) { "https://github.com/$repoSlug/pull/$prNumber" } else { '' }
    $auditLine = "review-handoff-wake: outcome=replay reason=listener_recovery wakeKind=ready_for_review session=$sessionId pr=#$prNumber"
    return @{
        ok               = $true
        wakeKind         = 'ready_for_review'
        sessionId        = $sessionId
        projectId        = if ($Record.projectId) { [string]$Record.projectId } else { $ProjectId }
        prNumber         = $prNumber
        prUrl            = $prUrl
        wakeMessage      = "wake ready_for_review session=$sessionId pr=#$prNumber"
        dedupeKey        = "ready_for_review|$sessionId|$prNumber|"
        handoffAdmission = @{
            promotedFromInfoPriority = $false
            admittedBaseRef          = [string]$Record.admittedBaseRef
            admittedHeadSha          = [string]$Record.headSha
            audit                    = @{
                outcome   = 'replay'
                reason    = 'listener_recovery'
                wakeKind  = 'ready_for_review'
                sessionId = $sessionId
                prNumber  = $prNumber
            }
            auditLine                = $auditLine
        }
    }
}


function Write-ReviewHandoffClaimAudit {
    param(
        [Parameter(Mandatory = $true)][string]$Outcome,
        [Parameter(Mandatory = $true)][string]$ClaimOutcome,
        [Parameter(Mandatory = $true)][string]$Reason,
        [string]$SessionId = '',
        [int]$PrNumber = 0,
        [scriptblock]$LogWriter = { param([string]$Message) Write-Host $Message }
    )

    $formatted = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'formatAudit' -Payload @{
        audit = @{
            outcome      = $Outcome
            reason       = $Reason
            claimOutcome = $ClaimOutcome
            sessionId    = $SessionId
            prNumber     = $PrNumber
        }
    }
    if ($formatted.auditLine) {
        & $LogWriter ([string]$formatted.auditLine)
    }
}

function Record-ReviewHandoffWakeAdmission {
    param(
        [string]$StateRoot = '',
        [object]$FilterResult,
        [long]$WakeReceivedMs = 0,
        [array]$OpenPrs = @(),
        [bool]$OpenPrIndexTrusted = $false,
        [switch]$DryRun
    )

    if (-not $StateRoot) {
        return @{ recorded = $false; reason = 'missing_state_root' }
    }
    if (-not $FilterResult.handoffAdmission) {
        return @{ recorded = $false; reason = 'not_handoff_admission' }
    }

    $path = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
    $seedOutcome = $null
    $lockResult = Invoke-ReviewHandoffWakeAdmissionStateLocked -Path $path -DryRun:$DryRun -Mutator {
        param($state)
        $seed = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'seed' -Payload @{
            existing             = $state.records
            actedOn              = $state.actedOn
            openPrs              = @($OpenPrs)
            openPrIndexTrusted   = $OpenPrIndexTrusted
            admission = @{
                subject = @{
                    sessionId    = [string]$FilterResult.sessionId
                    projectId    = [string]$FilterResult.projectId
                    prNumber     = [int]$FilterResult.prNumber
                    prUrl        = [string]$FilterResult.prUrl
                    priority     = [string]$FilterResult.handoffAdmission.audit.priority
                    eventId      = if ($FilterResult.handoffAdmission.audit.eventId) { [string]$FilterResult.handoffAdmission.audit.eventId } else { '' }
                    receivedAtMs = if ($WakeReceivedMs -gt 0) { $WakeReceivedMs } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
                }
                admittedBaseRef = [string]$FilterResult.handoffAdmission.admittedBaseRef
                admittedHeadSha = [string]$FilterResult.handoffAdmission.admittedHeadSha
                outcome         = 'promoted'
            }
            nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        $script:seedOutcome = $seed
        if (-not $seed.seeded) {
            return $null
        }
        return (Merge-ReviewHandoffWakeAdmissionWriteState -Current $state -Update @{
            records       = $seed.records
            lastUpdatedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        } -Baseline @{
            records = $state.records
            actedOn = $state.actedOn
        })
    }

    if (-not $lockResult.ok) {
        return @{ recorded = $false; reason = [string]$lockResult.reason }
    }
    $seed = $script:seedOutcome
    if (-not $seed.seeded) {
        return @{ recorded = $false; reason = [string]$seed.reason; noop = [bool]$seed.noop }
    }

    return @{
        recorded = $true
        key      = [string]$seed.key
        path     = $path
        record   = $seed.record
    }
}

function Record-ReviewHandoffWakePendingRetry {
    param(
        [string]$StateRoot = '',
        [string]$BodyJson = '',
        [string]$LookupDimension = '',
        [switch]$DryRun
    )

    if (-not $StateRoot) {
        return @{ recorded = $false; reason = 'missing_state_root' }
    }
    if (-not $BodyJson) {
        return @{ recorded = $false; reason = 'missing_body_json' }
    }

    $path = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
    $seedOutcome = $null
    $lockResult = Invoke-ReviewHandoffWakeAdmissionStateLocked -Path $path -DryRun:$DryRun -Mutator {
        param($state)
        $seed = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'seedPendingRetry' -Payload @{
            existing        = $state.pendingRetries
            bodyJson        = $BodyJson
            lookupDimension = $LookupDimension
            nowMs           = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        $script:seedOutcome = $seed
        if (-not $seed.seeded) {
            return $null
        }
        return (Merge-ReviewHandoffWakeAdmissionWriteState -Current $state -Update @{
            pendingRetries = $seed.pendingRetries
            lastUpdatedMs  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        } -Baseline @{
            pendingRetries = $state.pendingRetries
            records        = $state.records
            actedOn        = $state.actedOn
        })
    }

    if (-not $lockResult.ok) {
        return @{ recorded = $false; reason = [string]$lockResult.reason }
    }
    $seed = $script:seedOutcome
    if (-not $seed.seeded) {
        return @{ recorded = $false; reason = [string]$seed.reason }
    }

    return @{
        recorded = $true
        key      = [string]$seed.key
        path     = $path
        record   = $seed.record
    }
}

function Clear-ReviewHandoffWakePendingRetry {
    param(
        [string]$StateRoot = '',
        [string]$Key = '',
        [switch]$DryRun
    )

    if (-not $StateRoot -or -not $Key) {
        return @{ cleared = $false; reason = 'missing_state_or_key' }
    }

    $path = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
    $clearOutcome = $null
    $lockResult = Invoke-ReviewHandoffWakeAdmissionStateLocked -Path $path -DryRun:$DryRun -Mutator {
        param($state)
        $cleared = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'clearPendingRetry' -Payload @{
            existing = $state.pendingRetries
            key      = $Key
        }
        $script:clearOutcome = $cleared
        if (-not $cleared.cleared) {
            return $null
        }
        return (Merge-ReviewHandoffWakeAdmissionWriteState -Current $state -Update @{
            pendingRetries = $cleared.pendingRetries
            lastUpdatedMs  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        } -Baseline @{
            pendingRetries = $state.pendingRetries
            records        = $state.records
            actedOn        = $state.actedOn
        })
    }

    if (-not $lockResult.ok) {
        return @{ cleared = $false; reason = [string]$lockResult.reason }
    }
    $cleared = $script:clearOutcome
    if (-not $cleared.cleared) {
        return @{ cleared = $false; reason = [string]$cleared.reason }
    }

    return @{ cleared = $true; key = $Key; path = $path }
}

function Write-ReviewHandoffRecordTransition {
    param(
        [string]$Transition,
        [string]$Reason,
        [string]$Key = '',
        [string]$AdmissionId = '',
        [int]$PrNumber = 0,
        [string]$HeadSha = '',
        [scriptblock]$LogWriter = { param([string]$Message) Write-Host $Message }
    )

    $formatted = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'formatTransition' -Payload @{
        audit = @{
            transition = $Transition
            reason     = $Reason
            key        = $Key
            admissionId = $AdmissionId
            prNumber   = $PrNumber
            headSha    = $HeadSha
        }
    }
    if ($formatted.transitionLine) {
        & $LogWriter ([string]$formatted.transitionLine)
    }
}

function Save-ReviewHandoffWakeAdmissionLifecycleState {
    param(
        [string]$Path,
        [hashtable]$State,
        [hashtable]$Baseline,
        [switch]$DryRun,
        [switch]$IncludePendingRetries
    )

    if ($DryRun) { return @{ ok = $true } }
    $update = @{
        records       = $State.records
        actedOn       = $State.actedOn
        replayCursor  = if ($null -ne $State.replayCursor) { [int]$State.replayCursor } else { 0 }
        lastUpdatedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    if ($IncludePendingRetries -and $null -ne $State.pendingRetries) {
        $update.pendingRetries = $State.pendingRetries
    }
    return (Update-ReviewHandoffWakeAdmissionStateLocked -Path $Path -Update $update -Baseline $Baseline)
}

function Get-ReviewHandoffWakeAdmissionReplay {
    param(
        [string]$StateRoot = '',
        [long]$ListenerReadyMs,
        [array]$OpenPrs = @(),
        [bool]$OpenPrIndexTrusted = $false,
        [long]$NowMs = 0
    )

    if (-not $StateRoot) {
        return @{ replay = @(); listenerReadyMs = $ListenerReadyMs }
    }
    $path = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
    $state = Get-ReviewHandoffWakeAdmissionState -Path $path
    if (-not $NowMs) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    return Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'replay' -Payload @{
        records             = $state.records
        actedOn             = $state.actedOn
        replayCursor        = $state.replayCursor
        openPrs             = @($OpenPrs)
        openPrIndexTrusted  = $OpenPrIndexTrusted
        listenerReadyMs     = $ListenerReadyMs
        nowMs               = $NowMs
    }
}

function Get-ReviewHandoffWakePendingRetries {
    param([string]$StateRoot = '')

    if (-not $StateRoot) {
        return @{ retries = @() }
    }
    $path = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
    $state = Get-ReviewHandoffWakeAdmissionState -Path $path
    return Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'listPendingRetries' -Payload @{
        pendingRetries = $state.pendingRetries
    }
}

function Test-ReviewHandoffReceiptToRunBound {
    param(
        [long]$WakeReceivedMs,
        [long]$RunCreatedAtMs
    )

    return Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'receiptBound' -Payload @{
        wakeReceivedMs   = $WakeReceivedMs
        runCreatedAtMs   = $RunCreatedAtMs
    }
}

function Test-ReviewHandoffTriggerDurable {
    param([object]$TriggerOutcome)

    if ($null -eq $TriggerOutcome) { return $false }
    if ($TriggerOutcome -is [hashtable]) {
        if ($TriggerOutcome.triggerResult) {
            return [bool]$TriggerOutcome.triggerResult.triggered
        }
        return [bool]$TriggerOutcome.triggered
    }
    return $false
}

function Test-ReviewHandoffReceiptWindowExpired {
    param([long]$WakeReceivedMs)

    if ($WakeReceivedMs -le 0) { return $false }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $bound = Test-ReviewHandoffReceiptToRunBound -WakeReceivedMs $WakeReceivedMs -RunCreatedAtMs $nowMs
    return -not $bound.withinBound
}

function Get-ReviewHandoffTriggerFailureReason {
    param([object]$TriggerOutcome)

    if ($null -eq $TriggerOutcome) { return '' }
    if ($TriggerOutcome -is [hashtable]) {
        if ($TriggerOutcome.triggerResult -and $TriggerOutcome.triggerResult.reason) {
            return [string]$TriggerOutcome.triggerResult.reason
        }
        if ($TriggerOutcome.reason) {
            return [string]$TriggerOutcome.reason
        }
    }
    return ''
}

function Test-ReviewHandoffPendingRetryRetained {
    param(
        [object]$TriggerOutcome,
        [long]$ReceivedAtMs
    )

    if (Test-ReviewHandoffTriggerDurable -TriggerOutcome $TriggerOutcome) {
        return $false
    }
    if (Test-ReviewHandoffReceiptWindowExpired -WakeReceivedMs $ReceivedAtMs) {
        return $false
    }
    $reason = Get-ReviewHandoffTriggerFailureReason -TriggerOutcome $TriggerOutcome
    if ($reason -eq 'handoff_receipt_bound_exceeded') {
        return $false
    }
    return $true
}

function Get-ReviewRunCreatedAtMs {
    param([object]$Run)

    if (-not $Run) { return $null }
    foreach ($field in @('createdAt', 'createdAtUtc', 'startedAt')) {
        $raw = $Run.$field
        if (-not $raw) { continue }
        try {
            return [DateTimeOffset]::Parse([string]$raw).ToUnixTimeMilliseconds()
        }
        catch {
            continue
        }
    }
    return $null
}

function Invoke-ReviewHandoffWakeAdmissionRecovery {
    param(
        [string]$StateRoot = '',
        [long]$ListenerReadyMs,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$RepoRoot = '',
        [string]$ReviewCommand = '',
        [string]$SideEffectLockPath = '',
        [hashtable]$FixtureSnapshot,
        [scriptblock]$InvokeWakeFilter,
        [scriptblock]$ResolveOpenPrs,
        [scriptblock]$InvokeTrigger,
        [switch]$DryRun,
        [switch]$PendingRetriesOnly,
        [int]$ReplayBatchSize = 0,
        [scriptblock]$LogWriter = { param([string]$Message) Write-Host $Message }
    )

    if (-not $StateRoot) {
        return
    }

    $statePath = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
    $pending = Get-ReviewHandoffWakePendingRetries -StateRoot $StateRoot
    foreach ($retry in @($pending.retries)) {
        $bodyJson = [string]$retry.bodyJson
        $retryKey = [string]$retry.key
        if (-not $bodyJson) { continue }

        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $admissionState = Get-ReviewHandoffWakeAdmissionState -Path $statePath
        $pendingBaseline = @{
            records        = ConvertTo-ReviewHandoffAdmissionHashtable -Value $admissionState.records
            actedOn        = ConvertTo-ReviewHandoffAdmissionHashtable -Value $admissionState.actedOn
            pendingRetries = ConvertTo-ReviewHandoffAdmissionHashtable -Value $admissionState.pendingRetries
        }
        $lookupGate = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'evaluatePendingLookupRetry' -Payload @{
            record = $retry
            nowMs  = $nowMs
        }
        $lookupDimension = if ($lookupGate.lookupDimension) { [string]$lookupGate.lookupDimension } else { 'openPr' }

        if (-not $lookupGate.shouldAttempt) {
            if ($lookupGate.yieldToBackstop) {
                if ($lookupGate.reason -eq 'lookup_retry_exhausted' -and -not $retry.lookupDegraded) {
                    $degraded = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'markPendingLookupDegraded' -Payload @{
                        existing = $admissionState.pendingRetries
                        key      = $retryKey
                        nowMs    = $nowMs
                    }
                    if ($degraded.marked -and -not $DryRun) {
                        $write = Update-ReviewHandoffWakeAdmissionStateLocked -Path $statePath -Baseline $pendingBaseline -Update @{
                            pendingRetries = $degraded.pendingRetries
                            lastUpdatedMs  = $nowMs
                        }
                        if ($write.ok) {
                            $admissionState = $write.state
                        }
                    }
                }
                & $LogWriter "review-handoff-wake: pending retry key=$retryKey lookup degraded ($lookupDimension) reason=$($lookupGate.reason)"
            }
            else {
                & $LogWriter "review-handoff-wake: pending retry key=$retryKey lookup backoff ($lookupDimension) reason=$($lookupGate.reason)"
            }
            continue
        }

        $openPrLookupFailed = $false
        $openPrsForAdmission = @()
        try {
            $openPrsForAdmission = @(& $ResolveOpenPrs)
        }
        catch {
            $openPrLookupFailed = $true
        }
        if ($openPrLookupFailed) {
            $attempt = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'recordPendingLookupAttempt' -Payload @{
                existing        = $admissionState.pendingRetries
                key             = $retryKey
                lookupDimension = 'openPr'
                nowMs           = $nowMs
            }
            if ($attempt.recorded -and -not $DryRun) {
                $admissionState.pendingRetries = $attempt.pendingRetries
                $write = Save-ReviewHandoffWakeAdmissionLifecycleState -Path $statePath -State $admissionState -Baseline $pendingBaseline -IncludePendingRetries
                if ($write.ok) {
                    $admissionState = $write.state
                }
            }
            & $LogWriter "review-handoff-wake: pending retry key=$retryKey still admission_lookup_unknown lookupDimension=openPr attempt=$($attempt.record.lookupAttemptCount)"
            continue
        }

        $filterResult = & $InvokeWakeFilter $bodyJson $openPrsForAdmission $openPrLookupFailed
        if (-not $filterResult.ok) {
            if ($filterResult.retryable -and $filterResult.reason -eq 'admission_lookup_unknown') {
                $dim = 'openPr'
                if ($filterResult.audit -and $filterResult.audit.lookupDimension) {
                    $dim = [string]$filterResult.audit.lookupDimension
                }
                $attempt = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'recordPendingLookupAttempt' -Payload @{
                    existing        = $admissionState.pendingRetries
                    key             = $retryKey
                    lookupDimension = $dim
                    nowMs           = $nowMs
                }
                if ($attempt.recorded -and -not $DryRun) {
                    $stateNow = Get-ReviewHandoffWakeAdmissionState -Path $statePath
                    $stateNow.pendingRetries = $attempt.pendingRetries
                    $write = Save-ReviewHandoffWakeAdmissionLifecycleState -Path $statePath -State $stateNow -Baseline $pendingBaseline -IncludePendingRetries
                    if ($write.ok) {
                        $admissionState = $write.state
                    }
                }
                & $LogWriter "review-handoff-wake: pending retry key=$retryKey still admission_lookup_unknown lookupDimension=$dim attempt=$($attempt.record.lookupAttemptCount)"
            }
            elseif ($filterResult.retryable) {
                & $LogWriter "review-handoff-wake: pending retry key=$retryKey still retryable ($($filterResult.reason))"
            }
            else {
                & $LogWriter "review-handoff-wake: pending retry key=$retryKey dropped ($($filterResult.reason))"
                Clear-ReviewHandoffWakePendingRetry -StateRoot $StateRoot -Key $retryKey -DryRun:$DryRun | Out-Null
            }
            continue
        }

        if ($filterResult.wakeKind -eq 'ready_for_review') {
            $receivedAtMs = if ($retry.receivedAtMs) { [long]$retry.receivedAtMs } else { $ListenerReadyMs }
            if (Test-ReviewHandoffReceiptWindowExpired -WakeReceivedMs $receivedAtMs) {
                & $LogWriter "review-handoff-wake: pending retry key=$retryKey dropped (handoff_receipt_bound_exceeded)"
                Clear-ReviewHandoffWakePendingRetry -StateRoot $StateRoot -Key $retryKey -DryRun:$DryRun | Out-Null
                continue
            }
            $triggerOutcome = & $InvokeTrigger $filterResult $receivedAtMs
            if (Test-ReviewHandoffTriggerDurable -TriggerOutcome $triggerOutcome) {
                Clear-ReviewHandoffWakePendingRetry -StateRoot $StateRoot -Key $retryKey -DryRun:$DryRun | Out-Null
            }
            elseif (Test-ReviewHandoffPendingRetryRetained -TriggerOutcome $triggerOutcome -ReceivedAtMs $receivedAtMs) {
                & $LogWriter "review-handoff-wake: pending retry key=$retryKey retained until durable trigger"
            }
            else {
                $failureReason = Get-ReviewHandoffTriggerFailureReason -TriggerOutcome $triggerOutcome
                if (-not $failureReason) { $failureReason = 'trigger_not_durable' }
                & $LogWriter "review-handoff-wake: pending retry key=$retryKey dropped ($failureReason)"
                Clear-ReviewHandoffWakePendingRetry -StateRoot $StateRoot -Key $retryKey -DryRun:$DryRun | Out-Null
            }
        }
        else {
            Clear-ReviewHandoffWakePendingRetry -StateRoot $StateRoot -Key $retryKey -DryRun:$DryRun | Out-Null
        }
    }

    if ($PendingRetriesOnly) {
        return
    }

    $openPrLookupFailed = $false
    $openPrsForReplay = @()
    try {
        $openPrsForReplay = @(& $ResolveOpenPrs)
    }
    catch {
        $openPrLookupFailed = $true
    }
    $openPrIndexTrusted = -not $openPrLookupFailed

    $admissionState = Get-ReviewHandoffWakeAdmissionState -Path $statePath
    if (-not (Test-MechanicalJsonStateFencesTrusted -State $admissionState)) {
        $recoveryReason = Get-MechanicalJsonStateRecoveryReason -State $admissionState
        if (-not $recoveryReason) { $recoveryReason = 'untrusted_recovery_state' }
        & $LogWriter "review-handoff-wake: admission store corrupt; skipping replay (reason=$recoveryReason)"
        return
    }

    $continueReplay = $true
    while ($continueReplay) {
        $loopAdmissionState = $null
        $loopRead = Invoke-ReviewHandoffWakeAdmissionStateLocked -Path $statePath -DryRun:$DryRun -Mutator {
            param($current)
            $script:loopAdmissionState = $current
            return $null
        }
        if (-not $loopRead.ok) {
            & $LogWriter "review-handoff-wake: admission store busy; deferring replay"
            return
        }
        $admissionState = $script:loopAdmissionState
        $loopBaseline = @{
            records        = ConvertTo-ReviewHandoffAdmissionHashtable -Value $admissionState.records
            actedOn        = ConvertTo-ReviewHandoffAdmissionHashtable -Value $admissionState.actedOn
            pendingRetries = ConvertTo-ReviewHandoffAdmissionHashtable -Value $admissionState.pendingRetries
        }

        $replayPayload = @{
            records            = $admissionState.records
            actedOn            = $admissionState.actedOn
            replayCursor       = $admissionState.replayCursor
            openPrs            = @($openPrsForReplay)
            openPrIndexTrusted = $openPrIndexTrusted
            listenerReadyMs    = $ListenerReadyMs
        }
        if ($ReplayBatchSize -gt 0) { $replayPayload.batchSize = $ReplayBatchSize }
        $replay = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'replay' -Payload $replayPayload

        foreach ($evicted in @($replay.evicted)) {
            Write-ReviewHandoffRecordTransition -Transition 'evict' -Reason ([string]$evicted.reason) `
                -Key ([string]$evicted.key) -AdmissionId ([string]$evicted.admissionId) `
                -PrNumber ([int]$evicted.prNumber) -HeadSha ([string]$evicted.headSha) -LogWriter $LogWriter
        }
        foreach ($superseded in @($replay.superseded)) {
            Write-ReviewHandoffRecordTransition -Transition 'supersede' -Reason ([string]$superseded.reason) `
                -Key ([string]$superseded.key) -AdmissionId ([string]$superseded.admissionId) `
                -PrNumber ([int]$superseded.prNumber) -HeadSha ([string]$superseded.headSha) -LogWriter $LogWriter
        }

        $admissionState.records = $replay.records
        $admissionState.actedOn = $replay.actedOn

        $batchTriggered = $false
        $recordsDeletedInBatch = 0
        foreach ($record in @($replay.replay)) {
            $recordNowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            if ($recordNowMs - $ListenerReadyMs -gt 30000) {
                $continueReplay = $false
                break
            }
            $nowMs = $recordNowMs
            if ($record.durableTriggerPersisted -eq $true) {
                $cleared = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'clearRecord' -Payload @{
                    existing = $admissionState.records
                    actedOn  = $admissionState.actedOn
                    key      = [string]$record.key
                    outcome  = 'delete_on_durable_trigger'
                    reason   = 'crash_after_durable_trigger'
                    nowMs    = $nowMs
                }
                if ($cleared.cleared) {
                    $admissionState.records = $cleared.records
                    $admissionState.actedOn = $cleared.actedOn
                    Write-ReviewHandoffRecordTransition -Transition 'delete' -Reason 'crash_after_durable_trigger' `
                        -Key ([string]$record.key) -AdmissionId ([string]$record.admissionId) `
                        -PrNumber ([int]$record.prNumber) -HeadSha ([string]$record.headSha) -LogWriter $LogWriter
                    $recordsDeletedInBatch++
                }
                continue
            }

            $filterResult = New-ReviewHandoffWakeFilterResultFromAdmissionRecord -Record $record -ProjectId $ProjectId
            if (-not $filterResult) { continue }
            $receivedAtMs = if ($record.receivedAtMs) { [long]$record.receivedAtMs } else { $ListenerReadyMs }
            if (Test-ReviewHandoffReceiptWindowExpired -WakeReceivedMs $receivedAtMs) {
                $updated = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'updateRecordOutcome' -Payload @{
                    existing = $admissionState.records
                    key      = [string]$record.key
                    outcome  = 'handoff_receipt_bound_exceeded'
                    reason   = 'handoff_receipt_bound_exceeded'
                    nowMs    = $nowMs
                }
                if ($updated.updated) {
                    $admissionState.records = $updated.records
                }
                continue
            }

            & $LogWriter "review-handoff-wake: replay admission key=$($record.key) pr=#$($record.prNumber)"
            $triggerOutcome = & $InvokeTrigger $filterResult $receivedAtMs
            if (Test-ReviewHandoffTriggerDurable -TriggerOutcome $triggerOutcome) {
                $updated = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'updateRecordOutcome' -Payload @{
                    existing                 = $admissionState.records
                    key                      = [string]$record.key
                    outcome                  = 'claim_win'
                    reason                   = 'durable_trigger'
                    durableTriggerPersisted  = $true
                    nowMs                    = $nowMs
                }
                if ($updated.updated) {
                    $admissionState.records = $updated.records
                }
                $cleared = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'clearRecord' -Payload @{
                    existing = $admissionState.records
                    actedOn  = $admissionState.actedOn
                    key      = [string]$record.key
                    outcome  = 'delete_on_durable_trigger'
                    reason   = 'delete_on_durable_trigger'
                    nowMs    = $nowMs
                }
                if ($cleared.cleared) {
                    $admissionState.records = $cleared.records
                    $admissionState.actedOn = $cleared.actedOn
                    Write-ReviewHandoffRecordTransition -Transition 'delete' -Reason 'delete_on_durable_trigger' `
                        -Key ([string]$record.key) -AdmissionId ([string]$record.admissionId) `
                        -PrNumber ([int]$record.prNumber) -HeadSha ([string]$record.headSha) -LogWriter $LogWriter
                    $recordsDeletedInBatch++
                }
                $batchTriggered = $true
                continue
            }

            $failureReason = Get-ReviewHandoffTriggerFailureReason -TriggerOutcome $triggerOutcome
            if ($failureReason -eq 'handoff_receipt_bound_exceeded') {
                $updated = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'updateRecordOutcome' -Payload @{
                    existing = $admissionState.records
                    key      = [string]$record.key
                    outcome  = 'handoff_receipt_bound_exceeded'
                    reason   = 'handoff_receipt_bound_exceeded'
                    nowMs    = $nowMs
                }
                if ($updated.updated) {
                    $admissionState.records = $updated.records
                }
            }
        }

        if ($batchTriggered -or $recordsDeletedInBatch -gt 0) {
            $admissionState.replayCursor = 0
        }
        else {
            $admissionState.replayCursor = [int]$replay.replayCursor
        }
        $null = Save-ReviewHandoffWakeAdmissionLifecycleState -Path $statePath -State $admissionState -Baseline $loopBaseline -DryRun:$DryRun

        if (-not $replay.hasMore) {
            $continueReplay = $false
        }
        elseif (-not $batchTriggered -and @($replay.replay).Count -eq 0) {
            $continueReplay = $false
        }
        elseif ($nowMs - $ListenerReadyMs -gt 30000) {
            $continueReplay = $false
        }
    }
}
