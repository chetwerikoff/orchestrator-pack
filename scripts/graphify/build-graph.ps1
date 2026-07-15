#requires -Version 7.0
<#
.SYNOPSIS
  Build a fresh Graphify code graph for this repository (Issue #833, AC#1).
.DESCRIPTION
  Wraps `graphify extract <path> --code-only --out <dir>` -- the free, local, deterministic
  tree-sitter AST path. No LLM/API key is used or required. This entrypoint never passes
  `install` or any `<platform> install` subcommand; see scripts/graphify/lib/Resolve-GraphifyEnv.ps1
  for the single enforcement point.
.PARAMETER Path
  Repository subset to extract. Defaults to the repo root.
.PARAMETER OutDir
  Working output directory (untracked). Defaults to .graphify/graph.
.EXAMPLE
  pwsh scripts/graphify/build-graph.ps1
.EXAMPLE
  pwsh scripts/graphify/build-graph.ps1 -Path scripts
#>
param(
    [string]$Path = '',
    [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Resolve-GraphifyEnv.ps1')

$rawPath = if ($Path) { $Path } else { Get-GraphifyRepoRoot }
$targetPath = (Resolve-Path -LiteralPath $rawPath).ProviderPath
$targetOutDir = if ($OutDir) { $OutDir } else { Get-GraphifyGraphOutDir }

New-Item -ItemType Directory -Force -Path $targetOutDir | Out-Null
$targetOutDir = (Resolve-Path -LiteralPath $targetOutDir).ProviderPath

Write-Host "[graphify build] extracting (code-only, no LLM) from '$targetPath' -> '$targetOutDir'"
Invoke-GraphifyCommand -Subcommand 'extract' -Arguments @($targetPath, '--code-only', '--out', $targetOutDir)

$graphFile = Join-Path $targetOutDir 'graphify-out/graph.json'
if (-not (Test-Path -LiteralPath $graphFile -PathType Leaf)) {
    throw "graphify extract reported success but no graph was written at '$graphFile'."
}
Write-Host "[PASS] graph built at $graphFile"
