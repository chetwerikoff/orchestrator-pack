#requires -Version 5.1
<#
.SYNOPSIS
  Standing external fleet hygiene sentinel and on-demand hygiene action (Issue #711).

.DESCRIPTION
  Evaluates H1–H7 process-hygiene assertions for the configured live pack checkout
  and AO side-process state root. Default mode is alert-first (dry-run); process
  termination requires explicit kill enable. This entry point is NOT a supervised
  registry child and must not be launched by orchestrator-wake-supervisor.ps1.

  See docs/fleet-hygiene-sentinel-runbook.md
#>
[CmdletBinding(DefaultParameterSetName = 'Sentinel')]
param(
    [Parameter(ParameterSetName = 'Sentinel')]
    [Parameter(ParameterSetName = 'Hygiene')]
    [ValidateSet('Sentinel', 'Hygiene')]
    [string]$Action = 'Sentinel',

    [string]$ProjectId = '',
    [string]$StateDir = '',
    [string]$PackRoot = '',
    [switch]$KillEnable,
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Orchestrator-FleetHygiene.ps1')

# Static guard: this script must never appear in the wake supervisor child registry.
$Script:FleetHygieneSentinelEntryPoint = 'orchestrator-fleet-hygiene-sentinel.ps1'
foreach ($child in Get-OrchestratorWakeSupervisorChildRegistry) {
    if ($child.Script -eq $Script:FleetHygieneSentinelEntryPoint) {
        Write-Error "fleet-hygiene sentinel must not be registered as a supervised child ($($child.Id))"
        exit 2
    }
}

$config = Get-FleetHygieneConfig -ProjectId $ProjectId -StateDir $StateDir -PackRoot $PackRoot -KillEnable:$KillEnable

if ($Action -eq 'Sentinel') {
    $singleton = Enter-FleetHygieneSentinelSingleton -LockPath $config.SentinelLockPath
    if (-not $singleton.Acquired) {
        exit 0
    }
    try {
        if (-not (Test-FleetHygieneLinuxProcEnvironSupported)) {
            $message = Get-FleetHygieneUnsupportedPlatformMessage
            Write-FleetHygieneSentinelLog -Message $message -LogPath $config.SentinelLogPath
            Write-Error $message
            exit 1
        }

        $evaluation = Invoke-FleetHygieneEvaluation -Config $config
        $record = @{
            action     = 'Sentinel'
            timestamp  = (Get-Date).ToUniversalTime().ToString('o')
            stateRoot  = $config.StateRoot
            allPass    = $evaluation.AllPass
            assertions = $evaluation.Assertions
            killEnable = [bool]$config.KillEnable
        }
        Write-FleetHygieneSentinelLog -Message ($record | ConvertTo-Json -Compress -Depth 6) `
            -LogPath $config.SentinelLogPath

        if (-not $evaluation.AllPass) {
            Write-FleetHygieneAlert -Config $config -Evaluation $evaluation
            if ($config.KillEnable) {
                $reaped = Invoke-FleetHygieneConservativeKill -Config $config -Assertions $evaluation.Assertions
                if ($reaped.Count -gt 0) {
                    Write-FleetHygieneSentinelLog -Message ("kill-mode reaped: $($reaped -join ',')") `
                        -LogPath $config.SentinelLogPath
                }
            }
            exit 1
        }
        exit 0
    }
    finally {
        & $singleton.Release $config.SentinelLockPath
    }
}

# Hygiene action — on-demand one-shot with human-readable lines.
if (-not (Test-FleetHygieneLinuxProcEnvironSupported)) {
    $message = Get-FleetHygieneUnsupportedPlatformMessage
    Write-Error $message
    exit 1
}

$evaluation = Invoke-FleetHygieneEvaluation -Config $config
if ($JsonOutput) {
    $evaluation | ConvertTo-Json -Depth 6
}
else {
    Format-FleetHygieneHygieneOutput -Assertions $evaluation.Assertions
}

if ($evaluation.AllPass) {
    exit 0
}
exit 1
