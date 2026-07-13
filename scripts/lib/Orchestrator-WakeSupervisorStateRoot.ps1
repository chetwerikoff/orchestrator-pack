#requires -Version 5.1
<#
.SYNOPSIS
  Shared resolver for the orchestrator wake supervisor state root.
#>

function Get-OrchestratorWakeSupervisorStateRoot {
    param([string]$CliOverride = '')

    if ($CliOverride) { return $CliOverride }
    if ($env:AO_WAKE_SUPERVISOR_STATE_DIR) {
        return $env:AO_WAKE_SUPERVISOR_STATE_DIR.Trim()
    }

    $userHome = if (-not [string]::IsNullOrWhiteSpace($env:HOME)) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
    $stateBase = if (-not [string]::IsNullOrWhiteSpace($env:XDG_STATE_HOME)) {
        $env:XDG_STATE_HOME
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $env:LOCALAPPDATA
    }
    else {
        Join-Path $userHome '.local' 'state'
    }

    return Join-Path $stateBase 'orchestrator-pack-wake-supervisor'
}
