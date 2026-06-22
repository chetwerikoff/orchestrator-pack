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

. (Join-Path $PSScriptRoot 'lib/TrustedPackRoot-Common.ps1')

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

function Resolve-TrustedReverifyCoreScript {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$TrustedBaseRootOverride
    )

    $coreRelativePath = 'scripts/lib/Contract-EvidenceReverify-Core.ps1'
    $archiveRelativePaths = @(
        $coreRelativePath,
        'scripts/lib/Import-TrustedReverifyBootstrap.ps1',
        'scripts/lib/TrustedPackRoot-Common.ps1',
        'scripts/lib/Resolve-TrustedPackRoot.ps1',
        'scripts/lib/Ensure-ReverifyWorkspaceDeps.ps1'
    )

    if (-not [string]::IsNullOrWhiteSpace($TrustedBaseRootOverride)) {
        $trustedRoot = (Resolve-Path -LiteralPath $TrustedBaseRootOverride).Path
        Assert-TrustedRootOverrideEligible -TrustedRoot $trustedRoot -ReviewTargetRoot $ReviewTargetRoot
        $corePath = Join-Path $trustedRoot $coreRelativePath
        if (-not (Test-Path -LiteralPath $corePath)) {
            throw "trusted reverify unavailable: missing core implementation at $corePath"
        }
        return @{
            CoreScriptPath          = $corePath
            DisposableBootstrapRoot = $false
            BootstrapRoot           = $null
        }
    }

    if ($env:AO_TRUSTED_PACK_ROOT) {
        $trustedRoot = (Resolve-Path -LiteralPath $env:AO_TRUSTED_PACK_ROOT).Path
        Assert-TrustedRootOverrideEligible -TrustedRoot $trustedRoot -ReviewTargetRoot $ReviewTargetRoot
        $corePath = Join-Path $trustedRoot $coreRelativePath
        if (-not (Test-Path -LiteralPath $corePath)) {
            throw "trusted reverify unavailable: missing core implementation at $corePath"
        }
        return @{
            CoreScriptPath          = $corePath
            DisposableBootstrapRoot = $false
            BootstrapRoot           = $null
        }
    }

    $resolvedReviewTarget = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("opk-trusted-reverify-{0}" -f ([Guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null

    foreach ($gitRef in @('origin/main', 'HEAD')) {
        Get-ChildItem -LiteralPath $temp -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        Push-Location $resolvedReviewTarget
        try {
            git archive $gitRef -- @archiveRelativePaths 2>$null | tar -x -C $temp 2>$null
            if ($LASTEXITCODE -ne 0) {
                continue
            }
        }
        finally {
            Pop-Location
        }

        $corePath = Join-Path $temp $coreRelativePath
        if (Test-Path -LiteralPath $corePath) {
            if ($gitRef -eq 'HEAD') {
                Write-Warning 'trusted reverify bootstrap: core absent on origin/main; using archived review-target copy outside review tree (fixture/e2e only)'
            }
            return @{
                CoreScriptPath          = $corePath
                DisposableBootstrapRoot = $true
                BootstrapRoot           = $temp
            }
        }
    }

    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    throw 'trusted reverify unavailable: could not extract implementation from origin/main or HEAD archive'
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
    $resolvedImplementation = Resolve-TrustedReverifyCoreScript `
        -ReviewTargetRoot $reviewTargetRoot `
        -TrustedBaseRootOverride $launcherTrustedBase
    $disposableImplementationBootstrapRoot = [bool]$resolvedImplementation.DisposableBootstrapRoot

    . $resolvedImplementation.CoreScriptPath
    Invoke-ContractEvidenceReverifyCore @PSBoundParameters
    exit $LASTEXITCODE
}
finally {
    if ($disposableImplementationBootstrapRoot -and $resolvedImplementation -and -not [string]::IsNullOrWhiteSpace($resolvedImplementation.BootstrapRoot)) {
        Remove-Item -LiteralPath $resolvedImplementation.BootstrapRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
