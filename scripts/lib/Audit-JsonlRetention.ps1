#requires -Version 5.1
<#
  Bounded best-effort JSONL audit retention for Phase-0 telemetry (Issue #588).
#>

$Script:AuditJsonlRetentionPolicyPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'audit-jsonl-retention-policy.json'
$Script:AuditJsonlProcessAliveLoaded = $false

function Ensure-AuditJsonlProcessAliveLoaded {
    if ($Script:AuditJsonlProcessAliveLoaded) { return }
    . (Join-Path $PSScriptRoot 'Orchestrator-ProcessAlive.ps1')
    $Script:AuditJsonlProcessAliveLoaded = $true
}

function Get-AuditJsonlMaintenanceLockMaxAgeSeconds {
    $raw = [Environment]::GetEnvironmentVariable('AUDIT_JSONL_MAINTENANCE_LOCK_MAX_AGE_SECONDS')
    $parsed = 0
    if ($raw -and [int]::TryParse([string]$raw, [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return 300
}

function Get-AuditJsonlMaintenanceLockPid {
    param([string]$LockPath)

    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        return 0
    }
    try {
        $text = Get-Content -LiteralPath $LockPath -Raw
        if ($text -match '^\s*(\d+)') {
            return [int]$Matches[1]
        }
    }
    catch {
        return 0
    }
    return 0
}

function Test-AuditJsonlMaintenanceLockStale {
    param([string]$LockPath)

    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        return $false
    }

    $ownerPid = Get-AuditJsonlMaintenanceLockPid -LockPath $LockPath
    if ($ownerPid -gt 0) {
        Ensure-AuditJsonlProcessAliveLoaded
        if (-not (Test-ProcessAlive -ProcessId $ownerPid)) {
            return $true
        }
    }

    try {
        $startedAt = (Get-Item -LiteralPath $LockPath).LastWriteTimeUtc
    }
    catch {
        return $false
    }
    return ((Get-Date).ToUniversalTime() - $startedAt).TotalSeconds -gt (Get-AuditJsonlMaintenanceLockMaxAgeSeconds)
}

function Clear-AuditJsonlStaleMaintenanceLockIfNeeded {
    param(
        [string]$LockPath,
        [scriptblock]$LogWriter = $null
    )

    if (-not (Test-AuditJsonlMaintenanceLockStale -LockPath $LockPath)) {
        return $false
    }
    Remove-AuditJsonlMaintenanceLock -LockPath $LockPath
    if ($LogWriter) {
        & $LogWriter 'stale_lock_reclaimed' @{ lock = (Split-Path -Leaf $LockPath) }
    }
    return $true
}

function Get-AuditJsonlRetentionPolicyFilePath {
    if ($env:AUDIT_JSONL_RETENTION_POLICY_PATH) {
        return $env:AUDIT_JSONL_RETENTION_POLICY_PATH.Trim()
    }
    return $Script:AuditJsonlRetentionPolicyPath
}

function Get-AuditJsonlRetentionEmbeddedDefaults {
    param([string]$StreamId)

    switch ($StreamId) {
        'gh-wrapper' {
            return @{
                maxActiveBytes = 67108864
                maxTotalBytes  = 1073741824
                maxAgeDays     = 7
            }
        }
        'github-fleet-cache' {
            return @{
                maxActiveBytes = 16777216
                maxTotalBytes  = 209715200
                maxAgeDays     = 7
            }
        }
        default { throw "unknown audit stream: $StreamId" }
    }
}

function Get-AuditJsonlRetentionPolicyDefaults {
    param([string]$StreamId)

    try {
        $raw = Get-Content -LiteralPath (Get-AuditJsonlRetentionPolicyFilePath) -Raw | ConvertFrom-Json
        return $raw.$StreamId
    }
    catch {
        return Get-AuditJsonlRetentionEmbeddedDefaults -StreamId $StreamId
    }
}

function Resolve-AuditJsonlRetentionPolicy {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('gh-wrapper', 'github-fleet-cache')]
        [string]$StreamId
    )

    $defaults = Get-AuditJsonlRetentionPolicyDefaults -StreamId $StreamId
    $prefix = switch ($StreamId) {
        'gh-wrapper' { 'GH_WRAPPER_AUDIT' }
        'github-fleet-cache' { 'GH_FLEET_CACHE_AUDIT' }
    }

    $parsePositive = {
        param($EnvName, $Fallback)
        $raw = [Environment]::GetEnvironmentVariable($EnvName)
        $parsed = 0
        if ($raw -and [int]::TryParse([string]$raw, [ref]$parsed) -and $parsed -gt 0) {
            return $parsed
        }
        return [int]$Fallback
    }

    $maxActiveBytes = & $parsePositive "${prefix}_MAX_ACTIVE_BYTES" $defaults.maxActiveBytes
    $maxTotalBytes = & $parsePositive "${prefix}_MAX_TOTAL_BYTES" $defaults.maxTotalBytes
    $maxAgeDays = & $parsePositive "${prefix}_MAX_AGE_DAYS" $defaults.maxAgeDays

    return @{
        streamId        = $StreamId
        maxActiveBytes  = $maxActiveBytes
        maxTotalBytes   = $maxTotalBytes
        maxAgeMs        = [int64]$maxAgeDays * 24 * 60 * 60 * 1000
        defaults        = $defaults
    }
}

