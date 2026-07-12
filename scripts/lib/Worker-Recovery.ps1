#requires -Version 5.1

. (Join-Path $PSScriptRoot 'Invoke-OrchestratorEscalationEmit.ps1')
<#
  Sanctioned autonomous worker recovery primitive (Issue #522).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Worker-RecoveryClaim.ps1')
. (Join-Path $PSScriptRoot 'Worker-RecoveryBranchCleanup.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-AutonomousSpawnGate.ps1')
. (Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'Invoke-AoReviewApi.ps1')

$Script:WorkerRecoveryCli = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path 'docs/worker-recovery.mjs'
$Script:WorkerRecoverySpawnArgvCli = Join-Path $PSScriptRoot 'worker-recovery-spawn-argv.mjs'

function Invoke-WorkerRecoveryCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerRecoveryCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'worker-recovery' -JsonDepth 30
}


function Invoke-WorkerRecoveryCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerRecoveryCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'worker-recovery' -JsonDepth 30
}


function Get-WorkerRecoveryAoSessionById {
    param([string]$SessionId)

    if (-not $SessionId) { return $null }
    $sessions = Get-AoStatusSessionsIncludingTerminated
    foreach ($row in @($sessions)) {
        $name = [string]$row.name
        if ($name -eq $SessionId) { return $row }
        $sid = [string]$row.sessionId
        if ($sid -eq $SessionId) { return $row }
    }
    return $null
}

function ConvertTo-WorkerRecoverySessionSnapshot {
    param($AoRow)

    if (-not $AoRow) { return $null }
    $worktree = ''
    foreach ($key in @('worktree', 'workspace', 'workspacePath')) {
        if ($AoRow.$key) {
            $worktree = [string]$AoRow.$key
            break
        }
    }
    return @{
        runtime           = $AoRow.runtime
        status            = $AoRow.status
        worktree          = $worktree
        generationToken   = [string]$AoRow.generationToken
        sessionGeneration = [string]$AoRow.sessionGeneration
        generation        = [string]$AoRow.generation
    }
}

function Resolve-WorkerRecoveryGenerationToken {
    param($Snapshot)

    if (-not $Snapshot) { return '' }
    $session = $null
    if ($Snapshot.session) {
        $session = $Snapshot.session
    }
    $candidates = @(
        $Snapshot.generationToken,
        $Snapshot.sessionGeneration,
        $Snapshot.generation
    )
    if ($session) {
        $candidates += @(
            $session.generationToken,
            $session.sessionGeneration,
            $session.generation
        )
    }
    foreach ($candidate in $candidates) {
        $normalized = [string]$candidate
        if (-not [string]::IsNullOrWhiteSpace($normalized)) {
            return $normalized.Trim()
        }
    }
    return ''
}


function Get-WorkerRecoveryWorktreeRecordFromRepo {
    param(
        [string]$RepoRoot,
        [string]$CanonicalPath,
        [string]$ProjectId = 'orchestrator-pack',
        $FallbackRecord = $null,
        [switch]$FixtureMode
    )

    if ($FixtureMode) {
        return $FallbackRecord
    }
    if (-not $RepoRoot -or -not $CanonicalPath) {
        return $FallbackRecord
    }

    $porcelain = & git -C $RepoRoot worktree list --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) { return $FallbackRecord }
    $parsed = Invoke-WorkerRecoveryCli -Subcommand 'parseWorktreeList' -Payload @{
        porcelain = (($porcelain | ForEach-Object { $_ }) -join "`n")
    }
    foreach ($record in @($parsed.records)) {
        $canon = Invoke-WorkerRecoveryCli -Subcommand 'canonicalizePath' -Payload @{ path = $record.worktree }
        if (-not ($canon.ok -and $canon.canonical -eq $CanonicalPath)) { continue }

        $sessionId = ''
        if ($CanonicalPath -match '[/\\]worktrees[/\\]([^/\\]+)') {
            $sessionId = $Matches[1]
        }
        return @{
            worktree  = $canon.canonical
            head      = [string]$record.head
            branch    = if ($record.branch) { [string]$record.branch } else { '' }
            detached  = [bool]$record.detached
            sessionId = $sessionId
        }
    }
    return $FallbackRecord
}

