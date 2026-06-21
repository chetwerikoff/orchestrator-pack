#requires -Version 5.1
<#
.SYNOPSIS
  AO review --command entrypoint for checkpoint-2 e2e (Issue #376 AC#13).
#>
param(
    [string]$RepoRoot,
    [string]$FixtureDir = 'tests/fixtures/contract-evidence-reverify/e2e',
    [string]$ManifestPath = 'tests/fixtures/contract-evidence-reverify/capture-manifest.json',
    [int]$ExplicitIssue = 376,
    [string]$AoSessionId = ''
)

$ErrorActionPreference = 'Stop'
$packRoot = if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    Split-Path -Parent $PSScriptRoot
} else {
    $RepoRoot
}

if (-not [string]::IsNullOrWhiteSpace($AoSessionId)) {
    . (Join-Path $PSScriptRoot 'lib/Review-StartClaim.ps1')
    $mechanicalCommand = @(
        'pwsh -NoProfile -File'
        $PSCommandPath
        '-RepoRoot'
        $packRoot
        '-FixtureDir'
        $FixtureDir
        '-ManifestPath'
        $ManifestPath
        '-ExplicitIssue'
        $ExplicitIssue
    ) -join ' '
    Push-Location $packRoot
    try {
        & ao review run $AoSessionId --execute --command $mechanicalCommand
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

function Resolve-TrustedReverifyLauncherPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot
    )

    $launcherRelativePath = 'scripts/launch-contract-evidence-reverify.ps1'
    $bootstrapArchivePaths = @(
        $launcherRelativePath,
        'scripts/lib/Contract-EvidenceReverify-Core.ps1',
        'scripts/lib/Import-TrustedReverifyBootstrap.ps1',
        'scripts/lib/TrustedPackRoot-Common.ps1',
        'scripts/lib/Resolve-TrustedPackRoot.ps1',
        'scripts/lib/Ensure-ReverifyWorkspaceDeps.ps1'
    )
    $coreRelativePath = 'scripts/lib/Contract-EvidenceReverify-Core.ps1'

    foreach ($candidateRoot in @($env:AO_TRUSTED_PACK_ROOT, $env:OPK_TRUSTED_PACK_ROOT)) {
        if ([string]::IsNullOrWhiteSpace($candidateRoot)) {
            continue
        }
        $trustedRoot = (Resolve-Path -LiteralPath $candidateRoot).Path
        $launcherPath = Join-Path $trustedRoot $launcherRelativePath
        if (Test-Path -LiteralPath $launcherPath) {
            return @{
                LauncherPath            = $launcherPath
                TrustedBaseRoot         = $trustedRoot
                DisposableBootstrapRoot = $false
                BootstrapRoot           = $null
            }
        }
    }

    $resolvedReviewTarget = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path

    function New-TrustedReverifyBootstrapArchive {
        param(
            [Parameter(Mandatory)]
            [string]$GitRef,
            [Parameter(Mandatory)]
            [string]$TempPrefix
        )

        $temp = Join-Path ([IO.Path]::GetTempPath()) ("${TempPrefix}-{0}" -f ([Guid]::NewGuid().ToString('N')))
        New-Item -ItemType Directory -Path $temp -Force | Out-Null

        Push-Location $resolvedReviewTarget
        try {
            git archive $GitRef -- @bootstrapArchivePaths 2>$null | tar -x -C $temp 2>$null
            if ($LASTEXITCODE -ne 0) {
                Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
                return $null
            }
        }
        finally {
            Pop-Location
        }

        $corePath = Join-Path $temp $coreRelativePath
        if (-not (Test-Path -LiteralPath $corePath)) {
            Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
            return $null
        }

        return $temp
    }

    $temp = New-TrustedReverifyBootstrapArchive -GitRef 'origin/main' -TempPrefix 'opk-trusted-launcher'
    if (-not $temp) {
        return $null
    }

    $launcherPath = Join-Path $temp $launcherRelativePath
    if (-not (Test-Path -LiteralPath $launcherPath)) {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
        $temp = New-TrustedReverifyBootstrapArchive -GitRef 'HEAD' -TempPrefix 'opk-trusted-launcher'
        if (-not $temp) {
            return $null
        }
        $launcherPath = Join-Path $temp $launcherRelativePath
        if (-not (Test-Path -LiteralPath $launcherPath)) {
            Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
            return $null
        }
        Write-Warning 'reverify launcher bootstrap: launcher absent on origin/main; using archived review-target bootstrap copy outside review tree (fixture/e2e only)'
    }

    return @{
        LauncherPath            = $launcherPath
        TrustedBaseRoot         = $temp
        DisposableBootstrapRoot = $true
        BootstrapRoot           = $temp
    }
}

$fixtureRoot = if ([System.IO.Path]::IsPathRooted($FixtureDir)) {
    $FixtureDir
} else {
    Join-Path $packRoot $FixtureDir
}

$resolvedLauncher = $null
$disposableLauncherBootstrapRoot = $false

try {
    $resolvedLauncher = Resolve-TrustedReverifyLauncherPath -ReviewTargetRoot $packRoot
    if (-not $resolvedLauncher) {
        Write-Error 'trusted reverify launcher unavailable: set AO_TRUSTED_PACK_ROOT or land launch-contract-evidence-reverify.ps1 on origin/main'
    }
    $disposableLauncherBootstrapRoot = [bool]$resolvedLauncher.DisposableBootstrapRoot

    & $resolvedLauncher.LauncherPath `
        -RepoRoot $packRoot `
        -TrustedBaseRoot $resolvedLauncher.TrustedBaseRoot `
        -ReviewTargetRoot $packRoot `
        -ManifestPath $ManifestPath `
        -SnapshotFile (Join-Path $fixtureRoot 'issue-snapshot.md') `
        -PrBodyFile (Join-Path $fixtureRoot 'pr-body.md') `
        -ExplicitIssue $ExplicitIssue `
        -PrHeadSha 'e2e-fixture-head' `
        -Summary

    exit $LASTEXITCODE
}
finally {
    if ($disposableLauncherBootstrapRoot -and $resolvedLauncher -and -not [string]::IsNullOrWhiteSpace($resolvedLauncher.BootstrapRoot)) {
        Remove-Item -LiteralPath $resolvedLauncher.BootstrapRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
