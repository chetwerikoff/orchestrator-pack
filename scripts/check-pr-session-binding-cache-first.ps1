#requires -Version 5.1
<#
.SYNOPSIS
  Static guard for Issue #719: named consumers must consult pr-session-binding-cache
  before daemon PR-discovery fallback. Behavioral matrix lives in
  scripts/pr-session-binding-cache.test.ts.
#>
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

. (Join-Path $PSScriptRoot 'lib/Invoke-PackStaticGuardExit.ps1')

$cacheModule = Join-Path $Root 'docs/pr-session-binding-cache.mjs'
$cacheTest = Join-Path $Root 'scripts/pr-session-binding-cache.test.ts'
if (-not (Test-Path -LiteralPath $cacheModule)) {
  throw "missing pr-session-binding cache module: $cacheModule"
}
if (-not (Test-Path -LiteralPath $cacheTest)) {
  throw "missing pr-session-binding cache test: $cacheTest"
}

$consumerModules = @(
  'docs/ci-failure-notification.mjs',
  'docs/ci-green-wake-reconcile.mjs',
  'docs/review-trigger-reconcile.mjs',
  'docs/review-finding-delivery-confirm.mjs'
)

$requiredImport = "from './pr-session-binding-cache.mjs'"
$requiredSymbol = 'resolvePrSessionBindingForConsumer'

$failures = Invoke-ConsumerModuleStaticGuard -Root $Root -ConsumerModules $consumerModules -ValidateModule {
  param($rel, $text, $failures)
  if ($text -notlike "*$requiredImport*") {
    $failures.Add("$rel must import $requiredImport") | Out-Null
  }
  if ($text -notlike "*$requiredSymbol*") {
    $failures.Add("$rel must reference $requiredSymbol") | Out-Null
  }
  if ($text -match 'daemonPrDiscovery|discoverPrFromDaemon|agent-report-audit') {
    $failures.Add("$rel must not call daemon PR-discovery helpers for binding resolution") | Out-Null
  }
}

$ghWrapper = Join-Path $Root 'scripts/lib/gh-wrapper.mjs'
if (-not (Test-Path -LiteralPath $ghWrapper)) {
  $failures.Add('missing gh wrapper for push-register interception') | Out-Null
}
else {
  $wrapperText = Get-Content -LiteralPath $ghWrapper -Raw
  if ($wrapperText -notlike '*tryPushRegisterFromPrCreate*') {
    $failures.Add('scripts/lib/gh-wrapper.mjs must invoke tryPushRegisterFromPrCreate on gh pr create') | Out-Null
  }
  if ($wrapperText -notlike '*pr-session-binding-cache.mjs*') {
    $failures.Add('scripts/lib/gh-wrapper.mjs must import pr-session-binding-cache push-register helper') | Out-Null
  }
}

Complete-PackStaticGuard -Failures $failures -PassMessage '[PASS] pr-session-binding cache-first sole path (Issue #719)'
