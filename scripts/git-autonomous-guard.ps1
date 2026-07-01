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

$spawnGrantFinalize = $null
if (-not $deny.denied -and $deny.spawnGrantFinalize) {
    $spawnGrantFinalize = $deny.spawnGrantFinalize
}

$env:AO_AUTONOMOUS_GIT_INTERNAL_EXEC = '1'
$exitCode = 0
try {
    $realGit = Resolve-SystemGitExecutable
    if ($realGit -eq 'git') {
        & git @gitArgs
    }
    else {
        & $realGit @gitArgs
    }
    $exitCode = $LASTEXITCODE
}
finally {
    if ($spawnGrantFinalize) {
        $grantId = [string]$spawnGrantFinalize.grantId
        $canonicalPath = [string]$spawnGrantFinalize.canonicalPath
        if ($exitCode -eq 0) {
            $finalize = Finalize-AutonomousSpawnWorktreeGrant -GrantId $grantId -CanonicalPath $canonicalPath
            if (-not $finalize.ok) {
                [Console]::Error.WriteLine("autonomous spawn worktree grant finalization failed: $($finalize.reason)")
                $exitCode = 93
            }
        }
        else {
            Register-AutonomousSpawnWorktreeGrantFinalizationFailure -GrantId $grantId -CanonicalPath $canonicalPath -ExitCode $exitCode | Out-Null
        }
    }
    Remove-Item Env:AO_AUTONOMOUS_GIT_INTERNAL_EXEC -ErrorAction SilentlyContinue
}
exit $exitCode
