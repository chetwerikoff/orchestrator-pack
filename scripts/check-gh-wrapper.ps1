#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: scripts/gh wrapper wiring (Issue #431).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$required = @(
    @{ Path = 'scripts/gh'; Pattern = 'gh-wrapper\.mjs' },
    @{ Path = 'scripts/lib/gh-wrapper.mjs'; Pattern = 'matchInventoryRoute|passthrough' },
    @{ Path = 'scripts/lib/gh-inventory-match.mjs'; Pattern = 'pr-checks' },
    @{ Path = 'scripts/lib/gh-rest-routes.mjs'; Pattern = 'routePrChecks' },
    @{ Path = 'scripts/lib/gh-resolve-real-binary.mjs'; Pattern = 'resolveRealGhBinary' },
    @{ Path = 'agent-orchestrator.yaml.example'; Pattern = 'scripts/gh' }
)

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
