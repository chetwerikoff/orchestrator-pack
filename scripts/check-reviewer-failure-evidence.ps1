#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'docs/reviewer-failure-evidence.mjs'
$result = ('{"value":{"schemaVersion":1,"reviewerSessionId":"opk-rev-a","lastPhase":"wrapper_started"}}' | node $cli assert-secret-safe | ConvertFrom-Json)
if (-not $result.ok) { throw "secret-safe self-check failed: $($result.errors -join '; ')" }

$entrypointPath = Join-Path $PSScriptRoot 'invoke-pack-review.ps1'
$entrypointText = Get-Content -LiteralPath $entrypointPath -Raw
if ($entrypointText -notmatch 'Review-FailureEvidence\.ps1') {
    throw 'invoke-pack-review.ps1 must load Review-FailureEvidence.ps1'
}
if ($entrypointText -notmatch 'Initialize-ReviewFailureEvidence') {
    throw 'invoke-pack-review.ps1 must initialize failure evidence before wrapper start'
}
if ($entrypointText -notmatch 'Get-PackReviewWrapperProcessStartInfo') {
    throw 'Review-FailureEvidence.ps1 must build wrapper argv via ProcessStartInfo.ArgumentList'
}
Write-Host 'reviewer-failure-evidence registration/config OK'
