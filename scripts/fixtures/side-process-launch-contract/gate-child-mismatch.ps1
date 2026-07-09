#requires -Version 5.1
<#
  Negative fixture: per-review gate shape registered as supervised polling child (Issue #701).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][int]$PrNumber,
    [Parameter(Mandatory = $true)][string]$TargetSha,
    [Parameter(Mandatory = $true)][ValidateSet('approved', 'changes_requested')][string]$Verdict,
    [string]$ProjectId = 'orchestrator-pack',
    [string]$DeliveryMessage = ''
)

Write-Host '[gate-child-mismatch] should never start from supervised polling launch shape'
