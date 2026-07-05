#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #593 dead-worker reconciler wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$agentRules = Join-Path $Root 'prompts/agent_rules.md'
$reconcileScript = Join-Path $Root 'scripts/dead-worker-reconcile.ps1'
$reconcileMjs = Join-Path $Root 'docs/dead-worker-reconciler.mjs'
$policyPath = Join-Path $Root 'docs/autonomous-respawn-policy.json'
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'

if (-not (Test-Path -LiteralPath $reconcileScript -PathType Leaf)) {
    Write-Host 'Missing scripts/dead-worker-reconcile.ps1'
    exit 1
}

if (-not (Test-Path -LiteralPath $reconcileMjs -PathType Leaf)) {
    Write-Host 'Missing docs/dead-worker-reconciler.mjs'
    exit 1
}

$required = @(
    'DEAD WORKER RECONCILE',
    'dead-worker-reconcile.ps1',
    'reconcile_dead_worker',
    'invoke-worker-recovery.ps1',
    'allowReconcileDeadWorkerRespawn',
    'default-OFF',
    'AO_DEAD_WORKER_RECONCILE_STATE',
    'never plans new work',
    'operator kill',
    'audit-only'
)

$text = Get-Content -LiteralPath $example -Raw
$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing dead-worker reconcile phrases: {0}" -f ($missing -join ', '))
    exit 1
}

if ((Get-Content -LiteralPath $agentRules -Raw) -notlike '*Autonomous dead-worker respawn*') {
    Write-Host 'prompts/agent_rules.md missing autonomous dead-worker respawn section'
    exit 1
}

$mjs = Get-Content -LiteralPath $reconcileMjs -Raw
if ($mjs -notmatch 'DEFAULT_DEAD_WORKER_INTERVAL_MS = 60_000') {
    Write-Host 'docs/dead-worker-reconciler.mjs must default to 1-minute interval'
    exit 1
}

if (-not (Test-Path -LiteralPath $policyPath)) {
    Write-Host 'Missing docs/autonomous-respawn-policy.json'
    exit 1
}
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
if ($policy.allowReconcileDeadWorkerRespawn -ne $false) {
    Write-Host 'autonomous-respawn-policy.json must default allowReconcileDeadWorkerRespawn=false'
    exit 1
}

if (-not (Test-Path -LiteralPath $registryPath)) {
    Write-Host "Missing registry: $registryPath"
    exit 1
}
$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$child = $registry.children | Where-Object { $_.id -eq 'dead-worker-reconcile' } | Select-Object -First 1
if (-not $child) {
    Write-Host 'orchestrator-side-process-registry.json must register dead-worker-reconcile'
    exit 1
}

$ps1 = Get-Content -LiteralPath $reconcileScript -Raw
if ($ps1 -notmatch 'ProbedDeadEvidence') {
    Write-Host 'dead-worker-reconcile.ps1 must pass -ProbedDeadEvidence to invoke-worker-recovery.ps1'
    exit 1
}
if ($ps1 -notmatch '@recoveryArgv' -or $ps1 -match '&\s*pwsh\s+@args') {
    Write-Host 'dead-worker-reconcile.ps1 must invoke recovery with @recoveryArgv (not scriptblock-shadowed @args)'
    exit 1
}

Write-Host '[PASS] dead-worker reconcile entrypoint and example wiring (Issue #593)'
exit 0
