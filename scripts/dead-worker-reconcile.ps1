#requires -Version 5.1
<#
.SYNOPSIS
  Autonomous dead-worker reconciliation loop (Issue #593).

.DESCRIPTION
  Detects assigned workers with capture-backed dead evidence and invokes
  invoke-worker-recovery.ps1 -Trigger reconcile_dead_worker exactly once per
  recoverable durable key. Operator kills and shutdown windows are suppressed.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [int]$IntervalMinutes = 1,
    [int]$PollSeconds = 60,
    [string]$StateFile = '',
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'
$Script:ReconcileLogPrefix = 'dead-worker-reconcile'

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = $PackRoot }
$PlannerCli = Join-Path $PackRoot 'docs/dead-worker-reconciler.mjs'

. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/WorkerReportStore.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-WorkerMessageAdoptionBinding.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-OrchestratorYamlRules.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-OrchestratorEscalationEmit.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-WorkerOsLiveness.ps1')
. (Join-Path $PSScriptRoot 'lib/Sanctioned-Worker-Kill-Record.ps1')
. (Join-Path $PSScriptRoot 'lib/WorkerStatusStore.ps1')

$Script:DeadWorkerDefaultState = @{
    schemaVersion      = 'dead-worker-reconcile/v2'
    attempts           = @{}
    leases             = @{}
    audit              = @()
    pendingActions     = @{}
    quarantinedActions = @{}
    lastTickMs         = $null
}
$Script:DeadWorkerCliPrefixAllowlist = @(
    '^\[notifier\]\s*',
    '^\[gh[^\]]*\]\s*',
    '^\[scripts/gh[^\]]*\]\s*',
    '^(warn|warning|info):\s*'
)

function Write-DeadWorkerLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReconcileLogPrefix): $Message"
}

function Get-DeadWorkerStatePath {
    param([string]$CliPath)
    if ($CliPath) { return $CliPath }
    if ($env:AO_DEAD_WORKER_RECONCILE_STATE) { return $env:AO_DEAD_WORKER_RECONCILE_STATE }
    if ($env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR) {
        return Join-Path $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR 'orchestrator-dead-worker-reconcile-state.json'
    }
    return Join-Path (Join-Path (Join-Path $HOME '.local') 'state/orchestrator-pack-wake-supervisor') 'orchestrator-dead-worker-reconcile-state.json'
}

function Get-DeadWorkerState {
    param([string]$Path)
    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $Script:DeadWorkerDefaultState -ActionTracking
}

function Set-DeadWorkerState {
    param(
        [string]$Path,
        [object]$State
    )
    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $Script:DeadWorkerDefaultState -JsonDepth 40
}

function Copy-DeadWorkerActionMap {
    param([object]$Map)

    $copy = @{}
    if ($Map -is [System.Collections.IDictionary]) {
        foreach ($entry in $Map.GetEnumerator()) {
            $copy[[string]$entry.Key] = $entry.Value
        }
        return $copy
    }
    if ($Map) {
        foreach ($prop in $Map.PSObject.Properties) {
            $copy[[string]$prop.Name] = $prop.Value
        }
    }
    return $copy
}

function Get-DeadWorkerActionMapCount {
    param([object]$Map)

    return @((Copy-DeadWorkerActionMap -Map $Map).Keys).Count
}

function Set-DeadWorkerPendingAction {
    param(
        [object]$State,
        [object]$Action,
        [long]$NowMs
    )

    $pending = Copy-DeadWorkerActionMap -Map $State.pendingActions
    $key = [string]$Action.key
    $pending[$key] = @{
        key = $key
        sessionId = [string]$Action.sessionId
        issueNumber = [int]$Action.issueNumber
        prNumber = [int]$Action.prNumber
        generationToken = [string]$Action.generationToken
        revalidationToken = [string]$Action.revalidationToken
        recordedAtMs = $NowMs
    }
    $State.pendingActions = $pending
    return $State
}

function Clear-DeadWorkerPendingAction {
    param(
        [object]$State,
        [string]$Key
    )

    $pending = @{}
    foreach ($entry in (Copy-DeadWorkerActionMap -Map $State.pendingActions).GetEnumerator()) {
        $entryKey = [string]$entry.Key
        if ($entryKey -eq $Key) { continue }
        $pending[$entryKey] = $entry.Value
    }
    $State.pendingActions = $pending
    return $State
}

