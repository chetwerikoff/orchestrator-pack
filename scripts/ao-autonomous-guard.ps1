#requires -Version 5.1
<#
.SYNOPSIS
  ao process-boundary guard for autonomous orchestrator sessions (Issue #318).
#>
# No [CmdletBinding()] -- avoids PS 7.3+ ambiguity where -p matches both
# -ProgressAction and -PipelineVariable as common parameters.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Orchestrator-AutonomousReviewStartGate.ps1')

$deny = Test-AutonomousRawReviewRunDenied -Argv $args
if ($deny.denied) {
    [Console]::Error.WriteLine("autonomous review-starts paused by gate preflight: $($deny.reason). Use scripts/invoke-orchestrator-claimed-review-run.ps1")
    exit 93
}

$realAo = Resolve-RealAoExecutable
if ($realAo -eq 'ao') {
    & ao @args
}
else {
    & $realAo @args
}
exit $LASTEXITCODE
