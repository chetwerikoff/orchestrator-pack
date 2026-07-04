#requires -Version 5.1
<#
.SYNOPSIS
  Registry-aware guard: supervised fleet inventory reads route through cached helpers (Issues #453, #553, #569).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$Script:AffectedWakeChildIds = @(
    'review-trigger-reconcile',
    'ci-green-wake-reconcile',
    'review-send-reconcile',
    'review-finding-delivery-confirm',
    'ci-failure-notification-reconcile',
    'ci-failure-notification-reaction'
)

$Script:AffectedChildHelperLibs = @(
    'scripts/lib/Gh-PrChecks.ps1',
    'scripts/lib/Get-ReconcileChecksByPr.ps1',
    'scripts/lib/Ci-Failure-Notification-Common.ps1',
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1'
)

$Script:AllowedUpstreamFetchFunctions = @(
    'Invoke-GhFleetFetchOpenPrListUpstream',
    'Invoke-GhFleetFetchPrViewUpstream',
    'Invoke-GhFleetFetchChecksUpstream',
    'Invoke-GhFleetFetchBranchProtectionUpstream',
    'Invoke-GhFleetFetchPrListByHeadUpstream',
    'Invoke-GhFleetFetchReviewFreshnessUpstream',
    'Invoke-GhFleetFetchCommitDateUpstream'
)

$Script:AllowedDirectGhPaths = @(
    'scripts/lib/Gh-FleetInventoryCache.ps1',
    'scripts/lib/Gh-FleetRepoTickSnapshot.ps1',
    'scripts/lib/Get-AutoReviewPrContext.ps1',
    'scripts/check-gh-inventory-static.ps1',
    'scripts/check-github-fleet-cache-bypass.ps1',
    'scripts/check-review-finding-delivery-confirm.ps1',
    'scripts/check-review-trigger-reconcile.ps1',
    'scripts/check-review-wake-trigger.ps1',
    'scripts/pr-scope-check.ps1',
    'scripts/lib/Autonomous-SpawnWorktreeGate.ps1'
)

function Test-GhFleetBypassLine {
    param(
        [string]$Line,
        [string]$FilePath,
        [string]$Pattern,
        [string[]]$CommentAllowPatterns = @()
    )

    if ($Line -match '^\s*#') { return $true }
    if ($Line -notmatch $Pattern) { return $true }
    foreach ($allow in $CommentAllowPatterns) {
        if ($Line -match $allow) { return $true }
    }
    if ($Line -match 'SYNOPSIS|Shared gh pr list') { return $true }

    $rel = $FilePath.Substring($Root.Length).TrimStart('\').TrimStart('/')
    foreach ($path in $Script:AllowedDirectGhPaths) {
        if ($rel -eq $path) {
            return $true
        }
    }

    return $false
}

function Test-OpenPrListBypassLine {
    param(
        [string]$Line,
        [string]$FilePath
    )

    return Test-GhFleetBypassLine -Line $Line -FilePath $FilePath -Pattern '(^|[^a-zA-Z])gh\s+pr\s+list' -CommentAllowPatterns @(
        '-match\s+.+gh pr list|gh pr list failed|snapshot_populate_failed|child_list_bypass|must gate gh pr list|must fail tick when gh pr list',
        'gh pr list --head'
    )
}

function Test-PrViewBypassLine {
    param(
        [string]$Line,
        [string]$FilePath
    )

    return Test-GhFleetBypassLine -Line $Line -FilePath $FilePath -Pattern '(^|[^a-zA-Z])gh\s+pr\s+view' -CommentAllowPatterns @(
        'child_view_bypass|Never call bare `gh pr view`|detached-HEAD PR context uses headRefOid'
    )
}

function Test-PrChecksBypassLine {
    param(
        [string]$Line,
        [string]$FilePath
    )

    return Test-GhFleetBypassLine -Line $Line -FilePath $FilePath -Pattern '(^|[^a-zA-Z])gh\s+pr\s+checks' -CommentAllowPatterns @(
        'child_checks_bypass|gh pr checks PR'
    )
}

function Test-BranchProtectionBypassLine {
    param(
        [string]$Line,
        [string]$FilePath
    )

    return Test-GhFleetBypassLine -Line $Line -FilePath $FilePath -Pattern 'gh\s+api\s+.+branches/.+/protection' -CommentAllowPatterns @(
        'child_protection_bypass|branch protection lookup failed'
    )
}

$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
    Write-Host '[FAIL] missing orchestrator-side-process-registry.json'
    exit 1
}

