#requires -Version 5.1
<#
  Thin emit helper for Publish-OrchestratorEscalation adoption at reconcile emit sites.
#>

. (Join-Path $PSScriptRoot 'Orchestrator-Escalation.ps1')

function ConvertTo-OrchestratorEscalationEmitDiagnosis {
    param($Diagnosis)
    if ($null -eq $Diagnosis) { return @{} }
    if ($Diagnosis -is [hashtable]) { return $Diagnosis }
    $ht = @{}
    foreach ($prop in $Diagnosis.PSObject.Properties) {
        $ht[$prop.Name] = $prop.Value
    }
    return $ht
}

function Invoke-OrchestratorEscalationEmit {
    param(
        [Parameter(Mandatory = $true)][string]$EscalationClassId,
        [Parameter(Mandatory = $true)][string]$SourceProcess,
        [Parameter(Mandatory = $true)][string]$CorrelationKey,
        [Parameter(Mandatory = $true)][string]$DedupeKey,
        [Parameter(Mandatory = $true)]$Diagnosis,
        [ValidateSet('info', 'action', 'urgent')][string]$Severity = 'action',
        [string]$OrchestratorSessionId = '',
        [string]$Message = '',
        [switch]$DryRun
    )

    $payload = ConvertTo-OrchestratorEscalationEmitDiagnosis -Diagnosis $Diagnosis
    $payload['source_process'] = $SourceProcess
    $payload['severity'] = $Severity
    $payload['dedupe_key'] = $DedupeKey
    if (-not $Message -and $payload.ContainsKey('diagnosis')) {
        $Message = [string]$payload['diagnosis']
    }

    return Publish-OrchestratorEscalation -EscalationClassId $EscalationClassId `
        -CorrelationKey $CorrelationKey -Payload $payload -Message $Message `
        -OrchestratorSessionId $OrchestratorSessionId -DryRun:$DryRun
}
