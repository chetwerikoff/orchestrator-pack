#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: per-tier PR review-cycle cap wiring (Issue #646).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$required = @(
    'docs/review-cycle-cap.mjs',
    'scripts/lib/Review-CycleCap.ps1',
    'scripts/review-cycle-cap.test.ts'
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
if ($capMjs -notmatch 'evaluateReviewCycleCapGate') {
    Write-Host 'review-cycle-cap.mjs missing evaluateReviewCycleCapGate'
    exit 1
}

$capPs = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Review-CycleCap.ps1') -Raw
if ($capPs -match '\bao\s+review\s+list\b') {
    Write-Host 'Review-CycleCap.ps1 must not shell out to ao review list'
    exit 1
}
if ($capPs -notmatch 'review-cycle-cap\.mjs') {
    Write-Host 'Review-CycleCap.ps1 must route through review-cycle-cap.mjs'
    exit 1
}
if ($capPs -notmatch 'Get-ReviewCycleCapIssueBody') {
    Write-Host 'Review-CycleCap.ps1 missing Get-ReviewCycleCapIssueBody helper'
    exit 1
}
if ($capPs -notmatch 'Get-ReviewCycleCapIssueBodiesByPr') {
    Write-Host 'Review-CycleCap.ps1 missing Get-ReviewCycleCapIssueBodiesByPr helper'
    exit 1
}
if ($capPs -match '\$env:AO_ISSUE_NUMBER[\s\S]*Get-IssueNumberFromPrDiff') {
    Write-Host 'Get-ReviewCycleCapIssueBody must resolve per-PR issue via Get-IssueNumberFromPrDiff before AO_ISSUE_NUMBER'
    exit 1
}
if ($capPs -notmatch 'Get-ReviewCycleCapWorkerPrNumber') {
    Write-Host 'Review-CycleCap.ps1 must scope AO_ISSUE_NUMBER to the active worker PR'
    exit 1
}
if ($capPs -notmatch 'workerPr -gt 0 -and \$workerPr -eq \$PrNumber') {
    Write-Host 'Get-ReviewCycleCapIssueBody must apply AO_ISSUE_NUMBER only when worker PR matches'
    exit 1
}
if ($capMjs -notmatch 'cleanEntry\.targetSha === currentHeadSha') {
    Write-Host 'review-cycle-cap.mjs must only inherit clean_early_stop merge eligibility on the current head'
    exit 1
}
if ($capMjs -notmatch 'if \(!prState\.tierFrozen\)') {
    Write-Host 'review-cycle-cap.mjs must freeze tier at review-cycle start before completed runs exist'
    exit 1
}

$claimedRunPs = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1') -Raw
if ($claimedRunPs -notmatch 'Get-ReviewCycleCapIssueBody') {
    Write-Host 'Invoke-OrchestratorClaimedReviewRun.ps1 must pass issue tier data via Get-ReviewCycleCapIssueBody'
    exit 1
}
if ($claimedRunPs -notmatch 'issueBody') {
    Write-Host 'Invoke-OrchestratorClaimedReviewRun.ps1 must pass issueBody into cap gate payload'
    exit 1
}

$reconcilePs = Get-Content -LiteralPath (Join-Path $Root 'scripts/review-trigger-reconcile.ps1') -Raw
if ($reconcilePs -notmatch 'Get-ReviewCycleCapIssueBodiesByPr') {
    Write-Host 'review-trigger-reconcile.ps1 must pass issue tier data via Get-ReviewCycleCapIssueBodiesByPr'
    exit 1
}
if ($reconcilePs -notmatch 'issueBodiesByPr') {
    Write-Host 'review-trigger-reconcile.ps1 must pass issueBodiesByPr into cap gate payload'
    exit 1
}

$reevalPs = Get-Content -LiteralPath (Join-Path $Root 'scripts/review-trigger-reeval.ps1') -Raw
if ($reevalPs -notmatch 'Get-ReviewCycleCapIssueBodiesByPr') {
    Write-Host 'review-trigger-reeval.ps1 must pass issue tier data via Get-ReviewCycleCapIssueBodiesByPr'
    exit 1
}
if ($reevalPs -notmatch 'issueBodiesByPr') {
    Write-Host 'review-trigger-reeval.ps1 must pass issueBodiesByPr into cap gate payload'
    exit 1
}

$wakePs = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Invoke-ReviewWakeTrigger.ps1') -Raw
if ($wakePs -notmatch 'Get-ReviewCycleCapIssueBody') {
    Write-Host 'Invoke-ReviewWakeTrigger.ps1 must pass issue tier data via Get-ReviewCycleCapIssueBody'
    exit 1
}
if ($wakePs -notmatch 'issueBody') {
    Write-Host 'Invoke-ReviewWakeTrigger.ps1 must pass issueBody into cap gate payload'
    exit 1
}

$integrationScripts = @{
    'docs/review-trigger-reconcile.mjs'      = 'evaluateReviewCycleCapGate'
    'docs/orchestrator-claimed-review-run.mjs' = 'evaluateReviewCycleCapGate'
    'docs/review-wake-trigger.mjs'           = 'evaluateReviewCycleCapGate'
    'docs/review-trigger-reeval.mjs'         = 'evaluateReviewCycleCapGate'
    'scripts/review-trigger-reconcile.ps1'   = 'Review-CycleCap.ps1'
    'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1' = 'Review-CycleCap.ps1'
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1' = 'Review-CycleCap.ps1'
    'scripts/review-trigger-reeval.ps1'      = 'Review-CycleCap.ps1'
}

foreach ($rel in $integrationScripts.Keys) {
    $needle = $integrationScripts[$rel]
    $raw = Get-Content -LiteralPath (Join-Path $Root $rel) -Raw
    if ($raw -notmatch [regex]::Escape($needle)) {
        Write-Host "$rel must reference $needle (Issue #646)"
        exit 1
    }
}

$exampleYaml = Get-Content -LiteralPath (Join-Path $Root 'agent-orchestrator.yaml.example') -Raw
if ($exampleYaml -match 'ROUND LIMIT' -and $exampleYaml -notmatch 'tier-cap|clean_early_stop|distinct-head') {
    Write-Host 'agent-orchestrator.yaml.example still uses flat ROUND LIMIT without tier-cap replacement'
    exit 1
}
if ($exampleYaml -notmatch 'clean_early_stop|first clean') {
    Write-Host 'agent-orchestrator.yaml.example missing early-stop prose'
    exit 1
}
if ($exampleYaml -notmatch 'T1.*2|T2.*4|T3.*8|distinct-head') {
    Write-Host 'agent-orchestrator.yaml.example missing tier-keyed distinct-head cap prose'
    exit 1
}

$agentRules = Get-Content -LiteralPath (Join-Path $Root 'prompts/agent_rules.md') -Raw
if ($agentRules -notlike '*review-cycle-cap*' -and $agentRules -notlike '*review cycle cap*') {
    Write-Host 'prompts/agent_rules.md missing review-cycle-cap pointer'
    exit 1
}

Write-Host 'check-review-cycle-cap: PASS'
exit 0
