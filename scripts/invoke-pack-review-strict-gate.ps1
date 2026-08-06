#requires -Version 5.1
<#
.SYNOPSIS
  Strict pack review fixture gate for the empty-review trap and review-command
  contract drift.

.DESCRIPTION
  Evaluates committed JSON fixtures only. Live review state is owned by the
  pack review runner/store and is not inferred from a concrete runtime config or
  transport.
#>
[CmdletBinding()]
param(
    [string]$FixturePath = '',
    [string]$FixtureDir = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')

$PackRoot = Split-Path -Parent $PSScriptRoot
$DefaultFixtureDir = Join-Path $PackRoot 'tests/fixtures/pack-review-strict-gate'

function Test-SingleFixtureGate {
    param([string]$Path)

    $payload = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $reviewCommand = [string]$payload.reviewCommand
    if (-not $reviewCommand) {
        throw "Fixture missing reviewCommand: $Path"
    }

    $runs = @($payload.runs)
    $expectedReviewer = [string]$payload.expectedReviewer
    $violations = Get-PackReviewGateViolations `
        -Runs $runs `
        -ReviewCommand $reviewCommand `
        -ExpectedReviewer $expectedReviewer `
        -FixtureMode

    $shouldPass = $true
    if ($null -ne $payload.expectPass) {
        $shouldPass = [bool]$payload.expectPass
    }

    $passed = $violations.Count -eq 0
    if ($passed -eq $shouldPass) { return $true }

    $name = Split-Path -Leaf $Path
    if ($shouldPass) {
        Write-Host "[FAIL] $name — expected pass, got violations:"
    }
    else {
        Write-Host "[FAIL] $name — expected fail (negative fixture), gate passed"
    }

    foreach ($violation in $violations) {
        Write-Host ("  [{0}] {1}" -f $violation.Kind, $violation.Message)
    }
    return $false
}

$dir = if ($FixtureDir) { $FixtureDir } else { $DefaultFixtureDir }
if ($FixturePath) {
    $paths = @((Resolve-Path -LiteralPath $FixturePath).Path)
}
else {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        Write-Host "[FAIL] Fixture directory not found: $dir"
        exit 1
    }
    $paths = @(
        Get-ChildItem -LiteralPath $dir -Filter '*.json' -File |
            Sort-Object Name |
            ForEach-Object { $_.FullName }
    )
}

if ($paths.Count -eq 0) {
    Write-Host "[FAIL] No gate fixtures found under $dir"
    exit 1
}

$allOk = $true
foreach ($path in $paths) {
    if (-not (Test-SingleFixtureGate -Path $path)) { $allOk = $false }
}

if ($allOk) {
    Write-Host ("[PASS] Strict review gate ({0} fixture(s))" -f $paths.Count)
    exit 0
}
exit 1
