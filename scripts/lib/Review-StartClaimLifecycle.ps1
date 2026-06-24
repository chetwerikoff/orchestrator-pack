#requires -Version 5.1
<#
  Issue #417 lifecycle extensions for review-start claims.
#>

. (Join-Path $PSScriptRoot 'Review-RunLiveness.ps1')
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

$Script:ReviewStartClaimLifecycleCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-start-claim-lifecycle.mjs'

function Get-ReviewStartClaimLocalHostName {
    try { return [System.Net.Dns]::GetHostName().ToLowerInvariant() } catch { return 'unknown-host' }
}

function Get-ReviewStartClaimLifecycleConfig {
    return Invoke-ReviewStartClaimLifecycleCli -Subcommand 'validate-config' -Payload @{}
}

function Invoke-ReviewStartClaimLifecycleCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewStartClaimLifecycleCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-start-claim-lifecycle' -JsonDepth 30
}

function Get-ReviewStartClaimAuditDir {
    param([string]$Namespace)
    return (Join-Path $Namespace 'audit')
}

function Initialize-ReviewStartClaimAuditDir {
    param([string]$Namespace)
    $dir = Get-ReviewStartClaimAuditDir -Namespace $Namespace
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return $dir
}

function Write-ReviewStartClaimTransitionAudit {
    param(
        [string]$Namespace,
        [object]$PriorRecord,
        [string]$Outcome,
        [string]$DecisionSource,
        [hashtable]$Extra = @{},
        [string]$NewState = 'terminal'
    )

    $auditDir = Initialize-ReviewStartClaimAuditDir -Namespace $Namespace
    $path = Join-Path $auditDir "$([guid]::NewGuid().ToString('n')).json"
    $record = @{
        kind           = 'claim_transition'
        key            = [string]$PriorRecord.key
        prNumber       = [int]$PriorRecord.prNumber
        headSha        = [string]$PriorRecord.headSha
        priorState     = [string]$PriorRecord.state
        newState       = $NewState
        outcome        = $Outcome
        decisionSource = $DecisionSource
        atUtc          = (Get-Date).ToUniversalTime().ToString('o')
    }
    foreach ($key in $Extra.Keys) { $record[$key] = $Extra[$key] }
    ($record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Update-ReviewStartClaimRecordFields {
    param(
        [hashtable]$ClaimResult,
        [hashtable]$Fields,
        [string[]]$ClearFields = @()
    )

    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return @{ ok = $false; reason = 'no_claim' } }
    $lockDir = Get-ReviewStartClaimLockDir -Namespace $ClaimResult.namespace -PrNumber ([int]$ClaimResult.claim.prNumber) -HeadSha ([string]$ClaimResult.claim.headSha)
    if (-not (Enter-ReviewStartClaimMutex -LockDir $lockDir)) { return @{ ok = $false; reason = 'busy' } }
    try {
        $read = Read-ReviewStartClaimRecord -Path $ClaimResult.path
        if (-not $read.ok) { return @{ ok = $false; reason = 'ambiguous_claim'; detail = $read.reason } }
        if ([string]$read.record.holder.processGuid -ne [string]$ClaimResult.claim.holder.processGuid) {
            return @{ ok = $false; reason = 'lost_ownership'; holder = $read.record.holder }
        }
        $record = @{}
        $read.record.PSObject.Properties | ForEach-Object { $record[$_.Name] = $_.Value }
        foreach ($key in $Fields.Keys) { $record[$key] = $Fields[$key] }
        foreach ($key in @($ClearFields)) { $record.Remove($key) | Out-Null }
        ($record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $ClaimResult.path -Encoding UTF8
        foreach ($key in $Fields.Keys) { $ClaimResult.claim[$key] = $Fields[$key] }
        foreach ($key in @($ClearFields)) { $ClaimResult.claim.Remove($key) | Out-Null }
        return @{ ok = $true; record = $record }
    }
    finally {
        Exit-ReviewStartClaimMutex -LockDir $lockDir
    }
}

function Set-ReviewStartClaimHoldStarted {
    param([hashtable]$ClaimResult)
    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return @{ ok = $false } }
    if ($ClaimResult.claim.holdStartedAtUtc) { return @{ ok = $true; skipped = $true } }
    $now = (Get-Date).ToUniversalTime().ToString('o')
    return Update-ReviewStartClaimRecordFields -ClaimResult $ClaimResult -Fields @{ holdStartedAtUtc = $now }
}

function Confirm-ReviewStartClaimLaunchGate {
    param(
        [hashtable]$ClaimResult,
        [array]$ReviewRuns = @(),
        [string]$DecisionSource = 'hold_budget',
        [scriptblock]$LogWriter = $null
    )

    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return @{ ok = $false; reason = 'no_claim' } }
    $hold = Test-ReviewStartClaimHoldBudgetExceeded -ClaimResult $ClaimResult
    if ($hold.exceeded) {
        Invoke-ReviewStartClaimReclaimOrphan -Namespace $ClaimResult.namespace -Path $ClaimResult.path -Record $ClaimResult.claim `
            -ReviewRuns @($ReviewRuns) -DecisionSource $DecisionSource -LogWriter $LogWriter | Out-Null
        if ($LogWriter) { & $LogWriter "review-start-claim: hold budget exceeded key=$($ClaimResult.key)" }
        return @{ ok = $false; reason = 'hold_budget_exceeded' }
    }
    if (-not (Test-ReviewStartClaimOwnership -ClaimResult $ClaimResult)) {
        return @{ ok = $false; reason = 'claim_ownership_lost' }
    }
    $pending = Set-ReviewStartClaimLaunchPending -ClaimResult $ClaimResult
    if (-not $pending.ok) {
        $reason = if ([string]$pending.reason -eq 'lost_ownership') { 'claim_ownership_lost' } else { [string]$pending.reason }
        return @{ ok = $false; reason = $reason }
    }
    return @{ ok = $true }
}

function Set-ReviewStartClaimLaunchPending {
    param(
        [hashtable]$ClaimResult,
        [int]$BudgetMs = 0
    )

    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return @{ ok = $false; reason = 'no_claim' } }
    $config = Get-ReviewStartClaimLifecycleConfig
    $budget = if ($BudgetMs -gt 0) { $BudgetMs } else { [int]$config.config.launchPendingBudgetMs }
    $now = (Get-Date).ToUniversalTime().ToString('o')
    return Update-ReviewStartClaimRecordFields -ClaimResult $ClaimResult -Fields @{
        launchPending = @{
            atUtc    = $now
            budgetMs = $budget
        }
        launchPendingInvokedAtUtc = $now
    }
}

function Get-ReviewStartClaimActiveRecords {
    param([string]$Namespace)
    $records = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $Namespace -File -Filter 'pr-*.json' -ErrorAction SilentlyContinue)) {
        $read = Read-ReviewStartClaimRecord -Path $file.FullName
        if ($read.ok -and [string]$read.record.state -eq 'active') {
            $records += $read.record
        }
    }
    return $records
}

function Invoke-ReviewStartClaimTerminalizeFromDecision {
    param(
        [string]$Namespace,
        [string]$Path,
        [object]$Record,
        [object]$Decision,
        [string]$DecisionSource,
        [array]$ReviewRuns = @(),
        [switch]$MutexAlreadyHeld
    )

    $outcome = [string]$Decision.outcome
    if (-not $outcome) { return @{ ok = $false; reason = 'missing_outcome' } }
    $lockDir = Get-ReviewStartClaimLockDir -Namespace $Namespace -PrNumber ([int]$Record.prNumber) -HeadSha ([string]$Record.headSha)
    if (-not $MutexAlreadyHeld) {
        if (-not (Enter-ReviewStartClaimMutex -LockDir $lockDir)) { return @{ ok = $false; reason = 'busy' } }
    }
    try {
        $read = Read-ReviewStartClaimRecord -Path $Path
        if (-not $read.ok) { return @{ ok = $false; reason = 'ambiguous_claim'; detail = $read.reason } }
        if ([string]$read.record.state -ne 'active') { return @{ ok = $false; reason = 'not_active' } }
        if ([string]$read.record.holder.processGuid -ne [string]$Record.holder.processGuid) {
            return @{ ok = $false; reason = 'lost_ownership' }
        }
        $extra = @{
            decisionReason = [string]$Decision.reason
            decisionSource = $DecisionSource
        }
        if ($Decision.warn) { $extra.warn = $true }
        if ($Decision.coveredRunId) { $extra.coveredRunId = [string]$Decision.coveredRunId }
        if ($Decision.liveness) { $extra.holderLiveness = $Decision.liveness }
        if ($Decision.hold) { $extra.hold = $Decision.hold }
        if ($Decision.launch) { $extra.launch = $Decision.launch }
        if ($Decision.visibility) { $extra.visibility = $Decision.visibility }
        $extra.runStoreEvidence = @{
            inFlightCount = @($ReviewRuns | Where-Object {
                Test-ReviewStartClaimRunMatchesKey -Run $_ -PrNumber ([int]$Record.prNumber) -NormalizedHeadSha ([string]$Record.headSha)
            }).Count
        }
        $terminalPath = Move-ReviewStartClaimToTerminal -Namespace $Namespace -ActivePath $Path -Record $read.record `
            -Outcome $outcome -Extra $extra
        $auditPath = Write-ReviewStartClaimTransitionAudit -Namespace $Namespace -PriorRecord $read.record `
            -Outcome $outcome -DecisionSource $DecisionSource -Extra $extra
        return @{ ok = $true; terminalPath = $terminalPath; auditPath = $auditPath; outcome = $outcome }
    }
    finally {
        if (-not $MutexAlreadyHeld) {
            Exit-ReviewStartClaimMutex -LockDir $lockDir
        }
    }
}


function Test-ReviewStartClaimPostAcquireSideEffectAudit {
    param(
        [string]$Namespace,
        [string]$ClaimKey
    )

    if (-not $Namespace -or -not $ClaimKey) { return $false }
    $auditDir = Get-ReviewStartClaimAuditDir -Namespace $Namespace
    if (-not (Test-Path -LiteralPath $auditDir)) { return $false }
    foreach ($file in @(Get-ChildItem -LiteralPath $auditDir -File -Filter '*.json' -ErrorAction SilentlyContinue)) {
        try {
            $record = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        }
        catch {
            continue
        }
        if ([string]$record.key -ne [string]$ClaimKey) { continue }
        $source = [string]$record.decisionSource
        $outcome = [string]$record.outcome
        if ($source -in @('post_run_invoke', 'post_run_visibility', 'hold_budget')) { return $true }
        if ($outcome -eq 'run_started') { return $true }
    }
    return $false
}

function Mark-ReviewStartClaimForeignHolderBlocking {
    param(
        [string]$Namespace,
        [string]$Path,
        [object]$Record,
        [object]$Decision,
        [string]$DecisionSource,
        [array]$ReviewRuns = @(),
        [scriptblock]$LogWriter = $null
    )

    $lockDir = Get-ReviewStartClaimLockDir -Namespace $Namespace -PrNumber ([int]$Record.prNumber) -HeadSha ([string]$Record.headSha)
    if (-not (Enter-ReviewStartClaimMutex -LockDir $lockDir)) { return @{ ok = $false; reason = 'busy' } }
    try {
        $read = Read-ReviewStartClaimRecord -Path $Path
        if (-not $read.ok) { return @{ ok = $false; reason = 'ambiguous_claim'; detail = $read.reason } }
        if ([string]$read.record.state -ne 'active') { return @{ ok = $false; reason = 'not_active' } }
        if ([string]$read.record.holder.processGuid -ne [string]$Record.holder.processGuid) {
            return @{ ok = $false; reason = 'lost_ownership' }
        }
        if ($read.record.manualResolutionRequired) {
            return @{ ok = $true; skipped = $true; blocking = $true; outcome = [string]$read.record.manualResolutionRequired.outcome }
        }
        $now = (Get-Date).ToUniversalTime().ToString('o')
        $record = @{}
        $read.record.PSObject.Properties | ForEach-Object { $record[$_.Name] = $_.Value }
        $record.manualResolutionRequired = @{
            outcome        = [string]$Decision.outcome
            reason         = [string]$Decision.reason
            decisionSource = $DecisionSource
            atUtc          = $now
        }
        ($record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $Path -Encoding UTF8
        $extra = @{
            decisionReason = [string]$Decision.reason
            decisionSource = $DecisionSource
            blocking       = $true
        }
        $auditPath = Write-ReviewStartClaimTransitionAudit -Namespace $Namespace -PriorRecord $read.record `
            -Outcome ([string]$Decision.outcome) -DecisionSource $DecisionSource -Extra $extra -NewState 'active'
        if ($LogWriter) {
            & $LogWriter "review-start-claim: WARN foreign holder blocking key=$($Record.key) audit=$auditPath"
        }
        return @{ ok = $true; auditPath = $auditPath; blocking = $true; outcome = [string]$Decision.outcome }
    }
    finally {
        Exit-ReviewStartClaimMutex -LockDir $lockDir
    }
}

