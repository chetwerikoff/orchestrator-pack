#requires -Version 5.1
<#
  Command-runtime bootstrap wiring assertions (Issue #532).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Autonomous-GateCommon.ps1')
$RepoRoot = Resolve-PackGateRepoRoot -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot

$yaml = Join-Path $RepoRoot 'agent-orchestrator.yaml.example'
$rules = Get-Content -LiteralPath $yaml -Raw
$requiredPhrases = @(
    'orchestrator-command-runtime-preflight.ps1',
    'command-runtime-bootstrap/v1',
    'Issue #522/#527'
)
$missing = @($requiredPhrases | Where-Object { $rules -notmatch [regex]::Escape($_) })
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing command-runtime bootstrap phrases: {0}" -f ($missing -join ', '))
    exit 1
}

$paths = @(
    'scripts/orchestrator-command-runtime-preflight.ps1',
    'scripts/lib/command-runtime-bootstrap.mjs',
    'scripts/check-command-runtime-forbidden-workaround.ps1'
)
foreach ($rel in $paths) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $rel))) {
        Write-Host "missing required command-runtime bootstrap artifact: $rel"
        exit 1
    }
}

$bootstrap = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts/autonomous-orchestrator-surface-bootstrap.sh') -Raw
if ($bootstrap -notmatch 'command-runtime-bootstrap\.mjs') {
    Write-Host 'autonomous-orchestrator-surface-bootstrap.sh missing command-runtime preflight hook'
    exit 1
}

$ghShim = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts/gh') -Raw
if ($ghShim -notmatch '#530/#531') {
    Write-Host 'scripts/gh missing temporary REST unblock ownership note for #530/#531'
    exit 1
}

Write-Host '[PASS] command-runtime bootstrap wiring'
exit 0
