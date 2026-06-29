#requires -Version 5.1
<#
  Sanctioned autonomous worker recovery primitive (Issue #522).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Worker-RecoveryClaim.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-AutonomousSpawnGate.ps1')

$Script:WorkerRecoveryCli = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path 'docs/worker-recovery.mjs'

function Invoke-WorkerRecoveryCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerRecoveryCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'worker-recovery' -JsonDepth 30
}

function Get-WorkerRecoveryDirtyState {
    param([string]$WorktreePath)

    if (-not (Test-Path -LiteralPath $WorktreePath)) {
        return @{ trackedModifications = $false; untrackedFiles = $false; relevantIgnored = $false; unpushedCommits = $false }
    }
    Push-Location -LiteralPath $WorktreePath
    try {
        $status = & git status --porcelain 2>$null
        $tracked = $false
        $untracked = $false
        foreach ($line in @($status)) {
            if ($line -match '^\?\?') { $untracked = $true }
            elseif ($line -match '^[^?]') { $tracked = $true }
        }
        $unpushed = $false
        $branch = (& git rev-parse --abbrev-ref HEAD 2>$null).Trim()
        if ($branch -and $branch -ne 'HEAD') {
            $upstream = (& git rev-parse --abbrev-ref "$branch@{upstream}" 2>$null).Trim()
            if ($upstream) {
                $ahead = (& git rev-list --count "$upstream..HEAD" 2>$null).Trim()
                if ($ahead -and [int]$ahead -gt 0) { $unpushed = $true }
            }
            else {
                $unpushed = $true
            }
        }
        return @{
            trackedModifications = $tracked
            untrackedFiles       = $untracked
            relevantIgnored      = $false
            unpushedCommits      = $unpushed
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-WorkerRecovery {
    param(
        [string]$Trigger = 'operator_request',
        [string]$SessionId = '',
        [string]$CanonicalPath = '',
        [string]$ProjectId = 'orchestrator-pack',
        [string]$PackRoot = '',
        [string]$RepoRoot = '',
        [string]$Namespace = '',
        [string]$Surface = 'invoke-worker-recovery',
        [hashtable]$Session = $null,
        [hashtable]$WorktreeRecord = $null,
        [switch]$DanglingGitdir,
        [switch]$WorktreePresent,
        [switch]$DryRun,
        [string]$SpawnAction = '',
        [int]$PrNumber = 0,
        [hashtable]$SpawnPolicy = $null,
        [switch]$FixtureMode,
        [switch]$SkipSpawn
    )

    if (-not $PackRoot) {
        $PackRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path
    }
    if (-not $RepoRoot) { $RepoRoot = $PackRoot }

    $triggerAdmission = Invoke-WorkerRecoveryCli -Subcommand 'evaluateTrigger' -Payload @{
        trigger            = $Trigger
        probedDeadEvidence = ($Trigger -eq 'reconcile_dead_worker')
        liveOwnerPresent   = $false
    }
    if (-not $triggerAdmission.admitted) {
        return @{ ok = $false; outcome = 'skipped_ambiguous'; reason = $triggerAdmission.reason }
    }

    $pathCanon = Invoke-WorkerRecoveryCli -Subcommand 'canonicalizePath' -Payload @{ path = $CanonicalPath }
    if (-not $pathCanon.ok) {
        return @{ ok = $false; outcome = 'skipped_ambiguous'; reason = $pathCanon.reason }
    }

    $claimKeyResult = Invoke-WorkerRecoveryCli -Subcommand 'deriveRecoveryClaimKey' -Payload @{
        sessionId     = $SessionId
        canonicalPath = $pathCanon.canonical
    }
    $derivedKey = [string]$claimKeyResult.claimKey

    $aoBase = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    $eligibility = Invoke-WorkerRecoveryCli -Subcommand 'evaluateCleanup' -Payload @{
        projectId        = $ProjectId
        canonicalPath    = $pathCanon.canonical
        sessionId        = $SessionId
        session          = $Session
        worktreeRecord   = $WorktreeRecord
        aoBaseDir        = $aoBase
        danglingGitdir   = [bool]$DanglingGitdir
        worktreePresent  = [bool]$WorktreePresent
        dirtyState       = (Get-WorkerRecoveryDirtyState -WorktreePath $pathCanon.canonical)
    }

    if (-not $eligibility.eligible) {
        $audit = @{
            schemaVersion   = 'worker-recovery/v1'
            attemptId       = [guid]::NewGuid().ToString('n')
            candidate       = @{ sessionId = $SessionId; canonicalPath = $pathCanon.canonical }
            sourceEvidence  = @{ trigger = $Trigger }
            canonicalPath   = $pathCanon.canonical
            livenessVerdict = $eligibility.liveness.verdict
            ownershipProof  = $eligibility.ownership
            claimOutcome    = 'not_acquired'
            cleanupDecision = 'skipped'
            spawnDecision   = 'not_attempted'
            finalState      = $eligibility.outcome
            recordedAtUtc   = (Get-Date).ToUniversalTime().ToString('o')
        }
        $ns = Resolve-WorkerRecoveryNamespace -ProjectId $ProjectId -Namespace $Namespace
        Write-WorkerRecoveryAudit -Namespace $ns -Record $audit
        return @{ ok = $true; outcome = $eligibility.outcome; reason = $eligibility.reason; audit = $audit }
    }

    $claim = Acquire-WorkerRecoveryClaim -ClaimKey $derivedKey -Surface $Surface `
        -CanonicalPath $pathCanon.canonical -SessionId $SessionId `
        -BoundCandidates @($pathCanon.canonical) -Namespace $Namespace -ProjectId $ProjectId
    if (-not $claim.acquired) {
        $audit = @{
            schemaVersion   = 'worker-recovery/v1'
            claimOutcome    = 'claim_lost'
            finalState      = 'claim_lost'
            canonicalPath   = $pathCanon.canonical
            recordedAtUtc   = (Get-Date).ToUniversalTime().ToString('o')
        }
        Write-WorkerRecoveryAudit -Namespace $claim.namespace -Record $audit
        return @{ ok = $true; outcome = 'claim_lost'; reason = $claim.reason }
    }

    $revalidate = Invoke-WorkerRecoveryCli -Subcommand 'evaluatePostClaim' -Payload @{
        selection = @{
            canonicalPath = $pathCanon.canonical
            sessionId     = $SessionId
            session       = $Session
        }
        current = @{
            canonicalPath = $pathCanon.canonical
            sessionId     = $SessionId
            session       = $Session
        }
    }
    if (-not $revalidate.ok) {
        Complete-WorkerRecoveryClaim -Namespace $claim.namespace -Path $claim.path -Record $claim.record -Outcome 'skipped_ambiguous'
        return @{ ok = $true; outcome = 'skipped_ambiguous'; reason = $revalidate.reason }
    }

    Update-WorkerRecoveryClaimPhase -Path $claim.path -Record $claim.record -Phase 'cleanup_pending'

    $cleanupDone = $false
    if (-not $DryRun -and $WorktreePresent) {
        & git -C $RepoRoot worktree remove --force $pathCanon.canonical
        if ($LASTEXITCODE -eq 0) { $cleanupDone = $true }
    }
    elseif ($DryRun) {
        $cleanupDone = $true
    }

    $spawnDecision = 'not_attempted'
    $spawnOutcome = 'spawn_denied'
    if (-not $SkipSpawn -and $SpawnAction) {
        $policy = if ($FixtureMode -and $SpawnPolicy) {
            @{ ok = $true; policy = $SpawnPolicy; reason = 'spawn_policy_ok' }
        }
        else {
            Get-AutonomousSpawnPolicy -PackRoot $PackRoot
        }
        $freshness = Invoke-WorkerRecoveryCli -Subcommand 'evaluateSpawnFreshness' -Payload @{
            localSession           = $Session
            recoveryClaimSessionId = $SessionId
            restUnavailable        = $true
        }
        $route = Invoke-WorkerRecoveryCli -Subcommand 'evaluateSpawnRoute' -Payload @{
            policyLoadOk = [bool]$policy.ok
            policy       = $policy.policy
            spawnAction  = $SpawnAction
            grantDenied  = $false
        }
        if ($freshness.allowed -and $route.allowed) {
            $spawnDecision = 'spawn_started'
            $spawnOutcome = if ($DryRun) { 'spawn_started' } else { 'spawn_started' }
        }
        else {
            $spawnDecision = 'spawn_denied'
            $spawnOutcome = if ($route.reason) { $route.reason } else { $freshness.reason }
        }
    }

    $finalState = if ($cleanupDone -and $spawnDecision -eq 'spawn_denied') { 'partial_failure' } else { $eligibility.outcome }
    $audit = @{
        schemaVersion   = 'worker-recovery/v1'
        attemptId       = $claim.record.attemptId
        candidate       = @{ sessionId = $SessionId; canonicalPath = $pathCanon.canonical }
        sourceEvidence  = @{ trigger = $Trigger }
        canonicalPath   = $pathCanon.canonical
        livenessVerdict = $eligibility.liveness.verdict
        ownershipProof  = $eligibility.ownership
        claimHolder     = $claim.record.holder
        claimOutcome    = 'claim_acquired'
        cleanupDecision = if ($cleanupDone) { $eligibility.outcome } else { 'skipped' }
        spawnDecision   = $spawnDecision
        finalState      = $finalState
        recordedAtUtc   = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-WorkerRecoveryAudit -Namespace $claim.namespace -Record $audit
    Complete-WorkerRecoveryClaim -Namespace $claim.namespace -Path $claim.path -Record $claim.record -Outcome $finalState
    return @{
        ok        = $true
        outcome   = $finalState
        cleanup   = $cleanupDone
        spawn     = $spawnDecision
        audit     = $audit
        packRoot  = $PackRoot
        repoRoot  = $RepoRoot
    }
}
