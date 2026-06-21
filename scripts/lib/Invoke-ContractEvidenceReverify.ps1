#requires -Version 5.1
<#
.SYNOPSIS
  Trusted-base implementation for checkpoint-2 contract-evidence re-verification (Issue #376).
#>
param(
    [string]$RepoRoot,
    [string]$TrustedBaseRoot,
    [string]$ReviewTargetRoot,
    [string]$ManifestPath,
    [Parameter(Mandatory)]
    [string]$SnapshotFile,
    [string]$CurrentIssueFile,
    [string]$PrBodyFile,
    [int]$ExplicitIssue = 0,
    [int]$DeclarationIssue = 0,
    [int]$ExpectedIssue = 0,
    [string]$PrHeadSha,
    [string]$ChangedPathsFile,
    [int]$TimeoutMs = 0,
    [switch]$SimulateCrashBeforeFirstRow,
    [int]$SimulateCrashAfterRow = -1,
    [switch]$ForceProducerUnreachable,
    [switch]$Summary,
    [switch]$Text
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Import-TrustedReverifyBootstrap.ps1')

$packRoot = if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
} else {
    $RepoRoot
}
$reviewTargetRoot = if ([string]::IsNullOrWhiteSpace($ReviewTargetRoot)) {
    $packRoot
} else {
    $ReviewTargetRoot
}

function Write-TrustedRunnerUnavailableSummary {
    param([string]$Detail)
    @"
## Checkpoint-2 contract-evidence re-verification (candidate evidence only)

run-outcome: check-error
issue: n/a
snapshot-hash: n/a
snapshot-drift: false
pr-head-sha: n/a
never-blocks: true

rows: none
reason: trusted-runner-unavailable
detail: $Detail
"@ | Write-Output
}

$scriptBootstrap = $null
$trustedBaseRoot = $null
$disposableTrustedRoot = $false
$disposableScriptBootstrapRoot = $false

try {
    $scriptBootstrap = Import-TrustedReverifyBootstrap -ReviewTargetRoot $reviewTargetRoot -TrustedBaseRoot $TrustedBaseRoot
    $disposableScriptBootstrapRoot = [bool]$scriptBootstrap.DisposableBootstrapRoot
    $runnerTrustedBase = if (-not [string]::IsNullOrWhiteSpace($TrustedBaseRoot)) {
        $TrustedBaseRoot
    } else {
        $scriptBootstrap.BootstrapRoot
    }

    try {
        $trusted = Resolve-TrustedPackRunner -ReviewTargetRoot $reviewTargetRoot -TrustedBaseRoot $runnerTrustedBase
    }
    catch {
        if ($_.Exception.Message -match 'trusted runner unavailable|missing trusted runner') {
            if ($Summary -or $Text) {
                Write-TrustedRunnerUnavailableSummary -Detail $_.Exception.Message
                exit 0
            }
        }
        throw
    }
    $trustedBaseRoot = $trusted.TrustedBaseRoot
    $runner = $trusted.RunnerPath
    $disposableTrustedRoot = [bool]$trusted.DisposableTrustedRoot

    $args = @(
        $runner,
        '--repo-root', $reviewTargetRoot,
        '--trusted-base-root', $trustedBaseRoot,
        '--review-target-root', $reviewTargetRoot,
        '--snapshot-file', $SnapshotFile
    )

    if ($ManifestPath) { $args += @('--manifest-path', $ManifestPath) }
    if ($CurrentIssueFile) { $args += @('--current-issue-file', $CurrentIssueFile) }
    if ($PrBodyFile) { $args += @('--pr-body-file', $PrBodyFile) }
    if ($ExplicitIssue -gt 0) { $args += @('--explicit-issue', [string]$ExplicitIssue) }
    if ($DeclarationIssue -gt 0) { $args += @('--declaration-issue', [string]$DeclarationIssue) }
    if ($ExpectedIssue -gt 0) { $args += @('--expected-issue', [string]$ExpectedIssue) }
    if ($PrHeadSha) { $args += @('--pr-head-sha', $PrHeadSha) }
    if ($ChangedPathsFile) { $args += @('--changed-paths-file', $ChangedPathsFile) }
    if ($TimeoutMs -gt 0) { $args += @('--timeout-ms', [string]$TimeoutMs) }
    if ($SimulateCrashBeforeFirstRow) { $args += '--simulate-crash-before-first-row' }
    if ($SimulateCrashAfterRow -ge 0) {
        $args += @('--simulate-crash-after-row', [string]$SimulateCrashAfterRow)
    }
    if ($ForceProducerUnreachable) { $args += '--force-producer-unreachable' }
    if ($Summary -or $Text) { $args += '--summary' }

    Push-Location $reviewTargetRoot
    try {
        $tsxImport = Ensure-ReverifyWorkspaceDeps -RepoRoot $reviewTargetRoot -TrustedBaseRoot $trustedBaseRoot -WrapperName 'launch-contract-evidence-reverify.ps1'
        & node --import $tsxImport @args
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($disposableTrustedRoot -and -not [string]::IsNullOrWhiteSpace($trustedBaseRoot)) {
        Remove-Item -LiteralPath $trustedBaseRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    elseif ($disposableScriptBootstrapRoot -and $scriptBootstrap -and -not [string]::IsNullOrWhiteSpace($scriptBootstrap.BootstrapRoot)) {
        Remove-Item -LiteralPath $scriptBootstrap.BootstrapRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
