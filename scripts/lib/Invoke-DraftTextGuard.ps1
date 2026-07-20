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
        $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $node) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
        $nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
        if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion. Install/use Node 22 and run npm run check:node-major." }
        $typeScriptLauncher = (Join-Path $Root 'scripts/lib/Invoke-TypeScriptCli.ts')
        $nodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $GuardScript, '--')
        & $node.Source @nodeArgs `
            --text-file (Resolve-Path $DraftPath).Path `
            --draft-path (Resolve-Path $DraftPath).Path `
            --repo-root $Root
        return $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
