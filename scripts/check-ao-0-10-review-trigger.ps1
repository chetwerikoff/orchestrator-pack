#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: AO 0.10 review harness + trigger loop wiring (Issue #623).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Assert-RequiredPaths.ps1')

$required = @(
    'scripts/ao-review.ps1',
    'scripts/lib/Invoke-AoReviewApi.ps1',
    'docs/ao-0-10-review-api.mjs',
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1',
    'scripts/review-trigger-reconcile.ps1',
    'scripts/lib/Invoke-ReviewTriggerReeval.ps1',
    'docs/ao-0-10-review-harness-adoption.md'
)

Assert-RequiredPathsExist -Paths @($required | ForEach-Object { Join-Path $Root $_ })

$triggerScripts = @(
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1',
    'scripts/review-trigger-reconcile.ps1',
    'scripts/lib/Invoke-ReviewTriggerReeval.ps1'
)

foreach ($rel in $triggerScripts) {
    $text = Get-Content -LiteralPath (Join-Path $Root $rel) -Raw
    if ($text -notmatch 'Invoke-AoReviewTriggerForWorker') {
        Write-Host "$rel must invoke Invoke-AoReviewTriggerForWorker (POST /reviews/trigger)"
        exit 1
    }
    if ($text -match "@\('review',\s*'run'" -or $text -match '&\s+ao\s+@runArgs') {
        Write-Host "$rel must not retain ao review run argv invocation"
        exit 1
    }
    if ($text -notmatch 'Get-ReviewTriggerInvocationLine') {
        Write-Host "$rel must log ao-review shim invocation line"
        exit 1
    }
}

$aoReview = Get-Content -LiteralPath (Join-Path $Root 'scripts/ao-review.ps1') -Raw
if ($aoReview -notmatch 'REMOVED on AO 0.10') {
    Write-Host 'ao-review.ps1 must mark send/execute as REMOVED'
    exit 1
}

$recovery = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Worker-Recovery.ps1') -Raw
if ($recovery -notmatch 'Assert-ReviewBeforeCleanupGate') {
    Write-Host 'Worker-Recovery.ps1 must enforce review-before-cleanup gate'
    exit 1
}

$mjs = Get-Content -LiteralPath (Join-Path $Root 'docs/review-mechanical-cli.mjs') -Raw
if ($mjs -notmatch 'ao\\s\+review\\s\+run') {
    Write-Host 'review-mechanical-cli.mjs must forbid ao review run on mechanical paths'
    exit 1
}

Write-Host '[PASS] AO 0.10 review harness + trigger loop wiring (Issue #623)'
