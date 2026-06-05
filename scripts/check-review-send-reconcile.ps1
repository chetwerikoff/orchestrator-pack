#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #202 first-send review-finding delivery wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$agentRules = Join-Path $Root 'prompts/agent_rules.md'
$wakeScript = Join-Path $Root 'scripts/review-send-reconcile.ps1'
$wakeMjs = Join-Path $Root 'docs/review-send-reconcile.mjs'
$supervisorLib = Join-Path $Root 'scripts/lib/Orchestrator-WakeSupervisor.ps1'
$runbook = Join-Path $Root 'docs/orchestrator-recovery-runbook.md'

if (-not (Test-Path -LiteralPath $wakeScript -PathType Leaf)) {
    Write-Host 'Missing scripts/review-send-reconcile.ps1'
    exit 1
}

if (-not (Test-Path -LiteralPath $wakeMjs -PathType Leaf)) {
    Write-Host 'Missing docs/review-send-reconcile.mjs'
    exit 1
}

$required = @(
    'STATE-DERIVED FIRST REVIEW SEND',
    'review-send-reconcile.ps1',
    'sentFindingCount: 0',
    'never ao spawn',
    'never --claim-pr',
    'never ao session kill',
    'never ao send',
    'never ao report',
    'ao review send',
    'AO_REVIEW_SEND_RECONCILE_INTERVAL_MINUTES',
    'AO_REVIEW_SEND_RECONCILE_STATE',
    'additive to',
    'heartbeat backstop'
)

$text = Get-Content -LiteralPath $example -Raw
$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing review-send reconcile phrases: {0}" -f ($missing -join ', '))
    exit 1
}

if ((Get-Content -LiteralPath $agentRules -Raw) -notlike '*first-send review delivery*') {
    Write-Host 'prompts/agent_rules.md missing first-send review delivery section'
    exit 1
}

$mjs = Get-Content -LiteralPath $wakeMjs -Raw
if ($mjs -notmatch 'DEFAULT_REVIEW_SEND_INTERVAL_MS = 2 \* 60 \* 1000') {
    Write-Host 'docs/review-send-reconcile.mjs must default to 2-minute interval'
    exit 1
}

$supervisor = Get-Content -LiteralPath $supervisorLib -Raw
if ($supervisor -notmatch 'review-send-reconcile') {
    Write-Host 'Orchestrator-WakeSupervisor.ps1 must manage review-send-reconcile child'
    exit 1
}

$ps1 = Get-Content -LiteralPath $wakeScript -Raw
if ($ps1 -notmatch 'UseFixtureSnapshot[\s\S]*\$DryRunMode = \$true') {
    Write-Host 'review-send-reconcile.ps1 must force dry-run when using fixture snapshots'
    exit 1
}
if ($ps1 -notmatch 'if \(\$FixturePath\)[\s\S]*-DryRunMode -Fixture \$FixturePath') {
    Write-Host 'review-send-reconcile.ps1 must pass -DryRunMode on fixture ticks (no live ao/gh)'
    exit 1
}

$runbookText = Get-Content -LiteralPath $runbook -Raw
$runbookRequired = @(
    'review-send-reconcile',
    'AO_REVIEW_SEND_RECONCILE_INTERVAL_MINUTES',
    'AO_REVIEW_SEND_RECONCILE_STATE',
    'First-send review findings undelivered'
)

$missingRunbook = @($runbookRequired | Where-Object { $runbookText -notlike "*$_*" })
if ($missingRunbook.Count -gt 0) {
    Write-Host ("orchestrator-recovery-runbook.md missing review-send phrases: {0}" -f ($missingRunbook -join ', '))
    exit 1
}

Write-Host '[PASS] first-send review delivery reconcile entrypoint and wiring (Issue #202)'
exit 0
