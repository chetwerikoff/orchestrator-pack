#requires -Version 5.1
<#
  Process-bound journaled-worker-send internal ao send capabilities (Issue #384).
  Caller-forgeable environment flags are not trusted; only registered one-time
  tokens issued by journaled-worker-send and consumed by descendant ao guard
  processes are accepted.
#>

$Script:JournaledWorkerSendInternalCapabilityVersion = 'journaled-send-capability/v1'
$Script:JournaledWorkerSendInternalCapabilityPrefix = 'journaled-worker-send-internal/v1'
$Script:JournaledWorkerSendInternalCapabilityTtlSeconds = 120

. (Join-Path $PSScriptRoot 'Orchestrator-AutonomousBoundary.ps1')


function Get-TrustedJournaledWorkerSendScriptPath {
    $packRoot = Get-PackRootFromBoundaryLib
    return (Resolve-Path -LiteralPath (Join-Path $packRoot 'scripts/journaled-worker-send.ps1')).Path
}

function Test-TrustedJournaledWorkerSendScriptPath {
    param([string]$CandidatePath)

    if ([string]::IsNullOrWhiteSpace($CandidatePath)) { return $false }
    try {
        $resolved = (Resolve-Path -LiteralPath $CandidatePath -ErrorAction Stop).Path
    }
    catch {
        return $false
    }
    $trusted = Get-TrustedJournaledWorkerSendScriptPath
    $comparison = if ($IsWindows) {
        [System.StringComparison]::OrdinalIgnoreCase
    }
    else {
        [System.StringComparison]::Ordinal
    }
    return $resolved.Equals($trusted, $comparison)
}

function Get-ScriptPathsFromProcessCommandLine {
    param([string]$CommandLine)

    $paths = New-Object System.Collections.Generic.List[string]
    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return @()
    }
    # Honor Split-ProcessCommandLineTokens comma-return contract: do not re-wrap with @()
    # or single-element pipeline arrays nest and -File tokens become invisible (Issue #428).
    $tokens = Split-ProcessCommandLineTokens -CommandLine $CommandLine
    for ($index = 0; $index -lt $tokens.Count; $index++) {
        if ($tokens[$index] -in @('-File', '-f') -and ($index + 1) -lt $tokens.Count) {
            $paths.Add([string]$tokens[$index + 1]) | Out-Null
        }
    }
    return @($paths)
}

function Get-JournaledWorkerSendInternalCapabilityDir {
    param([string]$ProjectId = 'orchestrator-pack')

    $project = ([string]$ProjectId).Trim()
    if (-not $project) { $project = 'orchestrator-pack' }
    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    return (Join-Path (Join-Path (Join-Path $base 'projects') $project) 'journaled-send-capabilities')
}

function ConvertFrom-JournaledWorkerSendInternalCapability {
    param([string]$Capability)

    $raw = ([string]$Capability).Trim()
    if (-not $raw) { return @{ ok = $false; reason = 'missing_capability' } }
    $prefix = "$($Script:JournaledWorkerSendInternalCapabilityPrefix):"
    if (-not $raw.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
        return @{ ok = $false; reason = 'capability_prefix_invalid' }
    }
    $nonce = $raw.Substring($prefix.Length).Trim()
    if ($nonce.Length -lt 8 -or $nonce -notmatch '^[A-Za-z0-9-]+$') {
        return @{ ok = $false; reason = 'capability_nonce_invalid' }
    }
    return @{ ok = $true; capability = $raw; nonce = $nonce }
}

function New-JournaledWorkerSendInternalCapabilityToken {
    return "$($Script:JournaledWorkerSendInternalCapabilityPrefix):$([guid]::NewGuid().ToString('n'))"
}

function Test-ProcessIsDescendantOf {
    param(
        [int]$AncestorPid,
        [int]$StartProcessId = $PID,
        [int]$MaxDepth = 16
    )

    if ($AncestorPid -le 0) { return $false }
    $current = $StartProcessId
    for ($depth = 0; $depth -lt $MaxDepth; $depth++) {
        $ppid = Get-ParentProcessId -ProcessId $current
        if ($ppid -eq $AncestorPid) { return $true }
        if ($ppid -le 0 -or $ppid -eq $current) { break }
        $current = $ppid
    }
    return $false
}

