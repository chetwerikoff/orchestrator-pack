#requires -Version 5.1
<#
  Blessed-parent gate for candidate-scoped worktree remove during recovery (Issue #522).
#>

. (Join-Path $PSScriptRoot 'Worker-RecoveryClaim.ps1')
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Get-ProcessCommandLine.ps1')

$Script:WorkerRecoveryCli = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path 'docs/worker-recovery.mjs'
$Script:WorkerRecoveryParentPattern = 'invoke-worker-recovery.ps1'

function Test-ProcessCommandLineIsWorkerRecoveryParent {
    param([string]$CommandLine)

    if (-not $CommandLine) { return $false }
    $tokens = Split-ProcessCommandLineTokens -CommandLine $CommandLine
    if ($tokens.Count -eq 0) { return $false }

    for ($index = 0; $index -lt $tokens.Count; $index++) {
        if ($tokens[$index] -ieq '-File' -and ($index + 1) -lt $tokens.Count) {
            $scriptLeaf = Split-Path -Leaf ($tokens[$index + 1].Trim('"').Trim("'"))
            if ($scriptLeaf -ieq $Script:WorkerRecoveryParentPattern) {
                return $true
            }
        }
    }

    $firstLeaf = Split-Path -Leaf ($tokens[0].Trim('"').Trim("'"))
    return ($firstLeaf -ieq $Script:WorkerRecoveryParentPattern)
}

function Invoke-WorkerRecoveryBoundaryCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerRecoveryCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'worker-recovery-gate' -JsonDepth 30
}

function Test-AutonomousWorkerRecoveryGitAllow {
    param(
        [string[]]$Argv,
        [string[]]$FixtureParentChain = @(),
        [string]$ProjectId = 'orchestrator-pack',
        [string]$Namespace = ''
    )

    $parsed = Invoke-WorkerRecoveryBoundaryCli -Subcommand 'evaluateGitAllow' -Payload @{
        argv = @($Argv)
        recoveryParent = $false
        boundCandidates = @()
    }
    if (-not $parsed.ok -and $parsed.reason -ne 'not_force_remove' -and $parsed.reason -ne 'not_worktree_remove') {
        if ($parsed.allowed -eq $false -and $parsed.reason -eq 'not_force_remove') {
            return @{ allowed = $false; reason = 'not_recovery_remove' }
        }
    }

    $remove = Invoke-WorkerRecoveryBoundaryCli -Subcommand 'evaluateGitAllow' -Payload @{ argv = @($Argv) }
    if ($remove.reason -in @('not_worktree', 'not_worktree_remove', 'not_force_remove')) {
        return @{ allowed = $false; reason = 'not_recovery_remove' }
    }

    $recoveryParent = $false
    if ($FixtureParentChain.Count -gt 0) {
        foreach ($line in $FixtureParentChain) {
            if (Test-ProcessCommandLineIsWorkerRecoveryParent -CommandLine $line) {
                $recoveryParent = $true
                break
            }
        }
    }
    else {
        $chain = Get-ProcessParentChainCommandLines
        foreach ($line in $chain) {
            if (Test-ProcessCommandLineIsWorkerRecoveryParent -CommandLine $line) {
                $recoveryParent = $true
                break
            }
        }
    }

    if (-not $recoveryParent) {
        return @{ allowed = $false; reason = 'missing_recovery_parent' }
    }

    $targetResult = Invoke-WorkerRecoveryBoundaryCli -Subcommand 'canonicalizePath' -Payload @{
        path = ($Argv | Where-Object { $_ -and -not $_.StartsWith('-') } | Select-Object -Last 1)
    }
    if (-not $targetResult.ok) {
        return @{ allowed = $false; reason = 'target_unresolvable' }
    }

    $active = Get-ActiveWorkerRecoveryClaimForPath -CanonicalPath $targetResult.canonical -Namespace $Namespace -ProjectId $ProjectId
    if (-not $active) {
        return @{ allowed = $false; reason = 'no_active_recovery_claim' }
    }

    $bound = @($active.record.boundCandidates)
    if ($active.record.canonicalPath) {
        $bound += @([string]$active.record.canonicalPath)
    }

    $verdict = Invoke-WorkerRecoveryBoundaryCli -Subcommand 'evaluateGitAllow' -Payload @{
        argv             = @($Argv)
        recoveryParent   = $true
        boundCandidates  = @($bound | Select-Object -Unique)
    }
    if ($verdict.allowed) {
        return @{
            allowed        = $true
            reason         = 'recovery_worktree_remove_allow'
            canonicalPath  = [string]$verdict.canonicalPath
            claimPath      = $active.path
            claimKey       = [string]$active.record.claimKey
        }
    }
    return @{ allowed = $false; reason = [string]$verdict.reason }
}

