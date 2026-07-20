#requires -Version 5.1
<#
.SYNOPSIS
  Read-only operator projection of pack worker-status store (Issue #720).
.DESCRIPTION
  Compatibility wrapper for the TypeScript JSON producer. The historical implementation used
  Get-WorkerStatusReadOnlyProjection and computed age from workerStatusLastUpdatedMs as
  [long]$session.workerStatusLastUpdatedMs; those read-only semantics remain the contract.
#>
param(
    [string]$Project = 'orchestrator-pack',
    [string]$RepoSlug = '',
    [switch]$Json,
    [string]$SessionListsFixture = '',
    [string]$StorePath = '',
    [long]$NowMs = 0
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
$nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion. Install/use Node 22 and run npm run check:node-major." }
$typeScriptLauncher = (Join-Path $PSScriptRoot 'lib/Invoke-TypeScriptCli.ts')
$cli = Join-Path $PSScriptRoot 'json-producers/worker-status-report.ts'
$nodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $cli, '--')
$nodeArgs += @('--project', $Project)
if ($RepoSlug) { $nodeArgs += @('--repo-slug', $RepoSlug) }
if ($Json) { $nodeArgs += '--json' }
if ($SessionListsFixture) { $nodeArgs += @('--session-lists-fixture', $SessionListsFixture) }
if ($StorePath) { $nodeArgs += @('--store-path', $StorePath) }
if ($NowMs -gt 0) { $nodeArgs += @('--now-ms', [string]$NowMs) }
& $node.Source @nodeArgs
if ($LASTEXITCODE -ne 0) { throw "worker-status-report.ts exited $LASTEXITCODE" }
