#requires -Version 5.1
<#
.SYNOPSIS
  Stop-hook entry for coworker read-delegation audit (Issue #255).
.DESCRIPTION
  Compatibility wrapper. The TypeScript producer owns normalization and JSON serialization.
  Fail-open: always exits 0 so completion is never wedged.
#>
param(
    [string]$ArtifactPath,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
try {
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
    $nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion. Install/use Node 22 and run npm run check:node-major." }
    $typeScriptLauncher = (Join-Path $PSScriptRoot 'lib/Invoke-TypeScriptCli.ts')
    $cli = Join-Path $PSScriptRoot 'json-producers/read-delegation-audit-stop.ts'
    $nodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $cli, '--')
    if ($ArtifactPath) { $nodeArgs += @('--artifact-path', $ArtifactPath) }
    if ($RepoRoot) { $nodeArgs += @('--repo-root', $RepoRoot) }
    $stdin = [Console]::In.ReadToEnd()
    $stdin | & $node.Source @nodeArgs
}
catch {
    Write-Warning "read-delegation audit wrapper failed open: $($_.Exception.Message)"
}

# Fail-open by contract: deliberately ignore preparation, launch, and child failures.
exit 0
