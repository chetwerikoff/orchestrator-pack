#requires -Version 5.1
<#
  Record real-main review-pipeline spawn captures (Issue #480).
  Delegates to scripts/generate-review-pipeline-spawn-captures.ts
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
$PackRoot = if ($RepoRoot) { $RepoRoot } else { Split-Path -Parent $PSScriptRoot }
Push-Location $PackRoot
try {
    $runner = Join-Path $PackRoot 'scripts/generate-review-pipeline-spawn-captures.ts'
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
    $nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion. Install/use Node 22 and run npm run check:node-major." }
    $typeScriptLauncher = (Join-Path $PackRoot 'scripts/lib/Invoke-TypeScriptCli.ts')
    $nodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $runner, '--')
    & $node.Source @nodeArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
