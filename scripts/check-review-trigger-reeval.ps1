#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #235 deferred-head review re-evaluation wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$reevalScript = Join-Path $Root 'scripts/review-trigger-reeval.ps1'
$reevalMjs = Join-Path $Root 'docs/review-trigger-reeval.mjs'
$reevalLib = Join-Path $Root 'scripts/lib/Invoke-ReviewTriggerReeval.ps1'
$recordLib = Join-Path $Root 'scripts/lib/Record-ReviewTriggerReevalWatch.ps1'
$wakeLib = Join-Path $Root 'scripts/lib/Invoke-ReviewWakeTrigger.ps1'
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$scriptOwnedDoc = Join-Path $Root 'docs/script-owned-review-pipeline.md'
$wakeRunbook = Join-Path $Root 'docs/orchestrator-wake-runbook.md'
$migrationNotes = Join-Path $Root 'docs/migration_notes.md'
$capturePath = Join-Path $Root 'tests/external-output-references/captures/ao-webhook-notification/ready_for_review.raw.json'

foreach ($path in @($reevalScript, $reevalMjs, $reevalLib, $recordLib)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $path"
        exit 1
    }
}

$mjs = Get-Content -LiteralPath $reevalMjs -Raw
foreach ($needle in @(
        'INCIDENT_WAKE_TO_READINESS_DELAY_MS = 77_000',
        'DEFERRED_WATCH_WINDOW_MS = 300_000',
        'READINESS_TO_RUN_DECISION_MAX_MS = 5_000',
        "SCOPED_DEFERRED_HEAD_WATCH_POLL_CLASS = 'scoped_deferred_head_watch'",
        'evaluateHeadReviewTriggerDecision',
        'planDeferredWatchTick',
        'seedWatchFromWakeDefer',
        'seedWatchFromInProgressSignals',
        'evaluateReadyForReviewNotificationCapture'
    )) {
    if ($mjs -notlike "*$needle*") {
        Write-Host "docs/review-trigger-reeval.mjs missing: $needle"
        exit 1
    }
}

if ($mjs -notmatch 'review-head-ready\.mjs') {
    Write-Host 'docs/review-trigger-reeval.mjs must compose review-head-ready.mjs (Issue #195)'
    exit 1
}

if ((Get-Content -LiteralPath $wakeLib -Raw) -notmatch 'Record-ReviewTriggerReevalWatch') {
    Write-Host 'Invoke-ReviewWakeTrigger.ps1 must record deferred-head watches when StateRoot available'
    exit 1
}

$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$child = $registry.children | Where-Object { $_.id -eq 'review-trigger-reeval' } | Select-Object -First 1
if (-not $child -or -not $child.sideEffecting) {
    Write-Host 'orchestrator-side-process-registry.json must classify review-trigger-reeval as side-effecting'
    exit 1
}
if ($child.sideEffectLockFile -ne 'review-trigger-reeval-side-effect.lock') {
    Write-Host 'review-trigger-reeval sideEffectLockFile must be review-trigger-reeval-side-effect.lock'
    exit 1
}
if (-not ($child.extraArgs -contains '-StateDir') -or -not ($child.extraArgs -contains '{stateRoot}')) {
    Write-Host 'review-trigger-reeval extraArgs must pass -StateDir {stateRoot}'
    exit 1
}

if ((Get-Content -LiteralPath $scriptOwnedDoc -Raw) -notlike '*Deferred-head review re-evaluation*') {
    Write-Host 'docs/script-owned-review-pipeline.md missing deferred-head review re-evaluation section'
    exit 1
}

if ((Get-Content -LiteralPath $wakeRunbook -Raw) -notlike '*review-trigger-reeval*') {
    Write-Host 'docs/orchestrator-wake-runbook.md missing review-trigger-reeval documentation'
    exit 1
}

if ((Get-Content -LiteralPath $migrationNotes -Raw) -notlike '*review-trigger-reeval*') {
    Write-Host 'docs/migration_notes.md missing review-trigger-reeval adoption'
    exit 1
}

if (-not (Test-Path -LiteralPath $capturePath -PathType Leaf)) {
    Write-Host "Missing AO webhook capture: $capturePath"
    exit 1
}

$reevalPs1 = Get-Content -LiteralPath $reevalScript -Raw
if ($reevalPs1 -notmatch 'Get-ReviewTriggerReevalScopedOpenPrsFromGitHub') {
    Write-Host 'review-trigger-reeval.ps1 must resolve scoped open PRs from GitHub heads'
    exit 1
}
if ($reevalPs1 -match '-FixtureSnapshot\s+\$snapshot' -and $reevalPs1 -notmatch "if \(\`$FixturePayload\) \{[\s\S]*FixtureSnapshot") {
    Write-Host 'review-trigger-reeval.ps1 must only pass FixtureSnapshot during fixture replay'
    exit 1
}

if ($reevalPs1 -notmatch 'Update-ReviewTriggerReevalWatchStateMerged') {
    Write-Host 'review-trigger-reeval.ps1 must merge watch state under a shared lock'
    exit 1
}

$commonPs1 = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Review-TriggerReeval-Common.ps1') -Raw
if ($commonPs1 -notmatch 'System\.Collections\.IDictionary') {
    Write-Host 'Review-TriggerReeval-Common.ps1 must treat hashtable watch maps as empty when unset'
    exit 1
}

if ($mjs -notmatch 'gh\\s\+pr\\s\+merge') {
    Write-Host 'docs/review-trigger-reeval.mjs must forbid gh pr merge in review-run-only command guard'
    exit 1
}

$reevalLib = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Invoke-ReviewTriggerReeval.ps1') -Raw
if ($reevalLib -notmatch 'Test-ReviewTriggerReevalForbiddenCommand') {
    Write-Host 'Invoke-ReviewTriggerReeval.ps1 must reject gh pr merge in ReviewCommand'
    exit 1
}

Write-Host '[PASS] deferred-head review re-evaluation entrypoint and wiring (Issue #235)'
exit 0
