#requires -Version 5.1
<#
.SYNOPSIS
  Static sole-path guard for Issue #699: issue→PR correlation stays inside
  docs/session-pr-binding-resolver.mjs. Behavioral coverage lives in
  scripts/session-pr-binding-resolver.test.ts (Vitest CI lanes).
#>
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

$resolverModule = Join-Path $Root 'docs/session-pr-binding-resolver.mjs'
$guardTest = Join-Path $Root 'scripts/session-pr-binding-resolver.test.ts'
if (-not (Test-Path -LiteralPath $resolverModule)) {
  throw "missing session-pr-binding resolver module: $resolverModule"
}
if (-not (Test-Path -LiteralPath $guardTest)) {
  throw "missing session-pr-binding resolver test: $guardTest"
}

$consumerModules = @(
  'docs/ci-failure-notification.mjs',
  'docs/ci-green-wake-reconcile.mjs',
  'docs/review-trigger-reconcile.mjs',
  'docs/review-trigger-reeval.mjs',
  'docs/review-ready-report-state-seed.mjs',
  'docs/review-ready-stuck-guard.mjs',
  'docs/review-finding-delivery-confirm.mjs',
  'docs/review-wake-trigger.mjs',
  'docs/worker-nudge-gate.mjs'
)

$forbiddenPatterns = @(
  'issueLinkedWorkerBranchLiterals',
  'headRefCorrelatesToIssue',
  'listIssueCorrelatedOpenPrs',
  'feat/${',
  'issue-${'
)

$failures = [System.Collections.Generic.List[string]]::new()

foreach ($rel in $consumerModules) {
  $path = Join-Path $Root $rel
  if (-not (Test-Path -LiteralPath $path)) {
    $failures.Add("missing consumer module: $rel") | Out-Null
    continue
  }

  $text = Get-Content -LiteralPath $path -Raw
  foreach ($pattern in $forbiddenPatterns) {
    if ($text -match [regex]::Escape($pattern)) {
      $failures.Add("$rel must not contain forbidden sole-path pattern: $pattern") | Out-Null
    }
  }
}

if ($failures.Count -gt 0) {
  foreach ($item in $failures) {
    Write-Host "[FAIL] $item"
  }
  exit 1
}

Write-Host '[PASS] session-pr-binding sole-path contract (static guard)'
exit 0
