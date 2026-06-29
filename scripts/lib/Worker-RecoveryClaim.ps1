#requires -Version 5.1
<#
  Cross-process claims for autonomous worker recovery (Issue #522).
#>

$Script:WorkerRecoveryDefaultStaleMinutes = 15
$Script:WorkerRecoverySafeFloorMinutes = 2
$Script:WorkerRecoveryMutexStaleSeconds = 5
$Script:WorkerRecoveryTerminalRetentionCount = 64

function Get-WorkerRecoveryProjectNamespace {
    param([string]$ProjectId = 'orchestrator-pack')

    $project = ([string]$ProjectId).Trim()
    if (-not $project) { $project = 'orchestrator-pack' }
    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    return (Join-Path (Join-Path (Join-Path $base 'projects') $project) 'worker-recovery')
}

function Resolve-WorkerRecoveryNamespace {
    param(
        [string]$ProjectId = 'orchestrator-pack',
        [string]$Namespace = ''
    )

    if ($Namespace) { return $Namespace }
    if ($env:AO_WORKER_RECOVERY_DIR) { return $env:AO_WORKER_RECOVERY_DIR.Trim() }
    return (Get-WorkerRecoveryProjectNamespace -ProjectId $ProjectId)
}

function Get-WorkerRecoveryClaimKey {
    param([string]$ClaimKey)
    $key = ([string]$ClaimKey).Trim()
    if (-not $key) { throw 'ambiguous worker-recovery claim key' }
    return $key
}

function Get-WorkerRecoveryClaimPath {
    param([string]$Namespace, [string]$ClaimKey)
    return (Join-Path $Namespace "$((Get-WorkerRecoveryClaimKey -ClaimKey $ClaimKey)).json")
}

function Get-WorkerRecoveryLockDir {
    param([string]$Namespace, [string]$ClaimKey)
    return (Join-Path (Join-Path $Namespace '.locks') (Get-WorkerRecoveryClaimKey -ClaimKey $ClaimKey))
}

function Get-WorkerRecoveryAuditDir {
    param([string]$Namespace)
    return (Join-Path $Namespace 'audit')
}

function Get-WorkerRecoveryTerminalDir {
    param([string]$Namespace)
    return (Join-Path $Namespace 'terminal')
}

function Initialize-WorkerRecoveryNamespace {
    param([string]$Namespace)
    foreach ($dir in @($Namespace, (Get-WorkerRecoveryAuditDir -Namespace $Namespace), (Get-WorkerRecoveryTerminalDir -Namespace $Namespace), (Join-Path $Namespace '.locks'))) {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }
}

function New-WorkerRecoveryHolder {
    param([string]$Surface)
    $hostName = try { [System.Net.Dns]::GetHostName() } catch { 'unknown-host' }
    return @{
        surface     = $Surface
        pid         = $PID
        host        = $hostName
        generation  = if ($env:AO_CHILD_GENERATION) { $env:AO_CHILD_GENERATION } elseif ($env:AO_SESSION_ID) { $env:AO_SESSION_ID } else { '' }
        processGuid = [guid]::NewGuid().ToString('n')
    }
}

function Write-WorkerRecoveryAtomic {
    param(
        [string]$Path,
        [hashtable]$Record,
        [switch]$AllowOverwrite
    )
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $tmp = Join-Path $parent ".$([guid]::NewGuid().ToString('n')).tmp"
    ($Record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $tmp -Encoding UTF8
    try {
        if ($AllowOverwrite -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
            Remove-Item -LiteralPath $Path -Force
        }
        [System.IO.File]::Move($tmp, $Path)
    }
    catch {
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        if (-not $AllowOverwrite -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
            throw [System.IO.IOException]::new("claim already exists: $Path")
        }
        throw
    }
}

function Read-WorkerRecoveryClaimRecord {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return @{ ok = $false; reason = 'missing' }
        }
        $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
        $record = $raw | ConvertFrom-Json -AsHashtable
        return @{ ok = $true; record = $record }
    }
    catch {
        return @{ ok = $false; reason = 'unreadable' }
    }
}

function Enter-WorkerRecoveryMutex {
    param([string]$LockDir)
    if (-not (Test-Path -LiteralPath $LockDir)) {
        try {
            New-Item -ItemType Directory -Path $LockDir -Force | Out-Null
            return $true
        }
        catch {
            return $false
        }
    }
    return $false
}

function Exit-WorkerRecoveryMutex {
    param([string]$LockDir)
    Remove-Item -LiteralPath $LockDir -Recurse -Force -ErrorAction SilentlyContinue
}

function New-WorkerRecoveryActiveRecord {
    param(
        [string]$ClaimKey,
        [string]$Surface,
        [string]$CanonicalPath,
        [string]$SessionId = '',
        [string[]]$BoundCandidates = @(),
        [string]$Intent = 'recovery'
    )
    return @{
        schemaVersion   = 'worker-recovery/v1'
        claimKey        = $ClaimKey
        surface         = $Surface
        holder          = (New-WorkerRecoveryHolder -Surface $Surface)
        acquiredAtUtc   = (Get-Date).ToUniversalTime().ToString('o')
        canonicalPath   = $CanonicalPath
        sessionId       = $SessionId
        boundCandidates = @($BoundCandidates)
        intent          = $Intent
        phase           = 'claimed'
        attemptId       = [guid]::NewGuid().ToString('n')
    }
}

