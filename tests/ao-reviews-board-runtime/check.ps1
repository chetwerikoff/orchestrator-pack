#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: AO Reviews board runtime (#627) and UI fork (#628).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $Root 'scripts/lib/Assert-RequiredPaths.ps1')

$runtimeRoot = 'tests/ao-reviews-board-runtime'
$uiRoot = "$runtimeRoot/ui"
$required = @(
    "$runtimeRoot/start.ts",
    "$runtimeRoot/src/aggregate.ts",
    "$runtimeRoot/src/daemon-client.ts",
    "$runtimeRoot/src/server.ts",
    "$runtimeRoot/board-read-interface.schema.json",
    "$uiRoot/NOTICE",
    "$uiRoot/src/ReviewDashboard.tsx",
    "$uiRoot/src/review-types.ts",
    "$uiRoot/src/board-client.ts",
    'docs/ao-reviews-board-runbook.md',
    'tests/ao-reviews-board.test.ts',
    'tests/ao-reviews-board-ui.test.ts',
    'tests/ao-reviews-board-runtime/ui/render-board-view.harness.ts',
    'tests/fixtures/reviews-board-seven-columns.json',
    'tests/external-output-references/variants/ao-0-10-daemon/per-session-reviews-empty.json',
    'tests/external-output-references/captures/ao-0-10-daemon/per-session-reviews-empty.raw.json',
    'tests/external-output-references/captures/ao-0-10-daemon/sessions-list.raw.json',
    'tests/external-output-references/captures/ao-0-10-daemon/projects-list.raw.json',
    'tests/external-output-references/captures/ao-0-10-daemon/per-session-reviews-populated.raw.json'
)

Assert-RequiredPathsExist -Paths @($required | ForEach-Object { Join-Path $Root $_ })

$toolSources = Get-ChildItem -LiteralPath (Join-Path $Root $runtimeRoot) -Recurse -File |
    Where-Object { $_.Extension -in '.ts', '.mjs', '.js' -and $_.FullName -notmatch '[\\/]ui[\\/]node_modules[\\/]' }
foreach ($file in $toolSources) {
    $text = Get-Content -LiteralPath $file.FullName -Raw
    foreach ($pattern in @('ao\.db', 'app\.asar', '/usr/lib/agent-orchestrator', '~/.agent-orchestrator', 'code-reviews/')) {
        if ($text -match $pattern) {
            Write-Host "Forbidden coupling in $($file.FullName): $pattern"
            exit 1
        }
    }
}

$uiSources = Get-ChildItem -LiteralPath (Join-Path $Root $uiRoot) -Recurse -File |
    Where-Object { $_.Extension -in '.ts', '.tsx', '.js', '.jsx' -and $_.FullName -notmatch '[\\/]node_modules[\\/]' }
foreach ($file in $uiSources) {
    $text = Get-Content -LiteralPath $file.FullName -Raw
    foreach ($pattern in @('@aoagents/ao-core', 'createCodeReviewStore', 'getReviewPageData', 'window\.ao', 'ao\.db', '~/.agent-orchestrator')) {
        if ($text -match $pattern) {
            Write-Host "Forbidden UI data source in $($file.FullName): $pattern"
            exit 1
        }
    }
}

Push-Location (Join-Path $Root $uiRoot)
try {
    if (-not (Test-Path -LiteralPath 'node_modules')) {
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    & npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if (-not (Test-Path -LiteralPath (Join-Path (Get-Location) 'dist/index.html'))) {
        Write-Host 'UI build did not emit dist/index.html'
        exit 1
    }
}
finally {
    Pop-Location
}

$shapeGuardVariants = @(
    'ao-0-10-daemon/per-session-reviews-empty',
    'ao-0-10-daemon/per-session-reviews-populated',
    'ao-0-10-daemon/sessions-list',
    'ao-0-10-daemon/projects-list'
)
foreach ($variantId in $shapeGuardVariants) {
    & node (Join-Path $Root 'scripts/external-output-shape-guard.mjs') --variant $variantId
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Shape guard failed for variant: $variantId"
        exit $LASTEXITCODE
    }
}

& npm test -- (Join-Path $Root 'scripts/review-producer-contract-mapping.test.ts')
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Board aggregation + UI vitest suite failed (via producer-contract CI shim)'
    exit $LASTEXITCODE
}

Write-Host '[PASS] AO Reviews board runtime (#627) and UI fork (#628)'
