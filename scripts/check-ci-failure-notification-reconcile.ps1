#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$required = @(
  (Join-Path $Root 'docs/ci-failure-notification.mjs'),
  (Join-Path $Root 'scripts/ci-failure-notification.ps1'),
  (Join-Path $Root 'scripts/ci-failure-notification-reconcile.ps1'),
  (Join-Path $Root 'scripts/ci-failure-notification-reaction.ps1')
)
foreach ($p in $required) { if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "Missing $p" } }
$mjs = Get-Content -LiteralPath (Join-Path $Root 'docs/ci-failure-notification.mjs') -Raw
foreach ($phrase in @('evaluateLiveWorkerSuppressor', 'recordPendingEpisode', 'suppressed-live-worker', 'abandoned-superseded', "phase: 'record'")) {
  if ($mjs -notlike "*$phrase*") { throw "ci-failure-notification.mjs missing $phrase" }
}
$registry = Get-Content -LiteralPath (Join-Path $Root 'scripts/orchestrator-side-process-registry.json') -Raw | ConvertFrom-Json
if ($registry.requiredChildIds -notcontains 'ci-failure-notification-reconcile') {
  throw 'orchestrator-side-process-registry.json missing ci-failure-notification-reconcile'
}
if ($registry.requiredChildIds -notcontains 'ci-failure-notification-reaction') {
  throw 'orchestrator-side-process-registry.json missing ci-failure-notification-reaction'
}
Write-Host '[PASS] CI failure notification reconcile surface (Issue #342)'
