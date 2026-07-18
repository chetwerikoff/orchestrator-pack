#Requires -Version 5.1
<#
.SYNOPSIS
  Runtime checks for the reviewer-agnostic entrypoint and PACK_REVIEWER selector.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$entrypoint = Join-Path $Root 'scripts/invoke-pack-review.ps1'
$selectorLib = Join-Path $Root 'scripts/lib/Resolve-PackReviewer.ps1'
$codexWrapper = Join-Path $Root 'scripts/run-pack-review.ps1'
$claudeWrapper = Join-Path $Root 'scripts/run-pack-review-claude.ps1'

foreach ($path in @($entrypoint, $selectorLib, $codexWrapper, $claudeWrapper)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "[FAIL] missing pack-review runtime path: $path"
        exit 1
    }
}

. $selectorLib
$selectorText = Get-Content -LiteralPath $selectorLib -Raw
foreach ($wrapper in @('run-pack-review.ps1', 'run-pack-review-claude.ps1')) {
    if ($selectorText -notmatch [regex]::Escape($wrapper)) {
        Write-Host "[FAIL] PACK_REVIEWER selector missing wrapper: $wrapper"
        exit 1
    }
}

$entrypointText = Get-Content -LiteralPath $entrypoint -Raw
foreach ($marker in @('Get-PackReviewerFromSelector', 'Get-PackReviewWrapperPathForReviewer')) {
    if ($entrypointText -notmatch [regex]::Escape($marker)) {
        Write-Host "[FAIL] invoke-pack-review.ps1 missing selector marker: $marker"
        exit 1
    }
}
if ($entrypointText -match '\bao\s+review\s+run\b') {
    Write-Host '[FAIL] invoke-pack-review.ps1 must not invoke AO review run'
    exit 1
}

$savedProcess = $env:PACK_REVIEWER
try {
    if (Test-PackReviewerPersistentLayersAvailable) {
        $savedUser = [Environment]::GetEnvironmentVariable('PACK_REVIEWER', 'User')
        [Environment]::SetEnvironmentVariable('PACK_REVIEWER', $null, 'User')
    }

    $env:PACK_REVIEWER = 'not-a-reviewer'
    & $entrypoint --repo-root $Root --base origin/main 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host '[FAIL] invoke-pack-review.ps1 must fail closed for unrecognized PACK_REVIEWER'
        exit 1
    }
}
finally {
    if (Test-PackReviewerPersistentLayersAvailable) {
        [Environment]::SetEnvironmentVariable('PACK_REVIEWER', $savedUser, 'User')
    }
    if ($null -eq $savedProcess) {
        Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue
    }
    else {
        $env:PACK_REVIEWER = $savedProcess
    }
}

Write-Host '[PASS] reviewer-agnostic entrypoint and PACK_REVIEWER fail-closed checks'
exit 0