function Get-AuditJsonlSegmentBaseName {
    param([string]$ActivePath)
    return [System.IO.Path]::GetFileNameWithoutExtension($ActivePath)
}

function Test-AuditJsonlSegmentName {
    param(
        [string]$Name,
        [string]$ActivePath
    )

    $base = [regex]::Escape((Get-AuditJsonlSegmentBaseName -ActivePath $ActivePath))
    return $Name -match "^${base}\.\d{8}T\d{6}(?:\d{3})?Z(?:-[a-f0-9]{8})?\.jsonl$"
}

function Get-AuditJsonlRotationStamp {
    return (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmssfff'Z'")
}

function Resolve-AuditJsonlRotationSegmentPath {
    param(
        [string]$Dir,
        [string]$Base
    )

    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        $suffix = ([guid]::NewGuid().ToString('n')).Substring(0, 8)
        $segmentPath = Join-Path $Dir "$Base.$(Get-AuditJsonlRotationStamp)-$suffix.jsonl"
        if (-not (Test-Path -LiteralPath $segmentPath)) {
            return $segmentPath
        }
    }
    return $null
}

function Get-AuditJsonlActiveFileSize {
    param([string]$ActivePath)

    if (-not (Test-Path -LiteralPath $ActivePath -PathType Leaf)) {
        return 0
    }
    return (Get-Item -LiteralPath $ActivePath).Length
}

function Test-AuditJsonlMaintenanceLock {
    param(
        [string]$LockPath,
        [scriptblock]$LogWriter = $null
    )

    $dir = Split-Path -Parent $LockPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    Clear-AuditJsonlStaleMaintenanceLockIfNeeded -LockPath $LockPath -LogWriter $LogWriter | Out-Null

    try {
        $stream = [System.IO.FileStream]::new(
            $LockPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $writer = New-Object System.IO.StreamWriter($stream, [System.Text.UTF8Encoding]::new($false))
            $writer.Write("$PID`n")
            $writer.Flush()
        }
        finally {
            $stream.Dispose()
        }
        return $true
    }
    catch [System.IO.IOException] {
        return $false
    }
    catch [System.UnauthorizedAccessException] {
        return $false
    }
}

function Remove-AuditJsonlMaintenanceLock {
    param([string]$LockPath)
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}

function Get-AuditJsonlSegmentTimestamp {
    param(
        [string]$Name,
        [string]$ActivePath
    )

    $base = [regex]::Escape((Get-AuditJsonlSegmentBaseName -ActivePath $ActivePath))
    if ($Name -notmatch "^${base}\.(\d{8}T\d{6}(?:\d{3})?Z)(?:-[a-f0-9]{8})?\.jsonl$") {
        return 0
    }
    $compact = $Matches[1]
    if ($compact.Length -eq 16) {
        $iso = "{0}-{1}-{2}T{3}:{4}:{5}Z" -f $compact.Substring(0, 4), $compact.Substring(4, 2), $compact.Substring(6, 2), $compact.Substring(9, 2), $compact.Substring(11, 2), $compact.Substring(13, 2)
    }
    else {
        $iso = "{0}-{1}-{2}T{3}:{4}:{5}.{6}Z" -f $compact.Substring(0, 4), $compact.Substring(4, 2), $compact.Substring(6, 2), $compact.Substring(9, 2), $compact.Substring(11, 2), $compact.Substring(13, 2), $compact.Substring(15, 3)
    }
    $parsed = [DateTimeOffset]::Parse($iso)
    return $parsed.ToUnixTimeMilliseconds()
}

function Get-AuditJsonlSegments {
    param([string]$ActivePath)

    $dir = Split-Path -Parent $ActivePath
    if (-not (Test-Path -LiteralPath $dir)) {
        return @()
    }

    $segments = @()
    foreach ($item in Get-ChildItem -LiteralPath $dir -File) {
        if (-not (Test-AuditJsonlSegmentName -Name $item.Name -ActivePath $ActivePath)) {
            continue
        }
        $segments += @{
            name    = $item.Name
            path    = $item.FullName
            size    = $item.Length
            mtimeMs = [DateTimeOffset]$item.LastWriteTimeUtc.ToUniversalTime().ToUnixTimeMilliseconds()
            ts      = (Get-AuditJsonlSegmentTimestamp -Name $item.Name -ActivePath $ActivePath)
        }
    }
    return @($segments | Sort-Object ts, name)
}

