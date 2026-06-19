#requires -Version 5.1
<#
.SYNOPSIS
  Resolve AO epoch/config binding for journaled worker-send adoption preflight.
#>

function Get-AoRunningInstanceBinding {
    $roots = @()
    if ($env:AO_STATE_ROOT) { $roots += $env:AO_STATE_ROOT.Trim() }
    if ($env:HOME) { $roots += (Join-Path $env:HOME '.agent-orchestrator') }
    if ($env:USERPROFILE) { $roots += (Join-Path $env:USERPROFILE '.agent-orchestrator') }

    foreach ($root in @($roots | Select-Object -Unique)) {
        if (-not $root) { continue }
        $runningPath = Join-Path $root 'running.json'
        if (-not (Test-Path -LiteralPath $runningPath -PathType Leaf)) { continue }
        try {
            $content = Get-Content -LiteralPath $runningPath -Raw
            $running = $content | ConvertFrom-Json
            $startedAt = $null
            if ($content -match '"startedAt"\s*:\s*"([^"]+)"') {
                $startedAt = $matches[1]
            }
            elseif ($running.startedAt -is [DateTime]) {
                $startedAt = $running.startedAt.ToUniversalTime().ToString('o')
            }
            else {
                $startedAt = [string]$running.startedAt
            }
            if (-not $startedAt.Trim()) { continue }
            return @{
                StartedAt  = $startedAt
                ConfigPath = [string]$running.configPath
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
    $instance = $null
    if (-not $configPath -or -not $aoEpoch) {
        $instance = Get-AoRunningInstanceBinding
    }

    if (-not $configPath) {
        $instanceConfigPath = if ($instance) { [string]$instance.ConfigPath } else { '' }
        if ($instanceConfigPath.Trim()) {
            $configPath = $instanceConfigPath
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
        if ($instance) {
            $aoEpoch = "$configPath|$($instance.StartedAt)"
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
