#requires -Version 5.1
<#
.SYNOPSIS
  git process-boundary guard for autonomous orchestrator sessions (Issue #324).
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Orchestrator-AutonomousReviewStartGate.ps1')

Write-AutonomousBoundaryEscapeAudit | Out-Null

$deny = Test-AutonomousGitDenied -Argv $args
if ($deny.denied) {
    [Console]::Error.WriteLine("autonomous tree-mutating git denied by boundary gate: $($deny.reason). Use sanctioned pack review/preflight paths only.")
    exit 93
}

$gitArgs = @($args)
if ($deny.normalizedCommitOid) {
    $gitArgs = Rewrite-AutonomousSpawnWorktreeAddCommitArgv -Argv $gitArgs -NormalizedCommitOid ([string]$deny.normalizedCommitOid)
}

$env:AO_AUTONOMOUS_GIT_INTERNAL_EXEC = '1'
try {
    $realGit = Resolve-SystemGitExecutable
    if ($realGit -eq 'git') {
        & git @gitArgs
    }
    else {
        & $realGit @gitArgs
    }
    exit $LASTEXITCODE
}
finally {
    Remove-Item Env:AO_AUTONOMOUS_GIT_INTERNAL_EXEC -ErrorAction SilentlyContinue
}
