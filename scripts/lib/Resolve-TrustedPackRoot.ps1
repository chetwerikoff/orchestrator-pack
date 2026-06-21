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

    if (-not [string]::IsNullOrWhiteSpace($TrustedBaseRoot)) {
        $trustedRoot = (Resolve-Path -LiteralPath $TrustedBaseRoot).Path
        Assert-TrustedRootOverrideEligible -TrustedRoot $trustedRoot -ReviewTargetRoot $ReviewTargetRoot -BaseRef $BaseRef
        return @{
            Path                  = $trustedRoot
            DisposableTrustedRoot = $false
        }
    }

    if ($env:AO_TRUSTED_PACK_ROOT) {
        $trustedRoot = (Resolve-Path -LiteralPath $env:AO_TRUSTED_PACK_ROOT).Path
        Assert-TrustedRootOverrideEligible -TrustedRoot $trustedRoot -ReviewTargetRoot $ReviewTargetRoot -BaseRef $BaseRef
        return @{
            Path                  = $trustedRoot
            DisposableTrustedRoot = $false
        }
    }

    $resolvedReviewTarget = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path
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

    throw "trusted runner unavailable: could not resolve trusted pack root from main worktree or ${BaseRef} archive (refusing PR-head fallback)"
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
