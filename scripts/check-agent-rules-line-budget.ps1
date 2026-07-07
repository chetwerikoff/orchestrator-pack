#requires -Version 5.1
<#
.SYNOPSIS
  Line-budget ceiling guard for prompts/agent_rules.md (Issue #654).
#>
param(
    [string]$RepoRoot,
    [int]$MaxLines = 450
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}

$target = Join-Path $RepoRoot 'prompts/agent_rules.md'
if (-not (Test-Path -LiteralPath $target)) {
    Write-Host '[FAIL] missing prompts/agent_rules.md'
    exit 1
}

$lineCount = (Get-Content -LiteralPath $target).Count
if ($lineCount -gt $MaxLines) {
    Write-Host "[FAIL] prompts/agent_rules.md has $lineCount lines (ceiling $MaxLines)"
    exit 1
}

$vitestPath = Join-Path $RepoRoot 'tests/agent-rules-line-budget.test.ts'
$vitestConfig = Join-Path $RepoRoot 'tests/agent-rules-line-budget.vitest.config.ts'
if (-not (Test-Path -LiteralPath $vitestPath) -or -not (Test-Path -LiteralPath $vitestConfig)) {
    Write-Host '[FAIL] missing tests/agent-rules-line-budget.test.ts or vitest config'
    exit 1
}

Push-Location $RepoRoot
try {
    & npx vitest run --config $vitestConfig -t 'agent rules line budget' 2>&1 | Out-String | Write-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[FAIL] agent rules line budget vitest guard failed'
        exit 1
    }
}
finally {
    Pop-Location
}

Write-Host "[PASS] prompts/agent_rules.md line budget ($lineCount <= $MaxLines)"
exit 0
