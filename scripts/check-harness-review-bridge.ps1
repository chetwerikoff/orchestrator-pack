#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: trusted harness mapper and priority-tag contract behind the pack runner.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Assert-RequiredPaths.ps1')

$required = @(
    'scripts/harness-review-bridge.ps1',
    'scripts/harness-review-bridge.ts',
    'docs/harness-review-bridge.mjs',
    'prompts/harness_reviewer_submit_contract.md',
    '.cursor/rules/harness-review-bridge.mdc',
    'scripts/pack-review-runner.ts',
    'scripts/lib/pack-review-run-store.ts',
    'scripts/lib/Invoke-AoReviewApi.ps1',
    'scripts/invoke-pack-review.ps1'
)
Assert-RequiredPathsExist -Paths @($required | ForEach-Object { Join-Path $Root $_ })

$bridgePs1 = Get-Content -LiteralPath (Join-Path $Root 'scripts/harness-review-bridge.ps1') -Raw
if ($bridgePs1 -notmatch 'harness-review-bridge\.ts') {
    Write-Host 'harness-review-bridge.ps1 must delegate to the TypeScript mapper bridge'
    exit 1
}
if ($bridgePs1 -notmatch 'Resolve-TrustedPackRoot') {
    Write-Host 'harness-review-bridge.ps1 must resolve the trusted pack root'
    exit 1
}

$adapter = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Invoke-AoReviewApi.ps1') -Raw
if ($adapter -notmatch 'Invoke-PackReviewRunnerCli') {
    Write-Host 'review adapter must delegate invocation and status to the pack runner'
    exit 1
}
if ($adapter -notmatch 'Get-OpkTypeScriptNodeArguments') {
    Write-Host 'review adapter must use the shared Node-version-aware TypeScript launcher'
    exit 1
}
if ($adapter -match '/reviews/trigger') {
    Write-Host 'review adapter must not retain the daemon review trigger endpoint'
    exit 1
}

$runner = Get-Content -LiteralPath (Join-Path $Root 'scripts/pack-review-runner.ts') -Raw
if ($runner -notmatch 'invoke-pack-review\.ps1') {
    Write-Host 'pack runner must resolve the trusted reviewer script'
    exit 1
}

$invokePack = Get-Content -LiteralPath (Join-Path $Root 'scripts/invoke-pack-review.ps1') -Raw
if ($invokePack -match 'harness-review-bridge') {
    Write-Host 'the trusted reviewer must not delegate back into the compatibility mapper bridge'
    exit 1
}

$postSubmitCheck = Join-Path $Root 'scripts/check-harness-post-submit-pn-content-shape.ps1'
if (-not (Test-Path -LiteralPath $postSubmitCheck -PathType Leaf)) {
    Write-Host 'priority-tag content-shape compatibility check must exist'
    exit 1
}

Write-Host '[PASS] trusted harness mapper and pack-runner priority-tag contract'
exit 0
