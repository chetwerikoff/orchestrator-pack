#requires -Version 5.1
<#
  File-based side-effect fencing for supervised orchestrator children (Issue #205).
#>

. (Join-Path $PSScriptRoot 'Orchestrator-ProcessAlive.ps1')

$Script:SideEffectLockMaxAgeMinutesWithoutPid = 180

function Get-OrchestratorSideEffectStateRoot {
    if ($env:AO_SIDE_PROCESS_STATE_DIR) {
        return $env:AO_SIDE_PROCESS_STATE_DIR.Trim()
    }
    return ''
}

function Get-OrchestratorSideEffectLockPath {
    param([string]$LockFileName = 'side-effect.lock')

    $root = Get-OrchestratorSideEffectStateRoot
    if ($root) {
        return Join-Path $root $LockFileName
    }
    return Join-Path ([System.IO.Path]::GetTempPath()) "orchestrator-$LockFileName"
}

function Get-OrchestratorSideEffectLockMaxAgeMinutes {
    $envMinutes = $env:AO_SIDE_EFFECT_LOCK_MAX_AGE_MINUTES
    if ($envMinutes -and [int]::TryParse($envMinutes, [ref]$null)) {
        return [Math]::Max(1, [int]$envMinutes)
    }
    return $Script:SideEffectLockMaxAgeMinutesWithoutPid
}

function Get-OrchestratorSideEffectLockRecord {
    param([string]$LockPath)

    if (-not $LockPath -or -not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        return $null
    }

    try {
        $raw = Get-Content -LiteralPath $LockPath -Raw -ErrorAction Stop
        if (-not $raw.Trim()) {
            return $null
        }
        return $raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Test-OrchestratorSideEffectLockStale {
    param([string]$LockPath)

    if (-not $LockPath -or -not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        return $false
    }

    $record = Get-OrchestratorSideEffectLockRecord -LockPath $LockPath
    $ownerPid = 0
    $hasPid = $false
    if ($record -and $null -ne $record.pid) {
        $hasPid = [int]::TryParse([string]$record.pid, [ref]$ownerPid)
    }

    if ($hasPid) {
        return -not (Test-ProcessAlive -ProcessId $ownerPid)
    }

    $startedAt = $null
    if ($record -and $record.startedAt) {
        try {
            $startedAt = [datetimeoffset]::Parse([string]$record.startedAt).UtcDateTime
        }
        catch {
            $startedAt = $null
        }
    }
    if (-not $startedAt) {
        $startedAt = (Get-Item -LiteralPath $LockPath).LastWriteTimeUtc
    }

    $maxAgeMinutes = Get-OrchestratorSideEffectLockMaxAgeMinutes
    return ((Get-Date).ToUniversalTime() - $startedAt).TotalMinutes -gt $maxAgeMinutes
}

function Clear-OrchestratorStaleSideEffectLockIfNeeded {
    param([string]$LockPath)

    if (-not $LockPath -or -not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        return $false
    }
    if (-not (Test-OrchestratorSideEffectLockStale -LockPath $LockPath)) {
        return $false
    }

    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
    Write-Verbose "reclaimed stale side-effect lock: $LockPath"
    return $true
}

function Test-OrchestratorSideEffectInFlight {
    param([string]$LockPath)
    if (-not $LockPath) { return $false }
    Clear-OrchestratorStaleSideEffectLockIfNeeded -LockPath $LockPath | Out-Null
    return Test-Path -LiteralPath $LockPath -PathType Leaf
}

function New-OrchestratorSideEffectLockFile {
    param(
        [string]$LockPath,
        [string]$Json
    )

    $stream = [System.IO.FileStream]::new(
        $LockPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        $writer = New-Object System.IO.StreamWriter($stream, [System.Text.UTF8Encoding]::new($false))
        $writer.Write($Json)
        $writer.Flush()
    }
    finally {
        $stream.Dispose()
    }
}

function Enter-OrchestratorSideEffectFence {
    param(
        [string]$LockPath,
        [hashtable]$Metadata = @{}
    )

    if (-not $LockPath) { return $false }

    $dir = Split-Path -Parent $LockPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $payload = @{
        pid       = $PID
        startedAt = (Get-Date).ToString('o')
    }
    foreach ($key in $Metadata.Keys) {
        $payload[$key] = $Metadata[$key]
    }
    $json = $payload | ConvertTo-Json -Compress

    Clear-OrchestratorStaleSideEffectLockIfNeeded -LockPath $LockPath | Out-Null

    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        try {
            New-OrchestratorSideEffectLockFile -LockPath $LockPath -Json $json
            return $true
        }
        catch [System.IO.IOException] {
            if ($attempt -eq 0) {
                if (-not (Clear-OrchestratorStaleSideEffectLockIfNeeded -LockPath $LockPath)) {
                    return $false
                }
                continue
            }
            return $false
        }
        catch [System.UnauthorizedAccessException] {
            return $false
        }
    }

    return $false
}

function Exit-OrchestratorSideEffectFence {
    param([string]$LockPath)
    if ($LockPath -and (Test-Path -LiteralPath $LockPath)) {
        Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-OrchestratorSideEffectFenced {
    param(
        [string]$LockPath,
        [scriptblock]$Action,
        [hashtable]$Metadata = @{}
    )

    if (-not (Enter-OrchestratorSideEffectFence -LockPath $LockPath -Metadata $Metadata)) {
        return @{ ok = $false; reason = 'side_effect_busy' }
    }
    try {
        & $Action
        return @{ ok = $true }
    }
    finally {
        Exit-OrchestratorSideEffectFence -LockPath $LockPath
    }
}
