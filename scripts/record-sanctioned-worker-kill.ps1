#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [int]$IssueNumber = 0,
    [int]$PrNumber = 0,
    [string]$KillKind = 'manual',
    [long]$TimestampMs = 0,
    [string]$Path = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Sanctioned-Worker-Kill-Record.ps1')

$surface = Add-SanctionedWorkerKillRecord -SessionId $SessionId -IssueNumber $IssueNumber `
    -PrNumber $PrNumber -KillKind $KillKind -TimestampMs $TimestampMs -Path $Path
$surface | ConvertTo-Json -Depth 20
