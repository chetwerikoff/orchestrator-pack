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

$Script:DeadWorkerDefaultState = @{ attempts = @{}; leases = @{}; audit = @(); lastTickMs = $null }

function Write-DeadWorkerLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReconcileLogPrefix): $Message"
}

function Get-DeadWorkerStatePath {
    param([string]$CliPath)
    if ($CliPath) { return $CliPath }
    if ($env:AO_DEAD_WORKER_RECONCILE_STATE) { return $env:AO_DEAD_WORKER_RECONCILE_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-dead-worker-reconcile-state.json'
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

function Invoke-DeadWorkerPlannerCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $PlannerCli -Subcommand $Subcommand `
        -Payload $Payload -Label $Script:ReconcileLogPrefix -JsonDepth 40
}

function Get-AutonomousRespawnPolicy {
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

    $adoption = Invoke-DeadWorkerPlannerCli -Subcommand 'evaluate-adoption' -Payload @{
        orchestratorRules = [string]$OrchestratorRules
    }
    return [string]$adoption.effectiveRuntimePolicy
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
    param([string]$ProjectId)

    return @(Get-PackWorkerReportDiscoveryCandidates)
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
        auditCandidates = @(Get-DeadWorkerAuditDiscoveryCandidates -ProjectId $ProjectId)
        openPrs = @($OpenPrs)
    }
    return @($result.absentSessions)
}

function Get-DeadWorkerLivePayload {
    $sessions = @(Get-AoStatusSessionsWithReportsIncludingTerminated)
    return @{
        sessions = $sessions
        aoEvents = @(Get-AoEventsSince -SinceMinutes 60)
        livenessContext = @{
            osLiveness = Get-WorkerOsLivenessMap -Sessions $sessions
            sanctionedKillSurface = Read-SanctionedWorkerKillSurface
        }
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
        aoEvents = @($fixture.aoEvents)
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
        $openPrs = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot -Consumer 'dead-worker-reconcile')
        $terminalPrs = @()
        Push-Location -LiteralPath $RepoRoot
        try {
            $merged = @(ConvertFrom-GhJsonArrayOutput -RawOutput (gh pr list --state merged --json number,headRefName,state,mergedAt --limit 200 2>&1))
            if ($LASTEXITCODE -ne 0) {
                throw "gh pr list merged failed (exit $LASTEXITCODE)"
            }
            $closed = @(ConvertFrom-GhJsonArrayOutput -RawOutput (gh pr list --state closed --json number,headRefName,state,closedAt --limit 200 2>&1))
            if ($LASTEXITCODE -ne 0) {
                throw "gh pr list closed failed (exit $LASTEXITCODE)"
            }
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

function Invoke-DeadWorkerTick {
    param(
        [string]$StatePath,
        [switch]$DryRunMode,
        [string]$Fixture
    )
    $tracking = Get-DeadWorkerState -Path $StatePath
    Assert-MechanicalJsonStateFencesTrusted -State $tracking -Context 'dead-worker side effects'

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
        $livenessContext = @{
            osLiveness = Get-WorkerOsLivenessMap -Sessions $livenessProbeSessions
            sanctionedKillSurface = $live.livenessContext.sanctionedKillSurface
        }
        $payload = @{
            sessions = @($live.sessions)
            absentSessions = @($absentSessions)
            aoEvents = @($live.aoEvents)
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
        $attempted++
        $result = Invoke-DeadWorkerRecovery -Action $action -DryRunMode:$DryRunMode
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
