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
. (Join-Path $PSScriptRoot 'lib/Invoke-TypeScriptCli.ps1')
$cli = Join-Path $PSScriptRoot 'json-producers/sanctioned-worker-kill-record.ts'
$nodeArgs = Get-OpkTypeScriptNodeArguments -ScriptPath $cli
$nodeArgs += @(
    'add',
    '--session-id', $SessionId,
    '--issue-number', [string]$IssueNumber,
    '--pr-number', [string]$PrNumber,
    '--kill-kind', $KillKind,
    '--timestamp-ms', [string]$TimestampMs
)
if ($Path) { $nodeArgs += @('--path', $Path) }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw "sanctioned-worker-kill-record.ts exited $LASTEXITCODE" }
