[CmdletBinding()]
param(
    [switch]$AllowNoGit
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$EntryPoint = Join-Path $PSScriptRoot 'gate-runner/reusable-pack.ts'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host '[FAIL] node not found; cannot run TypeScript reusable-pack guard.'
    exit 1
}

$arguments = @(
    '--experimental-strip-types',
    $EntryPoint,
    '--repo-root',
    $Root
)

if ($AllowNoGit) {
    $arguments += '--allow-no-git'
}

& $node.Source @arguments
exit $LASTEXITCODE
