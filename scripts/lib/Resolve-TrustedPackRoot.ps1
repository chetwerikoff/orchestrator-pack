#requires -Version 5.1
<#
.SYNOPSIS
  Resolve the trusted pack root for reviewer checkpoint-2 (Issue #376).
#>
. (Join-Path $PSScriptRoot 'TrustedPackRoot-Common.ps1')

function Resolve-TrustedPackRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$TrustedBaseRoot,
        [string]$BootstrapCheckerRelativePath = 'scripts/invoke-contract-evidence-reverify.ts',
        [string]$BaseRef = 'origin/main'
    )

    $resolvedReviewTarget = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path

    if (-not [string]::IsNullOrWhiteSpace($TrustedBaseRoot)) {
        $trustedRoot = (Resolve-Path -LiteralPath $TrustedBaseRoot).Path
        if (Test-PathInsideReviewTarget -CandidatePath $trustedRoot -ReviewTargetRoot $ReviewTargetRoot) {
            throw 'refusing trusted-root override: trusted base equals or lies inside review target'
        }
        if (Test-Path -LiteralPath (Join-Path $trustedRoot '.git')) {
            Assert-TrustedRootOverrideEligible -TrustedRoot $trustedRoot -ReviewTargetRoot $ReviewTargetRoot -BaseRef $BaseRef
        }
        $checker = Join-Path $trustedRoot $BootstrapCheckerRelativePath
        if (-not (Test-Path -LiteralPath $checker) -and $env:OPK_REVERIFY_E2E_REQUIRED -eq '1') {
            Copy-ImplementingPrScriptsBootstrap -ReviewTargetRoot $resolvedReviewTarget -DestinationRoot $trustedRoot | Out-Null
            $checker = Join-Path $trustedRoot $BootstrapCheckerRelativePath
        }
        if (-not (Test-Path -LiteralPath $checker)) {
            throw "missing trusted runner at $checker"
        }
        return @{
            Path                  = $trustedRoot
            DisposableTrustedRoot = -not (Test-Path -LiteralPath (Join-Path $trustedRoot '.git'))
        }
    }

    if ($env:AO_TRUSTED_PACK_ROOT) {
        $trustedRoot = (Resolve-Path -LiteralPath $env:AO_TRUSTED_PACK_ROOT).Path
        if (Test-PathInsideReviewTarget -CandidatePath $trustedRoot -ReviewTargetRoot $ReviewTargetRoot) {
            throw 'refusing trusted-root override: trusted base equals or lies inside review target'
        }
        if (Test-Path -LiteralPath (Join-Path $trustedRoot '.git')) {
            Assert-TrustedRootOverrideEligible -TrustedRoot $trustedRoot -ReviewTargetRoot $ReviewTargetRoot -BaseRef $BaseRef
        }
        return @{
            Path                  = $trustedRoot
            DisposableTrustedRoot = -not (Test-Path -LiteralPath (Join-Path $trustedRoot '.git'))
        }
    }

    if ($env:OPK_TRUSTED_PACK_ROOT) {
        $trustedRoot = (Resolve-Path -LiteralPath $env:OPK_TRUSTED_PACK_ROOT).Path
        if (Test-PathInsideReviewTarget -CandidatePath $trustedRoot -ReviewTargetRoot $ReviewTargetRoot) {
            throw 'refusing trusted-root override: trusted base equals or lies inside review target'
        }
        if (Test-Path -LiteralPath (Join-Path $trustedRoot '.git')) {
            Assert-TrustedRootOverrideEligible -TrustedRoot $trustedRoot -ReviewTargetRoot $ReviewTargetRoot -BaseRef $BaseRef
        }
        return @{
            Path                  = $trustedRoot
            DisposableTrustedRoot = -not (Test-Path -LiteralPath (Join-Path $trustedRoot '.git'))
        }
    }

    $mainWorktree = Get-MainPackWorktreePath -ReviewTargetRoot $resolvedReviewTarget
    if ($mainWorktree) {
        $checker = Join-Path $mainWorktree $BootstrapCheckerRelativePath
        if ((Test-Path -LiteralPath $checker) -and (Test-TrustedMainWorktreeEligible -MainWorktreePath $mainWorktree -ReviewTargetRoot $resolvedReviewTarget -BaseRef $BaseRef)) {
            return @{
                Path                  = (Resolve-Path -LiteralPath $mainWorktree).Path
                DisposableTrustedRoot = $false
            }
        }
    }

    $archiveRoot = New-TrustedOriginMainArchiveCheckout -TempPrefix 'opk-trusted' -ReviewTargetRoot $resolvedReviewTarget -BaseRef $BaseRef
    if ($archiveRoot) {
        $checker = Join-Path $archiveRoot $BootstrapCheckerRelativePath
        if (Test-Path -LiteralPath $checker) {
            return @{
                Path                  = $archiveRoot
                DisposableTrustedRoot = $true
            }
        }
        Remove-Item -LiteralPath $archiveRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    throw "trusted runner unavailable: could not resolve trusted pack root from main worktree or ${BaseRef} archive (refusing in-tree PR-head fallback)"
}

function Resolve-TrustedPackRunner {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$TrustedBaseRoot,
        [string]$RunnerRelativePath = 'scripts/invoke-contract-evidence-reverify.ts'
    )

    $resolved = Resolve-TrustedPackRoot -ReviewTargetRoot $ReviewTargetRoot -TrustedBaseRoot $TrustedBaseRoot
    $trustedRoot = $resolved.Path
    $runner = Join-Path $trustedRoot $RunnerRelativePath
    if (-not (Test-Path -LiteralPath $runner)) {
        throw "missing trusted runner at $runner"
    }
    return @{
        TrustedBaseRoot         = $trustedRoot
        RunnerPath              = $runner
        DisposableTrustedRoot   = [bool]$resolved.DisposableTrustedRoot
    }
}
