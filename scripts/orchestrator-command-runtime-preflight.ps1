#requires -Version 5.1
<#
  Fail-closed preflight for autonomous orchestrator command runtime (Issue #532).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [switch]$FixtureMode
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Autonomous-GateCommon.ps1')

$RepoRoot = Resolve-PackGateRepoRoot -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot
$bootstrapScript = Join-Path $RepoRoot 'scripts/lib/command-runtime-bootstrap.mjs'

if ($FixtureMode) {
    $payload = @{
        packRoot       = $RepoRoot
        inheritedPath  = '/usr/bin:/bin'
        tools          = @{
            pwsh    = '/usr/bin/pwsh'
            node    = '/usr/bin/node'
            packGh  = (Join-Path $RepoRoot 'scripts/gh')
            firstGh = (Join-Path $RepoRoot 'scripts/gh')
            nativeGh = '/usr/bin/gh'
        }
    } | ConvertTo-Json -Depth 6 -Compress
    $result = & node $bootstrapScript evaluatePreflight $payload | ConvertFrom-Json
    if (-not $result.ok) {
        Write-Host "[FAIL] command-runtime bootstrap preflight fixture: $($result.reason) diagnostic=$($result.diagnostic)"
        exit 1
    }
    Write-Host '[PASS] command-runtime bootstrap preflight (fixture)'
    exit 0
}

& node $bootstrapScript livePreflight --pack-root $RepoRoot
exit $LASTEXITCODE
