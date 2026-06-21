#requires -Version 5.1
<#
.SYNOPSIS
  Reviewer checkpoint-2 contract-evidence re-verification entrypoint (Issue #376).

  This file is a minimal delegator only. The implementation and bootstrap helpers
  are loaded from origin/main (or an explicit trusted root), never dot-sourced
  from the PR checkout.
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

function Resolve-TrustedReverifyInvokeScript {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$TrustedBaseRootOverride
    )

    $implementationRelativePath = 'scripts/lib/Invoke-ContractEvidenceReverify.ps1'
    $archiveRelativePaths = @(
        $implementationRelativePath,
        'scripts/lib/Import-TrustedReverifyBootstrap.ps1'
    )

    if (-not [string]::IsNullOrWhiteSpace($TrustedBaseRootOverride)) {
        $trustedRoot = (Resolve-Path -LiteralPath $TrustedBaseRootOverride).Path
        $implementationPath = Join-Path $trustedRoot $implementationRelativePath
        if (-not (Test-Path -LiteralPath $implementationPath)) {
            throw "trusted invoke unavailable: missing implementation at $implementationPath"
        }
        return @{
            ScriptPath              = $implementationPath
            DisposableBootstrapRoot = $false
            BootstrapRoot           = $null
        }
    }

    if ($env:AO_TRUSTED_PACK_ROOT) {
        $trustedRoot = (Resolve-Path -LiteralPath $env:AO_TRUSTED_PACK_ROOT).Path
        $implementationPath = Join-Path $trustedRoot $implementationRelativePath
        if (-not (Test-Path -LiteralPath $implementationPath)) {
            throw "trusted invoke unavailable: missing implementation at $implementationPath"
        }
        return @{
            ScriptPath              = $implementationPath
            DisposableBootstrapRoot = $false
            BootstrapRoot           = $null
        }
    }

    $resolvedReviewTarget = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("opk-trusted-invoke-{0}" -f ([Guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null

    Push-Location $resolvedReviewTarget
    try {
        git archive origin/main -- @archiveRelativePaths 2>$null | tar -x -C $temp 2>$null
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
            throw 'trusted invoke unavailable: could not extract implementation from origin/main archive'
        }
    }
    finally {
        Pop-Location
    }

    $implementationPath = Join-Path $temp $implementationRelativePath
    if (Test-Path -LiteralPath $implementationPath) {
        return @{
            ScriptPath              = $implementationPath
            DisposableBootstrapRoot = $true
            BootstrapRoot           = $temp
        }
    }

    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue

    $headImplementationPath = Join-Path $resolvedReviewTarget $implementationRelativePath
    if (Test-Path -LiteralPath $headImplementationPath) {
        Write-Warning 'reverify invoke bootstrap: implementation absent on origin/main; using review-target copy (one-time until merge)'
        return @{
            ScriptPath              = $headImplementationPath
            DisposableBootstrapRoot = $false
            BootstrapRoot           = $null
        }
    }

    throw "trusted invoke unavailable: archive and review-target are both missing $implementationRelativePath"
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

$resolvedInvoke = $null
$disposableInvokeBootstrapRoot = $false

try {
    $resolvedInvoke = Resolve-TrustedReverifyInvokeScript -ReviewTargetRoot $reviewTargetRoot -TrustedBaseRootOverride $TrustedBaseRoot
    $disposableInvokeBootstrapRoot = [bool]$resolvedInvoke.DisposableBootstrapRoot

    & $resolvedInvoke.ScriptPath @PSBoundParameters
    exit $LASTEXITCODE
}
finally {
    if ($disposableInvokeBootstrapRoot -and $resolvedInvoke -and -not [string]::IsNullOrWhiteSpace($resolvedInvoke.BootstrapRoot)) {
        Remove-Item -LiteralPath $resolvedInvoke.BootstrapRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
