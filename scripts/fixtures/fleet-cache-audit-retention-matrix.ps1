#requires -Version 7.0
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('below_bound', 'rotate_over_bound', 'open_before_rename', 'rotate_blocked', 'corrupted_segment_prune')]
    [string]$Cell,
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/Audit-JsonlRetention.ps1')

function New-TestPolicy {
    param(
        [int]$MaxActive = 128,
        [int]$MaxTotal = 4096,
        [int]$MaxAgeMs = 604800000
    )

    return @{
        streamId       = 'github-fleet-cache'
        maxActiveBytes = $MaxActive
        maxTotalBytes  = $MaxTotal
        maxAgeMs       = $MaxAgeMs
    }
}

function Get-AllJsonlRecords {
    param(
        [string]$Dir,
        [string]$ActivePath
    )

    $records = @()
    foreach ($path in @($ActivePath) + @(Get-AuditJsonlSegments -ActivePath $ActivePath | ForEach-Object { $_.path })) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            continue
        }
        foreach ($line in (Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)) {
            if (-not $line.Trim()) { continue }
            $records += ($line | ConvertFrom-Json)
        }
    }
    return $records
}

New-Item -ItemType Directory -Path $Root -Force | Out-Null
$active = Join-Path $Root 'audit.jsonl'
$detail = @{}

switch ($Cell) {
    'below_bound' {
        $policy = New-TestPolicy -MaxActive 4096 -MaxTotal 100000
        Add-AuditJsonlLine -ActivePath $active -Line '{"event":"below-a"}' -Policy $policy
        Add-AuditJsonlLine -ActivePath $active -Line '{"event":"below-b"}' -Policy $policy
        $detail.segmentCount = @(Get-AuditJsonlSegments -ActivePath $active).Count
        $detail.lineCount = (Get-Content -LiteralPath $active).Count
        $ok = ($detail.segmentCount -eq 0) -and ($detail.lineCount -eq 2)
    }
    'rotate_over_bound' {
        $policy = New-TestPolicy -MaxActive 96 -MaxTotal 4096
        for ($i = 0; $i -lt 8; $i++) {
            Add-AuditJsonlLine -ActivePath $active -Line "{`"event`":`"rotate-$i`"}" -Policy $policy
        }
        $records = Get-AllJsonlRecords -Dir $Root -ActivePath $active
        $detail.recordCount = $records.Count
        $detail.segmentCount = @(Get-AuditJsonlSegments -ActivePath $active).Count
        $ok = ($detail.recordCount -eq 8) -and ($detail.segmentCount -gt 0)
    }
    'open_before_rename' {
        $policy = New-TestPolicy -MaxActive 1 -MaxTotal 100000
        Add-AuditJsonlLine -ActivePath $active -Line '{"event":"open-0"}' -Policy $policy
        $stream = [System.IO.FileStream]::new(
            $active,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite
        )
        try {
            Invoke-AuditJsonlRetentionMaintenance -ActivePath $active -Policy $policy | Out-Null
            Add-AuditJsonlLine -ActivePath $active -Line '{"event":"open-1"}' -Policy $policy
        }
        finally {
            $stream.Dispose()
        }
        $records = Get-AllJsonlRecords -Dir $Root -ActivePath $active
        $detail.recordCount = $records.Count
        $detail.events = @($records | ForEach-Object { $_.event })
        $ok = ($detail.recordCount -eq 2)
    }
    'rotate_blocked' {
        $policy = New-TestPolicy -MaxActive 1 -MaxTotal 100000
        Add-AuditJsonlLine -ActivePath $active -Line '{"event":"blocked-0"}' -Policy $policy
        $events = New-Object System.Collections.Generic.List[string]
        $logWriter = {
            param($Kind, $Fields)
            $null = $events.Add($Kind)
        }
        function Resolve-AuditJsonlRotationSegmentPath {
            param(
                [string]$Dir,
                [string]$Base
            )
            return $null
        }
        Invoke-AuditJsonlActiveRotation -ActivePath $active -Policy $policy -LogWriter $logWriter
        Add-AuditJsonlLine -ActivePath $active -Line '{"event":"blocked-1"}' -Policy $policy
        $records = Get-AllJsonlRecords -Dir $Root -ActivePath $active
        $detail.recordCount = $records.Count
        $detail.maintenanceEvents = @($events)
        $ok = ($detail.recordCount -ge 2) -and ($events -contains 'rotate_failed')
    }
    'corrupted_segment_prune' {
        $policy = New-TestPolicy -MaxActive 96 -MaxTotal 256 -MaxAgeMs (2 * 24 * 60 * 60 * 1000)
        $base = Get-AuditJsonlSegmentBaseName -ActivePath $active
        $expiredValid = Join-Path $Root "$base.20200101T000000000Z-deadbeef.jsonl"
        $expiredCorrupt = Join-Path $Root "$base.20200102T000000000Z-cafebabe.jsonl"
        Set-Content -LiteralPath $expiredValid -Value '{"event":"expired-valid"}' -Encoding UTF8
        Set-Content -LiteralPath $expiredCorrupt -Value '{not-json' -Encoding UTF8
        foreach ($path in @($expiredValid, $expiredCorrupt)) {
            (Get-Item -LiteralPath $path).LastWriteTimeUtc = (Get-Date).AddDays(-10).ToUniversalTime()
        }
        for ($i = 0; $i -lt 6; $i++) {
            Add-AuditJsonlLine -ActivePath $active -Line "{`"event`":`"corrupt-$i`"}" -Policy $policy
        }
        $records = Get-AllJsonlRecords -Dir $Root -ActivePath $active
        $detail.recordCount = $records.Count
        $detail.remainingSegments = @(Get-AuditJsonlSegments -ActivePath $active | ForEach-Object { $_.name })
        $detail.expiredStillPresent = @(
            (Test-Path -LiteralPath $expiredValid),
            (Test-Path -LiteralPath $expiredCorrupt)
        )
        $ok = ($detail.recordCount -eq 6) -and (-not $detail.expiredStillPresent.Contains($true))
    }
}

@{
    cell   = $Cell
    ok     = [bool]$ok
    detail = $detail
} | ConvertTo-Json -Compress -Depth 6
