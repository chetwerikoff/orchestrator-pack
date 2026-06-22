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
# AC#13 e2e runs before launch-contract-evidence-reverify.ps1 lands on origin/main.
$env:OPK_REVERIFY_E2E_REQUIRED = '1'
. (Join-Path $PSScriptRoot 'lib/TrustedPackRoot-Common.ps1')
$packRoot = if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    Split-Path -Parent $PSScriptRoot
} else {
    $RepoRoot
}

$e2ePrNumber = 9380
$e2eHeadSha = 'e2e0000000000000000000000000000000000000'
$e2eIssueNumber = $ExplicitIssue
$fixtureRoot = if ([System.IO.Path]::IsPathRooted($FixtureDir)) {
    $FixtureDir
} else {
    Join-Path $packRoot $FixtureDir
}
$issueBodyFile = Join-Path $fixtureRoot 'issue-snapshot.md'
$boundSnapshotStore = Join-Path ([IO.Path]::GetTempPath()) ("opk-e2e-bound-snapshot-{0}" -f ([Guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Path $boundSnapshotStore -Force | Out-Null
$env:OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR = $boundSnapshotStore

Push-Location $packRoot
try {
    & node --import tsx (Join-Path $packRoot 'scripts/bound-issue-snapshot-cli.ts') capture `
        --pr-number $e2ePrNumber `
        --pr-head-sha $e2eHeadSha `
        --issue-number $e2eIssueNumber `
        --issue-body-file $issueBodyFile | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'failed to capture e2e bound issue snapshot'
    }
}
finally {
    Pop-Location
}

$resolvedSnapshotFile = & pwsh -NoProfile -File (Join-Path $packRoot 'scripts/resolve-bound-issue-snapshot.ps1') `
    -PrNumber $e2ePrNumber `
    -PrHeadSha $e2eHeadSha `
    -IssueNumber $e2eIssueNumber `
    -Require
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolvedSnapshotFile)) {
    Write-Error 'failed to resolve e2e bound issue snapshot'
}

$changedPathsFile = Join-Path ([IO.Path]::GetTempPath()) ("opk-e2e-changed-paths-{0}.txt" -f ([Guid]::NewGuid().ToString('N')))
# Simulate an implementation-only PR diff; must not list trusted checker or capture paths.
[System.IO.File]::WriteAllLines($changedPathsFile, @('docs/migration_notes.md'))

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
        if (Test-PathInsideReviewTarget -CandidatePath $trustedRoot -ReviewTargetRoot $ReviewTargetRoot) {
            continue
        }
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
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("opk-trusted-launcher-{0}" -f ([Guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null

    Push-Location $resolvedReviewTarget
    try {
        git archive origin/main -- @bootstrapArchivePaths 2>$null | tar -x -C $temp 2>$null
    }
    finally {
        Pop-Location
    }

    $launcherPath = Join-Path $temp $launcherRelativePath
    $corePath = Join-Path $temp $coreRelativePath
    if (-not (Test-Path -LiteralPath $launcherPath) -or -not (Test-Path -LiteralPath $corePath)) {
        if ($env:OPK_REVERIFY_E2E_REQUIRED -eq '1') {
            if (Test-Path -LiteralPath $temp) {
                Remove-ImplementingPrScriptsBootstrap -DestinationRoot $temp
            }
            if (Copy-ImplementingPrScriptsBootstrap -ReviewTargetRoot $resolvedReviewTarget -DestinationRoot $temp) {
                $launcherPath = Join-Path $temp $launcherRelativePath
                $corePath = Join-Path $temp $coreRelativePath
            }
        }
    }

    if (-not (Test-Path -LiteralPath $launcherPath) -or -not (Test-Path -LiteralPath $corePath)) {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
        return $null
    }

    return @{
        LauncherPath            = $launcherPath
        TrustedBaseRoot         = $temp
        DisposableBootstrapRoot = $true
        BootstrapRoot           = $temp
    }
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
        -PrNumber $e2ePrNumber `
        -SnapshotFile $resolvedSnapshotFile.Trim() `
        -PrBodyFile (Join-Path $fixtureRoot 'pr-body.md') `
        -ExplicitIssue $ExplicitIssue `
        -PrHeadSha $e2eHeadSha `
        -ChangedPathsFile $changedPathsFile `
        -Summary

    exit $LASTEXITCODE
}
finally {
    if ($disposableLauncherBootstrapRoot -and $resolvedLauncher -and -not [string]::IsNullOrWhiteSpace($resolvedLauncher.BootstrapRoot)) {
        Remove-ImplementingPrScriptsBootstrap -DestinationRoot $resolvedLauncher.BootstrapRoot
    }
}