function Invoke-AuditJsonlSegmentPrune {
    param(
        [string]$ActivePath,
        [hashtable]$Policy,
        [scriptblock]$LogWriter = $null
    )

    $dir = Split-Path -Parent $ActivePath
    $segments = @(Get-AuditJsonlSegments -ActivePath $ActivePath)
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    $remaining = @()
    foreach ($segment in $segments) {
        $ageMs = if ($segment.mtimeMs -gt 0) { $nowMs - $segment.mtimeMs } else { $nowMs - $segment.ts }
        if ($Policy.maxAgeMs -gt 0 -and $ageMs -gt $Policy.maxAgeMs) {
            try {
                Remove-Item -LiteralPath $segment.path -Force
                if ($LogWriter) { & $LogWriter 'prune_age' @{ segment = $segment.name } }
                continue
            }
            catch {
                if ($LogWriter) { & $LogWriter 'prune_failed' @{ segment = $segment.name; reason = $_.Exception.Message } }
            }
        }
        $remaining += $segment
    }

    $totalBytes = ($remaining | ForEach-Object { $_.size } | Measure-Object -Sum).Sum
    if ($null -eq $totalBytes) { $totalBytes = 0 }
    $totalBytes += (Get-AuditJsonlActiveFileSize -ActivePath $ActivePath)

    while ($Policy.maxTotalBytes -gt 0 -and $totalBytes -gt $Policy.maxTotalBytes -and $remaining.Count -gt 0) {
        $oldest = $remaining[0]
        $remaining = @($remaining | Select-Object -Skip 1)
        try {
            Remove-Item -LiteralPath $oldest.path -Force
            $totalBytes -= $oldest.size
            if ($LogWriter) { & $LogWriter 'prune_footprint' @{ segment = $oldest.name; totalBytes = $totalBytes } }
        }
        catch {
            if ($LogWriter) { & $LogWriter 'prune_failed' @{ segment = $oldest.name; reason = $_.Exception.Message } }
            break
        }
    }
}

function Invoke-AuditJsonlActiveRotation {
    param(
        [string]$ActivePath,
        [hashtable]$Policy,
        [scriptblock]$LogWriter = $null
    )

    $dir = Split-Path -Parent $ActivePath
    $base = Get-AuditJsonlSegmentBaseName -ActivePath $ActivePath
    $segmentPath = Resolve-AuditJsonlRotationSegmentPath -Dir $dir -Base $base
    if (-not $segmentPath) {
        if ($LogWriter) { & $LogWriter 'rotate_failed' @{ reason = 'segment_name_collision' } }
        return
    }
    try {
        Move-Item -LiteralPath $ActivePath -Destination $segmentPath
        if ($LogWriter) { & $LogWriter 'rotate' @{ segment = (Split-Path -Leaf $segmentPath) } }
        Invoke-AuditJsonlSegmentPrune -ActivePath $ActivePath -Policy $Policy -LogWriter $LogWriter
    }
    catch {
        if ($LogWriter) { & $LogWriter 'rotate_failed' @{ reason = $_.Exception.Message } }
    }
}

function Invoke-AuditJsonlRetentionMaintenance {
    param(
        [string]$ActivePath,
        [hashtable]$Policy,
        [scriptblock]$LogWriter = $null
    )

    $activeSize = Get-AuditJsonlActiveFileSize -ActivePath $ActivePath
    if ($Policy.maxActiveBytes -gt 0 -and $activeSize -lt $Policy.maxActiveBytes) {
        return @{ rotated = $false; activeSize = $activeSize }
    }
    if ($activeSize -eq 0) {
        return @{ rotated = $false; activeSize = 0 }
    }

    $lockPath = "$ActivePath.maintenance.lock"
    if (-not (Test-AuditJsonlMaintenanceLock -LockPath $lockPath -LogWriter $LogWriter)) {
        return @{ rotated = $false; activeSize = $activeSize; lockContended = $true }
    }

    try {
        $lockedSize = Get-AuditJsonlActiveFileSize -ActivePath $ActivePath
        if ($Policy.maxActiveBytes -gt 0 -and $lockedSize -lt $Policy.maxActiveBytes) {
            return @{ rotated = $false; activeSize = $lockedSize }
        }
        if ($lockedSize -eq 0) {
            return @{ rotated = $false; activeSize = 0 }
        }
        Invoke-AuditJsonlActiveRotation -ActivePath $ActivePath -Policy $Policy -LogWriter $LogWriter
        return @{ rotated = $true; activeSize = $lockedSize }
    }
    finally {
        Remove-AuditJsonlMaintenanceLock -LockPath $lockPath
    }
}

function Add-AuditJsonlLine {
    param(
        [string]$ActivePath,
        [string]$Line,
        [hashtable]$Policy,
        [scriptblock]$LogWriter = $null
    )

    $dir = Split-Path -Parent $ActivePath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    Invoke-AuditJsonlRetentionMaintenance -ActivePath $ActivePath -Policy $Policy -LogWriter $LogWriter | Out-Null
    $payload = if ($Line.EndsWith("`n")) { $Line } else { "$Line`n" }
    [System.IO.File]::AppendAllText($ActivePath, $payload, [System.Text.UTF8Encoding]::new($false))
}
