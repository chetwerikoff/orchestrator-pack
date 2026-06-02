#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/Parse-PackReviewCliArgs.ps1')

$fixtureRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$parsed = Split-PackReviewCliArgs -Argv @(
    '--repo-root', $fixtureRoot,
    '--base', 'origin/develop',
    '--prompt-only'
)

if ($parsed.RepoRoot -ne $fixtureRoot) {
    Write-Host "[FAIL] --repo-root not parsed (got $($parsed.RepoRoot))"
    exit 1
}
if ($parsed.Base -ne 'origin/develop') {
    Write-Host "[FAIL] --base not parsed (got $($parsed.Base))"
    exit 1
}
if ($parsed.ForwardArgs -notcontains '--prompt-only') {
    Write-Host '[FAIL] forward args missing --prompt-only'
    exit 1
}

Write-Host '[PASS] run-pack-review.ps1 CLI flag parsing'
exit 0
