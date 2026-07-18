#Requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: the live pack-review entrypoint resolves supported reviewer wrappers.

.DESCRIPTION
  Review policy no longer comes from agent-orchestrator.yaml.example. Validate the
  executable pack-owned selector/wrapper path instead of requiring retired YAML prose.
#>
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$entrypointPath = Join-Path $Root 'scripts/invoke-pack-review.ps1'
$resolverPath = Join-Path $Root 'scripts/lib/Resolve-PackReviewer.ps1'
$requiredWrappers = @(
    'scripts/run-pack-review.ps1',
    'scripts/run-pack-review-claude.ps1'
)

foreach ($path in @($entrypointPath, $resolverPath) + @($requiredWrappers | ForEach-Object { Join-Path $Root $_ })) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "[FAIL] missing live pack-review path: $path"
        exit 1
    }
}

$entrypoint = Get-Content -LiteralPath $entrypointPath -Raw
foreach ($marker in @(
        'Resolve-PackReviewer.ps1',
        'Get-PackReviewerFromSelector',
        'Get-PackReviewWrapperPathForReviewer',
        'Invoke-PackReviewWrapperWithFailureEvidence'
    )) {
    if ($entrypoint -notmatch [regex]::Escape($marker)) {
        Write-Host "[FAIL] invoke-pack-review.ps1 missing live selector/wrapper marker: $marker"
        exit 1
    }
}

$resolver = Get-Content -LiteralPath $resolverPath -Raw
foreach ($marker in @(
        "codex  = 'run-pack-review.ps1'",
        "claude = 'run-pack-review-claude.ps1'",
        'PACK_REVIEWER'
    )) {
    if ($resolver -notmatch [regex]::Escape($marker)) {
        Write-Host "[FAIL] Resolve-PackReviewer.ps1 missing live reviewer mapping: $marker"
        exit 1
    }
}

if ($entrypoint -match 'agent-orchestrator\.yaml\.example' -or $entrypoint -match '\borchestratorRules\b') {
    Write-Host '[FAIL] live pack-review entrypoint must not read retired YAML review policy'
    exit 1
}

Write-Host '[PASS] live pack-review entrypoint resolves both reviewer wrappers without YAML policy'
exit 0
