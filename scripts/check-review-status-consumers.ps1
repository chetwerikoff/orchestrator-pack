#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #717 review-status consumers use pack worker report store.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$inventory = Join-Path $Root 'docs/review-status-consumer-inventory.md'
$aoCli = Join-Path $Root 'scripts/lib/Invoke-AoCliJson.ps1'
$testFile = Join-Path $Root 'scripts/review-status-consumer.test.ts'
$scriptOwnedDoc = Join-Path $Root 'docs/script-owned-review-pipeline.md'
$diagnose = Join-Path $Root 'scripts/orchestrator-diagnose.ps1'

foreach ($path in @($inventory, $aoCli, $testFile, $scriptOwnedDoc, $diagnose)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $path"
        exit 1
    }
}

$requiredConsumers = @{
    'scripts/review-trigger-reconcile.ps1'                 = 'Get-AoStatusSessionsWithReports'
    'scripts/review-trigger-reeval.ps1'                    = 'Get-AoStatusSessionsWithReports'
    'scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1'   = 'Get-AoStatusSessionsWithReportsIncludingTerminated'
    'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1'       = 'Get-AoStatusSessionsWithReports'
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1'             = 'Get-AoStatusSessionsWithReports'
    'scripts/ci-green-wake-reconcile.ps1'                  = 'Get-AoStatusSessionsWithReports'
    'scripts/worker-message-submit-reconcile.ps1'          = 'Get-AoStatusSessionsWithReports'
    'scripts/dead-worker-reconcile.ps1'                    = 'Get-AoStatusSessionsWithReportsIncludingTerminated'
}

foreach ($rel in $requiredConsumers.Keys) {
    $needle = $requiredConsumers[$rel]
    $raw = Get-Content -LiteralPath (Join-Path $Root $rel) -Raw
    if ($raw -notmatch [regex]::Escape($needle)) {
        Write-Host "$rel must call $needle (Issue #611)"
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
        Write-Host "Invoke-AoCliJson.ps1 missing $needle"
        exit 1
    }
}

foreach ($forbidden in @(
        'function Test-AoReportFullCliAvailable',
        'function Read-AoAgentReportAuditReports',
        'function Get-AoStatusReportsJson',
        'function Get-AoStatusReportsIncludingTerminatedJson',
        'function Merge-AoSessionRowsWithReportAudit',
        '.agent-report-audit',
        "status', '--json', '--reports', 'full'"
    )) {
    if ($aoCliRaw -match [regex]::Escape($forbidden)) {
        Write-Host "Invoke-AoCliJson.ps1 must not bind removed AO report surface: $forbidden"
        exit 1
    }
}

$diagnoseRaw = Get-Content -LiteralPath $diagnose -Raw
if ($diagnoseRaw -match "status', '--json', '--reports', 'full'" -and
    $diagnoseRaw -notmatch 'Get-AoStatusSessionsWithReports') {
    Write-Host 'orchestrator-diagnose.ps1 must not shell ao status --reports full directly'
    exit 1
}
if ($diagnoseRaw -notmatch 'reportSourcePath') {
    Write-Host 'orchestrator-diagnose.ps1 must print reportSourcePath for hand-off verdicts'
    exit 1
}

$rulesRaw = Get-Content -LiteralPath $scriptOwnedDoc -Raw
if ($rulesRaw -notlike '*Review-status reader contract*' -or
    $rulesRaw -notlike '*Get-AoStatusSessionsWithReports*') {
    Write-Host 'docs/script-owned-review-pipeline.md missing review-status reader contract section'
    exit 1
}

Write-Host 'check-review-status-consumers: PASS'
exit 0
