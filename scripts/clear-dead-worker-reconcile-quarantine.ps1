#requires -Version 5.1
<#
.SYNOPSIS
  Clear dead-worker reconcile quarantine after operator review.

.DESCRIPTION
  This command is intentionally fail-closed: it refuses to clear the quarantine
  marker while pending or quarantined actions still exist in the reconcile
  state. Successful clearance appends an audit row in the same durable state
  file and removes the `_recovery` fence so future ticks may resume planning.
#>
[CmdletBinding()]
param(
    [string]$StateFile = '',
    [string]$Actor = 'operator'
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')

$defaultState = @{
    schemaVersion      = 'dead-worker-reconcile/v2'
    attempts           = @{}
    leases             = @{}
    audit              = @()
    pendingActions     = @{}
    quarantinedActions = @{}
    lastTickMs         = $null
}

function Get-ClearStatePath {
    param([string]$CliPath)
    if ($CliPath) { return $CliPath }
    if ($env:AO_DEAD_WORKER_RECONCILE_STATE) { return $env:AO_DEAD_WORKER_RECONCILE_STATE }
    if ($env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR) {
        return Join-Path $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR 'orchestrator-dead-worker-reconcile-state.json'
    }
    return Join-Path (Join-Path (Join-Path $HOME '.local') 'state/orchestrator-pack-wake-supervisor') 'orchestrator-dead-worker-reconcile-state.json'
}

$path = Get-ClearStatePath -CliPath $StateFile
$state = Get-MechanicalJsonStateFile -Path $path -DefaultState $defaultState -ActionTracking
$pendingCount = @($state.pendingActions.Keys).Count
$quarantinedCount = @($state.quarantinedActions.Keys).Count
if ($pendingCount -gt 0 -or $quarantinedCount -gt 0) {
    throw "cannot clear dead-worker reconcile quarantine while pendingActions=$pendingCount quarantinedActions=$quarantinedCount"
}

if ($null -eq $state._recovery) {
    [pscustomobject]@{
        ok = $true
        outcome = 'noop'
        statePath = $path
        auditCount = @($state.audit).Count
    } | ConvertTo-Json -Compress
    exit 0
}

$audit = @($state.audit)
$audit += @{
    outcome = 'quarantine_cleared'
    reason = 'operator_clearance'
    actor = [string]$Actor
    recordedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}
$state.Remove('_recovery')
$state.audit = $audit
Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $defaultState -JsonDepth 40

[pscustomobject]@{
    ok = $true
    outcome = 'cleared'
    statePath = $path
    actor = [string]$Actor
    auditCount = @($audit).Count
} | ConvertTo-Json -Compress
