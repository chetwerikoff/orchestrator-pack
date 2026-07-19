#requires -Version 5.1

function Enable-OpkVitestNode22Toolcache {
    [CmdletBinding()]
    param()

    # The legacy Vitest lanes still select Node 20 in workflow code that Issue #900
    # is not allowed to change. Those lanes may exercise a production PowerShell→TS
    # bridge, so the test harness must select an installed Node 22 binary rather than
    # weakening the production preflight or restoring a Node 20 loader.
    if ($env:OPK_VITEST_HARNESS -ne '1' -or $env:CI -ne 'true' -or -not $env:RUNNER_TOOL_CACHE) {
        return
    }

    $nodeRoot = Join-Path $env:RUNNER_TOOL_CACHE 'node'
    if (-not (Test-Path -LiteralPath $nodeRoot -PathType Container)) {
        return
    }

    $versionDirs = @(Get-ChildItem -LiteralPath $nodeRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^22\.' } |
        Sort-Object -Property Name -Descending)
    foreach ($versionDir in $versionDirs) {
        foreach ($relativeDir in @('x64/bin', 'x64', 'arm64/bin', 'arm64')) {
            $candidateDir = Join-Path $versionDir.FullName $relativeDir
            foreach ($fileName in @('node', 'node.exe')) {
                $candidate = Join-Path $candidateDir $fileName
                if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                    continue
                }
                $versionOutput = @(& $candidate '--version' 2>$null)
                if ($LASTEXITCODE -eq 0 -and (($versionOutput | Out-String).Trim() -match '^v22\.')) {
                    $env:PATH = "$candidateDir$([IO.Path]::PathSeparator)$env:PATH"
                    return
                }
            }
        }
    }
}

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

    Enable-OpkVitestNode22Toolcache
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) {
        throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints. Install/use Node 22, then run "npm run check:node-major".'
    }

    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    Invoke-OpkNodeRuntimePreflight -RepoRoot $repoRoot -NodeCommand $node.Source

    return @('--experimental-strip-types', $ScriptPath)
}