function Enter-DeadWorkerRecoveryQuarantine {
    param(
        [object]$State,
        [string]$Reason,
        [long]$NowMs
    )

    $pending = Copy-DeadWorkerActionMap -Map $State.pendingActions
    if (@($pending.Keys).Count -le 0) {
        return $State
    }
    $State.pendingActions = @{}
    $quarantined = Copy-DeadWorkerActionMap -Map $State.quarantinedActions
    foreach ($entry in $pending.GetEnumerator()) {
        $record = Copy-DeadWorkerActionMap -Map $entry.Value
        $record['quarantineReason'] = [string]$Reason
        $record['quarantinedAtMs'] = $NowMs
        $quarantined[[string]$entry.Key] = $record
    }
    $State.quarantinedActions = $quarantined
    $audit = @($State.audit)
    $audit += @{
        outcome = 'recovery_quarantined'
        reason = [string]$Reason
        pendingKeys = @($pending.Keys)
        recordedAtMs = $NowMs
    }
    $State.audit = $audit
    return $State
}

function Invoke-DeadWorkerPlannerCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $PlannerCli -Subcommand $Subcommand `
        -Payload $Payload -Label $Script:ReconcileLogPrefix -JsonDepth 40
}

function Get-AutonomousRespawnPolicy {
    if ($env:AO_DEAD_WORKER_RESPAWN_POLICY_FIXTURE) {
        return Get-Content -LiteralPath $env:AO_DEAD_WORKER_RESPAWN_POLICY_FIXTURE -Raw | ConvertFrom-Json
    }
    $path = Join-Path $PackRoot 'docs/autonomous-respawn-policy.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return @{ version = 'autonomous-respawn-policy/v1'; allowReconcileDeadWorkerRespawn = $false }
    }
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Get-DeadWorkerResolvedBounds {
    param(
        [object]$RespawnPolicy,
        [object]$OverrideBounds = $null
    )

    $payload = @{ policy = $RespawnPolicy }
    if ($null -ne $OverrideBounds) { $payload.bounds = $OverrideBounds }
    return Invoke-DeadWorkerPlannerCli -Subcommand 'resolve-bounds' -Payload $payload
}

function Get-DeadWorkerEffectiveRuntimePolicy {
    param([string]$OrchestratorRules)

    if ($env:AO_DEAD_WORKER_EFFECTIVE_RUNTIME_POLICY) {
        return [string]$env:AO_DEAD_WORKER_EFFECTIVE_RUNTIME_POLICY
    }
    $adoption = Invoke-DeadWorkerPlannerCli -Subcommand 'evaluate-adoption' -Payload @{
        orchestratorRules = [string]$OrchestratorRules
    }
    return [string]$adoption.effectiveRuntimePolicy
}

function Get-DeadWorkerWorkerStatusRows {
    param($StoreState)

    if ($null -eq $StoreState) { return @() }
    $rows = $StoreState.records
    if ($null -eq $rows) { $rows = $StoreState.rows }
    if ($rows -is [System.Collections.IDictionary]) {
        return @($rows.GetEnumerator() | ForEach-Object { $_.Value } | Where-Object { $null -ne $_ })
    }
    if ($rows) {
        return @($rows.PSObject.Properties | ForEach-Object { $_.Value } | Where-Object { $null -ne $_ })
    }
    return @()
}

function Test-DeadWorkerWorkerStatusStoreDisabled {
    $raw = [string]($env:PACK_WORKER_STATUS_STORE_DISABLED ?? '')
    if ([string]::IsNullOrWhiteSpace($raw)) { return $false }
    switch ($raw.Trim().ToLowerInvariant()) {
        '1' { return $true }
        'true' { return $true }
        'yes' { return $true }
        'on' { return $true }
        default { return $false }
    }
}

function Resolve-DeadWorkerWorkerStatusStoreState {
    param([object]$StoreState = $null)

    if (Test-DeadWorkerWorkerStatusStoreDisabled) {
        return @{
            schemaVersion = 1
            records = @{}
            disabled = $true
        }
    }

    if ($null -ne $StoreState) {
        return $StoreState
    }

    return Get-WorkerStatusStoreState
}

function Get-DeadWorkerLivenessContext {
    param(
        [object[]]$Sessions,
        [object]$StoreState = $null,
        [object]$SanctionedKillSurface = $null,
        [hashtable]$OsLivenessOverride = $null,
        [long]$EvaluationNowMs = 0
    )

    $nowMs = if ($EvaluationNowMs) { $EvaluationNowMs } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $resolvedStore = Resolve-DeadWorkerWorkerStatusStoreState -StoreState $StoreState
    $resolvedKillSurface = if ($null -ne $SanctionedKillSurface) { $SanctionedKillSurface } else { Read-SanctionedWorkerKillSurface }
    $osLiveness = if ($null -ne $OsLivenessOverride) { $OsLivenessOverride } else { Get-WorkerOsLivenessMap -Sessions $Sessions }
    return @{
        evaluationNowMs               = $nowMs
        osLiveness                    = $osLiveness
        sanctionedKillSurface         = $resolvedKillSurface
        workerStatusStore             = $resolvedStore
        workerStatusRows              = @(Get-DeadWorkerWorkerStatusRows -StoreState $resolvedStore)
        supportedSchemaVersions       = @(1)
        supportedProducerCapabilities = @('pack-worker-status-store/v1')
        lifecycleAllowlist            = @('terminated', 'dead', 'exited')
    }
}

function Get-DeadWorkerLivePlanGates {
    $respawnPolicy = Get-AutonomousRespawnPolicy
    $boundsResult = Get-DeadWorkerResolvedBounds -RespawnPolicy $respawnPolicy
    $yamlPath = Resolve-OperatorOrchestratorYamlPath -PackRoot $PackRoot
    $rules = Get-OrchestratorRulesFromYamlPath -YamlPath $yamlPath
    return @{
        respawnPolicy = $respawnPolicy
        bounds = if ($boundsResult.ok) { $boundsResult.bounds } else { @{ maxAttempts = 0; backoffMs = 0; concurrency = 0 } }
        effectiveRuntimePolicy = (Get-DeadWorkerEffectiveRuntimePolicy -OrchestratorRules $rules)
    }
}

function Get-DeadWorkerWorktreeDiscoveryPorcelain {
    param([string]$RepoRoot)

    if (-not $RepoRoot) { return '' }
    $porcelain = & git -C $RepoRoot worktree list --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    return (($porcelain | ForEach-Object { $_ }) -join "`n")
}

