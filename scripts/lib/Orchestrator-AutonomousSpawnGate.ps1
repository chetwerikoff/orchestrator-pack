#requires -Version 5.1
<#
  Autonomous orchestrator spawn policy gate (Issue #458).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-GateCommon.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-ClaimPrResumeGate.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-SpawnWorktreeGate.ps1')

$Script:AutonomousSpawnPolicyRelativePath = 'docs/autonomous-spawn-policy.json'
$Script:AutonomousSpawnBoundaryCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/autonomous-orchestrator-boundary.mjs'

function Test-OrchestratorAutonomousSurfaceActiveForSpawnGate {
    return -not [string]::IsNullOrEmpty([string]$env:AO_SESSION_ID)
}

function Get-AutonomousSpawnPolicyPath {
    param([string]$PackRoot = '')

    if (-not $PackRoot) {
        $PackRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path
    }
    return Join-Path $PackRoot $Script:AutonomousSpawnPolicyRelativePath
}

function Invoke-AutonomousSpawnBoundaryCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:AutonomousSpawnBoundaryCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'autonomous-spawn-boundary' -JsonDepth 30
}

function Get-AutonomousSpawnPolicy {
    param(
        [string]$PackRoot = '',
        [object]$FixturePolicy = $null,
        [switch]$FixtureMode
    )

    if ($FixtureMode -and $null -ne $FixturePolicy) {
        $validated = Invoke-AutonomousSpawnBoundaryCli -Subcommand 'validateSpawnPolicy' -Payload @{
            version            = [string]$FixturePolicy.version
            allowSpawnNew      = $FixturePolicy.allowSpawnNew
            allowClaimPrResume = $FixturePolicy.allowClaimPrResume
        }
        if (-not $validated.ok) {
            return @{ ok = $false; reason = [string]$validated.reason; policy = $null }
        }
        return @{
            ok     = $true
            reason = 'spawn_policy_ok'
            policy = @{
                allowSpawnNew      = [bool]$FixturePolicy.allowSpawnNew
                allowClaimPrResume = [bool]$FixturePolicy.allowClaimPrResume
            }
        }
    }

    $policyPath = Get-AutonomousSpawnPolicyPath -PackRoot $PackRoot
    if (-not (Test-Path -LiteralPath $policyPath)) {
        return @{ ok = $false; reason = 'spawn_policy_missing_or_unreadable'; policy = $null }
    }
    try {
        $raw = Get-Content -LiteralPath $policyPath -Raw -ErrorAction Stop
        $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
        $validated = Invoke-AutonomousSpawnBoundaryCli -Subcommand 'validateSpawnPolicy' -Payload @{
            version            = [string]$parsed.version
            allowSpawnNew      = $parsed.allowSpawnNew
            allowClaimPrResume = $parsed.allowClaimPrResume
        }
        if (-not $validated.ok) {
            return @{ ok = $false; reason = [string]$validated.reason; policy = $null }
        }
        return @{
            ok     = $true
            reason = 'spawn_policy_ok'
            policy = @{
                allowSpawnNew      = [bool]$parsed.allowSpawnNew
                allowClaimPrResume = [bool]$parsed.allowClaimPrResume
            }
        }
    }
    catch {
        return @{ ok = $false; reason = 'spawn_policy_malformed'; policy = $null }
    }
}

function Get-SpawnArgvClassification {
    param([string[]]$Argv)

    $result = Invoke-AutonomousSpawnBoundaryCli -Subcommand 'evaluateSpawnPolicyDecision' -Payload @{
        argv               = @($Argv)
        autonomousSurface  = $true
        policyLoadOk       = $true
        policy             = @{ allowSpawnNew = $true; allowClaimPrResume = $true }
    }
    return [string]$result.action
}

function Get-SpawnClaimPrNumberFromArgv {
    param([string[]]$Argv)

    $tokens = @($Argv | ForEach-Object { [string]$_ })
    for ($index = 0; $index -lt $tokens.Count; $index++) {
        $token = $tokens[$index]
        if ($token -eq '--claim-pr' -and ($index + 1) -lt $tokens.Count) {
            $parsed = 0
            if ([int]::TryParse([string]$tokens[$index + 1], [ref]$parsed) -and $parsed -gt 0) {
                return $parsed
            }
            return 0
        }
        if ($token -match '^--claim-pr=(.+)$') {
            $parsed = 0
            if ([int]::TryParse([string]$Matches[1], [ref]$parsed) -and $parsed -gt 0) {
                return $parsed
            }
            return 0
        }
    }
    return 0
}

