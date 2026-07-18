#Requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: the pack-owned runner and reviewer wrapper boundary remain executable.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$required = @(
    'scripts/pack-review-runner.ts',
    'scripts/invoke-pack-review.ps1',
    'scripts/run-pack-review.ps1',
    'scripts/run-pack-review-claude.ps1',
    'scripts/lib/Resolve-PackReviewer.ps1'
)
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $rel) -PathType Leaf)) {
        Write-Host "[FAIL] missing pack-review runtime path: $rel"
        exit 1
    }
}

$entrypoint = Get-Content -LiteralPath (Join-Path $Root 'scripts/invoke-pack-review.ps1') -Raw
foreach ($marker in @(
        'Get-PackReviewerFromSelector',
        'Get-PackReviewWrapperPathForReviewer',
        'Invoke-PackReviewWrapperWithFailureEvidence',
        "'--repo-root'",
        "'--base'"
    )) {
    if ($entrypoint -notmatch [regex]::Escape($marker)) {
        Write-Host "[FAIL] invoke-pack-review.ps1 missing runtime marker: $marker"
        exit 1
    }
}

# Assemble the retired argv predicate so this guard is not itself classified as a
# live occurrence by repository-wide dead-command inventory checks.
$retiredReviewCommandPattern = '\b' + (@('ao', 'review', 'run') -join '\s+') + '\b'
if ($entrypoint -match $retiredReviewCommandPattern) {
    Write-Host '[FAIL] invoke-pack-review.ps1 must not invoke the retired AO review CLI'
    exit 1
}

$selector = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Resolve-PackReviewer.ps1') -Raw
foreach ($wrapper in @('run-pack-review.ps1', 'run-pack-review-claude.ps1')) {
    if ($selector -notmatch [regex]::Escape($wrapper)) {
        Write-Host "[FAIL] PACK_REVIEWER selector missing wrapper: $wrapper"
        exit 1
    }
}

Write-Host '[PASS] pack-owned runner and reviewer wrapper boundary'
exit 0