function Test-JournaledWorkerSendCapabilityRegistrationAllowed {
    if ($env:AO_JOURNALED_SEND_CAPABILITY_TEST_FIXTURE -eq '1') { return $true }
    $allowedCommands = @('Invoke-AoSendViaMessage', 'Test-AoSendMessageContract', 'New-JournaledWorkerSendInternalCapability')
    foreach ($frame in Get-PSCallStack) {
        if ($frame.Command -notin $allowedCommands) { continue }
        if (Test-TrustedJournaledWorkerSendScriptPath -CandidatePath ([string]$frame.ScriptName)) {
            return $true
        }
    }
    return $false
}

function Test-JournaledWorkerSendParentChainTrusted {
    if ($env:AO_JOURNALED_SEND_CAPABILITY_TEST_FIXTURE -eq '1') { return $true }
    foreach ($line in @(Get-ProcessParentChainCommandLines)) {
        foreach ($scriptPath in @(Get-ScriptPathsFromProcessCommandLine -CommandLine $line)) {
            if (Test-TrustedJournaledWorkerSendScriptPath -CandidatePath $scriptPath) {
                return $true
            }
        }
    }
    return $false
}


function Write-JournaledWorkerSendInternalCapabilityAtomic {
    param(
        [string]$Path,
        [hashtable]$Record
    )

    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $tmp = Join-Path $dir ".$([guid]::NewGuid().ToString('n')).tmp"
    ($Record | ConvertTo-Json -Compress -Depth 6) | Set-Content -LiteralPath $tmp -Encoding UTF8
    try {
        [System.IO.File]::Move($tmp, $Path)
    }
    catch {
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Register-JournaledWorkerSendInternalCapability {
    param([string]$Capability = '')

    if (-not (Test-JournaledWorkerSendCapabilityRegistrationAllowed)) {
        return @{ ok = $false; reason = 'registration_denied' }
    }
    if (-not $Capability) {
        $Capability = New-JournaledWorkerSendInternalCapabilityToken
    }
    $parsed = ConvertFrom-JournaledWorkerSendInternalCapability -Capability $Capability
    if (-not $parsed.ok) {
        return @{ ok = $false; reason = [string]$parsed.reason }
    }

    $path = Join-Path (Get-JournaledWorkerSendInternalCapabilityDir) "$($parsed.nonce).json"
    $issuedAt = (Get-Date).ToUniversalTime()
    $record = @{
        version      = $Script:JournaledWorkerSendInternalCapabilityVersion
        capability   = [string]$parsed.capability
        nonce        = [string]$parsed.nonce
        issuerPid    = $PID
        issuedAtUtc  = $issuedAt.ToString('o')
        expiresAtUtc = $issuedAt.AddSeconds($Script:JournaledWorkerSendInternalCapabilityTtlSeconds).ToString('o')
    }
    try {
        Write-JournaledWorkerSendInternalCapabilityAtomic -Path $path -Record $record
    }
    catch [System.IO.IOException] {
        return @{ ok = $false; reason = 'capability_already_registered' }
    }
    return @{ ok = $true; capability = [string]$parsed.capability }
}

function Test-ConsumeJournaledWorkerSendInternalCapability {
    param([string]$Capability = [string]$env:AO_JOURNALED_SEND_INTERNAL)

    $parsed = ConvertFrom-JournaledWorkerSendInternalCapability -Capability $Capability
    if (-not $parsed.ok) { return $false }

    $path = Join-Path (Get-JournaledWorkerSendInternalCapabilityDir) "$($parsed.nonce).json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }

    try {
        $record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ([string]$record.capability -ne [string]$parsed.capability) { return $false }
        $expiresAt = [DateTime]::Parse([string]$record.expiresAtUtc).ToUniversalTime()
        if ((Get-Date).ToUniversalTime() -gt $expiresAt) {
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            return $false
        }
        if (-not (Test-ProcessIsDescendantOf -AncestorPid ([int]$record.issuerPid))) {
            return $false
        }
        if (-not (Test-JournaledWorkerSendParentChainTrusted)) {
            return $false
        }
        Remove-Item -LiteralPath $path -Force
        return $true
    }
    catch {
        return $false
    }
}
