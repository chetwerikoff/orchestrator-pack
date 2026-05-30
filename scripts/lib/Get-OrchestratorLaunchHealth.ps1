# Orchestrator launch-death heuristics (Issue #91). Signatures A/B reuse worker lib.

. (Join-Path $PSScriptRoot 'Test-WorkerLaunchFailure.ps1')

function Test-OrchestratorLaunchFailureCandidate {
    param($OrchestratorSession)

    if (-not $OrchestratorSession) { return $false }
    if (@('detecting', 'stuck', 'probe_failure', 'exited', 'errored') -contains $OrchestratorSession.status) {
        return $true
    }
    if ($OrchestratorSession.activity -eq 'exited') {
        return $true
    }
    return $false
}

function Get-OrchestratorPromptLaunchFeasibilityWarning {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PromptFilePath,
        [int]$ArgvLimitBytes = 8000
    )

    return Get-PromptLaunchFeasibilityWarning -PromptFilePath $PromptFilePath `
        -Role Orchestrator -IssueNumber 91 -ArgvLimitBytes $ArgvLimitBytes
}

function Test-OrchestratorSessionLaunchHealthy {
    <#
    .SYNOPSIS
      True when orchestrator session reports working and agent runtime is alive (if present).
    #>
    param($Session)

    if (-not $Session) { return $false }
    if ($Session.status -ne 'working') { return $false }
    if ($Session.activity -eq 'exited') { return $false }
    if ($Session.PSObject.Properties.Name -contains 'runtime') {
        if ($Session.runtime -and $Session.runtime -ne 'alive') {
            return $false
        }
    }
    return $true
}
