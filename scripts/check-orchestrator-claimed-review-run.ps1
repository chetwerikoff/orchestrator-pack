#requires -Version 5.1
<#
  Wiring guard for orchestrator claimed review-start gate (Issue #318).
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
    'AO_REAL_BINARY',
    'orchestrator-claimed-review-run/v1',
    'scripts/ao'
)
$missing = @($requiredPhrases | Where-Object { $rules -notmatch [regex]::Escape($_) })
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing orchestrator gate phrases: {0}" -f ($missing -join ', '))
    exit 1
}

if ($rules -match '(?m)^\s*AO_REAL_BINARY:\s*ao\s*(?:#.*)?$') {
    Write-Host 'agent-orchestrator.yaml.example must not set AO_REAL_BINARY to bare ao (shim recursion)'
    exit 1
}
if ($rules -notmatch 'AO_REAL_BINARY:\s*(/|[A-Za-z]:[\\/])') {
    Write-Host 'agent-orchestrator.yaml.example must document AO_REAL_BINARY as an absolute path'
    exit 1
}
if ($rules -notmatch 'PATH:\s*/.*/orchestrator-pack/scripts:') {
    Write-Host 'agent-orchestrator.yaml.example must prepend pack scripts/ to orchestrator PATH'
    exit 1
}

$paths = @(
    'scripts/invoke-orchestrator-claimed-review-run.ps1',
    'scripts/ao-autonomous-guard.ps1',
    'scripts/ao',
    'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1',
    'docs/orchestrator-claimed-review-run.mjs',
    'docs/autonomous-review-start-capabilities.json'
)
foreach ($rel in $paths) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $rel))) {
        Write-Host "missing required gate artifact: $rel"
        exit 1
    }
}

Write-Host '[PASS] orchestrator claimed review-start gate wiring'
exit 0
