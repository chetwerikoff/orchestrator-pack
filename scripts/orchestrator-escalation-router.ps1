#requires -Version 5.1
<#
  Redelivers outstanding llm-orchestrator escalation deliveries (Issue #641).
#>
[CmdletBinding()]
param(
    [string]$OrchestratorSessionId = '',
    [int]$PollSeconds = 15,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/Orchestrator-Escalation.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'orchestrator-wake-common.ps1')

$orchId = Get-OrchestratorSessionId -CliValue $OrchestratorSessionId

function Invoke-EscalationRouterTick {
    $path = Get-OrchestratorEscalationStatePath
    $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
    $redelivered = 0
    foreach ($key in @($state.records.Keys)) {
        $record = $state.records[$key]
        if ([string]$record.route -ne 'llm-orchestrator') { continue }
        if (Test-OrchestratorEscalationAcked -Record $record) { continue }
        $payload = @{}
        if ($record.lastPayload) { $payload = ConvertTo-OrchestratorEscalationHashtable -Value $record.lastPayload }
        $result = Publish-OrchestratorEscalation -EscalationClassId ([string]$record.escalationClassId) `
            -CorrelationKey ([string]$record.correlationKey) -Payload $payload `
            -Message ([string]$record.lastMessage) -OrchestratorSessionId $orchId
        if ($result.delivered) { $redelivered++ }
    }
    return $redelivered
}

Write-Host "[orchestrator-escalation-router] starting orchestrator=$orchId once=$Once"
try {
    do {
        Write-OrchestratorSideProcessProgress -ChildId 'escalation-router' -Phase 'poll'
        try {
            $count = Invoke-EscalationRouterTick
            Write-Host "[orchestrator-escalation-router] tick complete redelivered=$count"
            Write-OrchestratorSideProcessTickSuccess -ChildId 'escalation-router'
        }
        catch {
            Write-Host "[orchestrator-escalation-router] tick error: $_"
            Write-OrchestratorSideProcessTickError -ChildId 'escalation-router' -ErrorMessage "$_"
        }
        if ($Once) { break }
        Start-Sleep -Seconds ([Math]::Max(5, $PollSeconds))
    } while ($true)
}
finally {
    Write-Host '[orchestrator-escalation-router] stopped'
}
