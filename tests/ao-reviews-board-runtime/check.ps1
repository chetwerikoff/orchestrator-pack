#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: AO Reviews board runtime (Issue #627).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $Root 'scripts/lib/Assert-RequiredPaths.ps1')

$runtimeRoot = 'tests/ao-reviews-board-runtime'
$required = @(
    "$runtimeRoot/start.ts",
    "$runtimeRoot/src/aggregate.ts",
    "$runtimeRoot/src/daemon-client.ts",
    "$runtimeRoot/src/server.ts",
    "$runtimeRoot/board-read-interface.schema.json",
    'docs/ao-reviews-board-runbook.md',
    'tests/ao-reviews-board.test.ts',
    'tests/external-output-references/variants/ao-0-10-daemon/per-session-reviews-empty.json',
    'tests/external-output-references/captures/ao-0-10-daemon/per-session-reviews-empty.raw.json',
    'tests/external-output-references/captures/ao-0-10-daemon/sessions-list.raw.json',
    'tests/external-output-references/captures/ao-0-10-daemon/projects-list.raw.json',
    'tests/external-output-references/captures/ao-0-10-daemon/per-session-reviews-populated.raw.json'
)

Assert-RequiredPathsExist -Paths @($required | ForEach-Object { Join-Path $Root $_ })

$toolSources = Get-ChildItem -LiteralPath (Join-Path $Root $runtimeRoot) -Recurse -File |
    Where-Object { $_.Extension -in '.ts', '.mjs', '.js' }
foreach ($file in $toolSources) {
    $text = Get-Content -LiteralPath $file.FullName -Raw
    foreach ($pattern in @('ao\.db', 'app\.asar', '/usr/lib/agent-orchestrator', '~/.agent-orchestrator', 'code-reviews/')) {
        if ($text -match $pattern) {
            Write-Host "Forbidden coupling in $($file.FullName): $pattern"
            exit 1
        }
    }
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
    Write-Host 'Board aggregation vitest suite failed (via producer-contract CI shim)'
    exit $LASTEXITCODE
}

Write-Host '[PASS] AO Reviews board runtime (Issue #627)'
