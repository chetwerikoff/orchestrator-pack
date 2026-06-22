#requires -Version 5.1
<#
  Wiring guard for orchestrator claimed review-start gate (Issue #318) and spawn/git boundary (#324).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$yaml = Join-Path $RepoRoot 'agent-orchestrator.yaml.example'
$rules = Get-Content -LiteralPath $yaml -Raw
$requiredPhrases = @(
    'invoke-orchestrator-claimed-review-run.ps1',
    'AO_AUTONOMOUS_ORCHESTRATOR_SURFACE',
    'autonomous-real-binaries.json',
    'orchestrator-claimed-review-run/v1',
    'autonomous-orchestrator-boundary/v1',
    'scripts/ao',
    'scripts/git'
)
$missing = @($requiredPhrases | Where-Object { $rules -notmatch [regex]::Escape($_) })
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing orchestrator gate phrases: {0}" -f ($missing -join ', '))
    exit 1
}

if ($rules -match '(?m)^\s*AO_REAL_BINARY:\s*') {
    Write-Host 'agent-orchestrator.yaml.example must not set turn-visible AO_REAL_BINARY (use .ao/autonomous-real-binaries.json)'
    exit 1
}
if ($rules -match '(?m)^\s*GIT_REAL_BINARY:\s*') {
    Write-Host 'agent-orchestrator.yaml.example must not set turn-visible GIT_REAL_BINARY (use .ao/autonomous-real-binaries.json)'
    exit 1
}
if ($rules -notmatch 'PATH:\s*/.*/orchestrator-pack/scripts:') {
    Write-Host 'agent-orchestrator.yaml.example must prepend pack scripts/ to orchestrator PATH'
    exit 1
}

$paths = @(
    'scripts/invoke-orchestrator-claimed-review-run.ps1',
    'scripts/ao-autonomous-guard.ps1',
    'scripts/git-autonomous-guard.ps1',
    'scripts/ao',
    'scripts/git',
    'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1',
    'scripts/lib/Orchestrator-AutonomousBoundary.ps1',
    'docs/orchestrator-claimed-review-run.mjs',
    'docs/autonomous-orchestrator-boundary.mjs',
    'docs/autonomous-review-start-capabilities.json',
    'docs/autonomous-real-binaries.example.json'
)
foreach ($rel in $paths) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $rel))) {
        Write-Host "missing required gate artifact: $rel"
        exit 1
    }
}

Write-Host '[PASS] orchestrator claimed review-start gate wiring'
exit 0
