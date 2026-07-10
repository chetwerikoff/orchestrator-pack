#requires -Version 5.1
<#
  State-root singleton lease for wake supervisor fleet cardinality (Issue #709).
  Linux/WSL2: held flock on <stateRoot>/supervisor.lock with JSON payload.
  Native Windows (non-WSL): fail-closed unless held lock is available.
#>

$Script:OrchestratorWakeSupervisorLeaseContext = $null
$Script:OrchestratorWakeSupervisorPendingStartHandoff = $null
$Script:OrchestratorWakeSupervisorFlockNativeLoaded = $false

function Initialize-OrchestratorWakeSupervisorFlockNative {
    if ($Script:OrchestratorWakeSupervisorFlockNativeLoaded) { return }
    if (-not ($IsLinux -or $IsMacOS)) {
        $Script:OrchestratorWakeSupervisorFlockNativeLoaded = $true
        return
    }
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OrchestratorWakeSupervisorFlockNative {
    [DllImport("libc", SetLastError = true)]
    public static extern int flock(int fd, int operation);
    public const int LOCK_EX = 2;
    public const int LOCK_NB = 4;
    public const int LOCK_UN = 8;
}
"@ -ErrorAction SilentlyContinue
    $Script:OrchestratorWakeSupervisorFlockNativeLoaded = $true
}

function Test-OrchestratorWakeSupervisorLeasePlatformSupported {
  if ($IsLinux -or $IsMacOS) { return $true }
  if ($env:WSL_DISTRO_NAME) { return $true }
  return $false
}

function Get-OrchestratorWakeSupervisorLeasePath {
    param([hashtable]$Paths)
    if ($Paths.SupervisorLock) { return $Paths.SupervisorLock }
    return Join-Path $Paths.Root 'supervisor.lock'
}

function Get-OrchestratorWakeSupervisorMaintenancePath {
    param([hashtable]$Paths)
    if ($Paths.MaintenanceEpoch) { return $Paths.MaintenanceEpoch }
    return Join-Path $Paths.Root 'maintenance.epoch'
}

function Get-OrchestratorWakeSupervisorStartReservationPath {
    param([hashtable]$Paths)
    if ($Paths.SupervisorStartLock) { return $Paths.SupervisorStartLock }
    return Join-Path $Paths.Root 'supervisor.start.lock'
}

function Get-OrchestratorWakeSupervisorStaleGraceSidecarPath {
    param([hashtable]$Paths)
    if ($Paths.StaleGraceSidecar) { return $Paths.StaleGraceSidecar }
    return Join-Path $Paths.Root 'stale-heartbeat-grace.json'
}

function Read-OrchestratorWakeSupervisorStaleGraceSidecar {
    param(
        [hashtable]$Paths,
        [hashtable]$Lease
    )
    if (-not $Lease) { return 0 }
    $path = Get-OrchestratorWakeSupervisorStaleGraceSidecarPath -Paths $Paths
    if (-not (Test-Path -LiteralPath $path)) { return 0 }
    try {
        $doc = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ([int]$doc.holderPid -ne [int]$Lease.holderPid) { return 0 }
        if ([int]$doc.epoch -ne [int]$Lease.epoch) { return 0 }
        return [long]$doc.staleGraceStartMs
    }
    catch {
        return 0
    }
}

function Write-OrchestratorWakeSupervisorStaleGraceSidecar {
    param(
        [hashtable]$Paths,
        [hashtable]$Lease,
        [long]$StaleGraceStartMs
    )
    if (-not $Lease) { return }
    $path = Get-OrchestratorWakeSupervisorStaleGraceSidecarPath -Paths $Paths
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $payload = @{
        holderPid         = [int]$Lease.holderPid
        epoch             = [int]$Lease.epoch
        staleGraceStartMs = [long]$StaleGraceStartMs
    } | ConvertTo-Json -Compress
    $temp = "$path.$PID.tmp"
    Set-Content -LiteralPath $temp -Value $payload -Encoding utf8 -NoNewline
    Move-Item -LiteralPath $temp -Destination $path -Force
}

function Clear-OrchestratorWakeSupervisorStaleGraceSidecar {
    param([hashtable]$Paths)
    $path = Get-OrchestratorWakeSupervisorStaleGraceSidecarPath -Paths $Paths
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

function Get-OrchestratorWakeSupervisorEffectiveStaleGraceStartMs {
    param(
        [hashtable]$Paths,
        [hashtable]$Lease
    )
    $fromLease = [long]$Lease.staleGraceStartMs
    if ($fromLease -gt 0) { return $fromLease }
    return Read-OrchestratorWakeSupervisorStaleGraceSidecar -Paths $Paths -Lease $Lease
}

function Get-OrchestratorWakeSupervisorBootId {
    if ($IsLinux -or $IsMacOS) {
        $bootPath = '/proc/sys/kernel/random/boot_id'
        if (Test-Path -LiteralPath $bootPath) {
            return (Get-Content -LiteralPath $bootPath -Raw).Trim()
        }
    }
    return ''
}

function Get-OrchestratorWakeSupervisorProcessStartTimeMs {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return 0 }
    if ($IsLinux -or $IsMacOS) {
        $statPath = "/proc/$ProcessId/stat"
        if (Test-Path -LiteralPath $statPath) {
            $stat = Get-Content -LiteralPath $statPath -Raw
            $close = $stat.LastIndexOf(')')
            if ($close -ge 0 -and $close + 2 -lt $stat.Length) {
                $fields = ($stat.Substring($close + 2)) -split '\s+'
                if ($fields.Count -ge 20) {
                    $startTicks = [long]$fields[19]
                    $clkTck = 100
                    try {
                        $clkTck = [long](& getconf CLK_TCK 2>$null)
                        if ($clkTck -le 0) { $clkTck = 100 }
                    }
                    catch { $clkTck = 100 }
                    $bootEpoch = 0
                    $bootPath = '/proc/stat'
                    if (Test-Path -LiteralPath $bootPath) {
                        foreach ($line in (Get-Content -LiteralPath $bootPath)) {
                            if ($line -match '^btime\s+(\d+)') {
                                $bootEpoch = [long]$Matches[1]
                                break
                            }
                        }
                    }
                    if ($bootEpoch -gt 0) {
                        return ($bootEpoch * 1000) + [long](($startTicks * 1000) / $clkTck)
                    }
                }
            }
        }
    }
    try {
        $proc = Get-Process -Id $ProcessId -ErrorAction Stop
        return [long]$proc.StartTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds
    }
    catch {
        return 0
    }
}

function Get-OrchestratorWakeSupervisorLeaseHeartbeatTtlMs {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_LEASE_HEARTBEAT_TTL_MS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(1000, [int]$fromEnv)
    }
    $pollSec = Get-OrchestratorWakeSupervisorPollSeconds
    return [Math]::Max(15000, ($pollSec * 4 + 10) * 1000)
}

function Get-OrchestratorWakeSupervisorLeaseStaleGraceMs {
    $fromEnv = $env:AO_WAKE_SUPERVISOR_LEASE_STALE_GRACE_MS
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$null)) {
        return [Math]::Max(0, [int]$fromEnv)
    }
    return 5000
}

