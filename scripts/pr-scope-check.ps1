[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$TrustedRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$RunnerScript = Join-Path $PSScriptRoot 'pr-scope-runner.ts'

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.'
}
$nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') {
    throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion. Install/use Node 22 and run npm run check:node-major."
}

Push-Location $TrustedRoot
try {
    & $node.Source '--experimental-strip-types' $RunnerScript
    $runnerExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $runnerExitCode