function Get-WorkerRecoveryPostClaimSnapshot {
    param(
        [string]$SessionId,
        [string]$CanonicalPath,
        [string]$ProjectId,
        [string]$AoBaseDir,
        [string]$RepoRoot = '',
        [hashtable]$WorktreeRecord = $null,
        [hashtable]$FixtureSession = $null,
        [switch]$FixtureMode
    )

    $session = $null
    if ($FixtureMode) {
        $session = $FixtureSession
    }
    else {
        try {
            $aoRow = Get-WorkerRecoveryAoSessionById -SessionId $SessionId
            $session = ConvertTo-WorkerRecoverySessionSnapshot -AoRow $aoRow
        }
        catch {
            $session = $null
        }
    }

    $liveWorktreeRecord = Get-WorkerRecoveryWorktreeRecordFromRepo -RepoRoot $RepoRoot `
        -CanonicalPath $CanonicalPath -ProjectId $ProjectId -FallbackRecord $WorktreeRecord -FixtureMode:$FixtureMode

    return @{
        canonicalPath  = $CanonicalPath
        sessionId      = $SessionId
        session        = $session
        projectId      = $ProjectId
        worktreeRecord = $liveWorktreeRecord
        aoBaseDir      = $AoBaseDir
    }
}

function Get-WorkerRecoveryLiveDifferentOwner {
    param(
        [string]$RecoverySessionId,
        [string]$CanonicalPath,
        [switch]$FixtureMode,
        [array]$FixtureSessions = @()
    )

    $rows = @()
    if ($FixtureMode) {
        $rows = @($FixtureSessions)
    }
    else {
        try {
            $rows = @(Get-AoStatusSessions)
        }
        catch {
            $rows = @()
        }
    }

    $payloadRows = @()
    foreach ($row in $rows) {
        if (-not $row) { continue }
        $name = if ($row.name) { [string]$row.name } else { [string]$row.sessionId }
        $snap = if ($row.session) { $row.session } else { ConvertTo-WorkerRecoverySessionSnapshot -AoRow $row }
        $payloadRows += @{ name = $name; session = $snap }
    }

    return Invoke-WorkerRecoveryCli -Subcommand 'evaluateLiveDifferentOwner' -Payload @{
        recoveryClaimSessionId = $RecoverySessionId
        canonicalPath          = $CanonicalPath
        sessions               = $payloadRows
    }
}

function Test-WorkerRecoveryWorktreePresent {
    param(
        [string]$RepoRoot,
        [string]$CanonicalPath,
        [switch]$FixtureMode,
        [switch]$FixtureWorktreePresent
    )

    if ($FixtureMode) { return [bool]$FixtureWorktreePresent }
    $porcelain = & git -C $RepoRoot worktree list --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $parsed = Invoke-WorkerRecoveryCli -Subcommand 'parseWorktreeList' -Payload @{
        porcelain = (($porcelain | ForEach-Object { $_ }) -join "`n")
    }
    foreach ($record in @($parsed.records)) {
        $canon = Invoke-WorkerRecoveryCli -Subcommand 'canonicalizePath' -Payload @{ path = $record.worktree }
        if ($canon.ok -and $canon.canonical -eq $CanonicalPath) {
            return $true
        }
    }
    return $false
}

