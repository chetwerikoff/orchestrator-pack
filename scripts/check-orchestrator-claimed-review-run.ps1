#requires -Version 5.1
<#
  Scoped PR lookup regression guard (Issue #557), retained after Issue #821 retired
  the process-boundary wrapper wiring that previously shared this file.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Autonomous-GateCommon.ps1')
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = Resolve-PackGateRepoRoot -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot

$snapshotPath = Join-Path $RepoRoot 'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1'
$snapshotText = Get-Content -LiteralPath $snapshotPath -Raw
if ($snapshotText -match '(?<!ForNumbers)Invoke-GhOpenPrList\b') {
    Write-Host 'Get-ClaimedReviewStartSnapshot must not call full Invoke-GhOpenPrList when PrNumber is known (#557)'
    exit 1
}
if ($snapshotText -match "'pr',\s*'list'|gh pr list --state open") {
    Write-Host 'Get-ClaimedReviewStartSnapshot must use scoped PR lookup, not full open-PR list (#557)'
    exit 1
}
if ($snapshotText -notmatch 'Invoke-ReviewStartScopedGhPrView|Invoke-GhOpenPrListForNumbers' -or $snapshotText -notmatch "'pr',\s*'view'|Invoke-GhPrViewStructuredCapture|Invoke-ReviewStartPreflightGhPrView") {
    Write-Host 'Get-ClaimedReviewStartSnapshot must resolve known PR numbers via scoped stderr-safe lookup (#557/#566)'
    exit 1
}

Write-Host '[PASS] scoped claimed-review PR lookup regression'
exit 0
