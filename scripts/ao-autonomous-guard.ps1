#requires -Version 5.1
<#
.SYNOPSIS
  ao process-boundary guard for autonomous orchestrator sessions (Issue #318 / #458).
#>
# No [CmdletBinding()] -- avoids PS 7.3+ ambiguity where -p matches both
# -ProgressAction and -PipelineVariable as common parameters.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Orchestrator-AutonomousReviewStartGate.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-AutonomousNudgeGate.ps1')

Write-AutonomousBoundaryEscapeAudit | Out-Null

$spawnDeny = Test-AutonomousSpawnDenied -Argv $args
if ($spawnDeny.denied) {
    if ($spawnDeny.auditLine) {
        [Console]::Error.WriteLine($spawnDeny.auditLine)
    }
    [Console]::Error.WriteLine("autonomous worker spawn denied by boundary gate: $($spawnDeny.reason). Workers are started by the operator or automated reconcilers, not orchestrator turns.")
    exit 93
}

if ($spawnDeny.auditLine) {
    [Console]::Error.WriteLine($spawnDeny.auditLine)
}

$deny = Test-AutonomousRawReviewRunDenied -Argv $args
if ($deny.denied) {
    [Console]::Error.WriteLine("autonomous review-starts paused by gate preflight: $($deny.reason). Use scripts/invoke-orchestrator-claimed-review-run.ps1")
    exit 93
}

$sendDeny = Test-AutonomousRawWorkerSendDenied -Argv $args
if ($sendDeny.denied) {
    [Console]::Error.WriteLine("autonomous worker nudges paused by gate preflight: $($sendDeny.reason). Use scripts/invoke-gated-worker-nudge.ps1")
    exit 93
}

$realAo = Resolve-RealAoExecutable
$exitCode = 0
try {
    if ($realAo -eq 'ao') {
        & ao @args
    }
    else {
        & $realAo @args
    }
    $exitCode = $LASTEXITCODE
}
finally {
    if ($script:AutonomousSpawnWorktreeActiveGrant -and $script:AutonomousSpawnWorktreeActiveGrant.grantPath) {
        $read = Read-AutonomousSpawnWorktreeGrantRecord -Path $script:AutonomousSpawnWorktreeActiveGrant.grantPath
        if ($read.ok -and $read.record.consumed -and [string]$read.record.consumedCanonicalPath) {
            $workspaceRoot = [string]$read.record.consumedCanonicalPath
            if (Test-Path -LiteralPath $workspaceRoot) {
                $verify = Verify-AutonomousSpawnClaimPrPostCheckout -GrantRecord $read.record -WorkspaceRoot $workspaceRoot
                if (-not $verify.ok -and [string]$verify.reason -ne 'not_claim_pr') {
                    [Console]::Error.WriteLine("autonomous spawn claim-pr post-checkout verification failed: $($verify.reason)")
                    if ($exitCode -eq 0) { $exitCode = 93 }
                }
            }
        }
    }
    Clear-AutonomousClaimPrResumeActiveMutex
    Clear-AutonomousSpawnWorktreeActiveGrant
}
exit $exitCode
