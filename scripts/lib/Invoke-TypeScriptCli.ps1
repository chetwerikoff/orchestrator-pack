#requires -Version 5.1

function Invoke-OpkNodeRuntimePreflight {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$NodeCommand
    )

    $checkPath = Join-Path $RepoRoot 'scripts/toolchain/check-node-major.mjs'
    if (-not (Test-Path -LiteralPath $checkPath -PathType Leaf)) {
        throw "OPK_NODE_RUNTIME_CHECK_MISSING: canonical runtime check not found: $checkPath"
    }

    $checkOutput = @(& $NodeCommand $checkPath '--repo-root' $RepoRoot '--quiet' 2>&1)
    $checkExitCode = $LASTEXITCODE
    if ($checkExitCode -ne 0) {
        $detail = (($checkOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
        if (-not $detail) {
            $detail = "canonical Node.js runtime check exited $checkExitCode"
        }
        throw $detail
    }
}

function Get-OpkTypeScriptNodeArguments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath
    )

    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) {
        throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints. Install/use Node 22, then run "npm run check:node-major".'
    }

    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    Invoke-OpkNodeRuntimePreflight -RepoRoot $repoRoot -NodeCommand $node.Source

    return @('--experimental-strip-types', $ScriptPath)
}
