#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: scripts/gh wrapper runtime wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$required = @(
    @{ Path = 'scripts/gh'; Pattern = 'gh-wrapper\.mjs' },
    @{ Path = 'scripts/lib/gh-wrapper.mjs'; Pattern = 'matchInventoryRoute|passthrough|stdio:\s*''inherit''' },
    @{ Path = 'scripts/lib/gh-wrapper.mjs'; Pattern = 'exitCodeForPrChecks' },
    @{ Path = 'scripts/lib/gh-inventory-match.mjs'; Pattern = 'pr-checks' },
    @{ Path = 'scripts/lib/gh-rest-routes.mjs'; Pattern = 'routePrChecks' },
    @{ Path = 'scripts/lib/gh-resolve-real-binary.mjs'; Pattern = 'isNativeGhExecutable|resolveRealGhBinary' }
)

$ghShim = Join-Path $Root 'scripts/gh'
if (-not (Test-Path -LiteralPath $ghShim -PathType Leaf)) {
    Write-Host 'Missing required file: scripts/gh'
    exit 1
}
$gitMode = (git -C $Root ls-files -s -- scripts/gh 2>$null) -split '\s+' | Select-Object -First 1
if ($gitMode -ne '100755') {
    Write-Host "scripts/gh must be git mode 100755 for PATH intercept (got: $gitMode)"
    exit 1
}
if ($IsLinux -or $IsMacOS) {
    bash -lc "test -x '$ghShim'" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'scripts/gh must be executable on disk'
        exit 1
    }
}

foreach ($item in $required) {
    $full = Join-Path $Root $item.Path
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        Write-Host "Missing required file: $($item.Path)"
        exit 1
    }
    $text = Get-Content -LiteralPath $full -Raw
    if ($text -notmatch $item.Pattern) {
        Write-Host "Runtime pattern not found in $($item.Path): $($item.Pattern)"
        exit 1
    }
}

$agentsMd = Join-Path $Root 'AGENTS.md'
if (-not (Test-Path -LiteralPath $agentsMd -PathType Leaf) -or
    (Get-Content -LiteralPath $agentsMd -Raw) -notmatch 'scripts/gh') {
    Write-Host 'AGENTS.md must retain the worker-facing scripts/gh transport rule'
    exit 1
}

Write-Host '[PASS] gh wrapper runtime wiring'
exit 0
