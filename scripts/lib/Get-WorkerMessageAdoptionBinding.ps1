#requires -Version 5.1
<#
.SYNOPSIS
  Resolve AO epoch/config binding for journaled worker-send adoption preflight.
#>

function Get-WorkerMessageAdoptionBinding {
    param(
        [string]$PackRoot = ''
    )

    if (-not $PackRoot) {
        $PackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }

    $aoEpoch = [string]$env:AO_WORKER_MESSAGE_ADOPTION_EPOCH
    $configPath = [string]$env:AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH

    if (-not $configPath) {
        $live = Join-Path $PackRoot 'agent-orchestrator.yaml'
        if (Test-Path -LiteralPath $live -PathType Leaf) {
            $configPath = $live
        }
        else {
            $configPath = Join-Path $PackRoot 'agent-orchestrator.yaml.example'
        }
    }

    if (-not $aoEpoch) {
        if (Test-Path -LiteralPath $configPath -PathType Leaf) {
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