function Get-DeadWorkerAuditDiscoveryCandidates {
    param(
        [string]$ProjectId,
        [string]$RepoRoot = ''
    )

    return @(Get-PackWorkerReportDiscoveryCandidates -RepoRoot $RepoRoot)
}

function Get-DeadWorkerAbsentSessions {
    param(
        [object[]]$Sessions,
        [string]$ProjectId,
        [string]$RepoRoot,
        [object[]]$OpenPrs = @()
    )

    $result = Invoke-DeadWorkerPlannerCli -Subcommand 'discover-absent-sessions' -Payload @{
        sessions = @($Sessions)
        worktreePorcelain = (Get-DeadWorkerWorktreeDiscoveryPorcelain -RepoRoot $RepoRoot)
        auditCandidates = @(Get-DeadWorkerAuditDiscoveryCandidates -ProjectId $ProjectId -RepoRoot $RepoRoot)
        openPrs = @($OpenPrs)
    }
    return @($result.absentSessions)
}

function Get-DeadWorkerLivePayload {
    if ($env:AO_DEAD_WORKER_LIVE_PAYLOAD_FIXTURE) {
        $fixture = Get-Content -LiteralPath $env:AO_DEAD_WORKER_LIVE_PAYLOAD_FIXTURE -Raw | ConvertFrom-Json
        $sessions = @($fixture.sessions)
        $storeState = Resolve-DeadWorkerWorkerStatusStoreState -StoreState $(if ($fixture.workerStatusStore) { $fixture.workerStatusStore } else { @{ records = @{} } })
        $killSurface = if ($fixture.livenessContext.sanctionedKillSurface) {
            $fixture.livenessContext.sanctionedKillSurface
        }
        else {
            @{ healthy = $true; records = @() }
        }
        $osLiveness = @{}
        if ($fixture.livenessContext.osLiveness) {
            foreach ($prop in $fixture.livenessContext.osLiveness.PSObject.Properties) {
                $osLiveness[$prop.Name] = $prop.Value
            }
        }
        return @{
            sessions = $sessions
            livenessContext = Get-DeadWorkerLivenessContext -Sessions $sessions -StoreState $storeState `
                -SanctionedKillSurface $killSurface -OsLivenessOverride $osLiveness `
                -EvaluationNowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        }
    }
    $sessions = @(Get-WorkerStatusDecisionSessionsIncludingTerminated)
    $storeState = Resolve-DeadWorkerWorkerStatusStoreState
    return @{
        sessions = $sessions
        livenessContext = Get-DeadWorkerLivenessContext -Sessions $sessions -StoreState $storeState
    }
}

