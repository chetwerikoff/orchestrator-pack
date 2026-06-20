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

    $aoEpoch = [string]$env:AO_WORKER_MESSAGE_ADOPTION_EPOCH
    $configPath = [string]$env:AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH
    $runtime = $null
    if (-not $aoEpoch) {
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

    if (-not $aoEpoch) {
        if ($runtime) {
            $aoEpoch = [string]$runtime.Epoch
        }
        elseif (Test-Path -LiteralPath $configPath -PathType Leaf) {
            $aoEpoch = (Get-Item -LiteralPath $configPath).LastWriteTimeUtc.ToString('o')
        }
        else {
            $aoEpoch = 'unknown-config'
        }
    }

    return @{
        AoEpoch    = $aoEpoch
        ConfigPath = $configPath
    }
}
