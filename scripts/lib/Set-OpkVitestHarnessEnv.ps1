#requires -Version 5.1
<#
.SYNOPSIS
  Establish pack-owned vitest harness marker and isolated escalation paths (Issue #664).
#>

function Get-OrchestratorEscalationSharedDefaultStatePath {
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-escalation-state.json'
}

function Get-OrchestratorEscalationSharedDefaultOperatorInboxDir {
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-operator-inbox'
}

function Get-OrchestratorEscalationSharedDefaultHealthSpoolDir {
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-escalation-health'
}

function Set-OpkVitestHarnessEnv {
    param(
        [string]$RootDir = ''
    )

    if (-not $RootDir) {
        $RootDir = Join-Path ([System.IO.Path]::GetTempPath()) ("opk-vitest-escalation-" + [guid]::NewGuid().ToString('n'))
    }

    $statePath = Join-Path $RootDir 'escalation-state.json'
    $inboxDir = Join-Path $RootDir 'operator-inbox'
    $healthDir = Join-Path $RootDir 'health-spool'

    foreach ($dir in @($RootDir, $inboxDir, $healthDir)) {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }

    $env:OPK_VITEST_HARNESS = '1'
    $env:AO_ORCHESTRATOR_ESCALATION_STATE = $statePath
    $env:AO_OPERATOR_ESCALATION_INBOX = $inboxDir
    $env:AO_ESCALATION_HEALTH_SPOOL = $healthDir

    return @{
        root        = $RootDir
        statePath   = $statePath
        inboxDir    = $inboxDir
        healthDir   = $healthDir
    }
}