function Invoke-ReviewStartClaimReclaimOrphan {
    param(
        [string]$Namespace,
        [string]$Path,
        [object]$Record,
        [array]$ReviewRuns = @(),
        [string]$DecisionSource = 'reclaim',
        [scriptblock]$LogWriter = $null
    )

    $decision = Invoke-ReviewStartClaimLifecycleCli -Subcommand 'evaluate' -Payload @{
        claim                       = $Record
        reviewRuns                  = @($ReviewRuns)
        localHost                   = Get-ReviewStartClaimLocalHostName
        nowMs                       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        postAcquireSideEffectAudit  = (Test-ReviewStartClaimPostAcquireSideEffectAudit -Namespace $Namespace -ClaimKey ([string]$Record.key))
    }
    if ($decision.action -eq 'skip' -or $decision.action -eq 'block') {
        return @{ reclaimed = $false; decision = $decision }
    }
    if ($decision.action -eq 'mark_manual') {
        $result = Mark-ReviewStartClaimForeignHolderBlocking -Namespace $Namespace -Path $Path -Record $Record `
            -Decision $decision -DecisionSource $DecisionSource -ReviewRuns $ReviewRuns -LogWriter $LogWriter
        return @{ reclaimed = $false; manual = $true; blocking = $true; result = $result; decision = $decision }
    }
    if ($decision.action -eq 'terminalize') {
        $result = Invoke-ReviewStartClaimTerminalizeFromDecision -Namespace $Namespace -Path $Path -Record $Record `
            -Decision $decision -DecisionSource $DecisionSource -ReviewRuns $ReviewRuns
        if ($LogWriter -and $result.ok) {
            $level = if ($decision.warn) { 'WARN' } else { 'INFO' }
            & $LogWriter "review-start-claim: $level reclaimed orphan key=$($Record.key) outcome=$($decision.outcome) audit=$($result.auditPath)"
        }
        return @{ reclaimed = [bool]$result.ok; result = $result; decision = $decision }
    }
    return @{ reclaimed = $false; decision = $decision }
}