$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$scanFiles = @()
foreach ($helper in $Script:AffectedChildHelperLibs) {
    $scanFiles += (Join-Path $Root $helper)
}
foreach ($child in @($registry.children)) {
    if ($Script:AffectedWakeChildIds -contains [string]$child.id) {
        $scanFiles += (Join-Path $Root "scripts/$($child.script)")
    }
}

$violations = @()
foreach ($file in ($scanFiles | Sort-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        $violations += "missing supervised script: $file"
        continue
    }
    $lines = Get-Content -LiteralPath $file
    foreach ($line in $lines) {
        if (-not (Test-OpenPrListBypassLine -Line $line -FilePath $file)) {
            $violations += "${file}: open-pr list bypass: $line"
        }
        if (-not (Test-PrViewBypassLine -Line $line -FilePath $file)) {
            $violations += "${file}: pr view bypass: $line"
        }
        if (-not (Test-PrChecksBypassLine -Line $line -FilePath $file)) {
            $violations += "${file}: pr checks bypass: $line"
        }
        if (-not (Test-BranchProtectionBypassLine -Line $line -FilePath $file)) {
            $violations += "${file}: branch protection bypass: $line"
        }
    }
}

foreach ($child in @($registry.children)) {
    if ($Script:AffectedWakeChildIds -notcontains [string]$child.id) {
        continue
    }
    $scriptPath = Join-Path $Root "scripts/$($child.script)"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        continue
    }
    $content = Get-Content -LiteralPath $scriptPath -Raw
    if ($content -match 'gh\s+pr\s+list\s+--state\s+open' -and $content -notmatch 'Invoke-GhOpenPrList') {
        $violations += "${scriptPath}: affected child must route open-PR inventory through Invoke-GhOpenPrList"
    }
    foreach ($upstream in $Script:AllowedUpstreamFetchFunctions) {
        if ($content -match $upstream) {
            $violations += "${scriptPath}: affected child must not call shared snapshot producer upstream helper $upstream"
        }
    }
}

$cachePath = Join-Path $Root 'scripts/lib/Gh-FleetInventoryCache.ps1'
$cacheContent = Get-Content -LiteralPath $cachePath -Raw
if ($cacheContent -match 'open_pr_list_failthrough') {
    $violations += "${cachePath}: must not fail through to upstream open-PR list (Issue #553)"
}

if ($cacheContent -notmatch 'function Invoke-GhFleetCachedPrView') {
    $violations += "${cachePath}: must extend shared read model with cached PR view (Issue #569)"
}
if ($cacheContent -notmatch 'function Invoke-GhFleetCachedChecksByHeadSha') {
    $violations += "${cachePath}: must extend shared read model with cached CI checks (Issue #569)"
}
if ($cacheContent -notmatch 'function Invoke-GhFleetCachedBranchProtection') {
    $violations += "${cachePath}: must extend shared read model with cached branch protection (Issue #569)"
}

if ($cacheContent -match 'token bucket|TokenBucket|cooperative backoff|circuit breaker.*fleet|fake.success') {
    $violations += "${cachePath}: must not add hard-gate creep (Issue #569 AC#14)"
}

Get-ChildItem -LiteralPath (Join-Path $Root 'scripts') -Recurse -File -Filter '*.ps1' |
    Where-Object {
        $_.FullName -notlike '*Gh-FleetInventoryCache.ps1' -and
        $_.FullName -notlike '*Gh-FleetRepoTickSnapshot.ps1' -and
        $_.Name -notlike 'check-*.ps1'
    } |
    ForEach-Object {
        $content = Get-Content -LiteralPath $_.FullName -Raw
        foreach ($upstream in $Script:AllowedUpstreamFetchFunctions) {
            if ($content -match $upstream) {
                $violations += "$($_.FullName): only Gh-FleetInventoryCache.ps1 may call $upstream"
            }
        }
    }

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] github fleet cache bypass guard (Issues #453/#553/#569):'
    $violations | ForEach-Object { Write-Host $_ }
    exit 1
}

Write-Host '[PASS] github fleet cache bypass guard (Issues #453/#553/#569)'
exit 0
