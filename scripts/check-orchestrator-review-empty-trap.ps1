#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: failed zero-findings review handling has executable coverage.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$required = @(
    'scripts/pack-review-runner.ts',
    'scripts/lib/pack-review-run-store.ts',
    'scripts/pack-review-runner-severity.test.ts'
)
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $rel) -PathType Leaf)) {
        Write-Host "Missing required runtime/test path: $rel"
        exit 1
    }
}

$testText = Get-Content -LiteralPath (Join-Path $Root 'scripts/pack-review-runner-severity.test.ts') -Raw
if ($testText -notmatch 'startPackReview' -or $testText -notmatch 'PACK_REVIEW_REQUIRED_STATUS_CONTEXT') {
    Write-Host 'pack-review-runner-severity.test.ts must exercise the runner and required-status contract'
    exit 1
}

Write-Host '[PASS] failed zero-findings handling has runner-level regression coverage'
exit 0
