#requires -Version 5.1
<#
.SYNOPSIS
  Resolve AO epoch/config binding for journaled worker-send adoption preflight.
#>


function Get-AoRunningInstanceAdoptionEpoch {
    $candidates = @()
    if ($env:AO_AGENT_ORCHESTRATOR_STATE_DIR) {
        $candidates += (Join-Path $env:AO_AGENT_ORCHESTRATOR_STATE_DIR.Trim() 'running.json')
    }
    $homeRoot = if ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
    if ($homeRoot) {
        $candidates += (Join-Path $homeRoot '.agent-orchestrator/running.json')
    }
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $raw = Get-Content -LiteralPath $candidate -Raw
            $running = $raw | ConvertFrom-Json
            $startedAt = $null
            if ($raw -match '"startedAt"\s*:\s*"([^"]+)"') {
                $startedAt = $Matches[1]
            }
            else {
                $startedAtRaw = $running.startedAt
                if ($startedAtRaw -is [datetime]) {
                    $startedAt = $startedAtRaw.ToUniversalTime().ToString('o')
                }
                else {
                    $startedAt = [string]$startedAtRaw
                }
            }
            $runningPid = [string]$running.pid
            $loadedConfig = [string]$running.configPath
            if ($startedAt -and $runningPid) {
                return @{
                    Epoch      = "$startedAt|$runningPid|$loadedConfig"
                    ConfigPath = $loadedConfig
                }
            }
        }
        catch {
            continue
        }
    }
    return $null
}

function Get-WorkerMessageAdoptionBinding {
    param(
        [string]$PackRoot = ''
    )

    if (-not $PackRoot) {
        $PackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }

    $runtimeEpoch = [string]$env:OPK_WORKER_MESSAGE_ADOPTION_EPOCH
    $configPath = [string]$env:OPK_WORKER_MESSAGE_ADOPTION_CONFIG_PATH
    $runtime = $null
    if (-not $runtimeEpoch) {
        $runtime = Get-AoRunningInstanceAdoptionEpoch
    }

    if (-not $configPath) {
        if ($runtime -and $runtime.ConfigPath) {
            $configPath = [string]$runtime.ConfigPath
        }
        else {
            $live = Join-Path $PackRoot 'agent-orchestrator.yaml'
            if (Test-Path -LiteralPath $live -PathType Leaf) {
                $configPath = $live
            }
            else {
                $configPath = Join-Path $PackRoot 'agent-orchestrator.yaml.example'
            }
        }
    }

    if (-not $runtimeEpoch) {
        if ($runtime) {
            $runtimeEpoch = [string]$runtime.Epoch
        }
        elseif (Test-Path -LiteralPath $configPath -PathType Leaf) {
            $runtimeEpoch = (Get-Item -LiteralPath $configPath).LastWriteTimeUtc.ToString('o')
        }
        else {
            $runtimeEpoch = 'unknown-config'
        }
    }

    return @{
        RuntimeEpoch    = $runtimeEpoch
        ConfigPath = $configPath
    }
}

function Resolve-OperatorOrchestratorYamlPath {
    param(
        [string]$YamlPathOverride = '',
        [string]$PackRoot = ''
    )

    if ($YamlPathOverride) {
        try {
            return (Resolve-Path -LiteralPath $YamlPathOverride -ErrorAction Stop).Path
        }
        catch {
            return $YamlPathOverride
        }
    }

    if (-not $PackRoot) {
        $PackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }

    $binding = Get-WorkerMessageAdoptionBinding -PackRoot $PackRoot
    return [string]$binding.ConfigPath
}
