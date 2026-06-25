#requires -Version 5.1
<#
.SYNOPSIS
  Static guard: pack-owned PowerShell reconcile scripts use inventory-covered gh read shapes (Issue #431).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Test-InventoryGhReadLine {
    param([string]$Line)

    if ($Line -match '^\s*#' ) { return $true }
    if ($Line -notmatch '(^|[^a-zA-Z])gh\s+(pr|issue|repo)\s+') { return $true }
    if ($Line -match 'gh pr (merge|comment|create|close|edit|review)') { return $true }
    if ($Line -match 'throw\s+"gh |Write-Error\s+"gh |WarningTemplate\s*=\s*''warn: gh ') { return $true }
    if ($Line -match 'SYNOPSIS|Shared gh pr list') { return $true }

    $inventory = @(
        'gh pr list --state open --json number,headRefOid',
        'gh pr list --state open --json number,headRefOid,baseRefName',
        'gh pr view .+--json (number,headRefOid,baseRefName,state|baseRefName|body|number,body)',
        'gh pr view .+--json body',
        'gh pr checks .+--json name,state,bucket,link,startedAt,completedAt,workflow,description',
        'gh pr diff .+--name-only',
        'gh issue view .+--json body',
        'gh repo view --json nameWithOwner',
        'gh pr list --head',
        'gh pr list --head .+--json number,url --limit 1',
        'gh pr view .+--json ''number,body''',
        'gh pr view .+--jq'
    )

    foreach ($pattern in $inventory) {
        if ($Line -match $pattern) {
            return $true
        }
    }

    return $false
}

$scanRoots = @(
    (Join-Path $Root 'scripts/lib/Gh-PrChecks.ps1'),
    (Join-Path $Root 'scripts/pr-scope-check.ps1'),
    (Join-Path $Root 'scripts/lib/Get-AutoReviewPrContext.ps1'),
)

$violations = @()
foreach ($file in $scanRoots) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        continue
    }
    $lines = Get-Content -LiteralPath $file
    foreach ($line in $lines) {
        if (-not (Test-InventoryGhReadLine -Line $line)) {
            $violations += "${file}: $line"
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] non-inventory gh read shapes in pack reconcile scripts:'
    $violations | ForEach-Object { Write-Host $_ }
    exit 1
}

Write-Host '[PASS] pack-owned gh inventory static guard (Issue #431)'
exit 0
