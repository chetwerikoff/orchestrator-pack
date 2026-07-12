#requires -Version 5.1
<#
.SYNOPSIS
  Static call-site coverage for wake-supervisor repo-tick snapshot consumers (Issue #583 AC#7).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$ExpectedCoverage = @(
    @{ id = 'ci-failure-notification-reconcile'; classification = 'repo-tick snapshot'; helpers = @('Invoke-GhOpenPrList', 'Get-GhChecksBundleByPr') }
    @{ id = 'ci-green-wake-reconcile'; classification = 'repo-tick snapshot'; helpers = @('Invoke-GhOpenPrList', 'Get-GhChecksBundleByPr') }
    @{ id = 'review-trigger-reconcile'; classification = 'repo-tick snapshot'; helpers = @('Invoke-GhOpenPrList', 'Get-ReconcileChecksByPr') }
    @{ id = 'review-trigger-reeval'; classification = 'repo-tick snapshot'; helpers = @('Invoke-GhOpenPrList', 'Get-ReviewTriggerReevalChecksByPr') }
    @{ id = 'review-ready-report-state-seed'; classification = 'repo-tick snapshot'; helpers = @('Get-GhFleetRepoTickSnapshotIfConsumable', 'Resolve-ReviewReadyReportStateSeedOpenPrs', 'Get-GhChecksBundleByPr', 'Invoke-ReviewStartScopedGhPrView') }
    @{ id = 'listener'; classification = 'out of coverage'; helpers = @() }
    @{ id = 'heartbeat'; classification = 'out of coverage'; helpers = @() }
    @{ id = 'worker-message-submit-reconcile'; classification = 'out of coverage'; helpers = @() }
    @{ id = 'review-start-claim-reaper'; classification = 'out of coverage'; helpers = @() }
)

$ChildScriptMap = @{
    'ci-failure-notification-reconcile' = 'ci-failure-notification-reconcile.ps1'
    'ci-green-wake-reconcile'           = 'ci-green-wake-reconcile.ps1'
    'review-trigger-reconcile'          = 'review-trigger-reconcile.ps1'
    'review-trigger-reeval'             = 'review-trigger-reeval.ps1'
    'review-ready-report-state-seed'    = 'review-ready-report-state-seed.ps1'
    'listener'                          = 'orchestrator-wake-listener.ps1'
    'heartbeat'                         = 'orchestrator-wake-heartbeat.ps1'
    'worker-message-submit-reconcile'   = 'worker-message-submit-reconcile.ps1'
    'review-start-claim-reaper'         = 'review-start-claim-reaper.ps1'
}

$LibScriptMap = @{
    'review-ready-report-state-seed' = 'lib/Invoke-ReviewReadyReportStateSeed.ps1'
}

function Test-RepoTickCoverageContent {
    param(
        [string]$Content,
        [string[]]$Helpers,
        [string]$ChildId
    )

    $matched = $false
    foreach ($helper in $Helpers) {
        if ($Content -match [regex]::Escape($helper)) {
            $matched = $true
            break
        }
    }
    if (-not $matched -and $Content -match 'Gh-PrChecks\.ps1|Invoke-GhOpenPrList|Get-OpenPrList') {
        $matched = $true
    }
    if (-not $matched) {
        return "must reference cached fleet inventory helpers ($($Helpers -join ', '))"
    }
    if ($Content -match '(^|[^a-zA-Z])gh\s+pr\s+list' -and $Content -notmatch 'Invoke-GhOpenPrList|Invoke-GhOpenPrListForNumbers|Get-OpenPrList') {
        return 'must not call bare gh pr list outside cached helpers'
    }
    return $null
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
        $combined = $content
        if ($LibScriptMap.ContainsKey($id)) {
            $libPath = Join-Path $Root "scripts/$($LibScriptMap[$id])"
            if (-not (Test-Path -LiteralPath $libPath -PathType Leaf)) {
                $violations += "missing lib script for ${id}: $libPath"
                continue
            }
            $combined += "`n" + (Get-Content -LiteralPath $libPath -Raw)
        }
        $issue = Test-RepoTickCoverageContent -Content $combined -Helpers $row.helpers -ChildId $id
        if ($issue) {
            $violations += "$id $issue"
        }
        if ($id -eq 'review-ready-report-state-seed') {
            $libContent = Get-Content -LiteralPath (Join-Path $Root "scripts/$($LibScriptMap[$id])") -Raw
            if ($libContent -notmatch 'function New-ReviewReadyReportStateSeedGitHubSnapshot[\s\S]*Resolve-ReviewReadyReportStateSeedOpenPrs') {
                $violations += 'review-ready-report-state-seed background snapshot must consume repo-tick when warm before scoped reads'
            }
            if ($libContent -notmatch 'Invoke-ReviewStartScopedGhPrView') {
                $violations += 'review-ready-report-state-seed must preserve fresh pre-claim scoped pr view'
            }
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
elseif ((Get-Content -LiteralPath $repoTickPath -Raw) -notmatch 'function Get-GhFleetRepoTickSnapshotIfConsumable') {
    $violations += 'repo-tick snapshot API missing Get-GhFleetRepoTickSnapshotIfConsumable'
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] github fleet repo-tick coverage (Issue #583 AC#7):'
    $violations | ForEach-Object { Write-Host $_ }
    exit 1
}

Write-Host '[PASS] github fleet repo-tick coverage (Issue #583 AC#7)'
exit 0
