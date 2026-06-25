#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: scripts/gh wrapper wiring (Issue #431).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$required = @(
    @{ Path = 'scripts/gh'; Pattern = 'gh-wrapper\.mjs' },
    @{ Path = 'scripts/lib/gh-wrapper.mjs'; Pattern = 'matchInventoryRoute|passthrough|stdio:\s*''inherit''' },
    @{ Path = 'scripts/lib/gh-wrapper.mjs'; Pattern = 'exitCodeForPrChecks' },
    @{ Path = 'scripts/lib/gh-inventory-match.mjs'; Pattern = 'pr-checks' },
    @{ Path = 'scripts/lib/gh-rest-routes.mjs'; Pattern = 'routePrChecks' },
    @{ Path = 'scripts/lib/gh-resolve-real-binary.mjs'; Pattern = 'isNativeGhExecutable|resolveRealGhBinary' },
    @{ Path = 'agent-orchestrator.yaml.example'; Pattern = 'scripts/gh' }
)

$ghShim = Join-Path $Root 'scripts/gh'
if (-not (Test-Path -LiteralPath $ghShim -PathType Leaf)) {
    Write-Host 'Missing required file: scripts/gh'
    exit 1
}
# PATH intercept requires the shim to be executable (git index 100755, same as scripts/ao).
$gitMode = (git -C $Root ls-files -s -- scripts/gh 2>$null) -split '\s+' | Select-Object -First 1
if ($gitMode -ne '100755') {
    Write-Host "scripts/gh must be git mode 100755 for PATH intercept (got: $gitMode)"
    exit 1
}
if ($IsLinux -or $IsMacOS) {
    bash -lc "test -x '$ghShim'" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'scripts/gh must be executable on disk (chmod +x)'
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
        Write-Host "Pattern not found in $($item.Path): $($item.Pattern)"
        exit 1
    }
}

$agentRules = Join-Path $Root 'prompts/agent_rules.md'
$rulesText = Get-Content -LiteralPath $agentRules -Raw
if ($rulesText -notmatch 'scripts/gh') {
    Write-Host 'prompts/agent_rules.md must document scripts/gh REST inventory routing'
    exit 1
}

$migration = Join-Path $Root 'docs/migration_notes.md'
$migrationText = Get-Content -LiteralPath $migration -Raw
if ($migrationText -notmatch 'scripts/gh') {
    Write-Host 'docs/migration_notes.md must document scripts/gh adoption'
    exit 1
}

Write-Host '[PASS] gh wrapper wiring (Issue #431)'
exit 0
