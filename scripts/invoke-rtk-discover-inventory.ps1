#requires -Version 7.0
<#
.SYNOPSIS
  Regenerate the RTK missed-savings inventory from local rtk discover output (Issue #199).
#>
[CmdletBinding()]
param(
    [int]$SinceDays = 30,
    [switch]$AllProjects,
    [int]$Limit = 50,
    [string]$OutputJson,
    [string]$DiscoverFixture = '',
    [long]$NowMs = 0
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
$nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion. Install/use Node 22 and run npm run check:node-major." }
$typeScriptLauncher = (Join-Path $PSScriptRoot 'lib/Invoke-TypeScriptCli.ts')
$cli = Join-Path $PSScriptRoot 'json-producers/rtk-discover-inventory.ts'
$nodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $cli, '--')
$nodeArgs += @('--since-days', [string]$SinceDays, '--limit', [string]$Limit)
if ($AllProjects) { $nodeArgs += '--all-projects' }
if ($OutputJson) { $nodeArgs += @('--output-json', $OutputJson) }
if ($DiscoverFixture) { $nodeArgs += @('--discover-fixture', $DiscoverFixture) }
if ($NowMs -gt 0) { $nodeArgs += @('--now-ms', [string]$NowMs) }
& $node.Source @nodeArgs
if ($LASTEXITCODE -ne 0) { throw "rtk-discover-inventory.ts exited $LASTEXITCODE" }
