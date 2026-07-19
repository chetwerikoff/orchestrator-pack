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
        . (Join-Path $Root 'scripts/lib/Invoke-TypeScriptCli.ps1')
        $nodeArgs = Get-OpkTypeScriptNodeArguments -ScriptPath $GuardScript
        & node @nodeArgs `
            --text-file (Resolve-Path $DraftPath).Path `
            --draft-path (Resolve-Path $DraftPath).Path `
            --repo-root $Root
        return $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
