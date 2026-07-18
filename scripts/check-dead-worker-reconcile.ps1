#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: dead-worker reconciler runtime wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$reconcileScript = Join-Path $Root 'scripts/dead-worker-reconcile.ps1'
$reconcileMjs = Join-Path $Root 'docs/dead-worker-reconciler.mjs'
$policyPath = Join-Path $Root 'docs/autonomous-respawn-policy.json'
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'

foreach ($path in @($reconcileScript, $reconcileMjs, $policyPath, $registryPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required runtime file: $path"
        exit 1
    }
}

$mjs = Get-Content -LiteralPath $reconcileMjs -Raw
if ($mjs -notmatch 'DEFAULT_DEAD_WORKER_INTERVAL_MS = 60_000') {
    Write-Host 'dead-worker-reconciler.mjs must default to a 1-minute interval'
    exit 1
}
if ($mjs -notmatch 'input\.livenessContext\s*\?\s*classifyWorkerLivenessEvidence') {
    Write-Host 'dead-worker-reconciler.mjs must prefer the shared live liveness classifier'
    exit 1
}

$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
if ($policy.allowReconcileDeadWorkerRespawn -ne $false) {
    Write-Host 'autonomous-respawn-policy.json must default allowReconcileDeadWorkerRespawn=false'
    exit 1
}

$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$child = $registry.children | Where-Object { $_.id -eq 'dead-worker-reconcile' } | Select-Object -First 1
if (-not $child) {
    Write-Host 'orchestrator-side-process-registry.json must register dead-worker-reconcile'
    exit 1
}

$ps1 = Get-Content -LiteralPath $reconcileScript -Raw
if ($ps1 -match 'Get-AoEventsSince' -or $ps1 -match 'aoEvents\s*=') {
    Write-Host 'dead-worker-reconcile.ps1 must not call AO events or build aoEvents payloads'
    exit 1
}
if ($ps1 -match 'GetTempPath\(\).+orchestrator-dead-worker-reconcile-state') {
    Write-Host 'dead-worker-reconcile.ps1 must persist state under the stable supervisor state root'
    exit 1
}
foreach ($marker in @(
        'ProbedDeadEvidence',
        '@recoveryArgv',
        'Invoke-DeadWorkerGhListJsonArray'
    )) {
    if ($ps1 -notmatch [regex]::Escape($marker)) {
        Write-Host "dead-worker-reconcile.ps1 missing runtime marker: $marker"
        exit 1
    }
}
if ($ps1 -match '&\s*pwsh\s+@args') {
    Write-Host 'dead-worker-reconcile.ps1 must not invoke recovery through shadowed @args'
    exit 1
}

Write-Host '[PASS] dead-worker reconciler runtime wiring'
exit 0
