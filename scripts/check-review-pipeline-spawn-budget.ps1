#requires -Version 5.1
<#
  CI drift guard for orchestrator review-pipeline aggregate spawn budget (Issue #480).
#>
param([string]$RepoRoot = '')
. (Join-Path $PSScriptRoot 'lib/Invoke-PackSpawnBudgetGates.ps1')
Invoke-ReviewPipelineSpawnBudgetGate -RepoRoot $RepoRoot
