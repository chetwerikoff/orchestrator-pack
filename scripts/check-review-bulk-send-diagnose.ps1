#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #140 bulk-send / stuck-open diagnostic defaults, fixtures, and docs.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $Root 'scripts/review-bulk-send-diagnose.ps1'
$mjsPath = Join-Path $Root 'docs/review-bulk-send-diagnose.mjs'
$architecture = Join-Path $Root 'docs/architecture.md'
$sharedBoundaries = Join-Path $Root 'docs/issues_drafts/finding-routing-eval-shared-pack-boundaries.md'

if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    Write-Host 'Missing scripts/review-bulk-send-diagnose.ps1'
    exit 1
}

if (-not (Test-Path -LiteralPath $mjsPath -PathType Leaf)) {
    Write-Host 'Missing docs/review-bulk-send-diagnose.mjs'
    exit 1
}

$mjs = Get-Content -LiteralPath $mjsPath -Raw
if ($mjs -notmatch 'bulk_send_trap' -or $mjs -notmatch 'stuck_open') {
    Write-Host 'docs/review-bulk-send-diagnose.mjs must classify bulk_send_trap and stuck_open'
    exit 1
}

$ps1 = Get-Content -LiteralPath $scriptPath -Raw
if ($ps1 -notmatch 'read-only' -or $ps1 -notmatch 'Issue #140') {
    Write-Host 'scripts/review-bulk-send-diagnose.ps1 must document read-only Issue #140 scope'
    exit 1
}

$architectureText = Get-Content -LiteralPath $architecture -Raw
$architectureRequired = @(
    'review-bulk-send-diagnose.ps1',
    'bulk_send_trap',
    'stuck_open',
    'multi_open_awaiting_dispatch',
    'active-blocked-upstream',
    'hand-edit',
    'code-reviews/findings'
)

$missingArchitecture = @($architectureRequired | Where-Object { $architectureText -notmatch [regex]::Escape($_) })
if ($missingArchitecture.Count -gt 0) {
    Write-Host ("docs/architecture.md missing bulk-send diagnostic phrases: {0}" -f ($missingArchitecture -join ', '))
    exit 1
}

$boundariesText = Get-Content -LiteralPath $sharedBoundaries -Raw
if ($boundariesText -notmatch 'review-bulk-send-diagnose\.ps1' -or $boundariesText -notmatch 'drafts 47 / 50') {
    Write-Host 'finding-routing-eval-shared-pack-boundaries.md must cross-link the bulk-send diagnostic'
    exit 1
}

$fixtures = @(
    'needs-triage-multi-open.json',
    'stuck-open-partial-send.json',
    'clean-no-open.json'
)
$fixtureDir = Join-Path $Root 'scripts/fixtures/review-bulk-send-diagnose'

foreach ($name in $fixtures) {
    $path = Join-Path $fixtureDir $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing fixture $name"
        exit 1
    }
    & $scriptPath -FixturePath $path -Json | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Fixture run failed: $name"
        exit 1
    }
}

Write-Host '[PASS] review bulk-send diagnostic entrypoint and architecture docs (Issue #140)'
exit 0
