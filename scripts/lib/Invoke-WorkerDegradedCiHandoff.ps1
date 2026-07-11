#requires -Version 5.1
<#
  Worker degraded-CI hand-off emitter routed through the orchestrator escalation contract.
#>

. (Join-Path $PSScriptRoot 'Invoke-OrchestratorEscalationEmit.ps1')

function Invoke-WorkerDegradedCiHandoff {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$PrHeadSha,
        [Parameter(Mandatory = $true)][string]$WorkerSessionId,
        [Parameter(Mandatory = $true)][string]$Reason,
        [string]$PrUrl = '',
        [string]$Message = '',
        [string]$OrchestratorSessionId = '',
        [switch]$DryRun
    )

    $correlationKey = "corr:worker-degraded-ci:${PrNumber}:${PrHeadSha}"
    $dedupeKey = "dedupe:worker-degraded-ci:${PrNumber}:${PrHeadSha}"
    $diagnosis = @{
        prNumber        = $PrNumber
        prHeadSha       = $PrHeadSha
        prUrl           = $PrUrl
        workerSessionId = $WorkerSessionId
        reason          = $Reason
        diagnosis       = $Reason
    }

    return Invoke-OrchestratorEscalationEmit `
        -EscalationClassId 'escalation-worker-degraded-ci-handoff' `
        -SourceProcess 'worker' `
        -CorrelationKey $correlationKey `
        -DedupeKey $dedupeKey `
        -Diagnosis $diagnosis `
        -Severity 'action' `
        -Message $Message `
        -OrchestratorSessionId $OrchestratorSessionId `
        -DryRun:$DryRun
}
