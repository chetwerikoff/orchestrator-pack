#requires -Version 5.1
<#
  Wiring guard for review-start claim ↔ AO run lifecycle binding (Issue #521).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$paths = @(
    'docs/review-start-claim-run-binding.mjs',
    'scripts/lib/Review-StartClaimRunBinding.ps1',
    'scripts/review-start-claim-run-binding.test.ts',
    'tests/external-output-references/review-start-claim-run-binding/pr-519-incident-redacted.json'
)
foreach ($rel in $paths) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $rel))) {
        Write-Host "missing required binding artifact: $rel"
        exit 1
    }
}

$invokeClaimed = Join-Path $RepoRoot 'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1'
$reconcile = Join-Path $RepoRoot 'scripts/review-trigger-reconcile.ps1'
$lifecycle = Join-Path $RepoRoot 'docs/review-start-claim-lifecycle.mjs'
foreach ($pair in @(
    @{ Path = $invokeClaimed; Pattern = 'Confirm-ReviewStartClaimRunBindingLaunch' },
    @{ Path = $reconcile; Pattern = 'Confirm-ReviewStartClaimRunBindingLaunch' },
    @{ Path = $lifecycle; Pattern = 'review-start-claim-run-binding.mjs' }
)) {
  $text = Get-Content -LiteralPath $pair.Path -Raw
  if ($text -notmatch [regex]::Escape($pair.Pattern)) {
    Write-Host "$($pair.Path) missing binding integration: $($pair.Pattern)"
    exit 1
  }
}

Write-Host '[PASS] review-start claim run binding wiring'
exit 0
