#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: pack-owned review runner/store wiring (Issue #839).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Assert-RequiredPaths.ps1')

$required = @(
    'scripts/pack-review-runner.ts',
    'scripts/lib/pack-review-run-store.ts',
    'scripts/lib/Invoke-AoReviewApi.ps1',
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1',
    'scripts/review-trigger-reconcile.ps1',
    'scripts/lib/Invoke-ReviewTriggerReeval.ps1',
    'docs/ao-0-10-review-harness-adoption.md'
)
Assert-RequiredPathsExist -Paths @($required | ForEach-Object { Join-Path $Root $_ })

$retiredShim = Join-Path $Root 'scripts/ao-review.ps1'
if (Test-Path -LiteralPath $retiredShim) {
    Write-Host 'scripts/ao-review.ps1 must remain retired'
    exit 1
}

$adapterPath = Join-Path $Root 'scripts/lib/Invoke-AoReviewApi.ps1'
$adapter = Get-Content -LiteralPath $adapterPath -Raw
foreach ($requiredPhrase in @('scripts/pack-review-runner.ts', "Subcommand 'list'", "Subcommand 'start'")) {
    if ($adapter -notmatch [regex]::Escape($requiredPhrase)) {
        Write-Host "Invoke-AoReviewApi.ps1 missing pack-runner adapter phrase: $requiredPhrase"
        exit 1
    }
}
if ($adapter -match '/api/v1/sessions/.*/reviews(?:/trigger)?') {
    Write-Host 'Invoke-AoReviewApi.ps1 must not retain daemon review trigger/list HTTP paths'
    exit 1
}

$runner = Get-Content -LiteralPath (Join-Path $Root 'scripts/pack-review-runner.ts') -Raw
$store = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/pack-review-run-store.ts') -Raw
if ($runner -notmatch '#opk-kernel/subprocess') {
    Write-Host 'pack-review-runner.ts must use the sanctioned subprocess kernel'
    exit 1
}
if ($runner -match '\bao\s+review\s+submit\b') {
    Write-Host 'pack-review-runner.ts must not call ao review submit'
    exit 1
}
if ($store -notmatch 'runner_disappeared_stale' -or $store -notmatch 'multiple active records') {
    Write-Host 'pack-review-run-store.ts must retain stale-run and fail-closed ambiguity contracts'
    exit 1
}

foreach ($rel in @(
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1',
    'scripts/review-trigger-reconcile.ps1',
    'scripts/lib/Invoke-ReviewTriggerReeval.ps1'
)) {
    $text = Get-Content -LiteralPath (Join-Path $Root $rel) -Raw
    if ($text -notmatch 'Invoke-AoReviewTriggerForWorker') {
        Write-Host "$rel must invoke the shared pack-runner adapter"
        exit 1
    }
    if ($text -notmatch 'Get-ReviewTriggerInvocationLine') {
        Write-Host "$rel must log the shared pack-runner invocation line"
        exit 1
    }
    if ($text -match "@\('review',\s*'run'" -or $text -match '&\s+ao\s+@runArgs') {
        Write-Host "$rel must not retain ao review run argv invocation"
        exit 1
    }
}

$recovery = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Worker-Recovery.ps1') -Raw
if ($recovery -notmatch 'Assert-ReviewBeforeCleanupGate') {
    Write-Host 'Worker-Recovery.ps1 must enforce the pack-store review-before-cleanup gate'
    exit 1
}

Write-Host '[PASS] pack-owned review runner/store wiring (Issue #839)'
