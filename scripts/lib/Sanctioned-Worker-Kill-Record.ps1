#requires -Version 5.1

function Get-SanctionedWorkerKillRecordPath {
    if ($env:AO_SANCTIONED_WORKER_KILL_RECORD_PATH) {
        return $env:AO_SANCTIONED_WORKER_KILL_RECORD_PATH
    }
    $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    return Join-Path $root 'docs/state/sanctioned-worker-kills.json'
}

function Read-SanctionedWorkerKillSurface {
    param([string]$Path = '')

    if (-not $Path) { $Path = Get-SanctionedWorkerKillRecordPath }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{
            healthy = $false
            reason = 'sanctioned_kill_record_surface_absent'
            records = @()
        }
    }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw
        $parsed = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { @() }
        $records = if ($parsed.PSObject.Properties.Name -contains 'records') { @($parsed.records) } else { @($parsed) }
        return [pscustomobject]@{ healthy = $true; records = @($records) }
    }
    catch {
        return [pscustomobject]@{
            healthy = $false
            reason = 'sanctioned_kill_record_unreadable'
            detail = $_.Exception.Message
            records = @()
        }
    }
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
    if ($TimestampMs -le 0) { $TimestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $surface = Read-SanctionedWorkerKillSurface -Path $Path
    if (-not $surface.healthy) {
        if ($surface.reason -eq 'sanctioned_kill_record_surface_absent') {
            $records = @()
        }
        else {
            throw ($surface.detail ?? $surface.reason)
        }
    }
    else {
        $records = @($surface.records)
    }
    $records += [pscustomobject]@{
        sessionId = $SessionId
        issueNumber = $IssueNumber
        prNumber = $PrNumber
        killKind = $KillKind
        timestampMs = $TimestampMs
    }
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [pscustomobject]@{ records = @($records) } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding utf8
    return [pscustomobject]@{ healthy = $true; records = @($records) }
}
