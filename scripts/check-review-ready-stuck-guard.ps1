#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: review-ready false-stuck runtime classifier.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$mjsPath = Join-Path $Root 'docs/review-ready-stuck-guard.mjs'
$testPath = Join-Path $Root 'scripts/review-ready-stuck-guard.test.ts'

foreach ($path in @($mjsPath, $testPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required runtime/test file: $path"
        exit 1
    }
}

$mjs = Get-Content -LiteralPath $mjsPath -Raw
foreach ($marker in @(
        'DEFAULT_GRACE_MINUTES = 15',
        "status !== 'clean'",
        'hold_grace',
        "GRACE_MINUTES_ENV_VAR = 'AO_REVIEW_READY_STUCK_GRACE_MINUTES'",
        'session-runtime-liveness.mjs'
    )) {
    if ($mjs -notmatch [regex]::Escape($marker)) {
        Write-Host "review-ready-stuck-guard.mjs missing runtime marker: $marker"
        exit 1
    }
}

$test = Get-Content -LiteralPath $testPath -Raw
if ($test -notmatch 'hold_grace' -or $test -notmatch 'AO_REVIEW_READY_STUCK_GRACE_MINUTES') {
    Write-Host 'review-ready-stuck-guard.test.ts must cover grace behavior and override'
    exit 1
}

Write-Host '[PASS] review-ready false-stuck runtime classifier'
exit 0