function Get-DeadWorkerFixturePayload {
    param([string]$Path)
    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $respawnPolicy = Get-AutonomousRespawnPolicy
    if ($fixture.respawnPolicy) { $respawnPolicy = $fixture.respawnPolicy }
    $effectiveRuntimePolicy = 'deny'
    if ($fixture.effectiveRuntimePolicy) {
        $effectiveRuntimePolicy = [string]$fixture.effectiveRuntimePolicy
    }
    $boundsResult = Get-DeadWorkerResolvedBounds -RespawnPolicy $respawnPolicy -OverrideBounds $fixture.bounds
    $bounds = if ($boundsResult.ok) { $boundsResult.bounds } else { @{ maxAttempts = 0; backoffMs = 0; concurrency = 0 } }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($fixture.nowMs) { $nowMs = [long]$fixture.nowMs }
    $issueOnlyPrAmbiguous = $true
    if ($null -ne $fixture.issueOnlyPrAmbiguous) { $issueOnlyPrAmbiguous = [bool]$fixture.issueOnlyPrAmbiguous }
    return @{
        sessions = @($fixture.sessions)
        absentSessions = @($fixture.absentSessions)
        livenessContext = $fixture.livenessContext
        respawnPolicy = $respawnPolicy
        tracking = $fixture.tracking
        recoveryChecks = $fixture.recoveryChecks
        effectiveRuntimePolicy = $effectiveRuntimePolicy
        bounds = $bounds
        nowMs = $nowMs
        issueOnlyPrAmbiguous = $issueOnlyPrAmbiguous
        prLookupFailed = [bool]$fixture.prLookupFailed
        openPrs = @($fixture.openPrs)
        terminalPrs = @($fixture.terminalPrs)
    }
}

function Get-DeadWorkerCliBridgeText {
    param([object]$RawOutput)

    return (($RawOutput | ForEach-Object {
                if ($_ -is [string]) { $_ }
                elseif ($null -ne $_) { $_.ToString() }
            }) -join "`n").Trim()
}

function Test-DeadWorkerAllowedPrefixLine {
    param([string]$Line)

    foreach ($pattern in $Script:DeadWorkerCliPrefixAllowlist) {
        if ($Line -match $pattern) { return $true }
    }
    return $false
}

function Get-DeadWorkerJsonBridgePayload {
    param(
        [string]$Text,
        [ValidateSet('Array', 'Object')]
        [string]$ExpectedRoot,
        [string]$FailureLabel
    )

    $trimmed = [string]$Text
    while ($trimmed.Length -gt 0) {
        $trimmed = $trimmed.TrimStart()
        if (-not $trimmed) { break }
        $lineBreak = $trimmed.IndexOf("`n")
        $line = if ($lineBreak -ge 0) { $trimmed.Substring(0, $lineBreak).TrimEnd("`r") } else { $trimmed }
        if (Test-DeadWorkerAllowedPrefixLine -Line $line) {
            $trimmed = if ($lineBreak -ge 0) { $trimmed.Substring($lineBreak + 1) } else { '' }
            continue
        }
        $expectedChar = if ($ExpectedRoot -eq 'Array') { '[' } else { '{' }
        if ($trimmed[0] -eq $expectedChar) { break }
        throw "$FailureLabel parse failed: unrecognized prefix line"
    }

    if (-not $trimmed) {
        throw "$FailureLabel produced no JSON output"
    }

    $openChar = if ($ExpectedRoot -eq 'Array') { '[' } else { '{' }
    $closeChar = if ($ExpectedRoot -eq 'Array') { ']' } else { '}' }
    if ($trimmed[0] -ne $openChar) {
        throw "$FailureLabel parse failed: expected top-level $ExpectedRoot"
    }

    $depth = 0
    $inString = $false
    $escaped = $false
    $endIndex = -1
    for ($index = 0; $index -lt $trimmed.Length; $index++) {
        $ch = $trimmed[$index]
        if ($inString) {
            if ($escaped) {
                $escaped = $false
            }
            elseif ($ch -eq '\') {
                $escaped = $true
            }
            elseif ($ch -eq '"') {
                $inString = $false
            }
            continue
        }
        if ($ch -eq '"') {
            $inString = $true
            continue
        }
        if ($ch -eq $openChar) {
            $depth++
            continue
        }
        if ($ch -eq $closeChar) {
            $depth--
            if ($depth -eq 0) {
                $endIndex = $index
                break
            }
        }
    }

    if ($endIndex -lt 0) {
        throw "$FailureLabel parse failed: unterminated JSON"
    }

    $jsonText = $trimmed.Substring(0, $endIndex + 1)
    $trailing = $trimmed.Substring($endIndex + 1).Trim()
    if ($trailing) {
        throw "$FailureLabel parse failed: trailing non-whitespace after JSON"
    }
    return $jsonText
}

