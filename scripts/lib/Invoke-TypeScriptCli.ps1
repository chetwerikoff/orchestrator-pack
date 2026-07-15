#requires -Version 5.1

function Get-OpkTypeScriptNodeArguments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath
    )

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js is required to run TypeScript producer entrypoints.'
    }

    $nodeMajorRaw = & node -p "Number(process.versions.node.split('.')[0])"
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to determine the Node.js major version.'
    }

    [int]$nodeMajor = 0
    if (-not [int]::TryParse(($nodeMajorRaw | Out-String).Trim(), [ref]$nodeMajor)) {
        throw "Unable to parse the Node.js major version: $nodeMajorRaw"
    }

    if ($nodeMajor -ge 22) {
        return @('--experimental-strip-types', $ScriptPath)
    }

    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $loader = Join-Path $repoRoot 'scripts/toolchain/typescript-loader.mjs'
    if (-not (Test-Path -LiteralPath $loader)) {
        throw "TypeScript loader not found: $loader"
    }

    return @('--no-warnings', '--loader', $loader, $ScriptPath)
}