function Get-OrchestratorWakeSupervisorNowMs {
    return [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
}

function Read-OrchestratorWakeSupervisorLeaseDocument {
    param([string]$LeasePath)
    if (-not (Test-Path -LiteralPath $LeasePath -PathType Leaf)) { return $null }

    $raw = ''
    if ($IsLinux -or $IsMacOS) {
        try {
            $raw = (& /bin/cat -- $LeasePath 2>$null | Out-String).Trim()
        }
        catch {
            $raw = ''
        }
    }
    if ([string]::IsNullOrWhiteSpace($raw)) {
        try {
            $stream = [System.IO.File]::Open(
                $LeasePath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::ReadWrite
            )
            try {
                $reader = New-Object System.IO.StreamReader($stream)
                $raw = $reader.ReadToEnd()
                $reader.Dispose()
            }
            finally {
                $stream.Dispose()
            }
        }
        catch {
            if (($IsLinux -or $IsMacOS) -and [string]::IsNullOrWhiteSpace($raw)) {
                try {
                    $raw = (& /bin/cat -- $LeasePath 2>$null | Out-String).Trim()
                }
                catch {
                    $raw = ''
                }
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    try {
        return $raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function ConvertTo-OrchestratorWakeSupervisorLeaseHashtable {
    param($Document)
    if (-not $Document) { return $null }
    return @{
        epoch             = if ($Document.epoch) { [int]$Document.epoch } else { 1 }
        holderPid         = if ($Document.holderPid) { [int]$Document.holderPid } else { 0 }
        holderStartTimeMs = if ($Document.holderStartTimeMs) { [long]$Document.holderStartTimeMs } else { 0 }
        bootId            = if ($Document.bootId) { [string]$Document.bootId } else { '' }
        heartbeatMs       = if ($Document.heartbeatMs) { [long]$Document.heartbeatMs } else { 0 }
        projectId         = if ($Document.projectId) { [string]$Document.projectId } else { '' }
        holderScriptPath  = if ($Document.holderScriptPath) { [string]$Document.holderScriptPath } else { '' }
        staleGraceStartMs = if ($Document.staleGraceStartMs) { [long]$Document.staleGraceStartMs } else { 0 }
        startLauncherPid  = if ($Document.startLauncherPid) { [int]$Document.startLauncherPid } else { 0 }
    }
}

function Write-OrchestratorWakeSupervisorLeaseDocument {
    param(
        [System.IO.FileStream]$LockStream,
        [hashtable]$Lease,
        [string]$LeasePath
    )
    $json = $Lease | ConvertTo-Json -Compress -Depth 4
    if ($LockStream) {
        $LockStream.SetLength(0)
        $LockStream.Position = 0
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $LockStream.Write($bytes, 0, $bytes.Length)
        $LockStream.Flush()
        return
    }
    Set-Content -LiteralPath $LeasePath -Value $json -Encoding utf8 -NoNewline
}

function Invoke-OrchestratorWakeSupervisorFlock {
    param(
        [System.IO.FileStream]$Stream,
        [int]$Operation
    )
    Initialize-OrchestratorWakeSupervisorFlockNative
    if (-not ($IsLinux -or $IsMacOS)) { return -1 }
    $handle = $Stream.SafeFileHandle
    $fd = $handle.DangerousGetHandle().ToInt32()
    return [OrchestratorWakeSupervisorFlockNative]::flock($fd, $Operation)
}

function New-OrchestratorWakeSupervisorHeldLock {
    param(
        [hashtable]$Paths,
        [switch]$NonBlocking
    )
    if (-not (Test-OrchestratorWakeSupervisorLeasePlatformSupported)) {
        return $null
    }
    Initialize-OrchestratorWakeSupervisorFlockNative
    $leasePath = Get-OrchestratorWakeSupervisorLeasePath -Paths $Paths
    $dir = Split-Path -Parent $leasePath
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    try {
        $stream = [System.IO.File]::Open(
            $leasePath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::ReadWrite
        )
    }
    catch {
        return $null
    }
    $op = [OrchestratorWakeSupervisorFlockNative]::LOCK_EX
    if ($NonBlocking) {
        $op = $op -bor [OrchestratorWakeSupervisorFlockNative]::LOCK_NB
    }
    $result = Invoke-OrchestratorWakeSupervisorFlock -Stream $stream -Operation $op
    if ($result -ne 0) {
        $stream.Dispose()
        return $null
    }
    return @{
        Stream    = $stream
        LeasePath = $leasePath
        Paths     = $Paths
    }
}

function Release-OrchestratorWakeSupervisorHeldLock {
    param($Context)
    if (-not $Context) { return }
    try {
        if ($Context.Stream) {
            Invoke-OrchestratorWakeSupervisorFlock -Stream $Context.Stream `
                -Operation ([OrchestratorWakeSupervisorFlockNative]::LOCK_UN) | Out-Null
            $Context.Stream.Dispose()
        }
    }
    catch {
        # ignore
    }
    if ($Script:OrchestratorWakeSupervisorLeaseContext -eq $Context) {
        $Script:OrchestratorWakeSupervisorLeaseContext = $null
    }
}

function New-OrchestratorWakeSupervisorHeldLockAtPath {
    param(
        [string]$LockPath,
        [hashtable]$Paths,
        [switch]$NonBlocking
    )
    if (-not (Test-OrchestratorWakeSupervisorLeasePlatformSupported)) {
        return $null
    }
    Initialize-OrchestratorWakeSupervisorFlockNative
    $dir = Split-Path -Parent $LockPath
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    try {
        $stream = [System.IO.File]::Open(
            $LockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::ReadWrite
        )
    }
    catch {
        return $null
    }
    $op = [OrchestratorWakeSupervisorFlockNative]::LOCK_EX
    if ($NonBlocking) {
        $op = $op -bor [OrchestratorWakeSupervisorFlockNative]::LOCK_NB
    }
    $result = Invoke-OrchestratorWakeSupervisorFlock -Stream $stream -Operation $op
    if ($result -ne 0) {
        $stream.Dispose()
        return $null
    }
    return @{
        Stream    = $stream
        LeasePath = $LockPath
        Paths     = $Paths
    }
}

function Test-OrchestratorWakeSupervisorStartLeaseInProgress {
    param(
        [hashtable]$Paths,
        [string]$LeasePath = ''
    )
    if (-not $LeasePath) {
        $LeasePath = Get-OrchestratorWakeSupervisorLeasePath -Paths $Paths
    }
    $startPath = Get-OrchestratorWakeSupervisorStartReservationPath -Paths $Paths
    $startHeld = New-OrchestratorWakeSupervisorHeldLockAtPath -LockPath $startPath -Paths $Paths -NonBlocking
    if ($startHeld) {
        Release-OrchestratorWakeSupervisorHeldLock -Context $startHeld
        return $false
    }
    return $true
}

function Acquire-OrchestratorWakeSupervisorStartLeaseHandoff {
    param(
        [hashtable]$Paths,
        [string]$ProjectId,
        [int]$Epoch,
        [string]$LogPath = ''
    )
    $startRes = New-OrchestratorWakeSupervisorHeldLockAtPath `
        -LockPath (Get-OrchestratorWakeSupervisorStartReservationPath -Paths $Paths) `
        -Paths $Paths -NonBlocking
    if (-not $startRes) { return $null }

    $main = New-OrchestratorWakeSupervisorHeldLock -Paths $Paths -NonBlocking
    if (-not $main) {
        Release-OrchestratorWakeSupervisorHeldLock -Context $startRes
        return $null
    }

    $nowMs = Get-OrchestratorWakeSupervisorNowMs
    $pending = @{
        epoch             = $Epoch
        holderPid         = 0
        holderStartTimeMs = 0
        bootId            = ''
        heartbeatMs       = $nowMs
        projectId         = $ProjectId
        holderScriptPath  = Get-OrchestratorWakeSupervisorScriptPath
        staleGraceStartMs = 0
        startLauncherPid  = $PID
    }
    Write-OrchestratorWakeSupervisorLeaseDocument -LockStream $main.Stream -Lease $pending -LeasePath $main.LeasePath
    if ($LogPath) {
        Write-OrchestratorWakeSupervisorLog -Message "start lease handoff reserved epoch=$Epoch launcherPid=$PID" -LogPath $LogPath
    }
    $handoff = @{
        StartReservation = $startRes
        MainLock         = $main
        Epoch            = $Epoch
        Paths            = $Paths
        ProjectId        = $ProjectId
    }
    $Script:OrchestratorWakeSupervisorPendingStartHandoff = $handoff
    return $handoff
}


function Invoke-OrchestratorWakeSupervisorStartLeaseHandoffRollback {
    param(
        [hashtable]$Handoff,
        [int]$SpawnedPid = 0,
        [string]$LogPath = ''
    )
    if (-not $Handoff) { return }
    $paths = $Handoff.Paths
    $projectId = if ($Handoff.ProjectId) { [string]$Handoff.ProjectId } else { '' }
    $stateRoot = if ($paths.Root) { [string]$paths.Root } else { '' }
    if ($SpawnedPid -gt 0 -and (Test-ProcessAlive -ProcessId $SpawnedPid)) {
        if ($LogPath) {
            Write-OrchestratorWakeSupervisorLog -Message "start lease handoff rollback: stopping spawned supervisor pid=$SpawnedPid" -LogPath $LogPath
        }
        Stop-OrchestratorWakeSupervisorChildren -Paths $paths -LogPath $LogPath -ProjectId $projectId -StateRoot $stateRoot
        Stop-OrchestratorWakeSupervisorProcess -ProcessId $SpawnedPid -PidFile $paths.SupervisorPid `
            -ManagedRole '' -LogPath $LogPath -ProjectId $projectId -StateRoot $stateRoot
        Wait-OrchestratorWakeSupervisorProcessExit -ProcessId $SpawnedPid -TimeoutSeconds 5
    }
    Abort-OrchestratorWakeSupervisorStartLeaseHandoff -Handoff $Handoff
}

function Abort-OrchestratorWakeSupervisorStartLeaseHandoff {
    param([hashtable]$Handoff)
    if (-not $Handoff) { return }
    if ($Handoff.MainLock) {
        Release-OrchestratorWakeSupervisorHeldLock -Context $Handoff.MainLock
        $Handoff.MainLock = $null
    }
    if ($Handoff.StartReservation) {
        Release-OrchestratorWakeSupervisorHeldLock -Context $Handoff.StartReservation
        $Handoff.StartReservation = $null
    }
    if ($Script:OrchestratorWakeSupervisorPendingStartHandoff -eq $Handoff) {
        $Script:OrchestratorWakeSupervisorPendingStartHandoff = $null
    }
}

function Complete-OrchestratorWakeSupervisorStartLeaseHandoff {
    param(
        [hashtable]$Handoff,
        [int]$SpawnedPid,
        [string]$LogPath = '',
        [int]$TimeoutSeconds = 0
    )
    if (-not $Handoff) { return $false }
    if ($TimeoutSeconds -le 0) {
        $TimeoutSeconds = 30
        if ($env:AO_WAKE_SUPERVISOR_START_HANDOFF_TIMEOUT_SEC -and [int]::TryParse($env:AO_WAKE_SUPERVISOR_START_HANDOFF_TIMEOUT_SEC, [ref]$null)) {
            $TimeoutSeconds = [Math]::Max(5, [int]$env:AO_WAKE_SUPERVISOR_START_HANDOFF_TIMEOUT_SEC)
        }
    }
    $paths = $Handoff.Paths
    $leasePath = Get-OrchestratorWakeSupervisorLeasePath -Paths $paths
    $deadline = (Get-Date).AddSeconds([Math]::Max(5, $TimeoutSeconds))

    while ((Get-Date) -lt $deadline) {
        if (Test-ProcessAlive -ProcessId $SpawnedPid) { break }
        Start-Sleep -Milliseconds 50
    }
    if (-not (Test-ProcessAlive -ProcessId $SpawnedPid)) {
        if ($LogPath) {
            Write-OrchestratorWakeSupervisorLog -Message "start lease handoff failed: spawned pid=$SpawnedPid never became alive" -LogPath $LogPath
        }
        Invoke-OrchestratorWakeSupervisorStartLeaseHandoffRollback -Handoff $Handoff -SpawnedPid $SpawnedPid -LogPath $LogPath
        return $false
    }

    if ($Handoff.MainLock) {
        Release-OrchestratorWakeSupervisorHeldLock -Context $Handoff.MainLock
        $Handoff.MainLock = $null
    }

    while ((Get-Date) -lt $deadline) {
        $lease = ConvertTo-OrchestratorWakeSupervisorLeaseHashtable `
            -Document (Read-OrchestratorWakeSupervisorLeaseDocument -LeasePath $leasePath)
        if ($lease -and [int]$lease.holderPid -eq $SpawnedPid -and (Test-ProcessAlive -ProcessId $SpawnedPid)) {
            if ($Handoff.StartReservation) {
                Release-OrchestratorWakeSupervisorHeldLock -Context $Handoff.StartReservation
                $Handoff.StartReservation = $null
            }
            if ($LogPath) {
                Write-OrchestratorWakeSupervisorLog -Message "start lease handoff complete holderPid=$SpawnedPid epoch=$($lease.epoch)" -LogPath $LogPath
            }
            if ($Script:OrchestratorWakeSupervisorPendingStartHandoff -eq $Handoff) {
                $Script:OrchestratorWakeSupervisorPendingStartHandoff = $null
            }
            return $true
        }
        Start-Sleep -Milliseconds 100
    }

    if ($LogPath) {
        Write-OrchestratorWakeSupervisorLog -Message "start lease handoff timed out waiting for holderPid=$SpawnedPid" -LogPath $LogPath
    }
    Invoke-OrchestratorWakeSupervisorStartLeaseHandoffRollback -Handoff $Handoff -SpawnedPid $SpawnedPid -LogPath $LogPath
    return $false
}

function Complete-OrchestratorWakeSupervisorStartLeaseHandoffAfterLoopAcquire {
    param([string]$LogPath = '')
    $handoff = $Script:OrchestratorWakeSupervisorPendingStartHandoff
    if (-not $handoff) { return }
    if ($handoff.StartReservation) {
        Release-OrchestratorWakeSupervisorHeldLock -Context $handoff.StartReservation
        $handoff.StartReservation = $null
    }
    if ($handoff.MainLock) {
        Release-OrchestratorWakeSupervisorHeldLock -Context $handoff.MainLock
        $handoff.MainLock = $null
    }
    $Script:OrchestratorWakeSupervisorPendingStartHandoff = $null
    if ($LogPath) {
        Write-OrchestratorWakeSupervisorLog -Message "start lease handoff complete in-loop holderPid=$PID" -LogPath $LogPath
    }
}

function Test-OrchestratorWakeSupervisorHeldLockAlive {
    param($Context)
    if (-not $Context -or -not $Context.Stream) { return $false }
    try {
        Initialize-OrchestratorWakeSupervisorFlockNative
        $op = [OrchestratorWakeSupervisorFlockNative]::LOCK_EX -bor [OrchestratorWakeSupervisorFlockNative]::LOCK_NB
        $result = Invoke-OrchestratorWakeSupervisorFlock -Stream $Context.Stream -Operation $op
        return ($result -eq 0)
    }
    catch {
        return $false
    }
}

function Get-OrchestratorWakeSupervisorCurrentLeaseEpoch {
    param([hashtable]$Paths)
    if ($Script:OrchestratorWakeSupervisorLeaseContext -and $Script:OrchestratorWakeSupervisorLeaseContext.Epoch) {
        return [int]$Script:OrchestratorWakeSupervisorLeaseContext.Epoch
    }
    $leasePath = Get-OrchestratorWakeSupervisorLeasePath -Paths $Paths
    $doc = ConvertTo-OrchestratorWakeSupervisorLeaseHashtable `
        -Document (Read-OrchestratorWakeSupervisorLeaseDocument -LeasePath $leasePath)
    if ($doc) { return [int]$doc.epoch }
    return 0
}

function Test-OrchestratorWakeSupervisorLeaseMutationAllowed {
    param([hashtable]$Paths)
    if (-not $Script:OrchestratorWakeSupervisorLeaseContext) { return $false }
    if (-not (Test-OrchestratorWakeSupervisorHeldLockAlive -Context $Script:OrchestratorWakeSupervisorLeaseContext)) {
        return $false
    }
    $currentEpoch = Get-OrchestratorWakeSupervisorCurrentLeaseEpoch -Paths $Paths
    return ($Script:OrchestratorWakeSupervisorLeaseContext.Epoch -eq $currentEpoch)
}

function Test-OrchestratorWakeSupervisorLeaseStaleEvidence {
    param(
        [hashtable]$Lease,
        [string]$LogPath = '',
        [hashtable]$Paths = $null
    )
    if (-not $Lease) { return 'missing-lease' }
    $holderPid = [int]$Lease.holderPid
    if ($holderPid -le 0) { return 'missing-holder-pid' }
    if (-not (Test-ProcessAlive -ProcessId $holderPid)) { return 'dead-pid' }

    $liveStartMs = Get-OrchestratorWakeSupervisorProcessStartTimeMs -ProcessId $holderPid
    if ($Lease.holderStartTimeMs -gt 0 -and $liveStartMs -gt 0 -and $Lease.holderStartTimeMs -ne $liveStartMs) {
        return 'start-time-mismatch'
    }

    $bootId = Get-OrchestratorWakeSupervisorBootId
    if ($bootId -and $Lease.bootId -and $Lease.bootId -ne $bootId) {
        return 'prior-boot'
    }

    $nowMs = Get-OrchestratorWakeSupervisorNowMs
    $ttl = Get-OrchestratorWakeSupervisorLeaseHeartbeatTtlMs
    $heartbeatMs = [long]$Lease.heartbeatMs
    if ($heartbeatMs -gt 0 -and ($nowMs - $heartbeatMs) -gt $ttl) {
        $graceMs = Get-OrchestratorWakeSupervisorLeaseStaleGraceMs
        $graceStart = [long]$Lease.staleGraceStartMs
        if ($graceStart -le 0 -and $Paths) {
            $graceStart = Get-OrchestratorWakeSupervisorEffectiveStaleGraceStartMs -Paths $Paths -Lease $Lease
        }
        if ($graceStart -le 0) {
            return 'stale-heartbeat-grace-pending'
        }
        if (($nowMs - $graceStart) -lt $graceMs) {
            return 'stale-heartbeat-grace-pending'
        }
        return 'stale-heartbeat'
    }
  return ''
}

function Write-OrchestratorWakeSupervisorStructuredAudit {
    param(
        [string]$Kind,
        [hashtable]$Fields,
        [string]$LogPath = ''
    )
    $redacted = @{}
    foreach ($key in $Fields.Keys) {
        $value = $Fields[$key]
        if ($null -eq $value) { continue }
        if ($value -is [string] -and $value -match '(?i)(secret|token|password|apikey)') {
            $redacted[$key] = '[redacted]'
        }
        else {
            $redacted[$key] = $value
        }
    }
    $line = "wake-supervisor-audit kind=$Kind " + ($redacted.GetEnumerator() | ForEach-Object {
            "{0}={1}" -f $_.Key, ($_.Value | Out-String).Trim()
        } | Where-Object { $_ } | Sort-Object) -join ' '
    Write-Host $line
    if ($LogPath) {
        Write-OrchestratorWakeSupervisorLog -Message $line -LogPath $LogPath
    }
}

function Invoke-OrchestratorWakeSupervisorStaleLiveReclaim {
    param(
        [hashtable]$Paths,
        [hashtable]$Lease,
        [string]$StaleEvidence,
        [string]$LogPath = ''
    )
    $holderPid = [int]$Lease.holderPid
    Write-OrchestratorWakeSupervisorStructuredAudit -Kind 'stale-live-reclaim' -LogPath $LogPath -Fields @{
        staleEvidence    = $StaleEvidence
        graceMs          = Get-OrchestratorWakeSupervisorLeaseStaleGraceMs
        priorHolderPid   = $holderPid
        priorEpoch       = $Lease.epoch
        priorProjectId   = $Lease.projectId
        priorScriptPath  = if ($Lease.holderScriptPath) { (Split-Path -Leaf $Lease.holderScriptPath) } else { '' }
        priorHeartbeatMs = $Lease.heartbeatMs
    }
    $leasePath = Get-OrchestratorWakeSupervisorLeasePath -Paths $Paths
    $freshLease = ConvertTo-OrchestratorWakeSupervisorLeaseHashtable `
        -Document (Read-OrchestratorWakeSupervisorLeaseDocument -LeasePath $leasePath)
    if ($freshLease) {
        $holderPid = [int]$freshLease.holderPid
        $Lease = $freshLease
        $recheckStale = Test-OrchestratorWakeSupervisorLeaseStaleEvidence -Lease $freshLease -LogPath $LogPath -Paths $Paths
        if (-not $recheckStale -or $recheckStale -eq 'stale-heartbeat-grace-pending') {
            Write-OrchestratorWakeSupervisorStructuredAudit -Kind 'stale-live-reclaim-aborted' -LogPath $LogPath -Fields @{
                reason             = if ($recheckStale) { 'grace-pending' } else { 'heartbeat-recovered' }
                holderPid          = $holderPid
                priorStaleEvidence = $StaleEvidence
                recheckStale       = if ($recheckStale) { $recheckStale } else { '' }
            }
            return $false
        }
        $StaleEvidence = $recheckStale
    }
    if ($holderPid -gt 0 -and (Test-ProcessAlive -ProcessId $holderPid)) {
        Stop-OrchestratorWakeSupervisorProcess -ProcessId $holderPid -ManagedRole 'supervisor' `
            -LogPath $LogPath -ProjectId $Lease.projectId -StateRoot $Paths.Root
        if (Test-ProcessAlive -ProcessId $holderPid) {
            if ($IsLinux -or $IsMacOS) {
                & kill -9 $holderPid 2>$null
            }
            else {
                Stop-Process -Id $holderPid -Force -ErrorAction SilentlyContinue
            }
        }
        Wait-OrchestratorWakeSupervisorProcessExit -ProcessId $holderPid -TimeoutSeconds 5
    }
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        if ($holderPid -le 0 -or -not (Test-ProcessAlive -ProcessId $holderPid)) { break }
        Start-Sleep -Milliseconds 100
    }
    $fenced = ($holderPid -le 0) -or -not (Test-ProcessAlive -ProcessId $holderPid)
    Write-OrchestratorWakeSupervisorStructuredAudit -Kind 'stale-live-reclaim-result' -LogPath $LogPath -Fields @{
        priorHolderPid = $holderPid
        fenced         = $fenced
        postCheck      = if ($fenced) { 'holder-exited' } else { 'holder-still-live' }
    }
    return $fenced
}

function Update-OrchestratorWakeSupervisorLeaseStaleGraceMarker {
    param(
        [hashtable]$Paths,
        [hashtable]$Lease,
        [string]$StaleEvidence
    )
    if ($StaleEvidence -ne 'stale-heartbeat-grace-pending') { return $Lease }
    $nowMs = Get-OrchestratorWakeSupervisorNowMs
    $effective = Get-OrchestratorWakeSupervisorEffectiveStaleGraceStartMs -Paths $Paths -Lease $Lease
    if ($effective -le 0) {
        $Lease.staleGraceStartMs = $nowMs
        if ($Script:OrchestratorWakeSupervisorLeaseContext) {
            Write-OrchestratorWakeSupervisorLeaseDocument -LockStream $Script:OrchestratorWakeSupervisorLeaseContext.Stream `
                -Lease $Lease -LeasePath (Get-OrchestratorWakeSupervisorLeasePath -Paths $Paths)
        }
        else {
            Write-OrchestratorWakeSupervisorStaleGraceSidecar -Paths $Paths -Lease $Lease -StaleGraceStartMs $nowMs
        }
    }
    elseif ([long]$Lease.staleGraceStartMs -le 0) {
        $Lease.staleGraceStartMs = $effective
    }
    return $Lease
}

function Enter-OrchestratorWakeSupervisorStopMaintenanceEpoch {
    param(
        [hashtable]$Paths,
        [string]$Reason = 'stop'
    )
    $path = Get-OrchestratorWakeSupervisorMaintenancePath -Paths $Paths
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    @{
        reason    = $Reason
        startedMs = (Get-OrchestratorWakeSupervisorNowMs)
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $path -Encoding utf8
    Set-OrchestratorWakeSupervisorStoppingFlag -Paths $Paths
}

function Exit-OrchestratorWakeSupervisorStopMaintenanceEpoch {
    param([hashtable]$Paths)
    $path = Get-OrchestratorWakeSupervisorMaintenancePath -Paths $Paths
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
    Clear-OrchestratorWakeSupervisorStoppingFlag -Paths $Paths
}

function Test-OrchestratorWakeSupervisorStopMaintenanceEpochActive {
    param([hashtable]$Paths)
    $path = Get-OrchestratorWakeSupervisorMaintenancePath -Paths $Paths
    return (Test-Path -LiteralPath $path) -or (Test-OrchestratorWakeSupervisorStopping -Paths $Paths)
}

function Find-OrchestratorWakeSupervisorLegacyNoLockHolders {
    param(
        [string]$ProjectId,
        [string]$StateRoot,
        [hashtable]$Paths
    )
    $candidates = @(
        Find-OrchestratorWakeSupervisorManagedSupervisorCandidates -ProjectId $ProjectId -StateRoot $StateRoot |
            Where-Object { $_ -ne $PID }
    )
    if ($candidates.Count -eq 0) { return @() }

    $leasePath = Get-OrchestratorWakeSupervisorLeasePath -Paths $Paths
    if (-not (Test-Path -LiteralPath $leasePath)) {
        return $candidates
    }

    $probe = New-OrchestratorWakeSupervisorHeldLock -Paths $Paths -NonBlocking
    if (-not $probe) {
        $lease = ConvertTo-OrchestratorWakeSupervisorLeaseHashtable `
            -Document (Read-OrchestratorWakeSupervisorLeaseDocument -LeasePath $leasePath)
        if ($lease -and $lease.holderPid -gt 0) {
            return @($candidates | Where-Object { $_ -ne [int]$lease.holderPid })
        }
        return @()
    }

    Release-OrchestratorWakeSupervisorHeldLock -Context $probe
    return $candidates
}

function Initialize-OrchestratorWakeSupervisorLoopLease {
    param(
        [hashtable]$Paths,
        [string]$ProjectId,
        [string]$LogPath = ''
    )
    if (-not (Test-OrchestratorWakeSupervisorLeasePlatformSupported)) {
        throw 'wake-supervisor lease unsupported on this platform; use Linux/WSL2 or fail-closed native Windows path'
    }
    if (Test-OrchestratorWakeSupervisorStopMaintenanceEpochActive -Paths $Paths) {
        throw 'start blocked: stop maintenance epoch active'
    }

    $gateHoldMs = 0
    if ($env:AO_WAKE_SUPERVISOR_LEASE_GATE_HOLD_MS -and [int]::TryParse($env:AO_WAKE_SUPERVISOR_LEASE_GATE_HOLD_MS, [ref]$null)) {
        $gateHoldMs = [Math]::Max(0, [int]$env:AO_WAKE_SUPERVISOR_LEASE_GATE_HOLD_MS)
    }
    if ($gateHoldMs -gt 0) {
        Start-Sleep -Milliseconds $gateHoldMs
    }

    $leasePath = Get-OrchestratorWakeSupervisorLeasePath -Paths $Paths
    $existing = ConvertTo-OrchestratorWakeSupervisorLeaseHashtable `
        -Document (Read-OrchestratorWakeSupervisorLeaseDocument -LeasePath $leasePath)
    $pendingHandoff = $false
    if ($existing -and [int]$existing.holderPid -eq 0 -and [int]$existing.startLauncherPid -gt 0) {
        $pendingHandoff = $true
    }
    elseif ($existing) {
        $stale = Test-OrchestratorWakeSupervisorLeaseStaleEvidence -Lease $existing -LogPath $LogPath -Paths $Paths
        if ($stale -and $stale -ne 'stale-heartbeat-grace-pending') {
            $null = Invoke-OrchestratorWakeSupervisorStaleLiveReclaim -Paths $Paths -Lease $existing `
                -StaleEvidence $stale -LogPath $LogPath
        }
        elseif ($stale -eq 'stale-heartbeat-grace-pending') {
            $null = Update-OrchestratorWakeSupervisorLeaseStaleGraceMarker -Paths $Paths -Lease $existing -StaleEvidence $stale
            throw "lease held by live supervisor pid=$($existing.holderPid); heartbeat grace pending"
        }
        elseif (-not $stale) {
            throw "lease held by live supervisor pid=$($existing.holderPid)"
        }
    }

    $held = New-OrchestratorWakeSupervisorHeldLock -Paths $Paths
    if (-not $held) {
        throw 'failed to acquire state-root supervisor lease (another holder owns flock)'
    }

    if ($pendingHandoff) {
        $epoch = [Math]::Max(1, [int]$existing.epoch)
    }
    else {
        $priorEpoch = if ($existing) { [int]$existing.epoch } else { 0 }
        $epoch = [Math]::Max(1, $priorEpoch + 1)
    }
    $nowMs = Get-OrchestratorWakeSupervisorNowMs
    $lease = @{
        epoch             = $epoch
        holderPid         = $PID
        holderStartTimeMs = Get-OrchestratorWakeSupervisorProcessStartTimeMs -ProcessId $PID
        bootId            = Get-OrchestratorWakeSupervisorBootId
        heartbeatMs       = $nowMs
        projectId         = $ProjectId
        holderScriptPath  = Get-OrchestratorWakeSupervisorScriptPath
        staleGraceStartMs = 0
    }
    Write-OrchestratorWakeSupervisorLeaseDocument -LockStream $held.Stream -Lease $lease -LeasePath $leasePath
    Clear-OrchestratorWakeSupervisorStaleGraceSidecar -Paths $Paths
    $held.Epoch = $epoch
    $held.Lease = $lease
    $Script:OrchestratorWakeSupervisorLeaseContext = $held
    Write-OrchestratorWakeSupervisorLog -Message "lease acquired epoch=$epoch holderPid=$PID" -LogPath $LogPath
    if ($Script:OrchestratorWakeSupervisorPendingStartHandoff) {
        Complete-OrchestratorWakeSupervisorStartLeaseHandoffAfterLoopAcquire -LogPath $LogPath
    }
    return $held
}

function Update-OrchestratorWakeSupervisorLeaseHeartbeat {
    param(
        [hashtable]$Paths,
        [string]$LogPath = ''
    )
    if (-not $Script:OrchestratorWakeSupervisorLeaseContext) { return $false }
    if (-not (Test-OrchestratorWakeSupervisorHeldLockAlive -Context $Script:OrchestratorWakeSupervisorLeaseContext)) {
        return $false
    }
    $nowMs = Get-OrchestratorWakeSupervisorNowMs
    $lease = $Script:OrchestratorWakeSupervisorLeaseContext.Lease.Clone()
    $lease.heartbeatMs = $nowMs
    $lease.staleGraceStartMs = 0
    $lease.holderPid = $PID
    Clear-OrchestratorWakeSupervisorStaleGraceSidecar -Paths $Paths
    Write-OrchestratorWakeSupervisorLeaseDocument -LockStream $Script:OrchestratorWakeSupervisorLeaseContext.Stream `
        -Lease $lease -LeasePath (Get-OrchestratorWakeSupervisorLeasePath -Paths $Paths)
    $Script:OrchestratorWakeSupervisorLeaseContext.Lease = $lease
    return $true
}

function Test-OrchestratorWakeSupervisorLoopLeaseHeld {
    param(
        [hashtable]$Paths,
        [string]$LogPath = ''
    )
    if (-not $Script:OrchestratorWakeSupervisorLeaseContext) {
        Write-OrchestratorWakeSupervisorLog -Message 'lease lost: no local held context' -LogPath $LogPath
        return $false
    }
    if (-not (Test-OrchestratorWakeSupervisorHeldLockAlive -Context $Script:OrchestratorWakeSupervisorLeaseContext)) {
        Write-OrchestratorWakeSupervisorLog -Message 'lease lost: flock no longer held' -LogPath $LogPath
        return $false
    }
    if (-not (Update-OrchestratorWakeSupervisorLeaseHeartbeat -Paths $Paths -LogPath $LogPath)) {
        Write-OrchestratorWakeSupervisorLog -Message 'lease lost: heartbeat refresh failed' -LogPath $LogPath
        return $false
    }
    return $true
}


function Resolve-OrchestratorWakeSupervisorLiveHolderStartOutcome {
    param(
        [hashtable]$Lease,
        [string]$ProjectId,
        [hashtable]$Paths = $null,
        [string]$LogPath = ''
    )
    if (-not $Lease) { return $null }

    $holderPid = [int]$Lease.holderPid
    if ($holderPid -le 0) {
        $launcherPid = if ($null -ne $Lease.startLauncherPid) { [int]$Lease.startLauncherPid } else { 0 }
        if ($launcherPid -gt 0 -and (Test-ProcessAlive -ProcessId $launcherPid)) {
            return @{
                Outcome  = 'start-in-progress'
                ExitCode = 2
                Message  = 'start blocked: another Start is reserving the state-root lease'
            }
        }
        return $null
    }

    $stale = Test-OrchestratorWakeSupervisorLeaseStaleEvidence -Lease $Lease -LogPath $LogPath -Paths $Paths
    if ($stale) { return $null }
    if (-not (Test-ProcessAlive -ProcessId $holderPid)) { return $null }

    $localScript = Normalize-OrchestratorWakeSupervisorPath -PathValue (Get-OrchestratorWakeSupervisorScriptPath)
    $holderScript = if ($Lease.holderScriptPath) {
        Normalize-OrchestratorWakeSupervisorPath -PathValue $Lease.holderScriptPath
    }
    else { '' }

    if ($holderScript -and $holderScript -eq $localScript) {
        return @{
            Outcome       = 'already-running-same-checkout'
            ExitCode      = 0
            Message       = "supervisor already running (pid=$holderPid)"
            HolderPid     = $holderPid
            HolderProject = $Lease.projectId
        }
    }

    $crossProject = $Lease.projectId -and $Lease.projectId -ne $ProjectId
    $msg = if ($crossProject) {
        "cross-project start blocked: holder pid=$holderPid project=$($Lease.projectId) owns state-root lease; use Stop -Force on holder project or shared recovery"
    }
    else {
        "cross-checkout start blocked: holder pid=$holderPid from foreign checkout owns state-root lease (script=$(Split-Path -Leaf $holderScript)); Status/Stop from this checkout can manage it"
    }
    return @{
        Outcome       = 'foreign-holder'
        ExitCode      = 3
        Message       = $msg
        HolderPid     = $holderPid
        HolderProject = $Lease.projectId
        HolderScript  = $holderScript
    }
}

function Resolve-OrchestratorWakeSupervisorStartLeaseDecision {
    param(
        [hashtable]$Paths,
        [string]$ProjectId,
        [string]$LogPath = ''
    )
    if (-not (Test-OrchestratorWakeSupervisorLeasePlatformSupported)) {
        return @{
            Outcome  = 'unsupported-platform'
            ExitCode = 2
            Message  = 'wake-supervisor state-root lease is unsupported on native Windows PowerShell; use Linux/WSL2'
        }
    }
    if (Test-OrchestratorWakeSupervisorStopMaintenanceEpochActive -Paths $Paths) {
        return @{
            Outcome  = 'maintenance-active'
            ExitCode = 2
            Message  = 'start blocked: stop maintenance epoch active'
        }
    }

    $legacy = Find-OrchestratorWakeSupervisorLegacyNoLockHolders -ProjectId $ProjectId -StateRoot $Paths.Root -Paths $Paths
    if ($legacy.Count -gt 0) {
        return @{
            Outcome     = 'legacy-no-lock'
            ExitCode    = 2
            Message     = "legacy managed supervisor without lease detected (pids=$($legacy -join ',')); use Stop -Force before Start"
            LegacyPids  = $legacy
        }
    }

    $leasePath = Get-OrchestratorWakeSupervisorLeasePath -Paths $Paths
    if (Test-OrchestratorWakeSupervisorStartLeaseInProgress -Paths $Paths -LeasePath $leasePath) {
        return @{
            Outcome  = 'start-in-progress'
            ExitCode = 2
            Message  = 'start blocked: another Start is reserving the state-root lease'
        }
    }

    $existing = ConvertTo-OrchestratorWakeSupervisorLeaseHashtable `
        -Document (Read-OrchestratorWakeSupervisorLeaseDocument -LeasePath $leasePath)
    $liveHolderOutcome = Resolve-OrchestratorWakeSupervisorLiveHolderStartOutcome -Lease $existing `
        -ProjectId $ProjectId -Paths $Paths -LogPath $LogPath
    if ($liveHolderOutcome) { return $liveHolderOutcome }

    $nextEpochAfterReclaim = 0
    if ($existing) {
        $stalePreHandoff = Test-OrchestratorWakeSupervisorLeaseStaleEvidence -Lease $existing -LogPath $LogPath -Paths $Paths
        if ($stalePreHandoff -eq 'stale-heartbeat-grace-pending') {
            $existing = Update-OrchestratorWakeSupervisorLeaseStaleGraceMarker -Paths $Paths -Lease $existing -StaleEvidence $stalePreHandoff
            $stalePreHandoff = Test-OrchestratorWakeSupervisorLeaseStaleEvidence -Lease $existing -LogPath $LogPath -Paths $Paths
            if ($stalePreHandoff -eq 'stale-heartbeat-grace-pending') {
                return @{
                    Outcome  = 'lease-grace-pending'
                    ExitCode = 2
                    Message  = "lease heartbeat stale but grace pending for holder pid=$($existing.holderPid)"
                }
            }
        }
        if ($stalePreHandoff -and $stalePreHandoff -ne 'stale-heartbeat-grace-pending') {
            $fencedPreHandoff = Invoke-OrchestratorWakeSupervisorStaleLiveReclaim -Paths $Paths -Lease $existing `
                -StaleEvidence $stalePreHandoff -LogPath $LogPath
            if ($fencedPreHandoff) {
                $nextEpochAfterReclaim = [int]$existing.epoch + 1
                Clear-OrchestratorWakeSupervisorStaleGraceSidecar -Paths $Paths
                $existing = $null
            }
            else {
                $existing = ConvertTo-OrchestratorWakeSupervisorLeaseHashtable `
                    -Document (Read-OrchestratorWakeSupervisorLeaseDocument -LeasePath $leasePath)
                if (-not $existing) {
                    return @{
                        Outcome  = 'reclaim-failed'
                        ExitCode = 2
                        Message  = 'stale lease reclaim failed: lease payload unreadable after reclaim attempt'
                    }
                }
                $staleAfterReclaim = Test-OrchestratorWakeSupervisorLeaseStaleEvidence -Lease $existing -LogPath $LogPath -Paths $Paths
                if ($staleAfterReclaim -and $staleAfterReclaim -ne 'stale-heartbeat-grace-pending') {
                    return @{
                        Outcome  = 'reclaim-failed'
                        ExitCode = 2
                        Message  = "stale lease reclaim failed for holder pid=$($existing.holderPid)"
                    }
                }
                if ($staleAfterReclaim -eq 'stale-heartbeat-grace-pending') {
                    return @{
                        Outcome  = 'lease-grace-pending'
                        ExitCode = 2
                        Message  = "lease heartbeat stale but grace pending for holder pid=$($existing.holderPid)"
                    }
                }
                $liveHolderOutcome = Resolve-OrchestratorWakeSupervisorLiveHolderStartOutcome -Lease $existing `
                    -ProjectId $ProjectId -Paths $Paths -LogPath $LogPath
                if ($liveHolderOutcome) { return $liveHolderOutcome }
            }
        }
    }

    $epoch = if ($nextEpochAfterReclaim -gt 0) { $nextEpochAfterReclaim }
    elseif ($existing) { [int]$existing.epoch + 1 }
    else { 1 }
    $handoff = Acquire-OrchestratorWakeSupervisorStartLeaseHandoff -Paths $Paths -ProjectId $ProjectId `
        -Epoch $epoch -LogPath $LogPath
    if ($handoff) {
        return @{
            Outcome  = 'spawn-allowed'
            Epoch    = $epoch
            Handoff  = $handoff
        }
    }

    $lease = if ($existing) { $existing } else {
        ConvertTo-OrchestratorWakeSupervisorLeaseHashtable `
            -Document (Read-OrchestratorWakeSupervisorLeaseDocument -LeasePath $leasePath)
    }
    if (-not $lease) {
        return @{
            Outcome  = 'lease-contended'
            ExitCode = 2
            Message  = 'state-root lease contended but payload unreadable; retry or use Stop -Force'
        }
    }

    $stale = Test-OrchestratorWakeSupervisorLeaseStaleEvidence -Lease $lease -LogPath $LogPath -Paths $Paths
    if ($stale -eq 'stale-heartbeat-grace-pending') {
        $lease = Update-OrchestratorWakeSupervisorLeaseStaleGraceMarker -Paths $Paths -Lease $lease -StaleEvidence $stale
        $stale = Test-OrchestratorWakeSupervisorLeaseStaleEvidence -Lease $lease -LogPath $LogPath -Paths $Paths
    }
    if ($stale -and $stale -ne 'stale-heartbeat-grace-pending') {
        $fenced = Invoke-OrchestratorWakeSupervisorStaleLiveReclaim -Paths $Paths -Lease $lease `
            -StaleEvidence $stale -LogPath $LogPath
        if ($fenced) {
            Clear-OrchestratorWakeSupervisorStaleGraceSidecar -Paths $Paths
            $epoch = [int]$lease.epoch + 1
            $handoff = Acquire-OrchestratorWakeSupervisorStartLeaseHandoff -Paths $Paths -ProjectId $ProjectId `
                -Epoch $epoch -LogPath $LogPath
            if ($handoff) {
                return @{
                    Outcome = 'spawn-allowed'
                    Epoch   = $epoch
                    Handoff = $handoff
                }
            }
            return @{
                Outcome  = 'start-in-progress'
                ExitCode = 2
                Message  = 'start blocked: could not reserve state-root lease after stale reclaim'
            }
        }
        $lease = ConvertTo-OrchestratorWakeSupervisorLeaseHashtable `
            -Document (Read-OrchestratorWakeSupervisorLeaseDocument -LeasePath $leasePath)
        if (-not $lease) {
            return @{
                Outcome  = 'reclaim-failed'
                ExitCode = 2
                Message  = 'stale lease reclaim failed: lease payload unreadable after reclaim attempt'
            }
        }
        $stale = Test-OrchestratorWakeSupervisorLeaseStaleEvidence -Lease $lease -LogPath $LogPath -Paths $Paths
        if ($stale -and $stale -ne 'stale-heartbeat-grace-pending') {
            return @{
                Outcome  = 'reclaim-failed'
                ExitCode = 2
                Message  = "stale lease reclaim failed for holder pid=$($lease.holderPid)"
            }
        }
    }
    if ($stale -eq 'stale-heartbeat-grace-pending') {
        return @{
            Outcome  = 'lease-grace-pending'
            ExitCode = 2
            Message  = "lease heartbeat stale but grace pending for holder pid=$($lease.holderPid)"
        }
    }

    $holderPid = [int]$lease.holderPid
    $localScript = Normalize-OrchestratorWakeSupervisorPath -PathValue (Get-OrchestratorWakeSupervisorScriptPath)
    $holderScript = if ($lease.holderScriptPath) {
        Normalize-OrchestratorWakeSupervisorPath -PathValue $lease.holderScriptPath
    }
    else { '' }

    if ($holderPid -gt 0 -and (Test-ProcessAlive -ProcessId $holderPid)) {
        if ($holderScript -and $holderScript -eq $localScript) {
            return @{
                Outcome       = 'already-running-same-checkout'
                ExitCode      = 0
                Message       = "supervisor already running (pid=$holderPid)"
                HolderPid     = $holderPid
                HolderProject = $lease.projectId
            }
        }
        $crossProject = $lease.projectId -and $lease.projectId -ne $ProjectId
        $msg = if ($crossProject) {
            "cross-project start blocked: holder pid=$holderPid project=$($lease.projectId) owns state-root lease; use Stop -Force on holder project or shared recovery"
        }
        else {
            "cross-checkout start blocked: holder pid=$holderPid from foreign checkout owns state-root lease (script=$(Split-Path -Leaf $holderScript)); Status/Stop from this checkout can manage it"
        }
        return @{
            Outcome       = 'foreign-holder'
            ExitCode      = 3
            Message       = $msg
            HolderPid     = $holderPid
            HolderProject = $lease.projectId
            HolderScript  = $holderScript
        }
    }

    return @{
        Outcome  = 'lease-contended'
        ExitCode = 2
        Message  = 'state-root lease contended; holder state unclear'
    }
}

function Invoke-OrchestratorWakeSupervisorForceStop {
    param(
        [hashtable]$Paths,
        [string]$ProjectId,
        [string]$LogPath = ''
    )
    Enter-OrchestratorWakeSupervisorStopMaintenanceEpoch -Paths $Paths -Reason 'force-stop'
    $audit = @{
        matchedSupervisorCount = 0
        matchedSupervisorPids  = @()
        matchedChildCount      = 0
        matchedChildPids       = @()
        killed                 = @()
        skipped                = @()
        legacyStillLive        = @()
        stillLive              = @()
        leaseEpoch             = 0
        leaseHolderPid         = 0
    }

    $leasePath = Get-OrchestratorWakeSupervisorLeasePath -Paths $Paths
    $lease = ConvertTo-OrchestratorWakeSupervisorLeaseHashtable `
        -Document (Read-OrchestratorWakeSupervisorLeaseDocument -LeasePath $leasePath)
    if ($lease) {
        $audit.leaseEpoch = [int]$lease.epoch
        $audit.leaseHolderPid = [int]$lease.holderPid
    }

    $supervisorCandidates = @(Find-OrchestratorWakeSupervisorManagedSupervisorCandidates -ProjectId $ProjectId -StateRoot $Paths.Root)
    $audit.matchedSupervisorCount = $supervisorCandidates.Count
    $audit.matchedSupervisorPids = $supervisorCandidates

    foreach ($candidatePid in $supervisorCandidates) {
        Stop-OrchestratorWakeSupervisorProcess -ProcessId $candidatePid -PidFile '' -ManagedRole '' `
            -LogPath $LogPath -ProjectId $ProjectId -StateRoot $Paths.Root
        $audit.killed += "supervisor:$candidatePid"
    }

    $registry = Get-OrchestratorWakeSupervisorChildRegistry
    foreach ($child in $registry) {
        $childPids = Find-OrchestratorWakeSupervisorManagedChildCandidatesForState -Paths $Paths `
            -ProjectId $ProjectId -ChildId $child.Id
        foreach ($childPid in $childPids) {
            $audit.matchedChildCount++
            $audit.matchedChildPids += $childPid
            Stop-OrchestratorWakeSupervisorProcess -ProcessId $childPid -PidFile '' -ManagedRole '' `
                -LogPath $LogPath -ProjectId $ProjectId -StateRoot $Paths.Root
            $audit.killed += "$($child.Id):$childPid"
        }
    }

    foreach ($candidatePid in @($audit.matchedSupervisorPids + $audit.matchedChildPids | Sort-Object -Unique)) {
        Wait-OrchestratorWakeSupervisorProcessExit -ProcessId $candidatePid -TimeoutSeconds 5
        if (Test-ProcessAlive -ProcessId $candidatePid) {
            $audit.stillLive += $candidatePid
        }
    }

    $holderPid = if ($lease) { [int]$lease.holderPid } else { 0 }
    if ($holderPid -gt 0 -and (Test-ProcessAlive -ProcessId $holderPid) -and ($audit.stillLive -notcontains $holderPid)) {
        $audit.stillLive += $holderPid
    }

    $allCandidates = @(Find-OrchestratorWakeSupervisorManagedSupervisorCandidates -ProjectId $ProjectId -StateRoot $Paths.Root)
    foreach ($candidatePid in $allCandidates) {
        if (Test-ProcessAlive -ProcessId $candidatePid) {
            $audit.legacyStillLive += $candidatePid
        }
    }

    $lockReleased = $false
    if ($holderPid -le 0 -or -not (Test-ProcessAlive -ProcessId $holderPid)) {
        $probe = New-OrchestratorWakeSupervisorHeldLock -Paths $Paths -NonBlocking
        if ($probe) {
            $lockReleased = $true
            Release-OrchestratorWakeSupervisorHeldLock -Context $probe
        }
    }

    $forceStopSucceeded = ($audit.stillLive.Count -eq 0)

    Write-OrchestratorWakeSupervisorStructuredAudit -Kind 'force-stop' -LogPath $LogPath -Fields @{
        matchedSupervisorCount = $audit.matchedSupervisorCount
        matchedSupervisorPids  = ($audit.matchedSupervisorPids -join ',')
        matchedChildCount      = $audit.matchedChildCount
        matchedChildPids       = ($audit.matchedChildPids -join ',')
        leaseEpoch             = $audit.leaseEpoch
        leaseHolderPid         = $audit.leaseHolderPid
        killed                 = ($audit.killed -join ',')
        skipped                = ($audit.skipped -join ',')
        legacyStillLive        = ($audit.legacyStillLive -join ',')
        stillLive              = ($audit.stillLive -join ',')
        lockReleased           = $lockReleased
        forceStopSucceeded     = $forceStopSucceeded
        projectId              = $ProjectId
        stateRoot              = $Paths.Root
    }

    if ($forceStopSucceeded) {
        if ($lockReleased) {
            Remove-OrchestratorWakeSupervisorPidFile -Path $Paths.SupervisorPid
        }
        foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
            $pidFile = Get-OrchestratorWakeSupervisorChildPidPath -Paths $Paths -ChildId $child.Id
            Remove-OrchestratorWakeSupervisorPidFile -Path $pidFile
        }
        if (Test-Path -LiteralPath $Paths.StateJson) {
            Remove-Item -LiteralPath $Paths.StateJson -Force -ErrorAction SilentlyContinue
        }
        Clear-OrchestratorWakeSupervisorStaleGraceSidecar -Paths $Paths
        Exit-OrchestratorWakeSupervisorStopMaintenanceEpoch -Paths $Paths
    }
    return $audit
}


function Get-OrchestratorWakeSupervisorLeaseEpoch {
    param([hashtable]$Paths = $null)
    if ($Script:OrchestratorWakeSupervisorLeaseContext -and $Script:OrchestratorWakeSupervisorLeaseContext.Epoch) {
        return [int]$Script:OrchestratorWakeSupervisorLeaseContext.Epoch
    }
    if ($Paths) {
        return Get-OrchestratorWakeSupervisorCurrentLeaseEpoch -Paths $Paths
    }
    return 0
}

function Test-OrchestratorWakeSupervisorLeaseEpochCurrent {
    param([hashtable]$Paths = $null)
    if (-not $Script:OrchestratorWakeSupervisorLeaseContext) { return $false }
    if ($Paths) {
        return Test-OrchestratorWakeSupervisorLeaseMutationAllowed -Paths $Paths
    }
    if (-not (Test-OrchestratorWakeSupervisorHeldLockAlive -Context $Script:OrchestratorWakeSupervisorLeaseContext)) {
        return $false
    }
    return $true
}

function Assert-OrchestratorWakeSupervisorLeaseMutationAllowed {
    param([hashtable]$Paths = $null)
    if (-not (Test-OrchestratorWakeSupervisorLeaseEpochCurrent -Paths $Paths)) {
        throw 'lease epoch stale; mutation refused'
    }
}

function Read-OrchestratorWakeSupervisorLeaseRecord {
    param([string]$LockPath)
    $doc = Read-OrchestratorWakeSupervisorLeaseDocument -LeasePath $LockPath
    if (-not $doc) { return $null }
    return @{
        pid   = [int]$doc.holderPid
        epoch = [int]$doc.epoch
    }
}

function Release-OrchestratorWakeSupervisorLease {
    if ($Script:OrchestratorWakeSupervisorLeaseContext) {
        Release-OrchestratorWakeSupervisorHeldLock -Context $Script:OrchestratorWakeSupervisorLeaseContext
    }
}

function Invoke-OrchestratorWakeSupervisorLeaseHeartbeat {
    param(
        [hashtable]$Paths,
        [int]$PollSeconds = 0,
        [string]$LogPath = ''
    )
    if (-not $Paths) { return $false }
    if (-not $LogPath) { $LogPath = $Paths.SupervisorLog }
    return Update-OrchestratorWakeSupervisorLeaseHeartbeat -Paths $Paths -LogPath $LogPath
}

function Test-OrchestratorWakeSupervisorLeaseStillHeld {
    param(
        [hashtable]$Paths,
        [int]$PollSeconds = 0,
        [string]$LogPath = ''
    )
    if (-not $LogPath) { $LogPath = $Paths.SupervisorLog }
    return Test-OrchestratorWakeSupervisorLoopLeaseHeld -Paths $Paths -LogPath $LogPath
}

function Enter-OrchestratorWakeSupervisorHeldLease {
    param(
        [hashtable]$Paths,
        [string]$ProjectId,
        [int]$PollSeconds = 0,
        [string]$CheckoutScript = '',
        [switch]$AllowReclaim
    )
    try {
        $held = Initialize-OrchestratorWakeSupervisorLoopLease -Paths $Paths -ProjectId $ProjectId `
            -LogPath $Paths.SupervisorLog
        return @{ ok = $true; held = $held }
    }
    catch {
        return @{ ok = $false; reason = [string]$_ }
    }
}

function Resolve-OrchestratorWakeSupervisorStartLeaseGate {
    param(
        [hashtable]$Paths,
        [string]$ProjectId,
        [int]$PollSeconds = 0,
        [string]$CheckoutScript = '',
        [string]$LogPath = ''
    )
    if (-not $LogPath) { $LogPath = $Paths.SupervisorLog }
    $decision = Resolve-OrchestratorWakeSupervisorStartLeaseDecision -Paths $Paths -ProjectId $ProjectId -LogPath $LogPath
    $outcome = [string]$decision.Outcome
    switch ($outcome) {
        'spawn-allowed' {
            return @{
                action  = 'spawn'
                epoch   = if ($null -ne $decision.Epoch) { [int]$decision.Epoch } else { 1 }
                handoff = $decision.Handoff
            }
        }
        'start-in-progress' {
            return @{
                action   = 'fail'
                exitCode = if ($decision.ExitCode) { [int]$decision.ExitCode } else { 2 }
                message  = [string]$decision.Message
            }
        }
        'already-running-same-checkout' {
            return @{
                action    = 'already_running'
                exitCode  = 0
                holderPid = if ($decision.HolderPid) { [int]$decision.HolderPid } else { 0 }
                message   = [string]$decision.Message
            }
        }
        'foreign-holder' {
            return @{
                action   = 'fail'
                exitCode = if ($decision.ExitCode) { [int]$decision.ExitCode } else { 3 }
                message  = [string]$decision.Message
            }
        }
        'lease-grace-pending' {
            return @{
                action   = 'fail'
                exitCode = if ($decision.ExitCode) { [int]$decision.ExitCode } else { 2 }
                message  = [string]$decision.Message
            }
        }
        default {
            return @{
                action   = 'fail'
                exitCode = if ($decision.ExitCode) { [int]$decision.ExitCode } else { 2 }
                message  = [string]$decision.Message
            }
        }
    }
}

function Test-OrchestratorWakeSupervisorSupervisorStateRootIdentity {
    param(
        [string]$CommandLine = '',
        [string[]]$Tokens = @(),
        [string]$ProjectId,
        [string]$StateRoot
    )
    if ((-not $Tokens -or $Tokens.Count -eq 0) -and $CommandLine) {
        $Tokens = Split-ProcessCommandLineTokens -CommandLine $CommandLine
    }
    if (-not $Tokens -or $Tokens.Count -eq 0) { return $false }

    $scriptInCommand = Get-OrchestratorWakeSupervisorCommandLineScriptPath -Tokens $Tokens
    if (-not $scriptInCommand) { return $false }
    if ($scriptInCommand -notmatch 'orchestrator-wake-supervisor\.ps1$') { return $false }

    $action = Get-OrchestratorWakeSupervisorCommandLineSwitchValue -Tokens $Tokens -SwitchName '-Action'
    if ($action -ne 'Start') { return $false }

    $hasSupervisorLoop = Test-OrchestratorWakeSupervisorCommandLineHasSwitch -Tokens $Tokens -SwitchName '-SupervisorLoop'
    $hasForeground = Test-OrchestratorWakeSupervisorCommandLineHasSwitch -Tokens $Tokens -SwitchName '-Foreground'
    if (-not $hasSupervisorLoop -and -not $hasForeground) { return $false }

    $defaultProject = Get-OrchestratorWakeSupervisorDefaultProjectId
    $commandProject = Get-OrchestratorWakeSupervisorCommandLineSwitchValue -Tokens $Tokens -SwitchName '-ProjectId'
    if ($commandProject) {
        if ($commandProject -ne $ProjectId) { return $false }
    }
    elseif ($ProjectId -ne $defaultProject) { return $false }

    $normalizedExpectedState = Normalize-OrchestratorWakeSupervisorPath -PathValue $StateRoot
    $commandStateDir = Get-OrchestratorWakeSupervisorCommandLineSwitchValue -Tokens $Tokens -SwitchName '-StateDir'
    if ($commandStateDir) {
        $normalizedCommandState = Normalize-OrchestratorWakeSupervisorPath -PathValue $commandStateDir
        if ($normalizedCommandState -ne $normalizedExpectedState) { return $false }
    }
    else {
        $defaultStateRoot = Normalize-OrchestratorWakeSupervisorPath -PathValue (Get-OrchestratorWakeSupervisorStateRoot)
        if ($normalizedExpectedState -ne $defaultStateRoot) { return $false }
    }
    return $true
}

function Test-OrchestratorWakeSupervisorSupervisorStateRootProcessIdentity {
    param(
        [int]$ProcessId,
        [string]$ProjectId,
        [string]$StateRoot
    )
    if ($ProcessId -le 0) { return $false }
    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return $false }
    $tokens = Get-OrchestratorWakeSupervisorProcessCommandLineTokens -ProcessId $ProcessId
    if (-not $tokens -or $tokens.Count -eq 0) { return $false }
    return Test-OrchestratorWakeSupervisorSupervisorStateRootIdentity -Tokens $tokens `
        -ProjectId $ProjectId -StateRoot $StateRoot
}
