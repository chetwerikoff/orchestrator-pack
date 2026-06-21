#requires -Version 5.1
<#
.SYNOPSIS
  Reviewer checkpoint-2 contract-evidence re-verification owner (Issue #376).
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
. (Join-Path $PSScriptRoot 'lib/Resolve-TrustedPackRoot.ps1')
. (Join-Path $PSScriptRoot 'lib/Install-PackReviewDependencies.ps1')

$packRoot = if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    Split-Path -Parent $PSScriptRoot
} else {
    $RepoRoot
}
$reviewTargetRoot = if ([string]::IsNullOrWhiteSpace($ReviewTargetRoot)) {
    $packRoot
} else {
    $ReviewTargetRoot
}

$trusted = Resolve-TrustedPackRunner -ReviewTargetRoot $reviewTargetRoot -TrustedBaseRoot $TrustedBaseRoot
$trustedBaseRoot = $trusted.TrustedBaseRoot
$runner = $trusted.RunnerPath

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
    Install-PackReviewDependencies -WrapperName 'invoke-contract-evidence-reverify.ps1'
    & node --import tsx @args
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
