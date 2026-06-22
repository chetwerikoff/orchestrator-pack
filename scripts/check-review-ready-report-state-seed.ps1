#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #391 report-state poll seed wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$seedScript = Join-Path $Root 'scripts/review-ready-report-state-seed.ps1'
$seedMjs = Join-Path $Root 'docs/review-ready-report-state-seed.mjs'
$invokeLib = Join-Path $Root 'scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1'
$recordLib = Join-Path $Root 'scripts/lib/Record-ReviewReadyReportStateSeed.ps1'
$reevalLib = Join-Path $Root 'scripts/lib/Invoke-ReviewTriggerReeval.ps1'
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$agentRules = Join-Path $Root 'prompts/agent_rules.md'
$wakeRunbook = Join-Path $Root 'docs/orchestrator-wake-runbook.md'
$migrationNotes = Join-Path $Root 'docs/migration_notes.md'
$capturePath = Join-Path $Root 'tests/external-output-references/captures/ao-status-sessions/ready_for_review_on_head.raw.json'

foreach ($path in @($seedScript, $seedMjs, $invokeLib, $recordLib, $reevalLib)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $path"
        exit 1
    }
}

$mjs = Get-Content -LiteralPath $seedMjs -Raw
foreach ($needle in @(
        "REPORT_STATE_POLL_CLASS = 'report_state_poll'",
        'planReportStatePollTick',
        'hasTerminalHandoffOutcome',
        'evaluatePollReportBinding',
        'findLatestAcceptedReadyForReviewAcrossSessions',
        'resolveOpenPrForRepoAndNumber'
    )) {
    if ($mjs -notlike "*$needle*") {
        Write-Host "docs/review-ready-report-state-seed.mjs missing: $needle"
        exit 1
    }
}

$reevalMjs = Get-Content -LiteralPath (Join-Path $Root 'docs/review-trigger-reeval.mjs') -Raw
foreach ($needle in @(
        "REPORT_STATE_SEED_START_REASON = 'report_state_seed'",
        'seedWatchFromReportStatePoll',
        'resolveStartReasonForWatchEntry',
        'seedFromReportStatePoll'
    )) {
    if ($reevalMjs -notlike "*$needle*") {
        Write-Host "docs/review-trigger-reeval.mjs missing: $needle"
        exit 1
    }
}

if ((Get-Content -LiteralPath $invokeLib -Raw) -notmatch "startReason -ne 'report_state_seed'") {
    Write-Host 'Invoke-ReviewReadyReportStateSeed.ps1 must revert unexecuted deferred-watch triggers'
    exit 1
}

if ((Get-Content -LiteralPath $reevalLib -Raw) -notmatch '\$planned\.startReason') {
    Write-Host 'Invoke-ReviewTriggerReeval.ps1 must propagate action startReason into planned + claim'
    exit 1
}

$aoCli = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Invoke-AoCliJson.ps1') -Raw
if ($aoCli -notmatch 'Get-AoStatusSessionsIncludingTerminated') {
    Write-Host 'Invoke-AoCliJson.ps1 must expose Get-AoStatusSessionsIncludingTerminated'
    exit 1
}

$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$child = $registry.children | Where-Object { $_.id -eq 'review-ready-report-state-seed' } | Select-Object -First 1
if (-not $child -or -not $child.sideEffecting) {
    Write-Host 'orchestrator-side-process-registry.json must classify review-ready-report-state-seed as side-effecting'
    exit 1
}
if ($child.sideEffectLockFile -ne 'review-ready-report-state-seed-side-effect.lock') {
    Write-Host 'review-ready-report-state-seed sideEffectLockFile must be review-ready-report-state-seed-side-effect.lock'
    exit 1
}
if (-not ($child.extraArgs -contains '-StateDir') -or -not ($child.extraArgs -contains '{stateRoot}')) {
    Write-Host 'review-ready-report-state-seed extraArgs must pass -StateDir {stateRoot}'
    exit 1
}

if (-not (Test-Path -LiteralPath $capturePath -PathType Leaf)) {
    Write-Host "Missing Gate A capture fixture: $capturePath"
    exit 1
}

if ((Get-Content -LiteralPath $agentRules -Raw) -notlike '*Report-state review-start seed*') {
    Write-Host 'prompts/agent_rules.md missing report-state seed section'
    exit 1
}

if ((Get-Content -LiteralPath $wakeRunbook -Raw) -notlike '*review-ready-report-state-seed*') {
    Write-Host 'docs/orchestrator-wake-runbook.md missing review-ready-report-state-seed documentation'
    exit 1
}

if ((Get-Content -LiteralPath $migrationNotes -Raw) -notlike '*review-ready-report-state-seed*') {
    Write-Host 'docs/migration_notes.md missing review-ready-report-state-seed adoption'
    exit 1
}

Write-Host 'check-review-ready-report-state-seed: PASS'
# Issue #391 report-state poll seed wiring guard
