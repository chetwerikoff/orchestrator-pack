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
    [string]$WorktreePath = '',
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [string]$SpawnAction = '',
    [int]$PrNumber = 0,
    [switch]$DanglingGitdir,
    [switch]$WorktreePresent,
    [switch]$DryRun,
    [switch]$Probe,
    [string]$FixtureSessionJson = '',
    [string]$FixturePolicyJson = ''
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = $PackRoot }

. (Join-Path $PSScriptRoot 'lib/Worker-Recovery.ps1')

$session = $null
if ($FixtureSessionJson) {
    $session = $FixtureSessionJson | ConvertFrom-Json -AsHashtable
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

$result = Invoke-WorkerRecovery -Trigger $Trigger -SessionId $SessionId -CanonicalPath $WorktreePath `
    -ProjectId $ProjectId -PackRoot $PackRoot -RepoRoot $RepoRoot -Surface 'invoke-worker-recovery' `
    -Session $session -DanglingGitdir:$DanglingGitdir -WorktreePresent:$WorktreePresent -DryRun:$DryRun `
    -SpawnAction $SpawnAction -PrNumber $PrNumber -SpawnPolicy $spawnPolicy -FixtureMode:([bool]$spawnPolicy) `
    -SkipSpawn:(-not $SpawnAction)

$result | ConvertTo-Json -Compress -Depth 8
if ((-not $result.ok -or $result.outcome -in @('skipped_ambiguous', 'skipped_live', 'spawn_denied', 'partial_failure')) -and -not $DryRun) {
    exit 2
}
