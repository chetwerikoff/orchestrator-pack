#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: pack-owned review-run idempotency contract (Issue #839).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$text = Get-Content -LiteralPath (Join-Path $Root 'agent-orchestrator.yaml.example') -Raw

$required = @(
    'REVIEW RUN IDEMPOTENCY',
    'current PR head sha',
    'do not start a new pack review run',
    'covered terminal',
    'up_to_date',
    'changes_requested',
    'PRE-RUN COVERAGE RE-CHECK',
    'Review-StartClaim.ps1',
    'pack review run store',
    'manual and automatic triggers share the same runner'
)
$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing pack-runner idempotency phrases: {0}" -f ($missing -join ', '))
    exit 1
}
if ($text -like '*ao-review list*' -or $text -like '*daemon session-reviews* as the status authority*') {
    Write-Host 'agent-orchestrator.yaml.example must not retain the daemon review-list authority contract'
    exit 1
}

Write-Host '[PASS] pack-owned review runner idempotency contract (Issue #839)'
exit 0