function ConvertFrom-DeadWorkerCliJsonArray {
    param(
        [object]$RawOutput,
        [string]$FailureLabel
    )

    $text = Get-DeadWorkerCliBridgeText -RawOutput $RawOutput
    if (-not $text) { return @() }
    $jsonText = Get-DeadWorkerJsonBridgePayload -Text $text -ExpectedRoot Array -FailureLabel $FailureLabel
    return @($jsonText | ConvertFrom-Json)
}

function Invoke-DeadWorkerGhListJsonArray {
    param(
        [string[]]$Args,
        [string]$FailureLabel,
        [string]$FixturePath = ''
    )

    $raw = if ($FixturePath) {
        Get-Content -LiteralPath $FixturePath -Raw
    }
    else {
        & (Join-Path $PackRoot 'scripts/gh') @Args 2>&1
    }
    if (-not $FixturePath -and $LASTEXITCODE -ne 0) {
        throw "$FailureLabel failed (exit $LASTEXITCODE): $(Get-DeadWorkerCliBridgeText -RawOutput $raw)"
    }
    return ConvertFrom-DeadWorkerCliJsonArray -RawOutput $raw -FailureLabel $FailureLabel
}

function Invoke-DeadWorkerRecovery {
    param(
        [object]$Action,
        [switch]$DryRunMode
    )
    if ($DryRunMode) {
        Write-DeadWorkerLog "dry-run would recover session=$($Action.sessionId) pr=$($Action.prNumber) issue=$($Action.issueNumber) key=$($Action.key)"
        return @{ ok = $true; deadWorkerOutcome = 'dry_run'; outcome = 'dry_run'; dryRun = $true }
    }

    $recoveryArgv = @(
        '-NoProfile', '-File', (Join-Path $PSScriptRoot 'invoke-worker-recovery.ps1'),
        '-Trigger', 'reconcile_dead_worker',
        '-ProbedDeadEvidence',
        '-SessionId', [string]$Action.sessionId,
        '-GenerationToken', [string]$Action.generationToken,
        '-WorktreePath', [string]$Action.worktree,
        '-ProjectId', $ProjectId,
        '-RepoRoot', $RepoRoot,
        '-SpawnAction', [string]$Action.spawnAction
    )
    if ([int]$Action.issueNumber -gt 0) { $recoveryArgv += @('-IssueNumber', [string]$Action.issueNumber) }
    if ([int]$Action.prNumber -gt 0) { $recoveryArgv += @('-PrNumber', [string]$Action.prNumber) }

    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'dead-worker-reconcile-side-effect.lock'
    Write-OrchestratorSideProcessProgress -ChildId 'dead-worker-reconcile' -Phase 'side_effect'
    $capture = @{ output = $null; exitCode = 0 }
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        $capture.output = & pwsh @recoveryArgv 2>&1
        $capture.exitCode = $LASTEXITCODE
    }
    if (-not $fenced.ok) {
        return @{ ok = $false; deadWorkerOutcome = 'escalated'; outcome = 'escalated'; reason = 'side_effect_busy' }
    }
    $output = ($capture.output | Out-String).Trim()
    if ([int]$capture.exitCode -ne 0) {
        return @{ ok = $false; deadWorkerOutcome = 'escalated'; outcome = 'escalated'; reason = "worker_recovery_exit_$($capture.exitCode)"; output = $output }
    }
    $classified = Invoke-DeadWorkerPlannerCli -Subcommand 'parse-recovery-output' -Payload @{ output = $output }
    return @{
        ok                = [bool]$classified.ok
        deadWorkerOutcome = [string]$classified.deadWorkerOutcome
        outcome           = [string]$classified.deadWorkerOutcome
        reason            = [string]$classified.reason
        recoveryOutcome   = [string]$classified.recoveryOutcome
        spawn             = [string]$classified.spawn
        output            = $output
    }
}

