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
