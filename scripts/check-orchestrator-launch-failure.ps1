#requires -Version 5.1
<#
.SYNOPSIS
  Offline check for orchestrator prompt-delivery launch failure signatures (Issue #91).

.DESCRIPTION
  Same Signature A/B detection as worker Issue #63; fixtures live under
  tests/fixtures/orchestrator-launch-failure/.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$FixturePath,
    [switch]$ExpectMatch,
    [switch]$ExpectNoMatch
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Test-WorkerLaunchFailure.ps1')

if (-not (Test-Path -LiteralPath $FixturePath -PathType Leaf)) {
    Write-Host "[FAIL] Fixture not found: $FixturePath"
    exit 1
}

$text = Get-Content -LiteralPath $FixturePath -Raw -Encoding UTF8
$result = Get-WorkerLaunchFailureSignature -Text $text
$matched = $result.IsLaunchFailure

if ($ExpectMatch -and -not $matched) {
    Write-Host "[FAIL] Expected orchestrator launch-failure match: $FixturePath"
    exit 1
}
if ($ExpectNoMatch -and $matched) {
    Write-Host "[FAIL] Expected no orchestrator launch-failure match: $FixturePath (got $($result.Signature))"
    exit 1
}

if ($matched) {
    Write-Host "[PASS] Orchestrator launch-failure detected ($($result.Signature)): $(Split-Path -Leaf $FixturePath)"
    foreach ($m in $result.Messages) { Write-Host "       $m" }
    exit 0
}

Write-Host "[PASS] No orchestrator launch-failure signature: $(Split-Path -Leaf $FixturePath)"
exit 0
