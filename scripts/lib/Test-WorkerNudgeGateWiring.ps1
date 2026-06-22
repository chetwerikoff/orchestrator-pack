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


$workerObservableSenders = @(
    'scripts/invoke-gated-worker-nudge.ps1',
    'scripts/ci-green-wake-reconcile.ps1',
    'scripts/review-send-reconcile.ps1',
    'scripts/ci-failure-notification-reconcile.ps1',
    'scripts/review-finding-delivery-confirm.ps1'
)
foreach ($rel in $workerObservableSenders) {
    $full = Join-Path $RepoRoot $rel
    if (-not (Test-Path -LiteralPath $full)) {
        Write-Host "missing worker-observable sender script: $rel"
        exit 1
    }
    $body = Get-Content -LiteralPath $full -Raw
    if ($body -notmatch 'Acquire-WorkerNudgeClaim') {
        Write-Host "worker-observable sender missing Acquire-WorkerNudgeClaim: $rel"
        exit 1
    }
    if ($rel -eq 'scripts/ci-failure-notification-reconcile.ps1' -or $rel -eq 'scripts/ci-green-wake-reconcile.ps1') {
        if ($body -notmatch 'journaled-worker-send\.ps1') {
            Write-Host "worker-observable sender missing journaled-worker-send transport: $rel"
            exit 1
        }
        if ($body -notmatch 'Set-WorkerNudgeClaimMessageContentHash') {
            Write-Host "worker-observable sender missing message hash persistence: $rel"
            exit 1
        }
        if ($body -notmatch '(?s)if\s*\(\s*-not\s+\$hashPersist\.ok\s*\)\s*\{.*?Release-WorkerNudgeActiveClaim') {
            Write-Host "worker-observable sender missing claim release on hash persist failure: $rel"
            exit 1
        }
    }
    if ($rel -eq 'scripts/ci-failure-notification-reconcile.ps1') {
        if ($body -match '(?m)^\s*& ao @sendArgs') {
            Write-Host "ci-failure-notification-reconcile still invokes raw ao send"
            exit 1
        }
    }
    if ($rel -eq 'scripts/review-finding-delivery-confirm.ps1' -or $rel -eq 'scripts/review-send-reconcile.ps1') {
        if ($body -notmatch 'Set-WorkerNudgeClaimSendAttempted') {
            Write-Host "review sender missing Set-WorkerNudgeClaimSendAttempted: $rel"
            exit 1
        }
    }
}

Write-Host '[PASS] worker nudge gate wiring'
exit 0