function Get-DeadWorkerPrSnapshot {
    try {
        $openPrs = if ($env:AO_DEAD_WORKER_OPEN_PRS_FIXTURE) {
            ConvertTo-GhOpenPrArray -OpenPrs (Get-Content -LiteralPath $env:AO_DEAD_WORKER_OPEN_PRS_FIXTURE -Raw | ConvertFrom-Json)
        }
        else {
            ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot -Consumer 'dead-worker-reconcile')
        }
        $terminalPrs = @()
        Push-Location -LiteralPath $RepoRoot
        try {
            $merged = @(Invoke-DeadWorkerGhListJsonArray -Args @('pr', 'list', '--state', 'merged', '--json', 'number,headRefName,state,mergedAt', '--limit', '200') `
                -FailureLabel 'gh pr list merged' -FixturePath $env:AO_DEAD_WORKER_GH_MERGED_RAW_FIXTURE)
            $closed = @(Invoke-DeadWorkerGhListJsonArray -Args @('pr', 'list', '--state', 'closed', '--json', 'number,headRefName,state,closedAt', '--limit', '200') `
                -FailureLabel 'gh pr list closed' -FixturePath $env:AO_DEAD_WORKER_GH_CLOSED_RAW_FIXTURE)
            $byNumber = @{}
            foreach ($pr in @($merged + $closed)) {
                if ($null -eq $pr) { continue }
                $n = [int]$pr.number
                if ($n -le 0) { continue }
                $byNumber[[string]$n] = $pr
            }
            $terminalPrs = @($byNumber.Values)
        }
        finally {
            Pop-Location
        }
        return @{
            openPrs        = @($openPrs)
            terminalPrs    = @($terminalPrs)
            prLookupFailed = $false
        }
    }
    catch {
        $message = $_.Exception.Message
        if ($message -match 'gh pr list failed|gh pr list merged failed|gh pr list closed failed|snapshot_populate_failed|child_list_bypass') {
            Write-DeadWorkerLog "pr lookup failed: $message"
            return @{
                openPrs        = @()
                terminalPrs    = @()
                prLookupFailed = $true
            }
        }
        throw
    }
}

function Commit-DeadWorkerAction {
    param(
        [object]$State,
        [object]$Action,
        [long]$NowMs
    )
    $commit = Invoke-DeadWorkerPlannerCli -Subcommand 'commit' -Payload @{
        tracking = $State
        action = $Action
        nowMs = $NowMs
    }
    return $commit.tracking
}

