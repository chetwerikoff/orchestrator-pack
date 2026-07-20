#!/usr/bin/env pwsh
# AO / GitHub Actions entrypoint for the Codex PR reviewer wrapper.
$ErrorActionPreference = 'Stop'

$BinDir = $PSScriptRoot
$ReviewTs = Join-Path $BinDir 'review.ts'

if (-not (Test-Path -LiteralPath $ReviewTs)) {
    Write-Error "review.ts not found at $ReviewTs"
}

$PackRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
$nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion. Install/use Node 22 and run npm run check:node-major." }
$typeScriptLauncher = (Join-Path $PackRoot 'scripts/lib/Invoke-TypeScriptCli.ts')
$nodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $ReviewTs, '--')
& $node.Source @nodeArgs @args
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
