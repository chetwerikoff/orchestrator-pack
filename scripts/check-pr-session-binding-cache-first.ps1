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

$ErrorActionPreference = 'Stop'

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

$forbiddenPatterns = @(
  'daemonPrDiscovery',
  'discoverPrFromDaemon',
  'agent-report-audit',
  '\.sqlite',
  'ndjson'
)

$failures = [System.Collections.Generic.List[string]]::new()

foreach ($rel in $consumerModules) {
  $path = Join-Path $Root $rel
  if (-not (Test-Path -LiteralPath $path)) {
    $failures.Add("missing consumer module: $rel") | Out-Null
    continue
  }

  $text = Get-Content -LiteralPath $path -Raw
  if ($text -notlike "*$requiredImport*") {
    $failures.Add("$rel must import $requiredImport") | Out-Null
  }
  if ($text -notlike "*$requiredSymbol*") {
    $failures.Add("$rel must reference $requiredSymbol") | Out-Null
  }

  foreach ($pattern in $forbiddenPatterns) {
    if ($text -match $pattern) {
      $failures.Add("$rel must not contain forbidden daemon/store pattern: $pattern") | Out-Null
    }
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

if ($failures.Count -gt 0) {
  foreach ($item in $failures) {
    Write-Host "[FAIL] $item"
  }
  exit 1
}

Write-Host '[PASS] pr-session-binding cache-first sole path (Issue #719)'
exit 0
