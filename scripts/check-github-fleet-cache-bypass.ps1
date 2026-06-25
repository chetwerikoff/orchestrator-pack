#requires -Version 5.1
<#
.SYNOPSIS
  Registry-aware guard: supervised fleet inventory list reads route through cached helpers (Issue #453).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Test-OpenPrListBypassLine {
    param(
        [string]$Line,
        [string]$FilePath
    )

    if ($Line -match '^\s*#') { return $true }
    if ($Line -notmatch '(^|[^a-zA-Z])gh\s+pr\s+list') { return $true }
    if ($Line -match '-match\s+.+gh pr list|gh pr list failed|must gate gh pr list|must fail tick when gh pr list') { return $true }
    if ($Line -match 'SYNOPSIS|Shared gh pr list') { return $true }
    if ($Line -match 'gh pr list --head') { return $true }

    $rel = $FilePath.Substring($Root.Length).TrimStart('\').TrimStart('/')
    $allowed = @(
        'scripts/lib/Gh-PrChecks.ps1',
        'scripts/lib/Gh-FleetInventoryCache.ps1',
        'scripts/lib/Get-AutoReviewPrContext.ps1',
        'scripts/check-gh-inventory-static.ps1',
        'scripts/check-github-fleet-cache-bypass.ps1',
        'scripts/check-review-finding-delivery-confirm.ps1',
        'scripts/check-review-trigger-reconcile.ps1',
        'scripts/check-review-wake-trigger.ps1'
    )
    foreach ($path in $allowed) {
        if ($rel -eq $path) {
            return $true
        }
    }

    return $false
}

$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
    Write-Host '[FAIL] missing orchestrator-side-process-registry.json'
    exit 1
}

$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$scanFiles = @(
    (Join-Path $Root 'scripts/lib/Invoke-ReviewWakeTrigger.ps1')
)
foreach ($child in @($registry.children)) {
    $scanFiles += (Join-Path $Root "scripts/$($child.script)")
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
            $violations += "${file}: $line"
        }
    }
}

foreach ($child in @($registry.children)) {
    $scriptPath = Join-Path $Root "scripts/$($child.script)"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        continue
    }
    $content = Get-Content -LiteralPath $scriptPath -Raw
    if ($content -match 'gh\s+pr\s+list\s+--state\s+open' -and $content -notmatch 'Invoke-GhOpenPrList') {
        $violations += "${scriptPath}: supervised child must route open-PR inventory through Invoke-GhOpenPrList"
    }
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] github fleet cache bypass guard (Issue #453):'
    $violations | ForEach-Object { Write-Host $_ }
    exit 1
}

Write-Host '[PASS] github fleet cache bypass guard (Issue #453)'
exit 0
