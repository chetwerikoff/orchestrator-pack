#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #611 review-status consumers use report-full readers.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$inventory = Join-Path $Root 'docs/review-status-consumer-inventory.md'
$aoCli = Join-Path $Root 'scripts/lib/Invoke-AoCliJson.ps1'
$testFile = Join-Path $Root 'scripts/review-status-consumer.test.ts'
$agentRules = Join-Path $Root 'prompts/agent_rules.md'
$exampleYaml = Join-Path $Root 'agent-orchestrator.yaml.example'
$diagnose = Join-Path $Root 'scripts/orchestrator-diagnose.ps1'

foreach ($path in @($inventory, $aoCli, $testFile, $agentRules, $exampleYaml, $diagnose)) {
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
    'scripts/review-finding-delivery-confirm.ps1'          = 'Get-AoStatusSessionsWithReports'
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
        'function Test-AoReportFullCliAvailable',
        'function Read-AoAgentReportAuditReports',
        'function Format-AoSessionReportSourcePath',
        'function Merge-AoSessionRowsWithReportAudit'
    )) {
    if ($aoCliRaw -notmatch [regex]::Escape($needle)) {
        Write-Host "Invoke-AoCliJson.ps1 missing $needle"
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

$rulesRaw = Get-Content -LiteralPath $agentRules -Raw
if ($rulesRaw -notlike '*Review-status reader contract*' -or
    $rulesRaw -notlike '*Get-AoStatusSessionsWithReports*') {
    Write-Host 'prompts/agent_rules.md missing review-status reader contract section'
    exit 1
}

$exampleRaw = Get-Content -LiteralPath $exampleYaml -Raw
if ($exampleRaw -notmatch '\$\.data\[\]' -or $exampleRaw -notlike '*report-full*') {
    Write-Host 'agent-orchestrator.yaml.example missing $.data[] report-full reader contract prose'
    exit 1
}

Write-Host 'check-review-status-consumers: PASS'
exit 0