function Get-WorkerRecoveryDirtyState {
    param([string]$WorktreePath)

    if (-not (Test-Path -LiteralPath $WorktreePath)) {
        return @{ trackedModifications = $false; untrackedFiles = $false; relevantIgnored = $false; unpushedCommits = $false }
    }
    Push-Location -LiteralPath $WorktreePath
    try {
        $status = & git status --porcelain 2>$null
        $ignoredStatus = & git status --ignored --porcelain 2>$null
        $tracked = $false
        $untracked = $false
        $relevantIgnored = $false
        foreach ($line in @($status)) {
            if ($line -match '^\?\?') { $untracked = $true }
            elseif ($line -match '^[^?]') { $tracked = $true }
        }
        foreach ($line in @($ignoredStatus)) {
            if ($line -match '^!!') { $relevantIgnored = $true; break }
        }
        $unpushed = $false
        $branchRaw = & git rev-parse --abbrev-ref HEAD 2>$null
        $branch = if ($null -ne $branchRaw) { [string]$branchRaw.Trim() } else { '' }
        if ($branch -and $branch -ne 'HEAD') {
            $upstreamRaw = & git rev-parse --abbrev-ref "$branch@{upstream}" 2>$null
            $upstream = if ($null -ne $upstreamRaw) { [string]$upstreamRaw.Trim() } else { '' }
            if ($upstream) {
                $aheadRaw = & git rev-list --count "$upstream..HEAD" 2>$null
                $ahead = if ($null -ne $aheadRaw) { [string]$aheadRaw.Trim() } else { '' }
                if ($ahead -and [int]$ahead -gt 0) { $unpushed = $true }
            }
            else {
                $unpushed = $true
            }
        }
        elseif ($branch -eq 'HEAD') {
            $referencedByBranch = $false
            foreach ($line in @(& git branch -a --contains HEAD 2>$null)) {
                $trimmed = if ($null -ne $line) { [string]$line.Trim() } else { '' }
                if (-not $trimmed) { continue }
                if ($trimmed -match 'detached' -or $trimmed -match 'no branch') { continue }
                $referencedByBranch = $true
                break
            }
            if (-not $referencedByBranch) { $unpushed = $true }
        }
        return @{
            trackedModifications = $tracked
            untrackedFiles       = $untracked
            relevantIgnored      = $relevantIgnored
            unpushedCommits      = $unpushed
        }
    }
    finally {
        Pop-Location
    }
}


function Invoke-WorkerRecoverySpawnArgvCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerRecoverySpawnArgvCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'worker-recovery-spawn-argv' -JsonDepth 30
}

function Build-WorkerRecoverySpawnArgv {
    param(
        [string]$SpawnAction,
        [string]$ProjectId,
        [int]$IssueNumber = 0,
        [int]$PrNumber = 0
    )

    return Invoke-WorkerRecoverySpawnArgvCli -Subcommand 'buildRecoverySpawnArgv' -Payload @{
        spawnAction = $SpawnAction
        projectId   = $ProjectId
        issueNumber = $IssueNumber
        prNumber    = $PrNumber
    }
}

function ConvertTo-WorkerRecoveryRecordMap {
    param($Record)

    if ($null -eq $Record) { return $null }
    if ($Record -is [hashtable]) { return $Record }
    if ($Record -is [System.Collections.IDictionary]) {
        return @{ } + $Record
    }

    $map = [ordered]@{}
    foreach ($prop in $Record.PSObject.Properties) {
        $map[$prop.Name] = $prop.Value
    }
    return $map
}

function Resolve-WorkerRecoverySpawnProjectId {
    param(
        $WorktreeRecord = $null,
        $AoSessionRow = $null,
        [string]$FallbackProjectId = ''
    )

    return Invoke-WorkerRecoverySpawnArgvCli -Subcommand 'resolveRecoverySpawnProjectId' -Payload @{
        worktreeRecord    = (ConvertTo-WorkerRecoveryRecordMap -Record $WorktreeRecord)
        aoSessionRow      = (ConvertTo-WorkerRecoveryRecordMap -Record $AoSessionRow)
        fallbackProjectId = $FallbackProjectId
    }
}

