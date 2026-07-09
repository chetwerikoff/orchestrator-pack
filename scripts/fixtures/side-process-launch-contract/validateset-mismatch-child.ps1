#requires -Version 5.1
<#
  Negative fixture: mandatory ValidateSet value not satisfiable from supervised launch shape (Issue #701 cell 4).
#>
[CmdletBinding()]
param(
    [string]$ProjectId = '',
    [Parameter(Mandatory = $true)][ValidateSet('alpha', 'beta')][string]$Mode
)

Write-Host '[validateset-mismatch-child] should fail mandatory-params guard'
