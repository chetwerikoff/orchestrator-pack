#requires -Version 7.0
<#
.SYNOPSIS
  Query an already-built Graphify graph for hub nodes, cluster membership, or import/call cycles
  (Issue #833, AC#3). Thin pass-through to query-graph.mjs -- pure Node, no `graphify` subprocess.
.EXAMPLE
  pwsh scripts/graphify/query-graph.ps1 hubs --top 5
.EXAMPLE
  pwsh scripts/graphify/query-graph.ps1 cluster --file scripts/pr-scope-check.ts
.EXAMPLE
  pwsh scripts/graphify/query-graph.ps1 cycle --file docs/review-cycle-cap.mjs
#>
$ErrorActionPreference = 'Stop'
$mjsPath = Join-Path $PSScriptRoot 'query-graph.mjs'
& node $mjsPath @args
exit $LASTEXITCODE
