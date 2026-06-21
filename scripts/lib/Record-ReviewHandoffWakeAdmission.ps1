#requires -Version 5.1
<#
.SYNOPSIS
  Durable ready_for_review hand-off admission records (Issue #381).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

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

    $default = @{ records = @{}; pendingRetries = @{}; lastUpdatedMs = $null }
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
        [switch]$DryRun
    )

    if (-not $StateRoot) {
        return @{ recorded = $false; reason = 'missing_state_root' }
    }
    if (-not $FilterResult.handoffAdmission) {
        return @{ recorded = $false; reason = 'not_handoff_admission' }
    }

    $path = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
    $state = Get-ReviewHandoffWakeAdmissionState -Path $path
    $seed = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'seed' -Payload @{
        existing  = $state.records
        admission = @{
            subject = @{
                sessionId    = [string]$FilterResult.sessionId
                projectId    = [string]$FilterResult.projectId
                prNumber     = [int]$FilterResult.prNumber
                prUrl        = [string]$FilterResult.prUrl
                priority     = [string]$FilterResult.handoffAdmission.audit.priority
                receivedAtMs = if ($WakeReceivedMs -gt 0) { $WakeReceivedMs } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
            }
            admittedBaseRef = [string]$FilterResult.handoffAdmission.admittedBaseRef
            admittedHeadSha = [string]$FilterResult.handoffAdmission.admittedHeadSha
            outcome         = 'promoted'
        }
        nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    if (-not $seed.seeded) {
        return @{ recorded = $false; reason = [string]$seed.reason }
    }

    if (-not $DryRun) {
        Set-ReviewHandoffWakeAdmissionState -Path $path -State @{
            records        = $seed.records
            pendingRetries = $state.pendingRetries
            lastUpdatedMs  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
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
        [switch]$DryRun
    )

    if (-not $StateRoot) {
        return @{ recorded = $false; reason = 'missing_state_root' }
    }
    if (-not $BodyJson) {
        return @{ recorded = $false; reason = 'missing_body_json' }
    }

    $path = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
    $state = Get-ReviewHandoffWakeAdmissionState -Path $path
    $seed = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'seedPendingRetry' -Payload @{
        existing = $state.pendingRetries
        bodyJson = $BodyJson
        nowMs    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    if (-not $seed.seeded) {
        return @{ recorded = $false; reason = [string]$seed.reason }
    }

    if (-not $DryRun) {
        Set-ReviewHandoffWakeAdmissionState -Path $path -State @{
            records        = $state.records
            pendingRetries = $seed.pendingRetries
            lastUpdatedMs  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
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
    $state = Get-ReviewHandoffWakeAdmissionState -Path $path
    $cleared = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'clearPendingRetry' -Payload @{
        existing = $state.pendingRetries
        key      = $Key
    }

    if (-not $cleared.cleared) {
        return @{ cleared = $false; reason = [string]$cleared.reason }
    }

    if (-not $DryRun) {
        Set-ReviewHandoffWakeAdmissionState -Path $path -State @{
            records        = $state.records
            pendingRetries = $cleared.pendingRetries
            lastUpdatedMs  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
    }

    return @{ cleared = $true; key = $Key; path = $path }
}

function Get-ReviewHandoffWakeAdmissionReplay {
    param(
        [string]$StateRoot = '',
        [long]$ListenerReadyMs
    )

    if (-not $StateRoot) {
        return @{ replay = @(); listenerReadyMs = $ListenerReadyMs }
    }
    $path = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
    $state = Get-ReviewHandoffWakeAdmissionState -Path $path
    return Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'replay' -Payload @{
        records         = $state.records
        listenerReadyMs = $ListenerReadyMs
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
        [scriptblock]$LogWriter = { param([string]$Message) Write-Host $Message }
    )

    if (-not $StateRoot) {
        return
    }

    $pending = Get-ReviewHandoffWakePendingRetries -StateRoot $StateRoot
    foreach ($retry in @($pending.retries)) {
        $bodyJson = [string]$retry.bodyJson
        $retryKey = [string]$retry.key
        if (-not $bodyJson) { continue }

        $openPrLookupFailed = $false
        $openPrsForAdmission = @()
        try {
            $openPrsForAdmission = @(& $ResolveOpenPrs)
        }
        catch {
            $openPrLookupFailed = $true
        }
        if ($openPrLookupFailed) {
            & $LogWriter "review-handoff-wake: pending retry key=$retryKey still admission_lookup_unknown"
            continue
        }

        $filterResult = & $InvokeWakeFilter $bodyJson $openPrsForAdmission $openPrLookupFailed
        if (-not $filterResult.ok) {
            if ($filterResult.retryable) {
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

    $replay = Get-ReviewHandoffWakeAdmissionReplay -StateRoot $StateRoot -ListenerReadyMs $ListenerReadyMs
    foreach ($record in @($replay.replay)) {
        if (-not $record.withinRecoveryBound) { continue }
        $filterResult = New-ReviewHandoffWakeFilterResultFromAdmissionRecord -Record $record -ProjectId $ProjectId
        if (-not $filterResult) { continue }
        $receivedAtMs = if ($record.replayReceivedAtMs) { [long]$record.replayReceivedAtMs } elseif ($record.receivedAtMs) { [long]$record.receivedAtMs } else { $ListenerReadyMs }
        & $LogWriter "review-handoff-wake: replay admission key=$($record.key) pr=#$($record.prNumber)"
        & $InvokeTrigger $filterResult $receivedAtMs
    }
}
