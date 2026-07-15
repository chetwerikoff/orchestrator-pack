#requires -Version 5.1

. (Join-Path $PSScriptRoot 'Invoke-TypeScriptCli.ps1')

function Get-SanctionedWorkerKillRecordPath {
    if ($env:AO_SANCTIONED_WORKER_KILL_RECORD_PATH) {
        return $env:AO_SANCTIONED_WORKER_KILL_RECORD_PATH
    }
    $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    return Join-Path $root 'docs/state/sanctioned-worker-kills.json'
}

function Get-SanctionedWorkerKillRecordCliPath {
    $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    return Join-Path $root 'scripts/json-producers/sanctioned-worker-kill-record.ts'
}

function Invoke-SanctionedWorkerKillRecordCli {
    param([string[]]$Arguments)

    $cli = Get-SanctionedWorkerKillRecordCliPath
    $nodeArgs = Get-OpkTypeScriptNodeArguments -ScriptPath $cli
    $output = & node @nodeArgs @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "sanctioned-worker-kill-record.ts exited $LASTEXITCODE`: $($output | Out-String)"
    }
    return (($output | Out-String).Trim() | ConvertFrom-Json)
}

function Read-SanctionedWorkerKillSurface {
    param([string]$Path = '')

    if (-not $Path) { $Path = Get-SanctionedWorkerKillRecordPath }
    return Invoke-SanctionedWorkerKillRecordCli -Arguments @('read', '--path', $Path)
}

function Add-SanctionedWorkerKillRecord {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [int]$IssueNumber = 0,
        [int]$PrNumber = 0,
        [string]$KillKind = 'manual',
        [long]$TimestampMs = 0,
        [string]$Path = ''
    )

    if (-not $Path) { $Path = Get-SanctionedWorkerKillRecordPath }
    return Invoke-SanctionedWorkerKillRecordCli -Arguments @(
        'add', '--path', $Path,
        '--session-id', $SessionId,
        '--issue-number', [string]$IssueNumber,
        '--pr-number', [string]$PrNumber,
        '--kill-kind', $KillKind,
        '--timestamp-ms', [string]$TimestampMs
    )
}
