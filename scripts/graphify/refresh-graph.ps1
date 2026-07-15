#requires -Version 7.0
<#
.SYNOPSIS
  Refresh an existing Graphify code graph in place (Issue #833, AC#1).
.DESCRIPTION
  Wraps `graphify update <dir>` -- re-extracts changed code files (no LLM needed) and updates the
  existing graph rather than rebuilding from scratch. Run build-graph.ps1 first if no graph exists
  yet at the target directory. Never passes `install` or any `<platform> install` subcommand.
.PARAMETER OutDir
  Working output directory to refresh (must already hold a graph from build-graph.ps1). Defaults
  to .graphify/graph.
.EXAMPLE
  pwsh scripts/graphify/refresh-graph.ps1
#>
param(
    [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Resolve-GraphifyEnv.ps1')

$rawOutDir = if ($OutDir) { $OutDir } else { Get-GraphifyGraphOutDir }
$graphFile = Join-Path $rawOutDir 'graphify-out/graph.json'

if (-not (Test-Path -LiteralPath $graphFile -PathType Leaf)) {
    throw "No existing graph at '$graphFile'. Run scripts/graphify/build-graph.ps1 first."
}
$targetOutDir = (Resolve-Path -LiteralPath $rawOutDir).ProviderPath

Write-Host "[graphify refresh] updating existing graph in '$targetOutDir' (no LLM needed)"
Invoke-GraphifyCommand -Subcommand 'update' -Arguments @($targetOutDir)

Write-Host "[PASS] graph refreshed at $graphFile"
