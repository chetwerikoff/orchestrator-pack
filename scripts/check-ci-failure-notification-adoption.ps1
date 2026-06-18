#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$liveYaml = Join-Path $Root 'agent-orchestrator.yaml'
if (-not (Test-Path -LiteralPath $liveYaml -PathType Leaf)) {
    Write-Host '[SKIP] live agent-orchestrator.yaml not present — adoption gate requires operator checkout'
    exit 0
}
$raw = Get-Content -LiteralPath $liveYaml -Raw
$workerStateOk = $raw -match 'workerState|sessions.*openPrs|ao status --json --reports full'
$dispatchOk = $raw -match 'Register-WorkerMessageDispatch|worker-message-dispatch|ci-failure-notification-reconcile'
$result = @{
    workerStateInputConfigured = [bool]$workerStateOk
    durableSubmitAckConfigured = [bool]$dispatchOk
} | ConvertTo-Json -Compress
$result | pwsh -NoProfile -File (Join-Path $Root 'scripts/ci-failure-notification.ps1') -Mode init-gate
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host '[PASS] live YAML ci-failed adoption gate (Issue #342)'
