#requires -Version 5.1
<#
.SYNOPSIS
  Trusted-base entrypoint for checkpoint-2 contract-evidence re-verification (Issue #376).

  Reviewers must invoke this script from origin/main (clean main worktree,
  AO_TRUSTED_PACK_ROOT, or an origin/main archive checkout), never from the PR
  checkout under review.
#>
param(
    [string]$RepoRoot,
    [string]$TrustedBaseRoot,
    [Parameter(Mandatory)]
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

function Assert-LauncherInvokedOutsideReviewTarget {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$LauncherPath,
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot
    )

    $launcher = [IO.Path]::GetFullPath($LauncherPath)
    $reviewTarget = [IO.Path]::GetFullPath($ReviewTargetRoot).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )

    if ($launcher.Equals($reviewTarget, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'refusing PR-checkout launcher: invoke launch-contract-evidence-reverify.ps1 from trusted pack root, not the review target'
    }

    $reviewPrefix = $reviewTarget + [IO.Path]::DirectorySeparatorChar
    if ($launcher.StartsWith($reviewPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'refusing PR-checkout launcher: invoke launch-contract-evidence-reverify.ps1 from trusted pack root (origin/main worktree, AO_TRUSTED_PACK_ROOT, or origin/main archive), not from the review target'
    }
}

function Resolve-TrustedReverifyImplementationScript {
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
            throw "trusted reverify unavailable: missing implementation at $implementationPath"
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
            throw "trusted reverify unavailable: missing implementation at $implementationPath"
        }
        return @{
            ScriptPath              = $implementationPath
            DisposableBootstrapRoot = $false
            BootstrapRoot           = $null
        }
    }

    $resolvedReviewTarget = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("opk-trusted-reverify-{0}" -f ([Guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null

    Push-Location $resolvedReviewTarget
    try {
        git archive origin/main -- @archiveRelativePaths 2>$null | tar -x -C $temp 2>$null
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
            throw 'trusted reverify unavailable: could not extract implementation from origin/main archive'
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
    throw "trusted reverify unavailable: origin/main archive missing $implementationRelativePath"
}

$reviewTargetRoot = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path
Assert-LauncherInvokedOutsideReviewTarget -LauncherPath $PSCommandPath -ReviewTargetRoot $reviewTargetRoot

$packRoot = if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $reviewTargetRoot
} else {
    (Resolve-Path -LiteralPath $RepoRoot).Path
}

$resolvedImplementation = $null
$disposableImplementationBootstrapRoot = $false
$launcherTrustedBase = if (-not [string]::IsNullOrWhiteSpace($TrustedBaseRoot)) {
    (Resolve-Path -LiteralPath $TrustedBaseRoot).Path
} elseif ($env:AO_TRUSTED_PACK_ROOT) {
    (Resolve-Path -LiteralPath $env:AO_TRUSTED_PACK_ROOT).Path
} else {
    $null
}

try {
    $resolvedImplementation = Resolve-TrustedReverifyImplementationScript `
        -ReviewTargetRoot $reviewTargetRoot `
        -TrustedBaseRootOverride $launcherTrustedBase
    $disposableImplementationBootstrapRoot = [bool]$resolvedImplementation.DisposableBootstrapRoot

    & $resolvedImplementation.ScriptPath @PSBoundParameters
    exit $LASTEXITCODE
}
finally {
    if ($disposableImplementationBootstrapRoot -and $resolvedImplementation -and -not [string]::IsNullOrWhiteSpace($resolvedImplementation.BootstrapRoot)) {
        Remove-Item -LiteralPath $resolvedImplementation.BootstrapRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
