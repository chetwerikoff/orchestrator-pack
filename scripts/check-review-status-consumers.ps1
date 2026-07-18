#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: review-status decision consumers use the pack worker-status store.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$aoCli = Join-Path $Root 'scripts/lib/Invoke-AoCliJson.ps1'
$workerStatusDecisionReader = Join-Path $Root 'scripts/lib/Get-WorkerStatusDecisionSessions.ps1'
$testFile = Join-Path $Root 'scripts/review-status-consumer.test.ts'
$diagnose = Join-Path $Root 'scripts/orchestrator-diagnose.ps1'
$workerStatusStore = Join-Path $Root 'scripts/lib/WorkerStatusStore.ps1'

foreach ($path in @($aoCli, $workerStatusDecisionReader, $workerStatusStore, $testFile, $diagnose)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required runtime/test file: $path"
        exit 1
    }
}

$requiredConsumers = @{
    'scripts/review-trigger-reconcile.ps1'               = 'Get-WorkerStatusDecisionSessions'
    'scripts/review-trigger-reeval.ps1'                  = 'Get-WorkerStatusDecisionSessions'
    'scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1'  = 'Get-WorkerStatusDecisionSessionsIncludingTerminated'
    'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1'     = 'Get-WorkerStatusDecisionSessions'
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1'           = 'Get-WorkerStatusDecisionSessions'
    'scripts/ci-green-wake-reconcile.ps1'                = 'Get-WorkerStatusDecisionSessions'
    'scripts/worker-message-submit-reconcile.ps1'        = 'Get-WorkerStatusDecisionSessions'
    'scripts/dead-worker-reconcile.ps1'                  = 'Get-WorkerStatusDecisionSessionsIncludingTerminated'
}

foreach ($rel in $requiredConsumers.Keys) {
    $path = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing review-status consumer: $rel"
        exit 1
    }
    $needle = $requiredConsumers[$rel]
    $raw = Get-Content -LiteralPath $path -Raw
    if ($raw -notmatch [regex]::Escape($needle)) {
        Write-Host "$rel must call $needle"
        exit 1
    }
}

$aoCliRaw = Get-Content -LiteralPath $aoCli -Raw
foreach ($needle in @(
        'function Get-AoStatusSessionsWithReports',
        'function Get-AoStatusSessionsWithReportsIncludingTerminated',
        'function Format-AoSessionReportSourcePath',
        'Merge-AoSessionRowsWithWorkerReportStore'
    )) {
    if ($aoCliRaw -notmatch [regex]::Escape($needle)) {
        Write-Host "Invoke-AoCliJson.ps1 missing runtime surface: $needle"
        exit 1
    }
}

$workerStatusDecisionReaderRaw = Get-Content -LiteralPath $workerStatusDecisionReader -Raw
foreach ($needle in @(
        'function Get-WorkerStatusDecisionSessions',
        'function Get-WorkerStatusDecisionSessionsIncludingTerminated'
    )) {
    if ($workerStatusDecisionReaderRaw -notmatch [regex]::Escape($needle)) {
        Write-Host "Get-WorkerStatusDecisionSessions.ps1 missing runtime surface: $needle"
        exit 1
    }
}

$workerStatusStoreRaw = Get-Content -LiteralPath $workerStatusStore -Raw
foreach ($needle in @(
        'function Merge-SessionsWithWorkerStatusStore',
        'function Merge-AoSessionRowsWithWorkerStatusStore'
    )) {
    if ($workerStatusStoreRaw -notmatch [regex]::Escape($needle)) {
        Write-Host "WorkerStatusStore.ps1 missing runtime surface: $needle"
        exit 1
    }
}

# Report/events compatibility helpers may remain until their consumers are migrated.
# This guard protects the current decision path rather than treating compatibility
# cleanup as part of the pack-review documentation change.
$diagnoseRaw = Get-Content -LiteralPath $diagnose -Raw
if ($diagnoseRaw -notmatch 'Get-WorkerStatusDecisionSessions') {
    Write-Host 'orchestrator-diagnose.ps1 must use the pack worker-status decision reader'
    exit 1
}
if ($diagnoseRaw -notmatch 'reportSourcePath') {
    Write-Host 'orchestrator-diagnose.ps1 must expose reportSourcePath for hand-off diagnostics'
    exit 1
}

Write-Host '[PASS] review-status consumers use pack worker-status runtime wiring'
exit 0
