#requires -Version 5.1
<#
.SYNOPSIS
  Pack scripted PR-review post-submit delivery seam (Issue #669).

.DESCRIPTION
  Called after ao review submit in the scripted review path. Runs the confirmed-delivery
  gate before any explicit journaled-worker-send.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$RunId,
    [string]$BatchId = '',
    [Parameter(Mandatory = $true)][int]$PrNumber,
    [Parameter(Mandatory = $true)][string]$TargetSha,
    [Parameter(Mandatory = $true)][ValidateSet('approved', 'changes_requested')][string]$Verdict,
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [int]$PollWindowSeconds = 0,
    [int]$PollIntervalSeconds = 0,
    [string]$FixtureReviewsPath = '',
    [string]$FixtureSessionsPath = '',
    [string]$FixtureOpenPrsPath = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$gateScript = Join-Path $PSScriptRoot 'scripted-review-confirmed-delivery-gate.ps1'
if (-not (Test-Path -LiteralPath $gateScript -PathType Leaf)) {
    throw "Missing $gateScript"
}

$gateArgs = @{
    SessionId           = $SessionId
    RunId               = $RunId
    BatchId             = $BatchId
    PrNumber            = $PrNumber
    TargetSha           = $TargetSha
    Verdict             = $Verdict
    ProjectId           = $ProjectId
    PollWindowSeconds   = $PollWindowSeconds
    PollIntervalSeconds = $PollIntervalSeconds
    FixtureReviewsPath  = $FixtureReviewsPath
    FixtureSessionsPath = $FixtureSessionsPath
    FixtureOpenPrsPath  = $FixtureOpenPrsPath
    DryRun              = $DryRun
}
if ($RepoRoot) { $gateArgs.RepoRoot = $RepoRoot }

$payload = [Console]::In.ReadToEnd()
if ($null -eq $payload) { $payload = '' }

$payload | pwsh -NoProfile -File $gateScript @gateArgs
exit $LASTEXITCODE
