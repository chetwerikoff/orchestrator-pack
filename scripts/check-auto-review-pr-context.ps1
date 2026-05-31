#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: detached-HEAD PR context uses headRefOid, not bare gh pr view (Issue #98).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$contextScript = Join-Path $Root 'scripts/lib/Get-AutoReviewPrContext.ps1'
$text = Get-Content -LiteralPath $contextScript -Raw

$required = @(
    'Get-GhPrNumberForHeadSha',
    'headRefOid',
    'Never call bare',
    'gh pr view'
)

$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($missing.Count -gt 0) {
    Write-Host ("Get-AutoReviewPrContext.ps1 missing detached-HEAD phrases: {0}" -f ($missing -join ', '))
    exit 1
}

if ($text -match 'function Get-GhPrNumberForHead\b') {
    Write-Host '[FAIL] legacy Get-GhPrNumberForHead must be replaced by headRefOid lookup'
    exit 1
}

Write-Host '[PASS] Get-AutoReviewPrContext.ps1 supports detached-HEAD PR resolution'
exit 0
