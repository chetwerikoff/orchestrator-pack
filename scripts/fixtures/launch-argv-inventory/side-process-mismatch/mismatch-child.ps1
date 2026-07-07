#requires -Version 5.1
<#
  Negative fixture: registry declares passProjectId but script omits ProjectId (Issue #659).
#>
[CmdletBinding()]
param(
    [string]$OrchestratorSessionId = '',
    [switch]$Once
)

Write-Host '[mismatch-child] should never bind supervisor ProjectId'
