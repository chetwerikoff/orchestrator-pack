#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #191 CI-green worker wake wiring and fast-path cadence.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$agentRules = Join-Path $Root 'prompts/agent_rules.md'
$text = Get-Content -LiteralPath $example -Raw
$rules = Get-Content -LiteralPath $agentRules -Raw
$wakeScript = Join-Path $Root 'scripts/ci-green-wake-reconcile.ps1'
$wakeMjs = Join-Path $Root 'docs/ci-green-wake-reconcile.mjs'

if (-not (Test-Path -LiteralPath $wakeScript -PathType Leaf)) {
    Write-Host 'Missing scripts/ci-green-wake-reconcile.ps1'
    exit 1
}

if (-not (Test-Path -LiteralPath $wakeMjs -PathType Leaf)) {
    Write-Host 'Missing docs/ci-green-wake-reconcile.mjs'
    exit 1
}

$required = @(
    'STATE-DERIVED CI-GREEN WORKER WAKE',
    'ci-green-wake-reconcile.ps1',
    'AO 0.9.x has no CI-green',
    'never ao spawn',
    'never --claim-pr',
    'never ao session kill',
    'ao send',
    'AO_CI_GREEN_WAKE_RECONCILE_INTERVAL_MINUTES',
    'does not recover dead workers'
)

$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing CI-green wake phrases: {0}" -f ($missing -join ', '))
    exit 1
}

if ($rules -notlike '*CI-green orchestrator nudge*') {
    Write-Host 'prompts/agent_rules.md missing CI-green orchestrator nudge section'
    exit 1
}

$mjs = Get-Content -LiteralPath $wakeMjs -Raw
if ($mjs -notmatch 'DEFAULT_CI_GREEN_WAKE_INTERVAL_MS = 60 \* 1000') {
    Write-Host 'docs/ci-green-wake-reconcile.mjs must default to 1-minute interval'
    exit 1
}

Write-Host '[PASS] CI-green worker wake entrypoint and example wiring (Issue #191)'
exit 0
