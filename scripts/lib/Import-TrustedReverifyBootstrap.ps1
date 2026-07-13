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
        if (Test-PathInsideReviewTarget -CandidatePath $resolved -ReviewTargetRoot $ReviewTargetRoot) {
            throw 'refusing trusted-root override: trusted base equals or lies inside review target'
        }
        if (Test-Path -LiteralPath (Join-Path $resolved '.git')) {
            Assert-TrustedRootOverrideEligible -TrustedRoot $resolved -ReviewTargetRoot $ReviewTargetRoot -BaseRef $BaseRef
        }
        foreach ($relativePath in $bootstrapHelperPaths) {
            $candidate = Join-Path $resolved $relativePath
            if (-not (Test-Path -LiteralPath $candidate)) {
                throw "trusted bootstrap unavailable: missing $relativePath under $resolved"
            }
        }
        return @{
            Path                    = $resolved
            DisposableBootstrapRoot = -not (Test-Path -LiteralPath (Join-Path $resolved '.git'))
        }
    }

    if ($env:AO_TRUSTED_PACK_ROOT) {
        $resolved = (Resolve-Path -LiteralPath $env:AO_TRUSTED_PACK_ROOT).Path
        if (Test-PathInsideReviewTarget -CandidatePath $resolved -ReviewTargetRoot $ReviewTargetRoot) {
            throw 'refusing trusted-root override: trusted base equals or lies inside review target'
        }
        if (Test-Path -LiteralPath (Join-Path $resolved '.git')) {
            Assert-TrustedRootOverrideEligible -TrustedRoot $resolved -ReviewTargetRoot $ReviewTargetRoot -BaseRef $BaseRef
        }
        foreach ($relativePath in $bootstrapHelperPaths) {
            $candidate = Join-Path $resolved $relativePath
            if (-not (Test-Path -LiteralPath $candidate)) {
                throw "trusted bootstrap unavailable: missing $relativePath under $resolved"
            }
        }
        return @{
            Path                    = $resolved
            DisposableBootstrapRoot = -not (Test-Path -LiteralPath (Join-Path $resolved '.git'))
        }
    }

    if ($env:OPK_TRUSTED_PACK_ROOT) {
        $resolved = (Resolve-Path -LiteralPath $env:OPK_TRUSTED_PACK_ROOT).Path
        if (Test-PathInsideReviewTarget -CandidatePath $resolved -ReviewTargetRoot $ReviewTargetRoot) {
            throw 'refusing trusted-root override: trusted base equals or lies inside review target'
        }
        if (Test-Path -LiteralPath (Join-Path $resolved '.git')) {
            Assert-TrustedRootOverrideEligible -TrustedRoot $resolved -ReviewTargetRoot $ReviewTargetRoot -BaseRef $BaseRef
        }
        foreach ($relativePath in $bootstrapHelperPaths) {
            $candidate = Join-Path $resolved $relativePath
            if (-not (Test-Path -LiteralPath $candidate)) {
                throw "trusted bootstrap unavailable: missing $relativePath under $resolved"
            }
        }
        return @{
            Path                    = $resolved
            DisposableBootstrapRoot = -not (Test-Path -LiteralPath (Join-Path $resolved '.git'))
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

function Test-TrustedReverifyBootstrapModule {
    param($Module)

    if (-not $Module -or -not (Get-Module -Name $Module.Name)) {
        return $false
    }
    foreach ($commandName in @('Resolve-TrustedPackRunner', 'Ensure-ReverifyWorkspaceDeps')) {
        $exported = $Module.ExportedFunctions.ContainsKey($commandName)
        $visible = [bool](Get-Command $commandName -CommandType Function -ErrorAction SilentlyContinue)
        if (-not $exported -or -not $visible) {
            return $false
        }
    }
    return $true
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

    $helperPaths = @(
        (Join-Path $bootstrapRoot 'scripts/lib/Resolve-TrustedPackRoot.ps1'),
        (Join-Path $bootstrapRoot 'scripts/lib/Ensure-ReverifyWorkspaceDeps.ps1')
    )
    $module = $null
    try {
        if ($script:TrustedReverifyBootstrapModule) {
            Remove-Module -ModuleInfo $script:TrustedReverifyBootstrapModule -Force -ErrorAction SilentlyContinue
            $script:TrustedReverifyBootstrapModule = $null
        }

        $moduleName = 'TrustedReverifyBootstrap_{0}' -f ([Guid]::NewGuid().ToString('N'))
        $module = New-Module -Name $moduleName -ArgumentList (,$helperPaths) -ScriptBlock {
            param([string[]]$Paths)
            foreach ($path in $Paths) {
                . $path
            }
        }
        $importedModule = @(Import-Module -ModuleInfo $module -Global -Force -PassThru)[0]
        if (-not (Test-TrustedReverifyBootstrapModule -Module $importedModule)) {
            $missingCommands = @('Resolve-TrustedPackRunner', 'Ensure-ReverifyWorkspaceDeps') | Where-Object {
                -not $importedModule.ExportedFunctions.ContainsKey($_)
            }
            throw "trusted bootstrap module is missing required commands: $($missingCommands -join ', ')"
        }
        $script:TrustedReverifyBootstrapModule = $importedModule
    }
    catch {
        if ($module) {
            Remove-Module -ModuleInfo $module -Force -ErrorAction SilentlyContinue
        }
        $script:TrustedReverifyBootstrapModule = $null
        if ([bool]$resolved.DisposableBootstrapRoot) {
            Remove-Item -LiteralPath $bootstrapRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw "trusted bootstrap dependency load failed: $($_.Exception.Message)"
    }

    return @{
        BootstrapRoot           = $bootstrapRoot
        DisposableBootstrapRoot = [bool]$resolved.DisposableBootstrapRoot
        ModuleName              = $script:TrustedReverifyBootstrapModule.Name
    }
}