function Acquire-WorkerRecoveryClaim {
    param(
        [string]$ClaimKey,
        [string]$Surface,
        [string]$CanonicalPath,
        [string]$SessionId = '',
        [string[]]$BoundCandidates = @(),
        [string]$Namespace = '',
        [string]$ProjectId = 'orchestrator-pack'
    )

    $ns = Resolve-WorkerRecoveryNamespace -ProjectId $ProjectId -Namespace $Namespace
    Initialize-WorkerRecoveryNamespace -Namespace $ns
    $path = Get-WorkerRecoveryClaimPath -Namespace $ns -ClaimKey $ClaimKey
    $lockDir = Get-WorkerRecoveryLockDir -Namespace $ns -ClaimKey $ClaimKey
    $held = Enter-WorkerRecoveryMutex -LockDir $lockDir
    if (-not $held) {
        $existing = Read-WorkerRecoveryClaimRecord -Path $path
        return @{
            acquired = $false
            reason   = 'claim_held'
            path     = $path
            namespace = $ns
            record   = if ($existing.ok) { $existing.record } else { $null }
        }
    }
    try {
        $existing = Read-WorkerRecoveryClaimRecord -Path $path
        if ($existing.ok) {
            return @{
                acquired  = $false
                reason    = 'claim_exists'
                path      = $path
                namespace = $ns
                record    = $existing.record
            }
        }
        $record = New-WorkerRecoveryActiveRecord -ClaimKey $ClaimKey -Surface $Surface `
            -CanonicalPath $CanonicalPath -SessionId $SessionId -BoundCandidates $BoundCandidates
        Write-WorkerRecoveryAtomic -Path $path -Record $record
        return @{
            acquired  = $true
            reason    = 'claim_acquired'
            path      = $path
            namespace = $ns
            record    = $record
            claim     = $record
        }
    }
    finally {
        Exit-WorkerRecoveryMutex -LockDir $lockDir
    }
}

function Write-WorkerRecoveryAudit {
    param(
        [string]$Namespace,
        [hashtable]$Record
    )
    $auditDir = Get-WorkerRecoveryAuditDir -Namespace $Namespace
    if (-not (Test-Path -LiteralPath $auditDir)) {
        New-Item -ItemType Directory -Path $auditDir -Force | Out-Null
    }
    $name = "$([guid]::NewGuid().ToString('n')).json"
    Write-WorkerRecoveryAtomic -Path (Join-Path $auditDir $name) -Record $Record
}

function Update-WorkerRecoveryClaimPhase {
    param(
        [string]$Path,
        [hashtable]$Record,
        [string]$Phase,
        [hashtable]$Patch = @{}
    )
    $next = @{}
    foreach ($key in $Record.Keys) { $next[$key] = $Record[$key] }
    $next.phase = $Phase
    foreach ($key in $Patch.Keys) { $next[$key] = $Patch[$key] }
    $next.updatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    Write-WorkerRecoveryAtomic -Path $Path -Record $next -AllowOverwrite
    return $next
}

function Complete-WorkerRecoveryClaim {
    param(
        [string]$Namespace,
        [string]$Path,
        [hashtable]$Record,
        [string]$Outcome
    )
    $terminalDir = Get-WorkerRecoveryTerminalDir -Namespace $Namespace
    $terminalName = "$($Record.claimKey)-$Outcome-$([guid]::NewGuid().ToString('n')).json"
    $terminal = @{}
    foreach ($key in $Record.Keys) { $terminal[$key] = $Record[$key] }
    $terminal.phase = 'terminal'
    $terminal.outcome = $Outcome
    $terminal.completedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    Write-WorkerRecoveryAtomic -Path (Join-Path $terminalDir $terminalName) -Record $terminal
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
    return $terminal
}

function Get-ActiveWorkerRecoveryClaimForPath {
    param(
        [string]$CanonicalPath,
        [string]$Namespace = '',
        [string]$ProjectId = 'orchestrator-pack'
    )
    $ns = Resolve-WorkerRecoveryNamespace -ProjectId $ProjectId -Namespace $Namespace
    if (-not (Test-Path -LiteralPath $ns)) { return $null }
    $files = @(Get-ChildItem -LiteralPath $ns -Filter '*.json' -File -ErrorAction SilentlyContinue)
    foreach ($file in $files) {
        $read = Read-WorkerRecoveryClaimRecord -Path $file.FullName
        if (-not $read.ok) { continue }
        $record = $read.record
        $bound = @($record.boundCandidates)
        if ($record.canonicalPath -eq $CanonicalPath -or $bound -contains $CanonicalPath) {
            return @{ path = $file.FullName; record = $record; namespace = $ns }
        }
    }
    return $null
}
