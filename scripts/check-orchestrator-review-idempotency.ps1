#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: pack-owned exact-head review idempotency runtime surfaces.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$runnerPath = Join-Path $Root 'scripts/pack-review-runner.ts'
$storePath = Join-Path $Root 'scripts/lib/pack-review-run-store.ts'
foreach ($path in @($runnerPath, $storePath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required runtime path: $path"
        exit 1
    }
}

$runner = Get-Content -LiteralPath $runnerPath -Raw
$store = Get-Content -LiteralPath $storePath -Raw
if ($runner -notmatch 'startPackReview' -or $store -notmatch 'createPackReviewRun') {
    Write-Host 'pack runner/store idempotency surfaces are incomplete'
    exit 1
}
if ($runner -match '\bao\s+review\s+run\b') {
    Write-Host 'pack-review-runner.ts must not invoke AO review run'
    exit 1
}

Write-Host '[PASS] pack-owned exact-head runner/store idempotency surfaces exist'
exit 0