function Test-AutonomousWorkerRecoveryBranchGitAllow {
    param(
        [string[]]$Argv,
        [string[]]$FixtureParentChain = @(),
        [string]$ProjectId = 'orchestrator-pack',
        [string]$Namespace = ''
    )

    $parsed = Invoke-WorkerRecoveryBoundaryCli -Subcommand 'evaluateBranchGitAllow' -Payload @{
        argv = @($Argv)
        recoveryParent = $false
    }
    if ($parsed.reason -in @('not_branch', 'not_force_delete')) {
        return @{ allowed = $false; reason = 'not_recovery_branch_delete' }
    }

    $recoveryParent = $false
    if ($FixtureParentChain.Count -gt 0) {
        foreach ($line in $FixtureParentChain) {
            if (Test-ProcessCommandLineIsWorkerRecoveryParent -CommandLine $line) {
                $recoveryParent = $true
                break
            }
        }
    }
    else {
        $chain = Get-ProcessParentChainCommandLines
        foreach ($line in $chain) {
            if (Test-ProcessCommandLineIsWorkerRecoveryParent -CommandLine $line) {
                $recoveryParent = $true
                break
            }
        }
    }
    if (-not $recoveryParent) {
        return @{ allowed = $false; reason = 'missing_recovery_parent' }
    }

    $branchCli = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path 'docs/worker-recovery-branch-cleanup.mjs'
    $branchParsed = Invoke-MechanicalNodeFilterCli -FilterCliPath $branchCli -Subcommand 'parseBranchDeleteArgv' -Payload @{ argv = @($Argv) } -Label 'worker-recovery-branch-gate' -JsonDepth 30
    if (-not $branchParsed.ok) {
        return @{ allowed = $false; reason = 'not_recovery_branch_delete' }
    }

    $active = $null
    $ns = Resolve-WorkerRecoveryNamespace -ProjectId $ProjectId -Namespace $Namespace
    if (Test-Path -LiteralPath $ns) {
        foreach ($file in @(Get-ChildItem -LiteralPath $ns -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
            $read = Read-WorkerRecoveryClaimRecord -Path $file.FullName
            if (-not $read.ok) { continue }
            $phase = [string]$read.record.phase
            if ($phase -notin @('cleanup_pending', 'branch_cleanup_pending', 'claimed')) { continue }
            $boundBranch = [string]$read.record.boundBranch
            if ($boundBranch -and $boundBranch -ieq [string]$branchParsed.branch) {
                $active = @{ path = $file.FullName; record = $read.record; namespace = $ns }
                break
            }
        }
    }
    if (-not $active) {
        return @{ allowed = $false; reason = 'no_active_recovery_claim' }
    }

    $boundBranch = [string]$active.record.boundBranch
    if (-not $boundBranch) {
        return @{ allowed = $false; reason = 'bound_branch_missing' }
    }

    $verdict = Invoke-MechanicalNodeFilterCli -FilterCliPath $branchCli -Subcommand 'evaluateBranchGitAllow' -Payload @{
        argv             = @($Argv)
        recoveryParent   = $true
        boundBranch      = $boundBranch
        boundSessionId   = [string]$active.record.sessionId
        claimSessionId   = [string]$active.record.sessionId
    } -Label 'worker-recovery-branch-gate' -JsonDepth 30
    if ($verdict.allowed) {
        return @{
            allowed = $true
            reason  = 'recovery_branch_delete_allow'
            branch  = [string]$verdict.branch
            claimPath = $active.path
            claimKey  = [string]$active.record.claimKey
        }
    }
    return @{ allowed = $false; reason = [string]$verdict.reason }
}

