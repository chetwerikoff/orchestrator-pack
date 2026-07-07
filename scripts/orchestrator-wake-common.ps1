#requires -Version 5.1
<#
.SYNOPSIS
  Shared helpers for orchestrator-wake-listener.ps1 and orchestrator-wake-heartbeat.ps1.
#>

$Script:OrchestratorWakeRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Script:OrchestratorWakeFilterCli = Join-Path $Script:OrchestratorWakeRepoRoot 'docs/orchestrator-wake-filter.mjs'
$Script:OrchestratorWakeCancelled = $false
$Script:OrchestratorWakeCancelHandler = $null

function Get-OrchestratorSessionId {
    param([string]$CliValue)
    if ($CliValue) { return $CliValue.Trim() }
    $fromEnv = $env:AO_ORCHESTRATOR_SESSION_ID
    if ($fromEnv) { return $fromEnv.Trim() }
    throw 'Orchestrator session id required: -OrchestratorSessionId or AO_ORCHESTRATOR_SESSION_ID'
}

function Get-OrchestratorWakeDedupStatePath {
    $fromEnv = $env:AO_WAKE_DEDUP_STATE
    if ($fromEnv) { return $fromEnv }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-wake-dedup.json'
}

function Write-OrchestratorWakeLog {
    param([string]$Message)
    $ts = (Get-Date).ToString('o')
    Write-Host "[$ts] $Message"
}

function Register-OrchestratorWakeCancelHandler {
    $script:OrchestratorWakeCancelled = $false
    $script:OrchestratorWakeCancelHandler = [ConsoleCancelEventHandler]{
        param($sender, $eventArgs)
        $script:OrchestratorWakeCancelled = $true
        $eventArgs.Cancel = $true
    }
    [Console]::add_CancelKeyPress($script:OrchestratorWakeCancelHandler)
}

function Unregister-OrchestratorWakeCancelHandler {
    if ($script:OrchestratorWakeCancelHandler) {
        [Console]::remove_CancelKeyPress($script:OrchestratorWakeCancelHandler)
        $script:OrchestratorWakeCancelHandler = $null
    }
}

function Test-OrchestratorWakeCancelled {
    return $script:OrchestratorWakeCancelled
}

function Invoke-OrchestratorWakeFilterCli {
    param([string[]]$NodeArguments)

    Push-Location $Script:OrchestratorWakeRepoRoot
    try {
        $output = & node $Script:OrchestratorWakeFilterCli @NodeArguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "orchestrator-wake-filter exited ${LASTEXITCODE}: $output"
        }
        return ($output | Out-String).Trim() | ConvertFrom-Json
    }
    finally {
        Pop-Location
    }
}

function Send-OrchestratorWakeMessage {
    param(
        [string]$OrchestratorId,
        [string]$Message,
        [switch]$DryRun,
        [string]$LogSuffix = ''
    )

    if ($DryRun) {
        Write-OrchestratorWakeLog "dry-run: ao send --session $OrchestratorId --message <redacted>"
        return
    }

    & ao send --message $Message --session $OrchestratorId
    if ($LASTEXITCODE -ne 0) {
        throw "ao send failed with exit code $LASTEXITCODE"
    }
    $label = if ($LogSuffix) { "forwarded ${LogSuffix}:" } else { 'forwarded:' }
    Write-OrchestratorWakeLog "${label} ao send --session $OrchestratorId"
}
