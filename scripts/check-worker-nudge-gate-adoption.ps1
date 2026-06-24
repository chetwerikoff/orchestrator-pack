#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$liveYaml = Join-Path $Root 'agent-orchestrator.yaml'
if (-not (Test-Path -LiteralPath $liveYaml -PathType Leaf)) {
    Write-Host '[SKIP] live agent-orchestrator.yaml not present — worker nudge adoption gate requires operator checkout'
    exit 0
}

function Get-YamlOrchestratorRules {
    param([string]$Raw)
    $lines = $Raw -split "`n"
    $capture = $false
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        if ($line -match '^\s+orchestratorRules:\s*(?:\||>)\s*$') {
            $capture = $true
            continue
        }
        if ($capture) {
            if ($line -match '^\S') { break }
            $out.Add($line)
        }
    }
    return ($out -join "`n")
}

$raw = Get-Content -LiteralPath $liveYaml -Raw
$rules = Get-YamlOrchestratorRules -Raw $raw

. (Join-Path $Root 'scripts/lib/Worker-AutonomousNudgeGate.ps1')
$gate = Test-WorkerNudgeGateAdoption -OrchestratorRules $rules
if (-not $gate.ok -or -not $gate.nudgeSurfaceEnabled) {
    Write-Host "[FAIL] live YAML worker-nudge adoption gate (Issue #384): ok=$($gate.ok) nudgeSurfaceEnabled=$($gate.nudgeSurfaceEnabled)"
    if ($gate.errors) {
        foreach ($err in @($gate.errors)) {
            Write-Host "  - $err"
        }
    }
    exit 1
}
Write-Host '[PASS] live YAML worker-nudge adoption gate (Issue #384)'
