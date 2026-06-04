#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #174 review-ready worker stuck guard defaults and runbook.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$mjsPath = Join-Path $Root 'docs/review-ready-stuck-guard.mjs'
$exampleYaml = Join-Path $Root 'agent-orchestrator.yaml.example'
$runbook = Join-Path $Root 'docs/orchestrator-recovery-runbook.md'
$migration = Join-Path $Root 'docs/migration_notes.md'

if (-not (Test-Path -LiteralPath $mjsPath -PathType Leaf)) {
    Write-Host 'Missing docs/review-ready-stuck-guard.mjs'
    exit 1
}

$mjs = Get-Content -LiteralPath $mjsPath -Raw
if ($mjs -notmatch 'DEFAULT_GRACE_MS = 15 \* 60 \* 1000') {
    Write-Host 'docs/review-ready-stuck-guard.mjs must default to 15-minute grace window'
    exit 1
}

if ($mjs -notmatch "status !== 'clean'") {
    Write-Host 'docs/review-ready-stuck-guard.mjs must require clean review run for protection'
    exit 1
}

if ($mjs -notmatch 'hold_grace') {
    Write-Host 'docs/review-ready-stuck-guard.mjs must implement hold_grace action'
    exit 1
}

$yaml = Get-Content -LiteralPath $exampleYaml -Raw
$yamlRequired = @(
    'REVIEW-READY WORKER STUCK GUARD',
    'bounded grace',
    'affirmative unreachability',
    'ao stop',
    'ao start'
)
$missingYaml = @($yamlRequired | Where-Object { $yaml -notlike "*$_*" })
if ($missingYaml.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing review-ready guard phrases: {0}" -f ($missingYaml -join ', '))
    exit 1
}

$runbookText = Get-Content -LiteralPath $runbook -Raw
$runbookRequired = @(
    'Review-ready worker false stuck',
    'review-ready-stuck-guard',
    'AO_REVIEW_READY_STUCK_GRACE_MINUTES',
    'bounded grace',
    'ao stop',
    'ao start'
)
$missingRunbook = @($runbookRequired | Where-Object { $runbookText -notlike "*$_*" })
if ($missingRunbook.Count -gt 0) {
    Write-Host ("orchestrator-recovery-runbook.md missing stuck-guard phrases: {0}" -f ($missingRunbook -join ', '))
    exit 1
}

$migrationText = Get-Content -LiteralPath $migration -Raw
if ($migrationText -notlike '*Review-ready worker stuck guard*') {
    Write-Host 'docs/migration_notes.md must document Issue #174 operator adoption'
    exit 1
}

Write-Host '[PASS] review-ready worker stuck guard (Issue #174)'
exit 0
