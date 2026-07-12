#requires -Version 5.1
<#
.SYNOPSIS
  Public worker recovery entrypoint for autonomous orchestrator (Issue #522).

.DESCRIPTION
  Enumerates dead worker worktrees, acquires a recovery claim, performs
  candidate-scoped cleanup, and routes respawn through spawn policy/grant gates.
  All git worktree remove operations must run as children of this script.
#>
[CmdletBinding()]
param(
    [ValidateSet('operator_request', 'operator_spawn', 'operator-recover', 'reconcile_dead_worker')]
    [string]$Trigger = 'operator_request',
    [string]$SessionId = '',
    [string]$GenerationToken = '',
    [string]$WorktreePath = '',
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [string]$SpawnAction = '',
    [int]$IssueNumber = 0,
    [int]$PrNumber = 0,
    [switch]$DanglingGitdir,
    [switch]$WorktreePresent,
    [switch]$DryRun,
    [switch]$Probe,
    [string]$FixtureSessionJson = '',
    [string]$FixturePolicyJson = '',
    [switch]$ProbedDeadEvidence
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = $PackRoot }

. (Join-Path $PSScriptRoot 'lib/Worker-Recovery.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-OrchestratorEscalationEmit.ps1')

function Invoke-RecordSanctionedWorkerKillIfNeeded {
    param(
        [string]$Trigger,
        [string]$SessionId,
        [int]$IssueNumber,
        [int]$PrNumber,
        [object]$RecoveryResult,
        [switch]$DryRun
    )

    if ($DryRun -or -not $SessionId) { return }
    if ($Trigger -notin @('operator_request', 'operator-recover')) { return }

    $audit = $RecoveryResult.audit
    if (-not $audit -or [string]$audit.claimOutcome -ne 'claim_acquired') { return }
    if ($RecoveryResult.cleanup -ne $true) { return }

    $recordScript = Join-Path $PSScriptRoot 'record-sanctioned-worker-kill.ps1'
    & pwsh -NoProfile -File $recordScript -SessionId $SessionId -IssueNumber $IssueNumber -PrNumber $PrNumber -KillKind 'manual' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "record-sanctioned-worker-kill failed session=$SessionId exit=$LASTEXITCODE"
    }
}


$session = $null
if ($FixtureSessionJson) {
    $session = $FixtureSessionJson | ConvertFrom-Json -AsHashtable
}
elseif ($SessionId) {
    try {
        $aoRow = Get-WorkerRecoveryAoSessionById -SessionId $SessionId
        $session = ConvertTo-WorkerRecoverySessionSnapshot -AoRow $aoRow
    }
    catch {
        $session = $null
    }
}
$spawnPolicy = $null
if ($FixturePolicyJson) {
    $spawnPolicy = $FixturePolicyJson | ConvertFrom-Json -AsHashtable
}

if ($Probe) {
    $Trigger = 'operator_request'
    $SessionId = 'opk-probe'
    $WorktreePath = Join-Path $HOME '.agent-orchestrator/projects/orchestrator-pack/worktrees/opk-probe'
    $WorktreePresent = $true
    $session = @{ sessionId = $SessionId; runtime = 'exited'; worktree = $WorktreePath; status = 'terminated' }
    $DryRun = $true
}

if (-not $WorktreePath) {
    throw 'WorktreePath is required unless -Probe is set.'
}


$recoveryParams = @{
    Trigger      = $Trigger
    SessionId    = $SessionId
    GenerationToken = $GenerationToken
    CanonicalPath = $WorktreePath
    ProjectId    = $ProjectId
    PackRoot     = $PackRoot
    RepoRoot     = $RepoRoot
    Surface      = 'invoke-worker-recovery'
    Session      = $session
    DanglingGitdir = $DanglingGitdir
    DryRun       = $DryRun
    SpawnAction  = $SpawnAction
    IssueNumber  = $IssueNumber
    PrNumber     = $PrNumber
    SpawnPolicy  = $spawnPolicy
    FixtureMode  = [bool]$spawnPolicy
    SkipSpawn    = (-not $SpawnAction)
    ProbedDeadEvidence = [bool]$ProbedDeadEvidence
}
if ($PSBoundParameters.ContainsKey('WorktreePresent') -or $Probe) {
    $result = Invoke-WorkerRecovery @recoveryParams -WorktreePresent:$WorktreePresent
}
else {
    $result = Invoke-WorkerRecovery @recoveryParams
}

Invoke-RecordSanctionedWorkerKillIfNeeded -Trigger $Trigger -SessionId $SessionId `
    -IssueNumber $IssueNumber -PrNumber $PrNumber -RecoveryResult $result -DryRun:$DryRun

if ($result.outcome -in @('skipped_ambiguous', 'skipped_live', 'spawn_denied', 'partial_failure', 'escalated')) {
    $sessionId = [string]$SessionId
    $reason = [string]$result.outcome
    $corr = "corr:recovery:$sessionId"
    $dedupe = "dedupe:recovery:$sessionId`:$reason"
    Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-dead-worker-recovery' `
        -SourceProcess 'invoke-worker-recovery' -CorrelationKey $corr -DedupeKey $dedupe `
        -Diagnosis @{ sessionId = $sessionId; outcome = $result.outcome; reason = $result.reason } -DryRun:$DryRun | Out-Null
}

$result | ConvertTo-Json -Compress -Depth 8
if ((-not $result.ok -or $result.outcome -in @('skipped_ambiguous', 'skipped_live', 'spawn_denied', 'partial_failure', 'escalated')) -and -not $DryRun) {
    exit 2
}
