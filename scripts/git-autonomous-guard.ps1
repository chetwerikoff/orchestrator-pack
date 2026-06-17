#requires -Version 5.1
<#
.SYNOPSIS
  git process-boundary guard for autonomous orchestrator sessions (Issue #324).
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Orchestrator-AutonomousReviewStartGate.ps1')

$deny = Test-AutonomousGitDenied -Argv $args
if ($deny.denied) {
    [Console]::Error.WriteLine("autonomous tree-mutating git denied by boundary gate: $($deny.reason). Use sanctioned pack review/preflight paths only.")
    exit 93
}

$realGit = Resolve-RealGitExecutable
if ($realGit -eq 'git') {
    & git @args
}
else {
    & $realGit @args
}
exit $LASTEXITCODE
