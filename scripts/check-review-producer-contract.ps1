#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: AO 0.10 review producer data contract (Issue #626).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$required = @(
    'scripts/lib/review-producer-contract.ts',
    'docs/ao-0-10-review-producer-contract.md',
    'docs/ao-0-10-review-producer-contract.schema.json',
    'tests/external-output-references/variants/ao-0-10-daemon/per-session-reviews-populated.json',
    'tests/external-output-references/captures/ao-0-10-daemon/per-session-reviews-populated.raw.json',
    'tests/external-output-references/captures/ao-0-10-daemon/sessions-list.raw.json',
    'tests/external-output-references/captures/ao-0-10-daemon/projects-list.raw.json'
)

foreach ($rel in $required) {
    $path = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $rel"
        exit 1
    }
}

$mappingSource = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/review-producer-contract.ts') -Raw
foreach ($field in @('needs_triage', 'sentFindingCount', 'terminationReason')) {
    if ($mappingSource -match "['`"]$field['`"]\s*:") {
        Write-Host "Producer mapping must not emit false-equivalence field: $field"
        exit 1
    }
}
if ($mappingSource -match 'ao\.db') {
    Write-Host 'Producer mapping must not read ao.db for consumer-facing fields'
    exit 1
}

$variants = @(
    'ao-0-10-daemon/per-session-reviews-populated',
    'ao-0-10-daemon/sessions-list',
    'ao-0-10-daemon/projects-list'
)
foreach ($variant in $variants) {
    & node (Join-Path $Root 'scripts/external-output-shape-guard.mjs') --variant $variant
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Shape guard failed for variant: $variant"
        exit $LASTEXITCODE
    }
}

Write-Host '[PASS] AO 0.10 review producer data contract (Issue #626)'
