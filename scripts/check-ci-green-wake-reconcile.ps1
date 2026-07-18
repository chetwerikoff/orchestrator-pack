#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: CI-green worker wake runtime wiring and cadence.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$wakeScript = Join-Path $Root 'scripts/ci-green-wake-reconcile.ps1'
$wakeMjs = Join-Path $Root 'docs/ci-green-wake-reconcile.mjs'

foreach ($path in @($wakeScript, $wakeMjs)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required path: $path"
        exit 1
    }
}

$scriptText = Get-Content -LiteralPath $wakeScript -Raw
$mjs = Get-Content -LiteralPath $wakeMjs -Raw

if ($mjs -notmatch 'DEFAULT_CI_GREEN_WAKE_INTERVAL_MS = 60 \* 1000') {
    Write-Host 'docs/ci-green-wake-reconcile.mjs must default to 1-minute interval'
    exit 1
}

foreach ($forbidden in @('ao spawn', '--claim-pr', 'ao session kill')) {
    if ($scriptText -match [regex]::Escape($forbidden)) {
        Write-Host "ci-green wake production path contains forbidden command: $forbidden"
        exit 1
    }
}

Write-Host '[PASS] CI-green worker wake runtime wiring and cadence'
exit 0