function Test-DeadWorkerPreKillRevalidation {
    param([object]$Action)

    $liveFixture = if ($env:AO_DEAD_WORKER_LIVE_PAYLOAD_FIXTURE) {
        Get-Content -LiteralPath $env:AO_DEAD_WORKER_LIVE_PAYLOAD_FIXTURE -Raw | ConvertFrom-Json
    }
    else {
        $null
    }
    $sessions = @()
    $absentSessions = @()
    $storeState = $null
    $killSurface = $null
    $osLiveness = $null
    if ($liveFixture) {
        $sessions = @($liveFixture.sessions)
        $absentSessions = @($liveFixture.absentSessions)
        $storeState = if ($liveFixture.workerStatusStore) { $liveFixture.workerStatusStore } else { $null }
        $killSurface = if ($liveFixture.livenessContext.sanctionedKillSurface) { $liveFixture.livenessContext.sanctionedKillSurface } else { $null }
        $osLiveness = if ($liveFixture.livenessContext.osLiveness) {
            $map = @{}
            foreach ($prop in $liveFixture.livenessContext.osLiveness.PSObject.Properties) {
                $map[$prop.Name] = $prop.Value
            }
            $map
        }
        else {
            $null
        }
    }
    else {
        $live = Get-DeadWorkerLivePayload
        $prSnapshot = Get-DeadWorkerPrSnapshot
        $sessions = @($live.sessions)
        $absentSessions = @(Get-DeadWorkerAbsentSessions -Sessions $sessions -ProjectId $ProjectId `
            -RepoRoot $RepoRoot -OpenPrs $prSnapshot.openPrs)
        $storeState = $live.livenessContext.workerStatusStore
        $killSurface = $live.livenessContext.sanctionedKillSurface
        $osLiveness = $live.livenessContext.osLiveness
    }
    $livenessProbeSessions = @($sessions) + @($absentSessions)
    $session = $livenessProbeSessions | Where-Object { [string]($_.sessionId ?? $_.id ?? $_.name) -eq [string]$Action.sessionId } | Select-Object -First 1
    if (-not $session) {
        return @{ ok = $false; reason = 'prekill_session_missing' }
    }
    $livenessContext = Get-DeadWorkerLivenessContext -Sessions $livenessProbeSessions -StoreState $storeState `
        -SanctionedKillSurface $killSurface -OsLivenessOverride $osLiveness
    $classification = Invoke-DeadWorkerPlannerCli -Subcommand 'classify-liveness' -Payload @{
        session = $session
        livenessContext = $livenessContext
    }
    if ([string]$classification.verdict -ne 'dead') {
        return @{ ok = $false; reason = 'prekill_verdict_changed'; classification = $classification }
    }
    $token = [string]($classification.evidence.revalidationToken ?? '')
    if (-not $token -or $token -ne [string]$Action.revalidationToken) {
        return @{ ok = $false; reason = 'prekill_generation_changed'; classification = $classification }
    }
    return @{ ok = $true; classification = $classification; session = $session }
}

function Invoke-DeadWorkerTick {
    param(
        [string]$StatePath,
        [switch]$DryRunMode,
        [string]$Fixture
    )
    $tracking = Get-DeadWorkerState -Path $StatePath
    Assert-MechanicalJsonStateFencesTrusted -State $tracking -Context 'dead-worker side effects'
    if ((Get-DeadWorkerActionMapCount -Map $tracking.quarantinedActions) -gt 0) {
        Write-DeadWorkerLog "recovery quarantine active; planning paused quarantinedActions=$((Get-DeadWorkerActionMapCount -Map $tracking.quarantinedActions))"
        return 0
    }
    if ((Get-DeadWorkerActionMapCount -Map $tracking.pendingActions) -gt 0) {
        $tracking = Enter-DeadWorkerRecoveryQuarantine -State $tracking -Reason 'incomplete_recovery_after_side_effect' `
            -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        if (-not $DryRunMode) {
            Set-DeadWorkerState -Path $StatePath -State $tracking
        }
        Write-DeadWorkerLog "recovery quarantine activated for quarantinedActions=$((Get-DeadWorkerActionMapCount -Map $tracking.quarantinedActions))"
        return 0
    }

    if ($Fixture) {
        $payload = Get-DeadWorkerFixturePayload -Path $Fixture
    }
    else {
        $live = Get-DeadWorkerLivePayload
        $checks = Invoke-DeadWorkerPlannerCli -Subcommand 'probe-checks' -Payload @{ packRoot = $PackRoot }
        $gates = Get-DeadWorkerLivePlanGates
        $prSnapshot = Get-DeadWorkerPrSnapshot
        $absentSessions = @(Get-DeadWorkerAbsentSessions -Sessions $live.sessions -ProjectId $ProjectId `
            -RepoRoot $RepoRoot -OpenPrs $prSnapshot.openPrs)
        $livenessProbeSessions = @($live.sessions) + @($absentSessions)
        $livenessContext = Get-DeadWorkerLivenessContext -Sessions $livenessProbeSessions `
            -StoreState $live.livenessContext.workerStatusStore `
            -SanctionedKillSurface $live.livenessContext.sanctionedKillSurface `
            -EvaluationNowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        $payload = @{
            sessions = @($live.sessions)
            absentSessions = @($absentSessions)
            livenessContext = $livenessContext
            respawnPolicy = $gates.respawnPolicy
            tracking = $tracking
            recoveryChecks = $checks
            effectiveRuntimePolicy = $gates.effectiveRuntimePolicy
            bounds = $gates.bounds
            nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            openPrs = @($prSnapshot.openPrs)
            terminalPrs = @($prSnapshot.terminalPrs)
            prLookupFailed = [bool]$prSnapshot.prLookupFailed
        }
    }
    if (-not $payload.tracking) { $payload.tracking = $tracking }

    $plan = Invoke-DeadWorkerPlannerCli -Subcommand 'plan' -Payload $payload
    if ($null -ne $plan.tracking) {
        $tracking = $plan.tracking
        if (-not $DryRunMode) {
            Set-DeadWorkerState -Path $StatePath -State $tracking
        }
    }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $attempted = 0
    foreach ($action in @($plan.actions)) {
        Write-DeadWorkerLog "action=$($action.type) session=$($action.sessionId) reason=$($action.reason) key=$($action.key)"
        $tracking = Commit-DeadWorkerAction -State $tracking -Action $action -NowMs $nowMs
        if (-not $DryRunMode) {
            Set-DeadWorkerState -Path $StatePath -State $tracking
        }
        if ($action.type -ne 'attempt_started') { continue }
        $revalidation = Test-DeadWorkerPreKillRevalidation -Action $action
        if (-not $revalidation.ok) {
            $finalAction = [ordered]@{}
            foreach ($prop in $action.PSObject.Properties) { $finalAction[$prop.Name] = $prop.Value }
            $finalAction.type = 'audit_only'
            $finalAction.outcome = 'audit-only'
            $finalAction.reason = [string]$revalidation.reason
            $tracking = Commit-DeadWorkerAction -State $tracking -Action $finalAction -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
            if (-not $DryRunMode) {
                Set-DeadWorkerState -Path $StatePath -State $tracking
            }
            continue
        }
        $attempted++
        if (-not $DryRunMode) {
            $tracking = Set-DeadWorkerPendingAction -State $tracking -Action $action -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
            Set-DeadWorkerState -Path $StatePath -State $tracking
        }
        $result = Invoke-DeadWorkerRecovery -Action $action -DryRunMode:$DryRunMode
        if (-not $DryRunMode) {
            $tracking = Clear-DeadWorkerPendingAction -State $tracking -Key ([string]$action.key)
        }
        $finalAction = [ordered]@{}
        foreach ($prop in $action.PSObject.Properties) { $finalAction[$prop.Name] = $prop.Value }
        $finalAction.type = [string]$result.deadWorkerOutcome
        if (-not $finalAction.type) {
            $finalAction.type = if ($result.ok) { 'recovered' } else { 'escalated' }
        }
        $finalAction.outcome = $finalAction.type
        $finalAction.reason = if ($result.reason) { [string]$result.reason } else { [string]$finalAction.type }
        if ($finalAction.type -eq 'escalated') {
            $sessionId = [string]$action.sessionId
            $reason = [string]$finalAction.reason
            $corr = "corr:recovery:$sessionId"
            $dedupe = "dedupe:recovery:$sessionId`:$reason"
            Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-dead-worker-recovery' `
                -SourceProcess 'dead-worker-reconcile' -CorrelationKey $corr -DedupeKey $dedupe `
                -Diagnosis @{ sessionId = $sessionId; reason = $reason; action = $finalAction } | Out-Null
        }
        $tracking = Commit-DeadWorkerAction -State $tracking -Action $finalAction -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    }
    $tracking.lastTickMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (-not $DryRunMode) { Set-DeadWorkerState -Path $StatePath -State $tracking }
    return $attempted
}

$intervalMs = [Math]::Max(1, $IntervalMinutes) * 60 * 1000
$pollMs = [Math]::Max(5, $PollSeconds) * 1000
$statePath = Get-DeadWorkerStatePath -CliPath $StateFile

Write-DeadWorkerLog "starting (project=$ProjectId, interval=${IntervalMinutes}m, state=$statePath, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"

try {
    do {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $state = Get-DeadWorkerState -Path $statePath
        $lastTickMs = if ($state.lastTickMs) { [long]$state.lastTickMs } else { $null }
        $gate = Invoke-DeadWorkerPlannerCli -Subcommand 'interval' -Payload @{
            nowMs = $nowMs
            lastTickMs = $lastTickMs
            intervalMs = $intervalMs
        }
        Write-OrchestratorSideProcessProgress -ChildId 'dead-worker-reconcile' -Phase 'poll'
        if ($FixturePath -or $gate.ok) {
            try {
                $count = Invoke-DeadWorkerTick -StatePath $statePath -DryRunMode:$DryRun -Fixture $FixturePath
                Write-DeadWorkerLog "tick complete (attempted=$count)"
                Write-OrchestratorSideProcessTickSuccess -ChildId 'dead-worker-reconcile'
            }
            catch {
                Write-DeadWorkerLog "tick error: $_"
                Write-OrchestratorSideProcessTickError -ChildId 'dead-worker-reconcile' -ErrorMessage "$_"
            }
        }
        else {
            Write-DeadWorkerLog "tick skipped: $($gate.reason)"
        }
        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-DeadWorkerLog 'stopped'
}
