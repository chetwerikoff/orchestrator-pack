#requires -Version 7.0
<#
.SYNOPSIS
  Regression guard: CI-failure notification runtime wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$required = @(
    'docs/ci-failure-notification.mjs',
    'scripts/ci-failure-notification.ps1',
    'scripts/ci-failure-notification-reconcile.ps1',
    'scripts/orchestrator-side-process-registry.json',
    'scripts/lib/Record-WorkerMessageDispatch.ps1'
)
foreach ($rel in $required) {
    $path = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required runtime file: $rel"
        exit 1
    }
}

$registry = Get-Content -LiteralPath (Join-Path $Root 'scripts/orchestrator-side-process-registry.json') -Raw | ConvertFrom-Json
if ($registry.requiredChildIds -notcontains 'ci-failure-notification-reconcile') {
    Write-Host 'side-process registry must require ci-failure-notification-reconcile'
    exit 1
}
if ($registry.requiredChildIds -contains 'ci-failure-notification-reaction') {
    Write-Host 'retired ci-failure-notification-reaction must not be a required child'
    exit 1
}

$reconcile = Get-Content -LiteralPath (Join-Path $Root 'scripts/ci-failure-notification-reconcile.ps1') -Raw
foreach ($marker in @('Get-AoStatusSessions', 'Register-WorkerMessageDispatch')) {
    if ($reconcile -notmatch [regex]::Escape($marker)) {
        Write-Host "ci-failure-notification-reconcile.ps1 missing runtime marker: $marker"
        exit 1
    }
}
if ($reconcile -match 'ci-failure-notification-reaction\.ps1') {
    Write-Host 'live CI-failure reconcile path must not invoke the retired reaction script'
    exit 1
}

$wrapper = Get-Content -LiteralPath (Join-Path $Root 'scripts/ci-failure-notification.ps1') -Raw
foreach ($marker in @('docs/ci-failure-notification.mjs', "'init-gate'", "'pre-send-recheck'", "'SEND','SUPPRESS'")) {
    if ($wrapper -notmatch [regex]::Escape($marker)) {
        Write-Host "ci-failure-notification.ps1 missing runtime marker: $marker"
        exit 1
    }
}

Write-Host '[PASS] CI-failure notification runtime wiring'
exit 0
