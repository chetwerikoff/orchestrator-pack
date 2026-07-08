#requires -Version 5.1

function Invoke-ScriptedReviewDeliveryEscalationEmit {
    param(
        [Parameter(Mandatory = $true)][string]$Reason,
        [string]$Detail = '',
        [string]$RunId = '',
        [string]$SessionId = '',
        [int]$PrNumber = 0,
        [Parameter(Mandatory = $true)][string]$SourceProcess,
        [Parameter(Mandatory = $true)][string]$GateFilterCli,
        [hashtable]$ExtraDiagnosis = @{},
        [switch]$DryRun,
        [Parameter(Mandatory = $true)][scriptblock]$WriteLog
    )

    . (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
    . (Join-Path $PSScriptRoot 'Invoke-OrchestratorEscalationEmit.ps1')

    $builtResult = Invoke-MechanicalNodeFilterCli -FilterCliPath $GateFilterCli -Subcommand 'build-escalation' -Payload @{
        runId     = $RunId
        sessionId = $SessionId
        prNumber  = $PrNumber
        reason    = $Reason
    } -Label 'scripted-review-delivery-escalation' -JsonDepth 20

    $built = [string]$builtResult.message
    if ($Detail) {
        $built = "$built Detail: $Detail"
    }
    & $WriteLog $built

    $corr = if ($RunId) { "corr:scripted-review-delivery:$RunId" } else { 'corr:scripted-review-delivery:unattributed' }
    $dedupe = if ($RunId) {
        "dedupe:scripted-review-delivery:$RunId`:$Reason"
    }
    else {
        "dedupe:scripted-review-delivery:unattributed:$Reason"
    }

    $diagnosis = @{
        runId     = $RunId
        sessionId = $SessionId
        prNumber  = $PrNumber
        reason    = $Reason
        detail    = $Detail
        diagnosis = $built
    }
    foreach ($key in $ExtraDiagnosis.Keys) {
        $diagnosis[$key] = $ExtraDiagnosis[$key]
    }

    Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-pipeline-failure' `
        -SourceProcess $SourceProcess -CorrelationKey $corr -DedupeKey $dedupe `
        -Diagnosis $diagnosis -Message $built -DryRun:$DryRun | Out-Null

    return @{
        action    = 'escalate'
        reason    = $Reason
        message   = $built
        ok        = $false
        escalated = $true
        detail    = $Detail
    }
}
