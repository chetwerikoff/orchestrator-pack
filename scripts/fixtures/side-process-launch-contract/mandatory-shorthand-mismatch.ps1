#requires -Version 5.1
<#
  Negative fixture: mandatory shorthand [Parameter(Mandatory)] not satisfiable from supervised shape (#701).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SessionId,
    [Parameter(Mandatory, Position = 0)][string]$RunId,
    [string]$ProjectId = 'orchestrator-pack'
)

Write-Host '[mandatory-shorthand-mismatch] should fail mandatory-params guard'
