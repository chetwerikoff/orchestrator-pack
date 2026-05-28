#Requires -Version 5.1
# Fails when agent-orchestrator.yaml.example REVIEW_COMMAND regresses to wrapper-only (Issue #60).
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ExamplePath = Join-Path $Root 'agent-orchestrator.yaml.example'
if (-not (Test-Path -LiteralPath $ExamplePath -PathType Leaf)) {
    Write-Host '[FAIL] agent-orchestrator.yaml.example not found'
    exit 1
}

$Lines = Get-Content -LiteralPath $ExamplePath
$inRules = $false
$rulesLines = [System.Collections.Generic.List[string]]::new()

for ($i = 0; $i -lt $Lines.Count; $i++) {
    $line = $Lines[$i]
    if ($line -match '^\s+orchestratorRules:\s*\|\s*$') {
        $inRules = $true
        continue
    }
    if ($inRules) {
        if ($line -match '^\S') {
            break
        }
        $rulesLines.Add($line) | Out-Null
    }
}

if ($rulesLines.Count -eq 0) {
    Write-Host '[FAIL] orchestratorRules literal not found in example config'
    exit 1
}

$rulesText = ($rulesLines -join "`n")

$hasWrapper =
    $rulesText -match 'review\.ps1' -or
    $rulesText -match 'run-pack-review\.ps1'

$hasPreflight =
    $rulesText -match 'npm ci' -or
    $rulesText -match 'run-pack-review\.ps1'

if (-not $hasWrapper) {
    Write-Host '[FAIL] orchestratorRules must name the pack review wrapper (review.ps1 or run-pack-review.ps1)'
    exit 1
}

if (-not $hasPreflight) {
    Write-Host '[FAIL] REVIEW_COMMAND must include dependency preflight (npm ci or scripts/run-pack-review.ps1)'
    exit 1
}

if ($rulesText -match 'REVIEW_COMMAND' -and $rulesText -notmatch 'run-pack-review\.ps1' -and $rulesText -notmatch 'npm ci') {
    Write-Host '[FAIL] REVIEW_COMMAND regressed to wrapper-only without documented preflight'
    exit 1
}

Write-Host '[PASS] REVIEW_COMMAND includes pack wrapper and dependency preflight'
exit 0
