#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: orchestratorRules require review-run idempotency (Issue #98).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$text = Get-Content -LiteralPath $example -Raw

$required = @(
    'REVIEW RUN IDEMPOTENCY',
    'ao review list --json',
    'running or reviewing',
    'current PR head sha',
    'do not spawn a new run'
)

$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing idempotency phrases: {0}" -f ($missing -join ', '))
    exit 1
}

Write-Host '[PASS] orchestratorRules documents review-run idempotency before ao review run'
exit 0
