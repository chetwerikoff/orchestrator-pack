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
$common = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Ci-Failure-Notification-Common.ps1') -Raw
$reconcile = Get-Content -LiteralPath (Join-Path $Root 'scripts/ci-failure-notification-reconcile.ps1') -Raw

if ($common -notlike '*function Get-RepoIdentity*') {
  throw 'Ci-Failure-Notification-Common.ps1 missing Get-RepoIdentity'
}
if ($reconcile -notlike '*Get-RepoIdentity*') {
  throw 'ci-failure-notification-reconcile.ps1 must resolve repo identity for reconcile ticks'
}
if ($reconcile -notlike '*dry-run would evaluate*') {
  throw 'ci-failure-notification-reconcile.ps1 must keep dry-run evaluation non-mutating'
}
if ($reconcile -notmatch 'mark-send-issued[\s\S]{0,400}Invoke-PlannedCiFailureReconcileSend') {
  throw 'ci-failure-notification-reconcile.ps1 must persist send-issued before the orchestrator side effect'
}

if ($reconcile -notmatch 'Sort-Object \{ \[long\]\$_.deliveredAtMs \} -Descending') {
  throw 'ci-failure-notification-reconcile.ps1 must select the newest dispatch journal entry by deliveredAtMs'
}
if ($reconcile -notmatch 'Test-CiFailureEpisodeDeliveryEvidence') {
  throw 'ci-failure-notification-reconcile.ps1 must gate resend skips on durable delivery evidence'
}
if ($reconcile -notmatch 'Test-CiFailureTransientPreSendHelperFailure') {
  throw 'ci-failure-notification-reconcile.ps1 must preserve transient pre-send helper failures for retry'
}
if ($reconcile -notlike '*post-intent recovery must not run pre-send CI recheck*') {
  throw 'ci-failure-notification-reconcile.ps1 missing post-intent pre-send recheck guard'
}
$registry = Get-Content -LiteralPath (Join-Path $Root 'scripts/orchestrator-side-process-registry.json') -Raw | ConvertFrom-Json
if ($registry.requiredChildIds -notcontains 'ci-failure-notification-reconcile') {
  throw 'orchestrator-side-process-registry.json missing ci-failure-notification-reconcile'
}
if ($registry.requiredChildIds -notcontains 'ci-failure-notification-reaction') {
  throw 'orchestrator-side-process-registry.json missing ci-failure-notification-reaction'
}
Write-Host '[PASS] CI failure notification reconcile surface (Issue #342)'
