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
    <#
    .SYNOPSIS
      Warn when orchestrator prompt file may risk Signature B (empirical argv limit).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PromptFilePath,
        [int]$ArgvLimitBytes = 8000
    )

    if (-not (Test-Path -LiteralPath $PromptFilePath -PathType Leaf)) {
        return $null
    }

    $size = (Get-Item -LiteralPath $PromptFilePath).Length
    if ($size -le $ArgvLimitBytes) {
        return $null
    }

    return "Orchestrator prompt file is $size bytes (empirical Windows argv risk above ~$ArgvLimitBytes). Cursor launch uses `$(cat <file>)`; may fail with 'command line is too long' (Signature B). See docs/migration_notes.md (Issue #91)."
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
