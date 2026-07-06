#requires -Version 7.0

function Invoke-DraftTextGuard {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$GuardScript,

        [Parameter(Mandatory = $true)]
        [string]$DraftPath,

        [string]$RepoRoot
    )

    $ErrorActionPreference = 'Stop'
    $libRoot = $PSScriptRoot
    $packRoot = Split-Path -Parent $libRoot
    $Root = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { Split-Path -Parent $packRoot }

    Push-Location $Root
    try {
        & node --import tsx $GuardScript `
            --text-file (Resolve-Path $DraftPath).Path `
            --draft-path (Resolve-Path $DraftPath).Path `
            --repo-root $Root
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