function Invoke-ReviewStartClaimReaperSweep {
    param(
        [string]$Namespace = '',
        [string]$ProjectId = 'orchestrator-pack',
        [array]$ReviewRuns = @(),
        [scriptblock]$LogWriter = $null
    )

    $resolved = Resolve-ReviewStartClaimNamespace -ProjectId $ProjectId -Namespace $Namespace
    Initialize-ReviewStartClaimNamespace -Namespace $resolved
    $active = @(Get-ReviewStartClaimActiveRecords -Namespace $resolved)
    $sweep = Invoke-ReviewStartClaimLifecycleCli -Subcommand 'sweep' -Payload @{
        activeClaims = @($active)
        reviewRuns   = @($ReviewRuns)
        localHost    = Get-ReviewStartClaimLocalHostName
        nowMs        = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $results = @()
    foreach ($entry in @($sweep.actions)) {
        $key = [string]$entry.key
        $claim = $active | Where-Object { [string]$_.key -eq $key } | Select-Object -First 1
        if (-not $claim) { continue }
        $path = Get-ReviewStartClaimPath -Namespace $resolved -PrNumber ([int]$claim.prNumber) -HeadSha ([string]$claim.headSha)
        $decision = $entry.decision
        if ($decision.action -eq 'skip' -or $decision.action -eq 'block') {
            $results += @{ key = $key; action = $decision.action; reason = $decision.reason }
            continue
        }
        $reclaim = Invoke-ReviewStartClaimReclaimOrphan -Namespace $resolved -Path $path -Record $claim `
            -ReviewRuns $ReviewRuns -DecisionSource 'reaper' -LogWriter $LogWriter
        $results += @{
            key       = $key
            action    = $decision.action
            outcome   = $decision.outcome
            reclaimed = [bool]$reclaim.reclaimed
        }
    }
    return @{
        ok        = $true
        namespace = $resolved
        scanned   = $active.Count
        results   = $results
        batchReads = 1
    }
}

function Test-ReviewStartClaimHoldBudgetExceeded {
    param([hashtable]$ClaimResult)

    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return @{ exceeded = $false } }
    $read = Read-ReviewStartClaimRecord -Path $ClaimResult.path
    if (-not $read.ok) { return @{ exceeded = $false; reason = 'unreadable' } }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $envelope = Invoke-ReviewStartClaimLifecycleCli -Subcommand 'readiness-envelope' -Payload @{
        claim = $read.record
        nowMs = $nowMs
    }
    $config = Get-ReviewStartClaimLifecycleConfig
    $started = if ($read.record.holdStartedAtUtc) { $read.record.holdStartedAtUtc } else { $read.record.acquiredAtUtc }
    $startedMs = [DateTimeOffset]::Parse([string]$started).ToUnixTimeMilliseconds()
    $ageMs = [Math]::Max(0, $nowMs - $startedMs)
    $budgetMs = [Math]::Min([int]$config.config.holdBudgetMs, [int]$envelope.budgetMs)
    return @{
        exceeded = ([bool]$envelope.exceeded -or ($ageMs -ge $budgetMs))
        ageMs    = $ageMs
        budgetMs = $budgetMs
        envelope = $envelope
    }
}


function Write-ReviewStartClaimRunStartedAudit {
    param(
        [hashtable]$ClaimResult,
        [object]$PriorRecord,
        [string]$TerminalPath,
        [string]$DecisionSource = 'post_run_invoke'
    )

    if (-not $ClaimResult -or -not $PriorRecord) { return '' }
    return Write-ReviewStartClaimTransitionAudit -Namespace $ClaimResult.namespace -PriorRecord $PriorRecord `
        -Outcome 'run_started' -DecisionSource $DecisionSource -Extra @{ terminalPath = $TerminalPath }
}

function Wait-ReviewStartClaimPostInvokeVisibility {
    param(
        [hashtable]$ClaimResult,
        [array]$ReviewRuns = @(),
        [scriptblock]$ResolveReviewRuns = $null,
        [scriptblock]$LogWriter = $null
    )

    $config = Get-ReviewStartClaimLifecycleConfig
    $pollMs = 250
    $runs = @($ReviewRuns)
    while ($true) {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($ResolveReviewRuns) {
            $runs = @(& $ResolveReviewRuns)
        }
        $read = Read-ReviewStartClaimRecord -Path $ClaimResult.path
        if (-not $read.ok) { return @{ ok = $false; reason = 'ambiguous_claim'; detail = $read.reason } }
        Bind-ReviewStartClaimToVisibleRun -ClaimResult $ClaimResult -ReviewRuns $runs | Out-Null
        $complete = Complete-ReviewStartClaim -ClaimResult $ClaimResult -Outcome 'run_started' -ReviewRuns $runs
        if ($complete.ok) {
            $auditPath = Write-ReviewStartClaimRunStartedAudit -ClaimResult $ClaimResult -PriorRecord $read.record -TerminalPath $complete.terminalPath -DecisionSource 'post_run_visibility'
            return @{ ok = $true; terminalPath = $complete.terminalPath; outcome = 'run_started'; auditPath = $auditPath }
        }
        $fence = Invoke-ReviewStartClaimLifecycleCli -Subcommand 'visibility-fence' -Payload @{
            claim      = $read.record
            reviewRuns = @($runs)
            nowMs      = $nowMs
        }
        if ($fence.shouldFence) {
            $terminal = Invoke-ReviewStartClaimTerminalizeFromDecision -Namespace $ClaimResult.namespace -Path $ClaimResult.path `
                -Record $read.record -Decision @{
                    action     = 'terminalize'
                    outcome    = 'run_not_visible_fenced'
                    reason     = [string]$fence.reason
                    visibility = $fence
                } -DecisionSource 'post_run_visibility' -ReviewRuns $runs
            if ($LogWriter) {
                & $LogWriter "review-start-claim: WARN run_not_visible_fenced key=$($ClaimResult.key) audit=$($terminal.auditPath)"
            }
            return @{ ok = [bool]$terminal.ok; reason = 'run_not_visible_fenced'; terminalPath = $terminal.terminalPath; outcome = 'run_not_visible_fenced'; fenced = $true; fence = $fence }
        }

        $envelope = Invoke-ReviewStartClaimLifecycleCli -Subcommand 'readiness-envelope' -Payload @{
            claim = $read.record
            nowMs = $nowMs
        }
        if ($envelope.exceeded) {
            $terminal = Invoke-ReviewStartClaimTerminalizeFromDecision -Namespace $ClaimResult.namespace -Path $ClaimResult.path `
                -Record $read.record -Decision @{
                    action     = 'terminalize'
                    outcome    = 'run_not_visible_fenced'
                    reason     = 'readiness_envelope_exceeded'
                    visibility = $fence
                    envelope   = $envelope
                } -DecisionSource 'post_run_visibility' -ReviewRuns $runs
            if ($LogWriter) {
                & $LogWriter "review-start-claim: WARN readiness envelope exceeded during visibility wait key=$($ClaimResult.key) audit=$($terminal.auditPath)"
            }
            return @{ ok = [bool]$terminal.ok; reason = 'run_not_visible_fenced'; terminalPath = $terminal.terminalPath; outcome = 'run_not_visible_fenced'; fenced = $true; envelope = $envelope }
        }

        $pendingMs = [DateTimeOffset]::Parse([string]$read.record.visibilityPendingAtUtc).ToUnixTimeMilliseconds()
        $visibilityAgeMs = [Math]::Max(0, $nowMs - $pendingMs)
        $visibilityBudgetMs = [int]$config.config.visibilityBudgetMs
        $remainingMs = [Math]::Min([int]$envelope.remainingMs, [Math]::Max(0, $visibilityBudgetMs - $visibilityAgeMs))
        if ($remainingMs -le 0) { continue }
        Start-Sleep -Milliseconds ([Math]::Min($pollMs, $remainingMs))
    }
}

function Complete-ReviewStartClaimAfterRunInvoke {
    param(
        [hashtable]$ClaimResult,
        [array]$ReviewRuns = @(),
        [scriptblock]$ResolveReviewRuns = $null,
        [scriptblock]$LogWriter = $null
    )

    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return @{ ok = $false; reason = 'no_claim' } }
    $priorRead = Read-ReviewStartClaimRecord -Path $ClaimResult.path
    Bind-ReviewStartClaimToVisibleRun -ClaimResult $ClaimResult -ReviewRuns $ReviewRuns | Out-Null
    $complete = Complete-ReviewStartClaim -ClaimResult $ClaimResult -Outcome 'run_started' -ReviewRuns $ReviewRuns
    if ($complete.ok) {
        $auditPath = ''
        if ($priorRead.ok) {
            $auditPath = Write-ReviewStartClaimRunStartedAudit -ClaimResult $ClaimResult -PriorRecord $priorRead.record `
                -TerminalPath $complete.terminalPath -DecisionSource 'post_run_invoke'
        }
        return @{ ok = $true; terminalPath = $complete.terminalPath; outcome = 'run_started'; auditPath = $auditPath }
    }

    if ($complete.reason -eq 'run_not_visible') {
        $now = (Get-Date).ToUniversalTime().ToString('o')
        $pendingRead = Read-ReviewStartClaimRecord -Path $ClaimResult.path
        $fields = @{ invokeCompletedAtUtc = $now }
        if (-not $pendingRead.record.visibilityPendingAtUtc) {
            $fields.visibilityPendingAtUtc = $now
        }
        Update-ReviewStartClaimRecordFields -ClaimResult $ClaimResult -Fields $fields -ClearFields @('launchPending') | Out-Null
        if ($LogWriter) {
            & $LogWriter "review-start-claim: waiting for post-invoke visibility key=$($ClaimResult.key)"
        }
        return Wait-ReviewStartClaimPostInvokeVisibility -ClaimResult $ClaimResult -ReviewRuns $ReviewRuns `
            -ResolveReviewRuns $ResolveReviewRuns -LogWriter $LogWriter
    }
    return $complete
}

function Sync-ReviewStartClaimReclaimBeforeSkip {
    param(
        [string]$Namespace,
        [string]$Path,
        [object]$Record,
        [array]$ReviewRuns = @(),
        [scriptblock]$LogWriter = $null
    )

    $reclaim = Invoke-ReviewStartClaimReclaimOrphan -Namespace $Namespace -Path $Path -Record $Record `
        -ReviewRuns $ReviewRuns -DecisionSource 'acquire_sync' -LogWriter $LogWriter
    return $reclaim
}