function Invoke-WorkerRecoverySpawn {
    param(
        [string]$SpawnAction,
        [int]$IssueNumber = 0,
        [int]$PrNumber = 0,
        [string]$ProjectId = '',
        [string]$PackRoot = '',
        [hashtable]$SpawnPolicy = $null,
        [switch]$FixtureMode,
        [switch]$DryRun
    )

    $built = Build-WorkerRecoverySpawnArgv -SpawnAction $SpawnAction -ProjectId $ProjectId `
        -IssueNumber $IssueNumber -PrNumber $PrNumber
    if (-not $built.ok) {
        $grantDenied = [string]$built.reason -in @(
            'missing_pr_number', 'missing_issue_number', 'unknown_spawn_action', 'missing_project_id'
        )
        return @{ ok = $false; started = $false; reason = [string]$built.reason; grantDenied = $grantDenied }
    }
    $argv = @($built.argv)

    $gate = Test-AutonomousSpawnDenied -Argv $argv -PackRoot $PackRoot -FixturePolicy $SpawnPolicy -FixtureMode:$FixtureMode
    if ($gate.denied) {
        return @{ ok = $false; started = $false; reason = [string]$gate.reason; grantDenied = $true }
    }

    if ($DryRun) {
        return @{ ok = $true; started = $true; reason = 'spawn_started_dry_run'; grantDenied = $false }
    }
    if ($FixtureMode) {
        return @{ ok = $true; started = $true; reason = 'spawn_started_fixture'; grantDenied = $false }
    }

    Push-Location -LiteralPath $PackRoot
    try {
        $spawnOutput = & ao @argv 2>&1
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            $combined = ($spawnOutput | Out-String)
            $classified = Invoke-WorkerRecoverySpawnArgvCli -Subcommand 'classifyRecoverySpawnExit' -Payload @{
                exitCode    = $exitCode
                stdout      = $combined
                stderr      = ''
                spawnAction = $SpawnAction
            }
            return @{
                ok          = $false
                started     = $false
                reason      = [string]$classified.reason
                grantDenied = $false
                defer       = [bool]$classified.defer
                exitCode    = $exitCode
            }
        }
        return @{ ok = $true; started = $true; reason = 'spawn_started'; grantDenied = $false }
    }
    finally {
        Pop-Location
        Clear-AutonomousClaimPrResumeActiveMutex
    }
}

function Invoke-WorkerRecovery {
    param(
        [string]$Trigger = 'operator_request',
        [string]$SessionId = '',
        [string]$GenerationToken = '',
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
        [int]$IssueNumber = 0,
        [int]$PrNumber = 0,
        [hashtable]$SpawnPolicy = $null,
        [hashtable]$FixtureGrantRecord = $null,
        [hashtable]$FixtureBranchObservation = $null,
        [hashtable]$FixtureBranchState = $null,
        [array]$FixtureWorktreeRecords = $null,
        [switch]$FixtureMode,
        [switch]$SkipSpawn,
        [switch]$TaskClosed,
        [switch]$TaskCancelled,
        [switch]$TaskSuperseded,
        [hashtable]$FixtureTaskEligibility = $null,
        [switch]$ProbedDeadEvidence
    )

    if (-not $PackRoot) {
        $PackRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path
    }
    if (-not $RepoRoot) { $RepoRoot = $PackRoot }

    $triggerAdmission = Invoke-WorkerRecoveryCli -Subcommand 'evaluateTrigger' -Payload @{
        trigger            = $Trigger
        probedDeadEvidence = [bool]$ProbedDeadEvidence
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
    $recoveryNamespace = Resolve-WorkerRecoveryNamespace -ProjectId $ProjectId -Namespace $Namespace
    $retryState = Get-WorkerRecoveryRetryAttemptState -Namespace $recoveryNamespace -ClaimKey $derivedKey
    $retryGate = Invoke-WorkerRecoveryCli -Subcommand 'evaluateRetry' -Payload @{
        attempt       = $retryState.attempt
        budget        = 3
        lastAttemptMs = $retryState.lastAttemptMs
    }
    if ($retryGate.escalate) {
        $audit = @{
            schemaVersion = 'worker-recovery/v1'
            claimKey      = $derivedKey
            finalState    = 'escalated'
            retryAttempt  = $retryState.attempt
            recordedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        }
        Write-WorkerRecoveryAudit -Namespace $recoveryNamespace -Record $audit
        $sessionId = [string]$SessionId
        $reason = [string]$retryGate.reason
        $corr = "corr:worker-recovery:$sessionId"
        $dedupe = "dedupe:worker-recovery:$sessionId`:$reason"
        Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-worker-recovery' `
            -SourceProcess 'dead-worker-reconcile' -CorrelationKey $corr -DedupeKey $dedupe `
            -Diagnosis @{ sessionId = $sessionId; reason = $reason; audit = $audit } | Out-Null
        return @{ ok = $false; outcome = 'escalated'; reason = $retryGate.reason; audit = $audit }
    }
    if (-not $retryGate.shouldRetry -and $retryState.attempt -gt 0) {
        return @{ ok = $true; outcome = 'no_op'; reason = $retryGate.reason }
    }

    if ($FixtureMode -or $PSBoundParameters.ContainsKey('WorktreePresent')) {
        $resolvedWorktreePresent = [bool]$WorktreePresent
    }
    else {
        $resolvedWorktreePresent = Test-WorkerRecoveryWorktreePresent -RepoRoot $RepoRoot `
            -CanonicalPath $pathCanon.canonical
    }

    $eligibility = Invoke-WorkerRecoveryCli -Subcommand 'evaluateCleanup' -Payload @{
        projectId        = $ProjectId
        canonicalPath    = $pathCanon.canonical
        sessionId        = $SessionId
        session          = $Session
        worktreeRecord   = $WorktreeRecord
        aoBaseDir        = $aoBase
        danglingGitdir   = [bool]$DanglingGitdir
        worktreePresent  = $resolvedWorktreePresent
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

    $selectionWorktreeRecord = Get-WorkerRecoveryWorktreeRecordFromRepo -RepoRoot $RepoRoot `
        -CanonicalPath $pathCanon.canonical -ProjectId $ProjectId -FallbackRecord $WorktreeRecord -FixtureMode:$FixtureMode
    $selectionSnapshot = @{
        canonicalPath  = $pathCanon.canonical
        sessionId      = $SessionId
        generationToken = $GenerationToken
        session        = $Session
        projectId      = $ProjectId
        worktreeRecord = $selectionWorktreeRecord
        aoBaseDir      = $aoBase
    }
    $currentSnapshot = Get-WorkerRecoveryPostClaimSnapshot -SessionId $SessionId `
        -CanonicalPath $pathCanon.canonical -ProjectId $ProjectId -AoBaseDir $aoBase -RepoRoot $RepoRoot `
        -WorktreeRecord $WorktreeRecord -FixtureSession $Session -FixtureMode:$FixtureMode

    $expectedGenerationToken = [string]$GenerationToken
    if (-not [string]::IsNullOrWhiteSpace($expectedGenerationToken)) {
        $expectedGenerationToken = $expectedGenerationToken.Trim()
    }
    if (-not $expectedGenerationToken) {
        $null = Complete-WorkerRecoveryClaim -Namespace $claim.namespace -Path $claim.path -Record $claim.record -Outcome 'skipped_ambiguous'
        return @{ ok = $true; outcome = 'skipped_ambiguous'; reason = 'missing_generation_token' }
    }
    $currentGenerationToken = Resolve-WorkerRecoveryGenerationToken -Snapshot $currentSnapshot
    if (-not $currentGenerationToken) {
        $null = Complete-WorkerRecoveryClaim -Namespace $claim.namespace -Path $claim.path -Record $claim.record -Outcome 'skipped_ambiguous'
        return @{ ok = $true; outcome = 'skipped_ambiguous'; reason = 'missing_generation_token' }
    }
    if ($currentGenerationToken -ne $expectedGenerationToken) {
        $null = Complete-WorkerRecoveryClaim -Namespace $claim.namespace -Path $claim.path -Record $claim.record -Outcome 'skipped_ambiguous'
        return @{ ok = $true; outcome = 'skipped_ambiguous'; reason = 'generation_changed' }
    }

    $revalidate = Invoke-WorkerRecoveryCli -Subcommand 'evaluatePostClaim' -Payload @{
        selection = $selectionSnapshot
        current   = $currentSnapshot
    }
    if (-not $revalidate.ok) {
        $null = Complete-WorkerRecoveryClaim -Namespace $claim.namespace -Path $claim.path -Record $claim.record -Outcome 'skipped_ambiguous'
        return @{ ok = $true; outcome = 'skipped_ambiguous'; reason = $revalidate.reason }
    }

    Update-WorkerRecoveryClaimPhase -Path $claim.path -Record $claim.record -Phase 'cleanup_pending'

    $cleanupAttempted = $false
    $cleanupDone = $false
    $worktreeStillPresent = Test-WorkerRecoveryWorktreePresent -RepoRoot $RepoRoot `
        -CanonicalPath $pathCanon.canonical -FixtureMode:$FixtureMode -FixtureWorktreePresent:$WorktreePresent
    $danglingGitdirCleanup = ($eligibility.outcome -eq 'removed_dangling_gitdir')
    $shouldCleanup = $worktreeStillPresent -or $danglingGitdirCleanup
    if ($shouldCleanup) {
        $preCleanupAudit = @{
            schemaVersion   = 'worker-recovery/v1'
            attemptId       = $claim.record.attemptId
            candidate       = @{ sessionId = $SessionId; canonicalPath = $pathCanon.canonical }
            sourceEvidence  = @{ trigger = $Trigger }
            canonicalPath   = $pathCanon.canonical
            livenessVerdict = $eligibility.liveness.verdict
            ownershipProof  = $eligibility.ownership
            claimHolder     = $claim.record.holder
            claimOutcome    = 'claim_acquired'
            cleanupDecision = $eligibility.outcome
            spawnDecision   = 'not_attempted'
            finalState      = 'cleanup_pending'
            recordedAtUtc   = (Get-Date).ToUniversalTime().ToString('o')
        }
        Write-WorkerRecoveryAudit -Namespace $claim.namespace -Record $preCleanupAudit
    }
    if (-not $DryRun -and $shouldCleanup) {
        $gateHead = ''
        if ($selectionWorktreeRecord -and $selectionWorktreeRecord.head) {
            $gateHead = [string]$selectionWorktreeRecord.head
        }
        $resolvedPrNumber = $PrNumber
        if ($resolvedPrNumber -le 0 -and $Session -and $Session.prNumber) {
            [void][int]::TryParse([string]$Session.prNumber, [ref]$resolvedPrNumber)
        }
        try {
            if (-not $FixtureMode) {
                Assert-ReviewBeforeCleanupGate -SessionId $SessionId -HeadSha $gateHead -PrNumber $resolvedPrNumber -Context 'worker_recovery_worktree_remove'
            }
        }
        catch {
            $null = Complete-WorkerRecoveryClaim -Namespace $claim.namespace -Path $claim.path -Record $claim.record -Outcome 'review_before_cleanup_blocked'
            return @{ ok = $false; outcome = 'review_before_cleanup_blocked'; reason = [string]$_ }
        }
        $cleanupAttempted = $true
        & git -C $RepoRoot worktree remove --force $pathCanon.canonical
        if ($LASTEXITCODE -eq 0) { $cleanupDone = $true }
    }
    elseif ($DryRun -and $shouldCleanup) {
        $cleanupDone = $true
    }


    $resolvedIssueNumber = $IssueNumber
    if ($resolvedIssueNumber -le 0 -and $Session -and $Session.issue) {
        [void][int]::TryParse([string]$Session.issue, [ref]$resolvedIssueNumber)
    }

    $branchCleanupOutcome = $null
    $branchCleanupBlocked = $false
    $taskEligibility = Get-WorkerRecoveryTaskEligibilityFlags -IssueNumber $resolvedIssueNumber `
        -PackRoot $PackRoot -RepoRoot $RepoRoot -FixtureMode:$FixtureMode `
        -FixtureTaskEligibility $FixtureTaskEligibility
    if ($claim.acquired -and (-not $cleanupAttempted -or $cleanupDone)) {
        $liveOwnerCheckForBranch = Get-WorkerRecoveryLiveDifferentOwner -RecoverySessionId $SessionId `
            -CanonicalPath $pathCanon.canonical -FixtureMode:$FixtureMode
        $branchCleanupOutcome = Invoke-WorkerRecoveryBranchCleanup -SessionId $SessionId `
            -CanonicalPath $pathCanon.canonical -PackRoot $PackRoot -RepoRoot $RepoRoot -ProjectId $ProjectId `
            -Namespace $claim.namespace -AttemptId $claim.record.attemptId `
            -ClaimPath $claim.path -ClaimRecord $claim.record `
            -GrantRecord $FixtureGrantRecord -FixtureObservation $FixtureBranchObservation `
            -FixtureBranchState $FixtureBranchState -FixtureWorktreeRecords $FixtureWorktreeRecords `
            -FixtureMode:$FixtureMode -DryRun:$DryRun `
            -LiveDifferentOwner:([bool]$liveOwnerCheckForBranch.liveDifferentOwner) `
            -IssueNumber $resolvedIssueNumber -TaskClosed:([bool]$taskEligibility.taskClosed) `
            -TaskCancelled:([bool]$taskEligibility.taskCancelled) -TaskSuperseded:([bool]$taskEligibility.taskSuperseded) `
            -TaskStateUnknown:([bool]$taskEligibility.taskStateUnknown)
        if ($branchCleanupOutcome.escalation) {
            $branchCleanupBlocked = $true
        }
        elseif (-not $branchCleanupOutcome.ok -and -not $branchCleanupOutcome.skipped) {
            $branchCleanupBlocked = $true
        }
    }


    $spawnDecision = 'not_attempted'
    $spawnOutcome = 'spawn_denied'
    $spawnDeferEscalate = $false
    if (-not $SkipSpawn -and $SpawnAction -and -not ($cleanupAttempted -and -not $cleanupDone) -and -not $branchCleanupBlocked) {
        $policy = if ($FixtureMode -and $SpawnPolicy) {
            @{ ok = $true; policy = $SpawnPolicy; reason = 'spawn_policy_ok' }
        }
        else {
            Get-AutonomousSpawnPolicy -PackRoot $PackRoot
        }
        $spawnSnapshot = Get-WorkerRecoveryPostClaimSnapshot -SessionId $SessionId `
            -CanonicalPath $pathCanon.canonical -ProjectId $ProjectId -AoBaseDir $aoBase -RepoRoot $RepoRoot `
            -WorktreeRecord $WorktreeRecord -FixtureSession $Session -FixtureMode:$FixtureMode
        $liveOwnerCheck = Get-WorkerRecoveryLiveDifferentOwner -RecoverySessionId $SessionId `
            -CanonicalPath $pathCanon.canonical -FixtureMode:$FixtureMode
        $freshness = Invoke-WorkerRecoveryCli -Subcommand 'evaluateSpawnFreshness' -Payload @{
            localSession           = $spawnSnapshot.session
            recoveryClaimSessionId = $SessionId
            liveDifferentOwner     = [bool]$liveOwnerCheck.liveDifferentOwner
            restUnavailable        = $true
        }
        $aoSessionRow = $null
        if (-not $FixtureMode -and $SessionId) {
            $aoSessionRow = Get-WorkerRecoveryAoSessionById -SessionId $SessionId
        }
        $spawnProjectResolved = Resolve-WorkerRecoverySpawnProjectId -WorktreeRecord $selectionWorktreeRecord `
            -AoSessionRow $aoSessionRow -FallbackProjectId $ProjectId
        $spawnProjectId = if ($spawnProjectResolved.ok) {
            [string]$spawnProjectResolved.projectId
        }
        else {
            $ProjectId
        }
        $spawnArgvBuild = Build-WorkerRecoverySpawnArgv -SpawnAction $SpawnAction -ProjectId $spawnProjectId `
            -IssueNumber $resolvedIssueNumber -PrNumber $PrNumber
        $spawnArgv = if ($spawnArgvBuild.ok) { @($spawnArgvBuild.argv) } else { @('spawn') }
        $spawnGate = if (-not $spawnArgvBuild.ok) {
            @{ denied = $true; reason = [string]$spawnArgvBuild.reason }
        }
        elseif ($FixtureMode) {
            @{ denied = $false; reason = 'spawn_policy_ok' }
        }
        else {
            Test-AutonomousSpawnDenied -Argv $spawnArgv -PackRoot $PackRoot -FixturePolicy $SpawnPolicy -FixtureMode:$FixtureMode
        }
        $route = Invoke-WorkerRecoveryCli -Subcommand 'evaluateSpawnRoute' -Payload @{
            policyLoadOk = [bool]$policy.ok
            policy       = $policy.policy
            spawnAction  = $SpawnAction
            grantDenied  = [bool]$spawnGate.denied
            grantReason  = [string]$spawnGate.reason
        }
        $spawnDeferEscalate = $false
        if ($freshness.allowed -and $route.allowed) {
            if (-not $spawnArgvBuild.ok) {
                $spawnDecision = 'spawn_denied'
                $spawnOutcome = [string]$spawnArgvBuild.reason
            }
            else {
                $spawnResult = Invoke-WorkerRecoverySpawn -SpawnAction $SpawnAction -IssueNumber $resolvedIssueNumber `
                    -PrNumber $PrNumber -ProjectId $spawnProjectId -PackRoot $PackRoot -SpawnPolicy $policy.policy `
                    -FixtureMode:$FixtureMode -DryRun:$DryRun
                if ($spawnResult.started) {
                    $spawnDecision = 'spawn_started'
                    $spawnOutcome = [string]$spawnResult.reason
                }
                else {
                    $spawnDecision = 'spawn_denied'
                    $spawnOutcome = [string]$spawnResult.reason
                    if ($spawnResult.defer) { $spawnDeferEscalate = $true }
                }
            }
        }
        else {
            $spawnDecision = 'spawn_denied'
            $spawnOutcome = if ($route.reason) { $route.reason } else { $freshness.reason }
        }
    }

    $finalState = $eligibility.outcome
    if ($cleanupAttempted -and -not $cleanupDone) {
        $finalState = 'partial_failure'
    }
    elseif ($branchCleanupBlocked) {
        $finalState = 'escalated'
    }
    elseif ($spawnDeferEscalate) {
        $finalState = 'escalated'
    }
    elseif ($cleanupDone -and $spawnDecision -eq 'spawn_denied' -and $SpawnAction) {
        $finalState = 'partial_failure'
    }
    $recoveryOk = -not ($cleanupAttempted -and -not $cleanupDone)
    if ($branchCleanupBlocked) { $recoveryOk = $false }
    if ($SpawnAction -and $spawnDecision -eq 'spawn_denied') { $recoveryOk = $false }
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
        cleanupDecision = if ($cleanupAttempted -and -not $cleanupDone) { 'failed' } elseif ($cleanupDone) { $eligibility.outcome } else { 'skipped' }
        spawnDecision   = $spawnDecision
        branchCleanup   = if ($branchCleanupOutcome) { $branchCleanupOutcome.reason } else { 'not_attempted' }
        finalState      = $finalState
        recordedAtUtc   = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-WorkerRecoveryAudit -Namespace $claim.namespace -Record $audit
    $null = Complete-WorkerRecoveryClaim -Namespace $claim.namespace -Path $claim.path -Record $claim.record -Outcome $finalState
    return @{
        ok        = $recoveryOk
        outcome   = $finalState
        cleanup   = $cleanupDone
        branch    = if ($branchCleanupOutcome) { $branchCleanupOutcome } else { $null }
        spawn     = $spawnDecision
        audit     = $audit
        packRoot  = $PackRoot
        repoRoot  = $RepoRoot
    }
}
