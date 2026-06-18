#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$required = @(
  (Join-Path $Root 'docs/ci-failure-notification.mjs'),
  (Join-Path $Root 'scripts/ci-failure-notification.ps1')
)
foreach ($p in $required) { if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "Missing $p" } }
$example = Get-Content -LiteralPath (Join-Path $Root 'agent-orchestrator.yaml.example') -Raw
foreach ($phrase in @('CI FAILURE DISCIPLINE', 'ci-failure-notification.ps1', 'reaction.action_succeeded', 'reactionKey=ci-failed', 'episode key', 'ci-failure-notification-reconcile.ps1', 'workerState', 'suppressed-live-worker', 'phase=record')) {
  if ($example -notlike "*$phrase*") { throw "agent-orchestrator.yaml.example missing $phrase" }
}
Write-Host '[PASS] CI failure notification predicate, reconcile surface, and orchestrator rule reference (Issues #283 / #342)'
