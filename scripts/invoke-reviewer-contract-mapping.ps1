#requires -Version 5.1
<#
.SYNOPSIS
  Reviewer-only contract-mapping preflight owner (Issue #362).
#>
param(
    [Parameter(Mandatory)]
    [string]$DiffFile,
    [string]$IssueFile,
    [string]$IssuesFile,
    [string[]]$IssueSpec,
    [string]$PrBodyFile,
    [string]$ChangedPathsFile,
    [int]$ExplicitIssue = 0,
    [int]$DeclarationIssue = 0,
    [string]$PrHeadSha,
    [string]$LedgerFile,
    [switch]$InvokeCoworker,
    [switch]$LookupUnavailable,
    [switch]$CoworkerUnavailable,
    [int]$ProviderInputByteLimit = 0,
    [switch]$Text
)

$ErrorActionPreference = 'Stop'
$packRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'invoke-reviewer-contract-mapping.ts'

if (-not (Test-Path -LiteralPath $runner)) {
    Write-Error "missing $runner"
}

$args = @(
    $runner,
    '--diff-file', $DiffFile
)

if ($IssueFile) { $args += @('--issue-file', $IssueFile) }
if ($IssuesFile) { $args += @('--issues-file', $IssuesFile) }
if ($IssueSpec) {
    foreach ($spec in $IssueSpec) {
        $args += @('--issue-spec', $spec)
    }
}
if ($PrBodyFile) { $args += @('--pr-body-file', $PrBodyFile) }
if ($ChangedPathsFile) { $args += @('--changed-paths-file', $ChangedPathsFile) }
if ($ExplicitIssue -gt 0) { $args += @('--explicit-issue', [string]$ExplicitIssue) }
if ($DeclarationIssue -gt 0) { $args += @('--declaration-issue', [string]$DeclarationIssue) }
if ($PrHeadSha) { $args += @('--pr-head-sha', $PrHeadSha) }
if ($LedgerFile) { $args += @('--ledger-file', $LedgerFile) }
if ($InvokeCoworker) { $args += '--invoke-coworker' }
if ($LookupUnavailable) { $args += '--lookup-unavailable' }
if ($CoworkerUnavailable) { $args += '--coworker-unavailable' }
if ($ProviderInputByteLimit -gt 0) {
    $args += @('--provider-input-byte-limit', [string]$ProviderInputByteLimit)
}
if ($Text) { $args += '--text' }

Push-Location $packRoot
try {
    & node --import tsx @args
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
