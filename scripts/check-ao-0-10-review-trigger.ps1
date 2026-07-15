#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: pack-owned review runner + trigger loop wiring (Issues #623/#839).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Assert-RequiredPaths.ps1')

$required = @(
    'scripts/pack-review-runner.ts',
    'scripts/lib/pack-review-run-store.ts',
    'scripts/invoke-pack-review.ps1',
    'scripts/lib/Invoke-AoReviewApi.ps1',
    'docs/ao-0-10-review-api.mjs',
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1',
    'scripts/review-trigger-reconcile.ps1',
    'scripts/lib/Invoke-ReviewTriggerReeval.ps1',
    'docs/ao-0-10-review-harness-adoption.md'
)

Assert-RequiredPathsExist -Paths @($required | ForEach-Object { Join-Path $Root $_ })

$retiredShim = Join-Path $Root 'scripts/ao-review.ps1'
if (Test-Path -LiteralPath $retiredShim) {
    Write-Host 'scripts/ao-review.ps1 must remain retired after the pack-runner cutover'
    exit 1
}

$adapter = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Invoke-AoReviewApi.ps1') -Raw
foreach ($marker in @(
        'Invoke-PackReviewRunnerCli',
        'Get-OpkTypeScriptNodeArguments',
        'scripts/pack-review-runner.ts',
        "-Subcommand 'start'",
        "-Subcommand 'list'"
    )) {
    if ($adapter -notmatch [regex]::Escape($marker)) {
        Write-Host "Invoke-AoReviewApi.ps1 missing pack-runner adapter marker: $marker"
        exit 1
    }
}
if ($adapter -match '/api/v1/sessions/.*/reviews(?:/trigger)?' -or $adapter -match 'POST\s+/reviews/trigger') {
    Write-Host 'Invoke-AoReviewApi.ps1 must not retain daemon session-review trigger/list paths'
    exit 1
}

$triggerScripts = @(
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1',
    'scripts/review-trigger-reconcile.ps1',
    'scripts/lib/Invoke-ReviewTriggerReeval.ps1'
)

foreach ($rel in $triggerScripts) {
    $text = Get-Content -LiteralPath (Join-Path $Root $rel) -Raw
    if ($text -notmatch 'Invoke-AoReviewTriggerForWorker') {
        Write-Host "$rel must invoke the stable pack-runner trigger adapter"
        exit 1
    }
    if ($text -match "@\('review',\s*'run'" -or $text -match '&\s+ao\s+@runArgs') {
        Write-Host "$rel must not retain ao review run argv invocation"
        exit 1
    }
    if ($text -notmatch 'Get-ReviewTriggerInvocationLine') {
        Write-Host "$rel must log the pack-runner invocation line"
        exit 1
    }
}

$adoption = Get-Content -LiteralPath (Join-Path $Root 'docs/ao-0-10-review-harness-adoption.md') -Raw
foreach ($marker in @(
        'Pack-owned review runner adoption',
        'GitHub PR review is the authoritative verdict record',
        'Do not use daemon review endpoints or `ao review submit`'
    )) {
    if ($adoption -notmatch [regex]::Escape($marker)) {
        Write-Host "review-runner adoption guide missing marker: $marker"
        exit 1
    }
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

Write-Host '[PASS] pack-owned review runner + trigger loop wiring (Issues #623/#839)'
