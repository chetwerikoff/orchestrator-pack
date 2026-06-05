#requires -Version 5.1
<#
  File-based side-effect fencing for supervised orchestrator children (Issue #205).
#>

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

function Test-OrchestratorSideEffectInFlight {
    param([string]$LockPath)
    if (-not $LockPath) { return $false }
    return Test-Path -LiteralPath $LockPath -PathType Leaf
}

function Enter-OrchestratorSideEffectFence {
    param(
        [string]$LockPath,
        [hashtable]$Metadata = @{}
    )

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
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $LockPath -Encoding utf8
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

    if (Test-OrchestratorSideEffectInFlight -LockPath $LockPath) {
        return @{ ok = $false; reason = 'side_effect_busy' }
    }

    Enter-OrchestratorSideEffectFence -LockPath $LockPath -Metadata $Metadata
    try {
        & $Action
        return @{ ok = $true }
    }
    finally {
        Exit-OrchestratorSideEffectFence -LockPath $LockPath
    }
}
