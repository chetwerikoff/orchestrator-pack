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
$cli = Join-Path $PSScriptRoot 'json-producers/sanctioned-worker-kill-record.ts'
$args = @(
    '--experimental-strip-types', $cli, 'add',
    '--session-id', $SessionId,
    '--issue-number', [string]$IssueNumber,
    '--pr-number', [string]$PrNumber,
    '--kill-kind', $KillKind,
    '--timestamp-ms', [string]$TimestampMs
)
if ($Path) { $args += @('--path', $Path) }
& node @args
if ($LASTEXITCODE -ne 0) { throw "sanctioned-worker-kill-record.ts exited $LASTEXITCODE" }
