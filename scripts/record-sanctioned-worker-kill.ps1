#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [int]$IssueNumber = 0,
    [int]$PrNumber = 0,
    [string]$KillKind = 'manual',
    [long]$TimestampMs = 0,
    [string]$Path = ''
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
$nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion. Install/use Node 22 and run npm run check:node-major." }
$typeScriptLauncher = (Join-Path $PSScriptRoot 'lib/Invoke-TypeScriptCli.ts')
$cli = Join-Path $PSScriptRoot 'json-producers/sanctioned-worker-kill-record.ts'
$nodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $cli, '--')
$nodeArgs += @(
    'add',
    '--session-id', $SessionId,
    '--issue-number', [string]$IssueNumber,
    '--pr-number', [string]$PrNumber,
    '--kill-kind', $KillKind,
    '--timestamp-ms', [string]$TimestampMs
)
if ($Path) { $nodeArgs += @('--path', $Path) }
& $node.Source @nodeArgs
if ($LASTEXITCODE -ne 0) { throw "sanctioned-worker-kill-record.ts exited $LASTEXITCODE" }
