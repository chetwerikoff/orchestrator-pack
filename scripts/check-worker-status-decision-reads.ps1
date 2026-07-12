#requires -Version 5.1
<#
.SYNOPSIS
  Guard: fleet reconcilers must not bind daemon composite for status decisions (Issue #720).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$consumers = @{
    'scripts/review-trigger-reconcile.ps1'              = 'Get-WorkerStatusDecisionSessions'
    'scripts/review-trigger-reeval.ps1'                   = 'Get-WorkerStatusDecisionSessions'
    'scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1'  = 'Get-WorkerStatusDecisionSessionsIncludingTerminated'
    'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1'      = 'Get-WorkerStatusDecisionSessions'
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1'            = 'Get-WorkerStatusDecisionSessions'
    'scripts/ci-green-wake-reconcile.ps1'                 = 'Get-WorkerStatusDecisionSessions'
    'scripts/worker-message-submit-reconcile.ps1'         = 'Get-WorkerStatusDecisionSessions'
    'scripts/dead-worker-reconcile.ps1'                   = 'Get-WorkerStatusDecisionSessionsIncludingTerminated'
    'scripts/orchestrator-diagnose.ps1'                   = 'Get-WorkerStatusDecisionSessions'
}

foreach ($rel in $consumers.Keys) {
    $path = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing consumer: $rel"
        exit 1
    }
    $raw = Get-Content -LiteralPath $path -Raw
    $needle = $consumers[$rel]
    if ($raw -notmatch [regex]::Escape($needle)) {
        Write-Host "$rel must call $needle for status decisions (Issue #720)"
        exit 1
    }
    if ($raw -match 'Get-AoStatusSessionsWithReports') {
        Write-Host "$rel must not call Get-AoStatusSessionsWithReports for status decisions (Issue #720)"
        exit 1
    }
}

$contractPath = Join-Path $Root 'docs/review-producer-contract.mjs'
$contractRaw = Get-Content -LiteralPath $contractPath -Raw
if ($contractRaw -notmatch 'REMOVED_DECISION_STATUS_SURFACES') {
    Write-Host 'review-producer-contract.mjs must define REMOVED_DECISION_STATUS_SURFACES'
    exit 1
}
if ($contractRaw -notmatch 'assertNoDaemonStatusDecisionRead') {
    Write-Host 'review-producer-contract.mjs must define assertNoDaemonStatusDecisionRead'
    exit 1
}

Write-Host 'check-worker-status-decision-reads: PASS'
exit 0
