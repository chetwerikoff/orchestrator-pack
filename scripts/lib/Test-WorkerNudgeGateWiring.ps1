#requires -Version 5.1
<#
  Worker nudge gate wiring assertions (Issue #384).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Autonomous-GateCommon.ps1')
$RepoRoot = Resolve-PackGateRepoRoot -RepoRoot $RepoRoot -CallerScriptRoot (Split-Path -Parent $PSScriptRoot)

$yaml = Join-Path $RepoRoot 'agent-orchestrator.yaml.example'
$rules = Get-Content -LiteralPath $yaml -Raw
$requiredPhrases = @(
    'invoke-gated-worker-nudge.ps1',
    'worker-nudge-gate/v1',
    'journaled-worker-send.ps1'
)
$missing = @($requiredPhrases | Where-Object { $rules -notmatch [regex]::Escape($_) })
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing worker nudge gate phrases: {0}" -f ($missing -join ', '))
    exit 1
}

$paths = @(
    'scripts/invoke-gated-worker-nudge.ps1',
    'scripts/journaled-worker-send.ps1',
    'scripts/lib/Worker-NudgeClaim.ps1',
    'scripts/lib/Worker-AutonomousNudgeGate.ps1',
    'scripts/worker-nudge-gate-preflight.ps1',
    'docs/worker-nudge-gate.mjs',
    'docs/autonomous-worker-nudge-capabilities.json',
    'docs/autonomous-shared-capabilities.json',
    'docs/autonomous-gate-preflight.mjs'
)
foreach ($rel in $paths) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $rel))) {
        Write-Host "missing required worker nudge gate artifact: $rel"
        exit 1
    }
}

Write-Host '[PASS] worker nudge gate wiring'
exit 0
