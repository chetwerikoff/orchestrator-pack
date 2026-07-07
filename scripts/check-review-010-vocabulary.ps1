#requires -Version 5.1
<#
.SYNOPSIS
  Static guard: production scripts must not use dead AO 0.9 review CLI or false-equivalence fields (Issue #625).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$allowlist = @(
    'scripts/ao-review.ps1',
    'scripts/check-review-010-vocabulary.ps1',
    'scripts/check-review-producer-contract.ps1',
    'scripts/check-ao-0-10-review-trigger.ps1',
    'scripts/patch-codex-review4.ps1',
    'scripts/check-review-send-reconcile.ps1',
    'scripts/check-review-start-claim-guard.ps1',
    'scripts/check-review-trigger-reconcile.ps1',
    'scripts/check-review-wake-trigger.ps1',
    'scripts/lib/Review-MechanicalForbiddenCommand.ps1',
    'scripts/lib/Review-Send-MechanicalForbiddenCommand.ps1',
    'scripts/review-send-reconcile.ps1',
    'docs/ao-0-10-review-api.mjs',
    'docs/review-mechanical-cli.mjs'
)

$deadVerbPattern = '\bao\s+review\s+(run|list|send|execute)\b'
$deadArgvPattern = '\[\s*[''"]review[''"]\s*,\s*[''"](run|list|send|execute)[''"]'
$falseFieldPattern = '\b(needs_triage|sentFindingCount|terminationReason)\b'

$scanRoots = @(
    (Join-Path $Root 'scripts'),
    (Join-Path $Root 'docs')
)

$violations = @()
foreach ($scanRoot in $scanRoots) {
    Get-ChildItem -LiteralPath $scanRoot -Recurse -File -Include '*.ps1', '*.mjs' | ForEach-Object {
        $rel = $_.FullName.Substring($Root.Length + 1).Replace('\', '/')
        if ($allowlist -contains $rel) { return }
        if ($rel -like 'tests/**') { return }
        if ($rel -like 'scripts/fixtures/**') { return }
        $text = Get-Content -LiteralPath $_.FullName -Raw
        if ($text -match $deadVerbPattern) {
            $violations += "${rel}: dead ao review CLI verb"
        }
        if ($text -match $deadArgvPattern) {
            $violations += "${rel}: dead ao review CLI argv"
        }
        if ($text -match $falseFieldPattern) {
            $violations += "${rel}: false-equivalence field name"
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host 'AO 0.10 review vocabulary violations:'
    $violations | ForEach-Object { Write-Host "  $_" }
    exit 1
}

Write-Host '[PASS] AO 0.10 review vocabulary guard (no dead CLI / false-equivalence fields)'
exit 0
