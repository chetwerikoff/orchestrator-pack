#requires -Version 5.1
<#
  Structured audit for worker nudge gate decisions (Issue #384).
#>

function Get-WorkerNudgeGateAuditRoot {
    param([string]$ProjectId = 'orchestrator-pack')
    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    return (Join-Path (Join-Path (Join-Path $base 'projects') $ProjectId) 'worker-nudge-gate-audit')
}

function Write-WorkerNudgeGateAudit {
    param(
        [string]$AuditRoot,
        [object]$Record
    )

    if (-not $AuditRoot) {
        $AuditRoot = Get-WorkerNudgeGateAuditRoot
    }
    if (-not (Test-Path -LiteralPath $AuditRoot)) {
        New-Item -ItemType Directory -Path $AuditRoot -Force | Out-Null
    }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
    $path = Join-Path $AuditRoot "$stamp-$([guid]::NewGuid().ToString('n')).json"
    ($Record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Write-WorkerNudgeGatePreflightRefusal {
    param(
        [string]$AuditRoot,
        [string]$Reason,
        [string]$MarkerState
    )
    return Write-WorkerNudgeGateAudit -AuditRoot $AuditRoot -Record @{
        kind        = 'preflight_refusal'
        reason      = $Reason
        markerState = $MarkerState
        atUtc       = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Write-WorkerNudgeGateDecisionAudit {
    param(
        [object]$Record,
        [string]$ProjectId = 'orchestrator-pack'
    )

    if (-not $Record) { return $null }
    return Write-WorkerNudgeGateAudit -AuditRoot (Get-WorkerNudgeGateAuditRoot -ProjectId $ProjectId) -Record $Record
}

function Merge-WorkerNudgeClaimSkipAudit {
    param(
        [object]$GateAudit,
        [string]$Reason,
        [string]$ClaimPhase = 'none',
        [string]$Decision = 'SUPPRESS'
    )

    $audit = @{}
    if ($GateAudit) {
        if ($GateAudit -is [pscustomobject]) {
            foreach ($prop in $GateAudit.PSObject.Properties) {
                $audit[$prop.Name] = $prop.Value
            }
        }
        elseif ($GateAudit -is [hashtable]) {
            $audit = @{} + $GateAudit
        }
    }
    $audit['decision'] = $Decision
    $audit['reason'] = $Reason
    $audit['claimPhase'] = $ClaimPhase
    if (-not $audit['kind']) { $audit['kind'] = 'worker-nudge-gate' }
    return $audit
}

