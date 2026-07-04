#requires -Version 5.1
<#
.SYNOPSIS
  Static call-site coverage for wake-supervisor repo-tick snapshot consumers (Issue #583 AC#7).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$ExpectedCoverage = @(
    @{ id = 'ci-failure-notification-reconcile'; classification = 'repo-tick snapshot'; helpers = @('Invoke-GhOpenPrList', 'Get-GhChecksBundleByPr') }
    @{ id = 'ci-failure-notification-reaction'; classification = 'repo-tick snapshot'; helpers = @('Invoke-GhOpenPrList') }
    @{ id = 'ci-green-wake-reconcile'; classification = 'repo-tick snapshot'; helpers = @('Invoke-GhOpenPrList', 'Get-GhChecksBundleByPr') }
    @{ id = 'review-send-reconcile'; classification = 'repo-tick snapshot'; helpers = @('Invoke-GhOpenPrList') }
    @{ id = 'review-finding-delivery-confirm'; classification = 'repo-tick snapshot'; helpers = @('Invoke-GhOpenPrListForNumbers') }
    @{ id = 'review-trigger-reconcile'; classification = 'repo-tick snapshot'; helpers = @('Invoke-GhOpenPrList', 'Get-ReconcileChecksByPr') }
    @{ id = 'review-trigger-reeval'; classification = 'repo-tick snapshot'; helpers = @('Invoke-GhOpenPrList', 'Get-ReviewTriggerReevalChecksByPr') }
    @{ id = 'listener'; classification = 'out of coverage'; helpers = @() }
    @{ id = 'heartbeat'; classification = 'out of coverage'; helpers = @() }
    @{ id = 'review-run-recovery'; classification = 'out of coverage'; helpers = @() }
    @{ id = 'worker-message-submit-reconcile'; classification = 'out of coverage'; helpers = @() }
    @{ id = 'review-ready-report-state-seed'; classification = 'out of coverage'; helpers = @() }
    @{ id = 'review-start-claim-reaper'; classification = 'out of coverage'; helpers = @() }
)

$ChildScriptMap = @{
    'ci-failure-notification-reconcile' = 'ci-failure-notification-reconcile.ps1'
    'ci-failure-notification-reaction'  = 'ci-failure-notification-reaction.ps1'
    'ci-green-wake-reconcile'           = 'ci-green-wake-reconcile.ps1'
    'review-send-reconcile'             = 'review-send-reconcile.ps1'
    'review-finding-delivery-confirm'   = 'review-finding-delivery-confirm.ps1'
    'review-trigger-reconcile'          = 'review-trigger-reconcile.ps1'
    'review-trigger-reeval'             = 'review-trigger-reeval.ps1'
    'listener'                          = 'orchestrator-wake-listener.ps1'
    'heartbeat'                         = 'orchestrator-wake-heartbeat.ps1'
    'review-run-recovery'               = 'review-run-recovery.ps1'
    'worker-message-submit-reconcile'   = 'worker-message-submit-reconcile.ps1'
    'review-ready-report-state-seed'    = 'review-ready-report-state-seed.ps1'
    'review-start-claim-reaper'         = 'review-start-claim-reaper.ps1'
}

$violations = @()
foreach ($row in $ExpectedCoverage) {
    $id = [string]$row.id
    $scriptName = $ChildScriptMap[$id]
    if (-not $scriptName) {
        $violations += "missing script map for child $id"
        continue
    }
    $scriptPath = Join-Path $Root "scripts/$scriptName"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        $violations += "missing child script for ${id}: $scriptPath"
        continue
    }
    $content = Get-Content -LiteralPath $scriptPath -Raw
    if ($row.classification -eq 'repo-tick snapshot') {
        $matched = $false
        foreach ($helper in $row.helpers) {
            if ($content -match [regex]::Escape($helper)) {
                $matched = $true
                break
            }
        }
        if (-not $matched -and $content -match 'Gh-PrChecks\.ps1|Invoke-GhOpenPrList|Get-OpenPrList') {
            $matched = $true
        }
        if (-not $matched) {
            $violations += "$id must reference cached fleet inventory helpers ($($row.helpers -join ', '))"
        }
        if ($content -match '(^|[^a-zA-Z])gh\s+pr\s+list' -and $content -notmatch 'Invoke-GhOpenPrList|Invoke-GhOpenPrListForNumbers|Get-OpenPrList') {
            $violations += "$id must not call bare gh pr list outside cached helpers"
        }
    }
}

$repoTickPath = Join-Path $Root 'scripts/lib/Gh-FleetRepoTickSnapshot.ps1'
if (-not (Test-Path -LiteralPath $repoTickPath -PathType Leaf)) {
    $violations += 'missing Gh-FleetRepoTickSnapshot.ps1'
}
elseif ((Get-Content -LiteralPath $repoTickPath -Raw) -notmatch 'function Ensure-GhFleetRepoTickSnapshot') {
    $violations += 'repo-tick snapshot API missing Ensure-GhFleetRepoTickSnapshot'
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] github fleet repo-tick coverage (Issue #583 AC#7):'
    $violations | ForEach-Object { Write-Host $_ }
    exit 1
}

Write-Host '[PASS] github fleet repo-tick coverage (Issue #583 AC#7)'
exit 0
