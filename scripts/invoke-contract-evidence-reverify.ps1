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

function Import-TrustedReverifyBootstrapModule {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$TrustedBaseRootOverride
    )

    $moduleRelativePath = 'scripts/lib/Import-TrustedReverifyBootstrap.ps1'

    if (-not [string]::IsNullOrWhiteSpace($TrustedBaseRootOverride)) {
        $bootstrapRoot = (Resolve-Path -LiteralPath $TrustedBaseRootOverride).Path
        $modulePath = Join-Path $bootstrapRoot $moduleRelativePath
        if (-not (Test-Path -LiteralPath $modulePath)) {
            throw "trusted bootstrap unavailable: missing bootstrap module at $modulePath"
        }
        . $modulePath
        return @{
            BootstrapRoot           = $bootstrapRoot
            DisposableBootstrapRoot = $false
        }
    }

    if ($env:AO_TRUSTED_PACK_ROOT) {
        $bootstrapRoot = (Resolve-Path -LiteralPath $env:AO_TRUSTED_PACK_ROOT).Path
        $modulePath = Join-Path $bootstrapRoot $moduleRelativePath
        if (-not (Test-Path -LiteralPath $modulePath)) {
            throw "trusted bootstrap unavailable: missing bootstrap module at $modulePath"
        }
        . $modulePath
        return @{
            BootstrapRoot           = $bootstrapRoot
            DisposableBootstrapRoot = $false
        }
    }

    $temp = Join-Path ([IO.Path]::GetTempPath()) ("opk-trusted-bootstrap-module-{0}" -f ([Guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null

    Push-Location $ReviewTargetRoot
    try {
        git archive origin/main -- $moduleRelativePath 2>$null | tar -x -C $temp 2>$null
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
            throw 'trusted bootstrap unavailable: could not extract bootstrap module from origin/main archive'
        }
    }
    finally {
        Pop-Location
    }

    $modulePath = Join-Path $temp $moduleRelativePath
    if (-not (Test-Path -LiteralPath $modulePath)) {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
        throw "trusted bootstrap unavailable: archive missing bootstrap module at $moduleRelativePath"
    }

    . $modulePath
    return @{
        BootstrapRoot           = $temp
        DisposableBootstrapRoot = $true
    }
}

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

$moduleBootstrap = $null
$scriptBootstrap = $null
$trustedBaseRoot = $null
$disposableTrustedRoot = $false
$disposableScriptBootstrapRoot = $false
$disposableModuleBootstrapRoot = $false

try {
    $moduleBootstrap = Import-TrustedReverifyBootstrapModule -ReviewTargetRoot $reviewTargetRoot -TrustedBaseRootOverride $TrustedBaseRoot
    $disposableModuleBootstrapRoot = [bool]$moduleBootstrap.DisposableBootstrapRoot

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
        $tsxImport = Ensure-ReverifyWorkspaceDeps -RepoRoot $reviewTargetRoot -TrustedBaseRoot $trustedBaseRoot -WrapperName 'invoke-contract-evidence-reverify.ps1'
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

    if ($disposableModuleBootstrapRoot -and $moduleBootstrap -and -not [string]::IsNullOrWhiteSpace($moduleBootstrap.BootstrapRoot)) {
        Remove-Item -LiteralPath $moduleBootstrap.BootstrapRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
