#requires -Version 5.1
<#
  Persist harness [Pn] retrigger counts across confirmed-delivery gate reruns (Issue #683).
#>

function Get-HarnessPnRetriggerStateRoot {
    if ($env:PACK_HARNESS_PN_RETRIGGER_STATE_ROOT) {
        return [string]$env:PACK_HARNESS_PN_RETRIGGER_STATE_ROOT
    }
    . (Join-Path $PSScriptRoot 'Orchestrator-SideProcessSupervisor.ps1')
    return Get-OrchestratorWakeSupervisorStateRoot
}

function Get-HarnessPnRetriggerStatePath {
    return Join-Path (Get-HarnessPnRetriggerStateRoot) 'harness-pn-retrigger-state.json'
}

function Get-HarnessPnRetriggerStateKey {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$TargetSha
    )

    $session = [string]$SessionId
    $sha = ([string]$TargetSha).Trim().ToLowerInvariant()
    return "$session|$PrNumber|$sha"
}

function Read-HarnessPnRetriggerStateMap {
    $path = Get-HarnessPnRetriggerStatePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return @{}
    }
    try {
        $raw = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
        if ($raw -isnot [System.Collections.IDictionary]) {
            return @{}
        }
        return $raw
    }
    catch {
        return @{}
    }
}

function Write-HarnessPnRetriggerStateMap {
    param([hashtable]$StateMap)

    $path = Get-HarnessPnRetriggerStatePath
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    ($StateMap | ConvertTo-Json -Depth 5 -Compress) | Set-Content -LiteralPath $path -Encoding utf8NoBOM
}

function Get-HarnessPnRetriggerCount {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$TargetSha
    )

    $key = Get-HarnessPnRetriggerStateKey -SessionId $SessionId -PrNumber $PrNumber -TargetSha $TargetSha
    $state = Read-HarnessPnRetriggerStateMap
    if (-not $state.ContainsKey($key)) {
        return 0
    }
    $entry = $state[$key]
    if ($entry -is [System.Collections.IDictionary]) {
        return [int]$entry.count
    }
    return [int]$entry
}

function Set-HarnessPnRetriggerCount {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$TargetSha,
        [Parameter(Mandatory = $true)][int]$Count
    )

    $key = Get-HarnessPnRetriggerStateKey -SessionId $SessionId -PrNumber $PrNumber -TargetSha $TargetSha
    $state = Read-HarnessPnRetriggerStateMap
    $state[$key] = @{
        count       = [int]$Count
        updatedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    Write-HarnessPnRetriggerStateMap -StateMap $state
}

function Clear-HarnessPnRetriggerCount {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$TargetSha
    )

    $key = Get-HarnessPnRetriggerStateKey -SessionId $SessionId -PrNumber $PrNumber -TargetSha $TargetSha
    $state = Read-HarnessPnRetriggerStateMap
    if (-not $state.ContainsKey($key)) {
        return
    }
    $state.Remove($key) | Out-Null
    Write-HarnessPnRetriggerStateMap -StateMap $state
}

function Resolve-HarnessPnRetriggerCount {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$TargetSha,
        [int]$ExplicitCount = 0
    )

    if ($ExplicitCount -gt 0) {
        return [int]$ExplicitCount
    }
    return Get-HarnessPnRetriggerCount -SessionId $SessionId -PrNumber $PrNumber -TargetSha $TargetSha
}
