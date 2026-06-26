#requires -Version 5.1
<#
  CI drift guard for autonomous spawn budget contract (Issue #462).
#>
param([string]$RepoRoot = '')
. (Join-Path $PSScriptRoot 'lib/Invoke-AutonomousSpawnBudgetGate.ps1')
Invoke-AutonomousSpawnBudgetGate -RepoRoot $RepoRoot
