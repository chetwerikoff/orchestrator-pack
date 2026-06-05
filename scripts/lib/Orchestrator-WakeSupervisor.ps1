#requires -Version 5.1
<#
  Orchestrator wake / side-process supervisor (Issues #168, #202, #205).
  Implementation lives in Orchestrator-SideProcessSupervisor.ps1.
#>

. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessSupervisor.ps1')

# Backward-compatible pack-root aliases for tests that grep this file
$Script:OrchestratorWakeSupervisorPackRoot = $Script:OrchestratorSideProcessPackRoot
$Script:OrchestratorWakeSupervisorTestChildScript = $Script:OrchestratorSideProcessTestChildScript
