#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: orchestratorRules document the failed+zero-findings trap.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$text = Get-Content -LiteralPath $example -Raw

$required = @(
    'EMPTY REVIEW TRAP',
    'findingCount 0 on failed',
    'terminationReason',
    'run-pack-review.ps1',
    'orchestrator-diagnose.ps1'
)

$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($missing.Count -gt 0) {
    Write-Error ("agent-orchestrator.yaml.example missing review empty-trap phrases: {0}" -f ($missing -join ', '))
}

Write-Host '[PASS] orchestratorRules documents empty-review trap and diagnose routing'
