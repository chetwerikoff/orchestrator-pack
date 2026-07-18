#requires -Version 5.1
<#
  Command-runtime bootstrap runtime wiring assertions.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Autonomous-GateCommon.ps1')
$RepoRoot = Resolve-PackGateRepoRoot -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot

$preflightPath = Join-Path $RepoRoot 'scripts/orchestrator-command-runtime-preflight.ps1'
$bootstrapPath = Join-Path $RepoRoot 'scripts/lib/command-runtime-bootstrap.mjs'
$workaroundGuardPath = Join-Path $RepoRoot 'scripts/check-command-runtime-forbidden-workaround.ps1'
$ghShimPath = Join-Path $RepoRoot 'scripts/gh'
foreach ($path in @($preflightPath, $bootstrapPath, $workaroundGuardPath, $ghShimPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "missing required command-runtime bootstrap artifact: $path"
        exit 1
    }
}

$preflight = Get-Content -LiteralPath $preflightPath -Raw
foreach ($marker in @(
        'scripts/lib/command-runtime-bootstrap.mjs',
        'evaluatePreflight',
        'livePreflight',
        'scripts/gh'
    )) {
    if ($preflight -notmatch [regex]::Escape($marker)) {
        Write-Host "orchestrator-command-runtime-preflight.ps1 missing runtime marker: $marker"
        exit 1
    }
}

$bootstrap = Get-Content -LiteralPath $bootstrapPath -Raw
foreach ($marker in @(
        "COMMAND_RUNTIME_BOOTSTRAP_VERSION = 'command-runtime-bootstrap/v1'",
        'evaluateCommandRuntimePreflight',
        'missing_pwsh',
        'missing_node',
        'missing_pack_gh',
        'pack_gh_not_first_on_path',
        'native_gh_unresolved'
    )) {
    if ($bootstrap -notmatch [regex]::Escape($marker)) {
        Write-Host "command-runtime-bootstrap.mjs missing runtime marker: $marker"
        exit 1
    }
}

& $preflightPath -RepoRoot $RepoRoot -FixtureMode
if ($LASTEXITCODE -ne 0) {
    Write-Host 'command-runtime bootstrap fixture preflight failed'
    exit 1
}

& $workaroundGuardPath
if ($LASTEXITCODE -ne 0) {
    Write-Host 'command-runtime forbidden-workaround guard failed'
    exit 1
}

Write-Host '[PASS] command-runtime bootstrap runtime wiring'
exit 0
