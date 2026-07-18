#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: per-tier PR review-cycle cap runtime wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$required = @(
    'docs/review-cycle-cap.mjs',
    'scripts/lib/Review-CycleCap.ps1',
    'scripts/review-cycle-cap.test.ts',
    'scripts/review-trigger-reconcile.ps1',
    'scripts/review-trigger-reeval.ps1',
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1'
)
foreach ($rel in $required) {
    $path = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $rel"
        exit 1
    }
}

$capMjs = Get-Content -LiteralPath (Join-Path $Root 'docs/review-cycle-cap.mjs') -Raw
if ($capMjs -match '\bao\s+review\s+list\b') {
    Write-Host 'review-cycle-cap.mjs must not shell out to ao review list'
    exit 1
}
foreach ($marker in @(
        'evaluateReviewCycleCapGate',
        'cleanEntry.targetSha === currentHeadSha',
        'if (!prState.tierFrozen)'
    )) {
    if ($capMjs -notmatch [regex]::Escape($marker)) {
        Write-Host "review-cycle-cap.mjs missing runtime marker: $marker"
        exit 1
    }
}

$capPs = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Review-CycleCap.ps1') -Raw
if ($capPs -match '\bao\s+review\s+list\b') {
    Write-Host 'Review-CycleCap.ps1 must not shell out to ao review list'
    exit 1
}
foreach ($marker in @(
        'review-cycle-cap.mjs',
        'Get-ReviewCycleCapIssueBody',
        'Get-ReviewCycleCapIssueBodiesByPr',
        'Get-ReviewCycleCapWorkerPrNumber',
        'workerPr -gt 0 -and $workerPr -eq $PrNumber'
    )) {
    if ($capPs -notmatch [regex]::Escape($marker)) {
        Write-Host "Review-CycleCap.ps1 missing runtime marker: $marker"
        exit 1
    }
}
if ($capPs -match '\$env:AO_ISSUE_NUMBER[\s\S]*Get-IssueNumberFromPrDiff') {
    Write-Host 'Get-ReviewCycleCapIssueBody must resolve per-PR issue before AO_ISSUE_NUMBER'
    exit 1
}

$integrationScripts = @{
    'docs/review-trigger-reconcile.mjs'        = 'evaluateReviewCycleCapGate'
    'docs/orchestrator-claimed-review-run.mjs' = 'evaluateReviewCycleCapGate'
    'docs/review-wake-trigger.mjs'             = 'evaluateReviewCycleCapGate'
    'docs/review-trigger-reeval.mjs'           = 'evaluateReviewCycleCapGate'
    'scripts/review-trigger-reconcile.ps1'     = 'Review-CycleCap.ps1'
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1' = 'Review-CycleCap.ps1'
    'scripts/review-trigger-reeval.ps1'        = 'Review-CycleCap.ps1'
}
foreach ($rel in $integrationScripts.Keys) {
    $needle = $integrationScripts[$rel]
    $raw = Get-Content -LiteralPath (Join-Path $Root $rel) -Raw
    if ($raw -notmatch [regex]::Escape($needle)) {
        Write-Host "$rel must reference $needle"
        exit 1
    }
}

$reconcilePs = Get-Content -LiteralPath (Join-Path $Root 'scripts/review-trigger-reconcile.ps1') -Raw
if ($reconcilePs -notmatch 'Get-ReviewCycleCapIssueBodiesByPr' -or $reconcilePs -notmatch 'issueBodiesByPr') {
    Write-Host 'review-trigger-reconcile.ps1 must pass per-PR issue tier data into the cap gate'
    exit 1
}
$reevalPs = Get-Content -LiteralPath (Join-Path $Root 'scripts/review-trigger-reeval.ps1') -Raw
if ($reevalPs -notmatch 'Get-ReviewCycleCapIssueBodiesByPr' -or $reevalPs -notmatch 'issueBodiesByPr') {
    Write-Host 'review-trigger-reeval.ps1 must pass per-PR issue tier data into the cap gate'
    exit 1
}
$wakePs = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Invoke-ReviewWakeTrigger.ps1') -Raw
if ($wakePs -notmatch 'Get-ReviewCycleCapIssueBody' -or $wakePs -notmatch 'issueBody') {
    Write-Host 'Invoke-ReviewWakeTrigger.ps1 must pass issue tier data into the cap gate'
    exit 1
}

Write-Host '[PASS] review-cycle cap runtime wiring'
exit 0
