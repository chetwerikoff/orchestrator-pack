#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: AO 0.10 harness review bridge + [Pn] submit contract (Issue #658).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Assert-RequiredPaths.ps1')

$required = @(
    'scripts/harness-review-bridge.ps1',
    'scripts/harness-review-bridge.ts',
    'docs/harness-review-bridge.mjs',
    'prompts/harness_reviewer_submit_contract.md',
    '.cursor/rules/harness-review-bridge.mdc'
)

Assert-RequiredPathsExist -Paths @($required | ForEach-Object { Join-Path $Root $_ })

$bridgePs1 = Get-Content -LiteralPath (Join-Path $Root 'scripts/harness-review-bridge.ps1') -Raw
if ($bridgePs1 -notmatch 'harness-review-bridge\.ts') {
    Write-Host 'harness-review-bridge.ps1 must delegate to harness-review-bridge.ts'
    exit 1
}
if ($bridgePs1 -notmatch 'Resolve-TrustedPackRoot') {
    Write-Host 'harness-review-bridge.ps1 must resolve trusted pack root'
    exit 1
}

$apiLib = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Invoke-AoReviewApi.ps1') -Raw
if ($apiLib -notmatch 'harness-guard') {
    Write-Host 'Invoke-AoReviewApi.ps1 must call harness-guard before POST trigger'
    exit 1
}

$invokePack = Get-Content -LiteralPath (Join-Path $Root 'scripts/invoke-pack-review.ps1') -Raw
if ($invokePack -match 'harness-review-bridge') {
    Write-Host 'invoke-pack-review.ps1 must remain frozen — no harness bridge delegation'
    exit 1
}

$postSubmitCheck = Join-Path $Root 'scripts/check-harness-post-submit-pn-content-shape.ps1'
if (-not (Test-Path -LiteralPath $postSubmitCheck -PathType Leaf)) {
    Write-Host 'Issue #683 post-submit [Pn] content-shape check must exist'
    exit 1
}

Write-Host '[PASS] AO 0.10 harness review bridge + post-submit [Pn] contract (Issues #658/#683)'
