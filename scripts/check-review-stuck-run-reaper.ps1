#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: AO 0.10 stuck review-run reaper wiring (Issue #624).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

. (Join-Path $PSScriptRoot 'lib/Assert-RequiredPaths.ps1')

$required = @(
    'scripts/review-stuck-run-reaper.ps1',
    'scripts/lib/Invoke-ReviewStuckRunReaper.ps1',
    'docs/review-stuck-run-reaper.mjs',
    'tests/fixtures/review-stuck-run-reaper/stuck-same-head-absent-pane.json'
)

Assert-RequiredPathsExist -Paths @($required | ForEach-Object { Join-Path $Root $_ })

$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$requiredChild = @($registry.requiredChildIds | Where-Object { $_ -eq 'review-stuck-run-reaper' })
$child = @($registry.children | Where-Object { $_.id -eq 'review-stuck-run-reaper' })
if ($requiredChild.Count -ne 1 -or $child.Count -ne 1) {
    Write-Host 'review-stuck-run-reaper must be registered exactly once as a required side-process child'
    exit 1
}
if (-not $child[0].sideEffecting) {
    Write-Host 'review-stuck-run-reaper must be marked sideEffecting'
    exit 1
}
if ($child[0].sideEffectLockFile -ne 'review-stuck-run-reaper-side-effect.lock') {
    Write-Host 'review-stuck-run-reaper side-effect lock mismatch'
    exit 1
}

$recovery = Get-Content -LiteralPath (Join-Path $Root 'scripts/review-run-recovery.ps1') -Raw
if ($recovery -notmatch 'review-stuck-run-reaper') {
    Write-Host 'review-run-recovery.ps1 must supersede to review-stuck-run-reaper on AO 0.10'
    exit 1
}

$mjs = Get-Content -LiteralPath (Join-Path $Root 'docs/review-stuck-run-reaper.mjs') -Raw
if ($mjs -notmatch 'AgentWrapper/agent-orchestrator#2070') {
    Write-Host 'review-stuck-run-reaper.mjs must document upstream fail-stale prerequisite'
    exit 1
}

Write-Host '[PASS] AO 0.10 stuck review-run reaper wiring (Issue #624)'
