#requires -Version 5.1
<#
.SYNOPSIS
  Load checkpoint-2 reverify PowerShell helpers from an immutable trusted base.
#>
. (Join-Path $PSScriptRoot 'TrustedPackRoot-Common.ps1')

function Get-TrustedBootstrapScriptRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$TrustedBaseRoot,
        [string]$BaseRef = 'origin/main'
    )

    $bootstrapHelperPaths = @(
        'scripts/lib/Resolve-TrustedPackRoot.ps1',
        'scripts/lib/Ensure-ReverifyWorkspaceDeps.ps1'
    )

    if (-not [string]::IsNullOrWhiteSpace($TrustedBaseRoot)) {
        $resolved = (Resolve-Path -LiteralPath $TrustedBaseRoot).Path
        foreach ($relativePath in $bootstrapHelperPaths) {
            $candidate = Join-Path $resolved $relativePath
            if (-not (Test-Path -LiteralPath $candidate)) {
                throw "trusted bootstrap unavailable: missing $relativePath under $resolved"
            }
        }
        return @{
            Path                    = $resolved
            DisposableBootstrapRoot = $false
        }
    }

    if ($env:AO_TRUSTED_PACK_ROOT) {
        $resolved = (Resolve-Path -LiteralPath $env:AO_TRUSTED_PACK_ROOT).Path
        foreach ($relativePath in $bootstrapHelperPaths) {
            $candidate = Join-Path $resolved $relativePath
            if (-not (Test-Path -LiteralPath $candidate)) {
                throw "trusted bootstrap unavailable: missing $relativePath under $resolved"
            }
        }
        return @{
            Path                    = $resolved
            DisposableBootstrapRoot = $false
        }
    }

    $resolvedReviewTarget = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path
    $mainWorktree = Get-MainPackWorktreePath -ReviewTargetRoot $resolvedReviewTarget
    if ($mainWorktree) {
        $eligible = Test-TrustedMainWorktreeEligible -MainWorktreePath $mainWorktree -ReviewTargetRoot $resolvedReviewTarget -BaseRef $BaseRef
        if ($eligible) {
            $resolvedMain = (Resolve-Path -LiteralPath $mainWorktree).Path
            foreach ($relativePath in $bootstrapHelperPaths) {
                $candidate = Join-Path $resolvedMain $relativePath
                if (-not (Test-Path -LiteralPath $candidate)) {
                    throw "trusted bootstrap unavailable: missing $relativePath under main worktree $resolvedMain"
                }
            }
            return @{
                Path                    = $resolvedMain
                DisposableBootstrapRoot = $false
            }
        }
    }

    $archiveRoot = New-TrustedOriginMainArchiveCheckout -TempPrefix 'opk-trusted-bootstrap' -ReviewTargetRoot $resolvedReviewTarget -BaseRef $BaseRef
    if (-not $archiveRoot) {
        throw "trusted bootstrap unavailable: could not extract bootstrap helpers from ${BaseRef} archive"
    }

    foreach ($relativePath in $bootstrapHelperPaths) {
        $candidate = Join-Path $archiveRoot $relativePath
        if (-not (Test-Path -LiteralPath $candidate)) {
            Remove-Item -LiteralPath $archiveRoot -Recurse -Force -ErrorAction SilentlyContinue
            throw "trusted bootstrap unavailable: archive missing $relativePath"
        }
    }

    return @{
        Path                    = $archiveRoot
        DisposableBootstrapRoot = $true
    }
}

function Import-TrustedReverifyBootstrap {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$TrustedBaseRoot
    )

    $resolved = Get-TrustedBootstrapScriptRoot -ReviewTargetRoot $ReviewTargetRoot -TrustedBaseRoot $TrustedBaseRoot
    $bootstrapRoot = $resolved.Path

    . (Join-Path $bootstrapRoot 'scripts/lib/Resolve-TrustedPackRoot.ps1')
    . (Join-Path $bootstrapRoot 'scripts/lib/Ensure-ReverifyWorkspaceDeps.ps1')

    return @{
        BootstrapRoot           = $bootstrapRoot
        DisposableBootstrapRoot = [bool]$resolved.DisposableBootstrapRoot
    }
}