function Test-AutonomousSpawnDenied {
    param(
        [string[]]$Argv,
        [string]$PackRoot = '',
        [object]$FixturePolicy = $null,
        [object[]]$FixtureSessions = @(),
        [hashtable]$FixtureResidualWorktrees = @{},
        [switch]$FixtureMode
    )

    if (-not (Test-OrchestratorAutonomousSurfaceActiveForSpawnGate)) {
        return @{ denied = $false; reason = 'manual_surface'; auditLine = '' }
    }

    if ($FixtureMode) {
        $env:AO_SPAWN_WORKTREE_FIXTURE_MODE = '1'
    }

    $sub = Get-AoArgvSubcommand -Argv $Argv
    if ($sub -notmatch '^(?i)spawn$') {
        return @{ denied = $false; reason = 'not_spawn'; auditLine = '' }
    }

    $policyLoad = Get-AutonomousSpawnPolicy -PackRoot $PackRoot -FixturePolicy $FixturePolicy -FixtureMode:$FixtureMode
    $claimPrResumeSafe = $true
    $claimPrResumeReason = 'claim_pr_resume_safe'
    $claimPrResumeMutex = $null

    if ($policyLoad.ok -and $policyLoad.policy.allowClaimPrResume) {
        $prNumber = Get-SpawnClaimPrNumberFromArgv -Argv $Argv
        if ($prNumber -gt 0) {
            $resumeGate = Test-AutonomousClaimPrResumePreconditions -PrNumber $prNumber `
                -FixtureSessions $FixtureSessions -FixtureMode:$FixtureMode -FixtureResidualWorktrees $FixtureResidualWorktrees
            if (-not $resumeGate.safe) {
                $claimPrResumeSafe = $false
                $claimPrResumeReason = [string]$resumeGate.reason
            }
            else {
                $claimPrResumeMutex = $resumeGate.mutex
            }
        }
    }

    $decision = Invoke-AutonomousSpawnBoundaryCli -Subcommand 'evaluateSpawnPolicy' -Payload @{
        argv                 = @($Argv)
        autonomousSurface    = $true
        policyLoadOk         = [bool]$policyLoad.ok
        policyLoadReason     = [string]$policyLoad.reason
        policy               = if ($policyLoad.policy) { $policyLoad.policy } else { $null }
        claimPrResumeSafe    = [bool]$claimPrResumeSafe
        claimPrResumeReason  = $claimPrResumeReason
    }

    if ($decision.allowed) {
        $parsedTarget = Invoke-SpawnWorktreeGrantCli -Subcommand 'parseSpawnTarget' -Payload @{ argv = @($Argv) }
        if (-not $parsedTarget.targetKey) {
            if ($claimPrResumeMutex) {
                Release-AutonomousClaimPrResumeMutex -Mutex $claimPrResumeMutex
            }
            return @{
                denied    = $true
                reason    = 'spawn_target_missing'
                auditLine = "autonomous spawn worktree grant deny: action=$($decision.action) reason=spawn_target_missing"
                action    = [string]$decision.action
            }
        }
        $grantId = ''
        $grant = Mint-AutonomousSpawnWorktreeGrant -Argv $Argv -Action ([string]$decision.action)
        if (-not $grant.ok) {
            if ($claimPrResumeMutex) {
                Release-AutonomousClaimPrResumeMutex -Mutex $claimPrResumeMutex
            }
            return @{
                denied    = $true
                reason    = [string]$grant.reason
                auditLine = "autonomous spawn worktree grant deny: action=$($decision.action) reason=$($grant.reason)"
                action    = [string]$decision.action
            }
        }
        $grantId = [string]$grant.grantId
        if ($claimPrResumeMutex) {
            $script:AutonomousClaimPrResumeActiveMutex = $claimPrResumeMutex
        }
        return @{
            denied    = $false
            reason    = [string]$decision.reason
            auditLine = [string]$decision.auditLine
            action    = [string]$decision.action
            grantId   = $grantId
        }
    }

    if ($claimPrResumeMutex) {
        Release-AutonomousClaimPrResumeMutex -Mutex $claimPrResumeMutex
    }

    return @{
        denied    = $true
        reason    = [string]$decision.reason
        auditLine = [string]$decision.auditLine
        action    = [string]$decision.action
    }
}

function Clear-AutonomousClaimPrResumeActiveMutex {
    if ($script:AutonomousClaimPrResumeActiveMutex) {
        Release-AutonomousClaimPrResumeMutex -Mutex $script:AutonomousClaimPrResumeActiveMutex
        $script:AutonomousClaimPrResumeActiveMutex = $null
    }
}
