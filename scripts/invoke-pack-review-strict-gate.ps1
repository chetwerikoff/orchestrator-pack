#requires -Version 5.1
<#
.SYNOPSIS
  Strict pack review gate: empty-review trap and REVIEW_COMMAND drift.

.DESCRIPTION
  Default (CI / verify.ps1): evaluates committed JSON fixtures only — no ao, gh, or network.
  -Live: reads live agent-orchestrator.yaml and Get-AoReviewRuns fan-out (operator workstation).

  Exit non-zero when the latest run violates empty-review trap or command-drift rules.
#>
[CmdletBinding()]
param(
    [string]$FixturePath = '',
    [string]$FixtureDir = '',
    [switch]$Live,
    [string]$YamlPath = '',
    [string]$ProjectId = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')

$PackRoot = Split-Path -Parent $PSScriptRoot
$DefaultFixtureDir = Join-Path $PackRoot 'tests/fixtures/pack-review-strict-gate'

function Resolve-ConfigYamlPath {
    param([string]$CliYamlPath)

    if ($CliYamlPath) {
        return (Resolve-Path -LiteralPath $CliYamlPath).Path
    }

    $live = Join-Path $PackRoot 'agent-orchestrator.yaml'
    $example = Join-Path $PackRoot 'agent-orchestrator.yaml.example'
    if (Test-Path -LiteralPath $live -PathType Leaf) {
        return $live
    }

    return $example
}

function Test-SingleFixtureGate {
    param(
        [string]$Path,
        [switch]$LiveMode
    )

    if ($LiveMode) {
        throw 'LiveMode must not be set when evaluating a committed fixture file'
    }

    $payload = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $reviewCommand = [string]$payload.reviewCommand
    if (-not $reviewCommand) {
        throw "Fixture missing reviewCommand: $Path"
    }

    $runs = @($payload.runs)
    $expectedReviewer = [string]$payload.expectedReviewer
    $violations = Get-PackReviewGateViolations -Runs $runs -ReviewCommand $reviewCommand -ExpectedReviewer $expectedReviewer -FixtureMode
    $shouldPass = $true
    if ($null -ne $payload.expectPass) {
        $shouldPass = [bool]$payload.expectPass
    }

    $passed = ($violations.Count -eq 0)
    if ($passed -eq $shouldPass) {
        return $true
    }

    $name = Split-Path -Leaf $Path
    if ($shouldPass) {
        Write-Host "[FAIL] $name — expected pass, got violations:"
    }
    else {
        Write-Host "[FAIL] $name — expected fail (negative fixture), gate passed"
    }

    foreach ($v in $violations) {
        Write-Host ("  [{0}] {1}" -f $v.Kind, $v.Message)
    }

    return $false
}

function Invoke-LiveGate {
    param(
        [string]$ConfigYaml,
        [string]$Project
    )

    $reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $ConfigYaml
    if (-not $reviewCommand) {
        Write-Host "[FAIL] Could not parse NAMED REVIEW_COMMAND from $ConfigYaml"
        return $false
    }

    $payload = Get-AoReviewRuns -Project $Project
    $runs = Get-AoReviewRunsFromPayload -Payload $payload -Project $Project

    $expectedReviewer = Get-PackReviewerFromSelector
    $violations = Get-PackReviewGateViolations -Runs $runs -ReviewCommand $reviewCommand -ExpectedReviewer $expectedReviewer
    if ($violations.Count -eq 0) {
        Write-Host '[PASS] Live strict gate: no empty-review trap, command drift, or selector mismatch on latest run'
        return $true
    }

    Write-Host '[FAIL] Live strict gate violations:'
    foreach ($v in $violations) {
        Write-Host ("  [{0}] {1}" -f $v.Kind, $v.Message)
        if ($v.Run -and $v.Run.body) {
            $line = ($v.Run.body -split "`n")[0]
            if ($line.Length -gt 120) { $line = $line.Substring(0, 117) + '...' }
            Write-Host ("           {0}" -f $line)
        }
    }

    return $false
}

if ($Live) {
    $config = Resolve-ConfigYamlPath -CliYamlPath $YamlPath
    $ok = Invoke-LiveGate -ConfigYaml $config -Project $ProjectId
    if (-not $ok) { exit 1 }
    exit 0
}

$dir = $FixtureDir
if (-not $dir) { $dir = $DefaultFixtureDir }

if ($FixturePath) {
    $paths = @((Resolve-Path -LiteralPath $FixturePath).Path)
}
else {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        Write-Host "[FAIL] Fixture directory not found: $dir"
        exit 1
    }
    $paths = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | Sort-Object Name | ForEach-Object { $_.FullName })
}

if ($paths.Count -eq 0) {
    Write-Host "[FAIL] No gate fixtures found under $dir"
    exit 1
}

$allOk = $true
foreach ($path in $paths) {
    if (-not (Test-SingleFixtureGate -Path $path)) {
        $allOk = $false
    }
}

if ($allOk) {
    Write-Host ("[PASS] Strict review gate ({0} fixture(s))" -f $paths.Count)
    exit 0
}

exit 1
