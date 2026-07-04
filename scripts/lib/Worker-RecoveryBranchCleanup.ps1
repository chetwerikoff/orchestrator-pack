#requires -Version 5.1
<#
  Worker recovery orphan branch cleanup (Issue #592).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-SpawnWorktreeGate.ps1')
. (Join-Path $PSScriptRoot 'Worker-RecoveryClaim.ps1')
. (Join-Path $PSScriptRoot 'Gh-FleetInventoryCache.ps1')

$Script:WorkerRecoveryBranchCleanupCli = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path 'docs/worker-recovery-branch-cleanup.mjs'



function ConvertTo-WorkerRecoveryBranchAuditHashtable {
    param($Record)

    if ($Record -is [hashtable]) { return $Record }
    $hash = @{}
    foreach ($prop in $Record.PSObject.Properties) {
        $hash[$prop.Name] = $prop.Value
    }
    return $hash
}

function Invoke-WorkerRecoveryBranchCleanupCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerRecoveryBranchCleanupCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'worker-recovery-branch-cleanup' -JsonDepth 30
}

function Get-WorkerRecoveryBranchObservationTtlSeconds {
    $raw = [Environment]::GetEnvironmentVariable('AO_WORKER_RECOVERY_BRANCH_OBSERVATION_TTL_SECONDS')
    if ($raw -and [int]::TryParse($raw, [ref]$null)) {
        return [int]$raw
    }
    return 60
}

function Find-WorkerRecoveryConsumedSpawnGrant {
    param(
        [string]$SessionId,
        [string]$CanonicalPath,
        [string]$ProjectId = 'orchestrator-pack'
    )

    $namespace = Get-AutonomousSpawnWorktreeGrantNamespace -ProjectId $ProjectId
    if (-not (Test-Path -LiteralPath $namespace)) {
        return @{ ok = $false; reason = 'grant_namespace_missing' }
    }
    $sessionLeaf = ''
    if ($CanonicalPath -match '[/\\]worktrees[/\\]([^/\\]+)$') {
        $sessionLeaf = $Matches[1]
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $namespace -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
        $read = Read-AutonomousSpawnWorktreeGrantRecord -Path $file.FullName
        if (-not $read.ok) { continue }
        $record = $read.record
        if (-not $record.consumed) { continue }
        $consumedPath = [string]$record.consumedCanonicalPath
        $authorized = @($record.authorizedWorktreeNames | ForEach-Object { [string]$_ })
        $pathMatch = $false
        if ($consumedPath -and $CanonicalPath) {
            if ($consumedPath -eq $CanonicalPath) { $pathMatch = $true }
            elseif ($sessionLeaf -and $consumedPath -like "*$sessionLeaf") { $pathMatch = $true }
        }
        $sessionMatch = ($SessionId -and $authorized -contains $SessionId)
        if ($pathMatch -or $sessionMatch) {
            return @{
                ok        = $true
                record    = $record
                path      = $file.FullName
                grantId   = [string]$record.grantId
                namespace = $namespace
            }
        }
    }
    return @{ ok = $false; reason = 'consumed_grant_not_found' }
}

function Get-WorkerRecoveryBranchDeletedAudit {
    param(
        [string]$Namespace,
        [string]$SessionId,
        [string]$Branch,
        [string]$AttemptId = ''
    )

    $auditDir = Get-WorkerRecoveryAuditDir -Namespace $Namespace
    if (-not (Test-Path -LiteralPath $auditDir)) { return $null }
    foreach ($file in @(Get-ChildItem -LiteralPath $auditDir -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
        try {
            $audit = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        }
        catch { continue }
        if ([string]$audit.kind -ne 'branch_deleted') { continue }
        if ($AttemptId -and [string]$audit.attemptId -ne $AttemptId) { continue }
        if ([string]$audit.sessionId -ne $SessionId) { continue }
        if ($Branch -and [string]$audit.branch -ne $Branch) { continue }
        return @{ path = $file.FullName; record = $audit }
    }
    return $null
}

function Get-WorkerRecoveryBranchGitState {
    param(
        [string]$RepoRoot,
        [string]$Branch
    )

    $normalized = Invoke-WorkerRecoveryBranchCleanupCli -Subcommand 'normalizeBranchRef' -Payload @{ branch = $Branch }
    if (-not $normalized.ok) {
        return @{ ok = $false; reason = $normalized.reason }
    }
    $branchName = [string]$normalized.branch
    $existsRaw = & git -C $RepoRoot show-ref --verify --quiet "refs/heads/$branchName" 2>$null
    $exists = ($LASTEXITCODE -eq 0)
    if (-not $exists) {
        return @{ ok = $true; exists = $false; branch = $branchName }
    }
    $headRaw = & git -C $RepoRoot rev-parse "refs/heads/$branchName" 2>$null
    $headOid = if ($null -ne $headRaw) { [string]$headRaw.Trim().ToLower() } else { '' }
    $localAhead = 0
    $remoteAhead = 0
    $diverged = $false
    $upstreamRaw = & git -C $RepoRoot rev-parse --abbrev-ref "$branchName@{upstream}" 2>$null
    $upstream = if ($null -ne $upstreamRaw) { [string]$upstreamRaw.Trim() } else { '' }
    if ($upstream) {
        $aheadRaw = & git -C $RepoRoot rev-list --count "$upstream..$branchName" 2>$null
        $behindRaw = & git -C $RepoRoot rev-list --count "$branchName..$upstream" 2>$null
        if ($null -ne $aheadRaw) { $localAhead = [int][string]$aheadRaw.Trim() }
        if ($null -ne $behindRaw) { $remoteAhead = [int][string]$behindRaw.Trim() }
        $diverged = ($localAhead -gt 0 -and $remoteAhead -gt 0)
    }
    $reflogEntries = @()
    foreach ($line in @(& git -C $RepoRoot reflog show --format='%H %gD' -n 20 "$branchName" 2>$null)) {
        $trimmed = if ($null -ne $line) { [string]$line.Trim() } else { '' }
        if (-not $trimmed) { continue }
        $parts = $trimmed -split '\s+', 2
        if ($parts.Count -ge 1) {
            $reflogEntries += @{ newOid = $parts[0].ToLower(); oldOid = '' }
        }
    }
    $danglingCount = 0
    if ($headOid) {
        $fsck = @(& git -C $RepoRoot fsck --unreachable --no-reflogs 2>$null)
        foreach ($line in $fsck) {
            if ([string]$line -match 'unreachable commit') { $danglingCount += 1 }
        }
    }
    return @{
        ok                 = $true
        exists             = $true
        branch             = $branchName
        branchHeadOid      = $headOid
        localAheadCount    = $localAhead
        remoteAheadCount   = $remoteAhead
        diverged           = $diverged
        reflogEntries      = $reflogEntries
        danglingReachableCount = $danglingCount
    }
}

function Get-WorkerRecoveryBranchRemotePrObservation {
    param(
        [string]$RepoRoot,
        [string]$Branch,
        [hashtable]$FixtureObservation = $null,
        [switch]$FixtureMode
    )

    $observedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    if ($FixtureMode -and $FixtureObservation) {
        return @{
            observedAtUtc          = if ($FixtureObservation.observedAtUtc) { [string]$FixtureObservation.observedAtUtc } else { $observedAtUtc }
            openPrByHeadRefName    = if ($FixtureObservation.openPrByHeadRefName) { $FixtureObservation.openPrByHeadRefName } else { @{} }
            fetchFailed            = [bool]$FixtureObservation.fetchFailed
            rateLimited            = [bool]$FixtureObservation.rateLimited
            remoteAdvancedAfterObservation = [bool]$FixtureObservation.remoteAdvancedAfterObservation
            source                 = 'fixture'
        }
    }
    try {
        & git -C $RepoRoot fetch --quiet origin 2>$null | Out-Null
    }
    catch { }
    $fetchFailed = ($LASTEXITCODE -ne 0)
    $rateLimited = $false
    $openPrByHeadRefName = @{}
    try {
        $indexes = Get-GhFleetOpenPrIndexes -RepoRoot $RepoRoot
        foreach ($entry in $indexes.byHeadRefName.GetEnumerator()) {
            $openPrByHeadRefName[[string]$entry.Key] = $entry.Value
        }
    }
    catch {
        $fetchFailed = $true
        if ([string]$_.Exception.Message -match 'rate.?limit') {
            $rateLimited = $true
        }
    }
    return @{
        observedAtUtc       = $observedAtUtc
        openPrByHeadRefName = $openPrByHeadRefName
        fetchFailed         = $fetchFailed
        rateLimited         = $rateLimited
        remoteAdvancedAfterObservation = $false
        source              = 'github_fleet'
    }
}

function Invoke-WorkerRecoveryBranchCleanup {
    param(
        [string]$SessionId,
        [string]$CanonicalPath,
        [string]$RepoRoot,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$Namespace = '',
        [string]$AttemptId = '',
        [string]$ClaimPath = '',
        [hashtable]$ClaimRecord = $null,
        [hashtable]$GrantRecord = $null,
        [hashtable]$FixtureObservation = $null,
        [hashtable]$FixtureBranchState = $null,
        [array]$FixtureWorktreeRecords = $null,
        [switch]$FixtureMode,
        [switch]$DryRun,
        [switch]$LiveDifferentOwner,
        [int]$IssueNumber = 0,
        [switch]$TaskClosed,
        [switch]$TaskCancelled,
        [switch]$TaskSuperseded
    )

    $ns = Resolve-WorkerRecoveryNamespace -ProjectId $ProjectId -Namespace $Namespace
    $grant = $null
    if ($FixtureMode -and $GrantRecord) {
        $grant = @{ ok = $true; record = $GrantRecord }
    }
    else {
        $grant = Find-WorkerRecoveryConsumedSpawnGrant -SessionId $SessionId -CanonicalPath $CanonicalPath -ProjectId $ProjectId
    }
    $branchName = ''
    if ($grant.ok -and $grant.record.expectedBranch) {
        $branchName = [string]$grant.record.expectedBranch
    }
    elseif ($IssueNumber -gt 0) {
        $branchName = "feat/issue-$IssueNumber"
    }
    if (-not $branchName) {
        return @{
            ok        = $true
            skipped   = $true
            reason    = 'branch_candidate_missing'
            branch    = ''
            deleted   = $false
            escalation = $null
        }
    }

    $existingDelete = Get-WorkerRecoveryBranchDeletedAudit -Namespace $ns -SessionId $SessionId -Branch $branchName -AttemptId $AttemptId
    if ($existingDelete) {
        return @{
            ok        = $true
            skipped   = $true
            reason    = 'branch_already_deleted'
            branch    = $branchName
            deleted   = $true
            audit     = $existingDelete.record
            escalation = $null
        }
    }

    $branchState = if ($FixtureMode -and $FixtureBranchState) {
        $FixtureBranchState
    }
    else {
        Get-WorkerRecoveryBranchGitState -RepoRoot $RepoRoot -Branch $branchName
    }
    if (-not $branchState.ok) {
        return @{ ok = $false; reason = $branchState.reason; escalation = 'branch_state_unavailable' }
    }
    if (-not $branchState.exists) {
        return @{
            ok        = $true
            skipped   = $true
            reason    = 'branch_absent'
            branch    = $branchName
            deleted   = $false
            escalation = $null
        }
    }

    $porcelain = if ($FixtureMode -and $PSBoundParameters.ContainsKey('FixtureWorktreeRecords')) {
        @($FixtureWorktreeRecords)
    }
    else {
        $raw = & git -C $RepoRoot worktree list --porcelain 2>$null
        $parsed = Invoke-MechanicalNodeFilterCli -FilterCliPath (Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path 'docs/worker-recovery.mjs') `
            -Subcommand 'parseWorktreeList' -Payload @{ porcelain = (($raw | ForEach-Object { $_ }) -join "`n") } -Label 'worker-recovery' -JsonDepth 30
        @($parsed.records)
    }

    $observation = Get-WorkerRecoveryBranchRemotePrObservation -RepoRoot $RepoRoot -Branch $branchName `
        -FixtureObservation $FixtureObservation -FixtureMode:$FixtureMode
    $ttl = Get-WorkerRecoveryBranchObservationTtlSeconds
    $classification = Invoke-WorkerRecoveryBranchCleanupCli -Subcommand 'evaluateBranchPreexists' -Payload @{
        branchExists                   = [bool]$branchState.exists
        branch                         = $branchName
        branchHeadOid                  = [string]$branchState.branchHeadOid
        sessionId                      = $SessionId
        canonicalPath                  = $CanonicalPath
        grant                          = if ($grant.ok) { $grant.record } else { $null }
        worktreeRecords                = @($porcelain)
        localAheadCount                = [int]$branchState.localAheadCount
        remoteAheadCount               = [int]$branchState.remoteAheadCount
        diverged                       = [bool]$branchState.diverged
        reflogEntries                  = @($branchState.reflogEntries)
        danglingReachableCount         = [int]$branchState.danglingReachableCount
        openPrByHeadRefName            = $observation.openPrByHeadRefName
        observedAtUtc                  = [string]$observation.observedAtUtc
        ttlSeconds                     = $ttl
        fetchFailed                    = [bool]$observation.fetchFailed
        rateLimited                    = [bool]$observation.rateLimited
        remoteAdvancedAfterObservation = [bool]$observation.remoteAdvancedAfterObservation
        liveDifferentOwner             = [bool]$LiveDifferentOwner
        taskClosed                     = [bool]$TaskClosed
        taskCancelled                  = [bool]$TaskCancelled
        taskSuperseded                 = [bool]$TaskSuperseded
    }

    if ($classification.action -eq 'preserve') {
        $escalation = [string]$classification.escalation
        if (-not $escalation) { $escalation = [string]$classification.reason }
        $audit = Invoke-WorkerRecoveryBranchCleanupCli -Subcommand 'buildBranchCleanupAudit' -Payload @{
            kind          = 'branch_preserved'
            attemptId     = $AttemptId
            sessionId     = $SessionId
            taskId        = if ($IssueNumber -gt 0) { [string]$IssueNumber } else { '' }
            branch        = $branchName
            repoIdentity  = $RepoRoot
            predicates    = @{ preexists = $classification }
            observation   = $observation
            escalation    = $escalation
        }
        Write-WorkerRecoveryAudit -Namespace $ns -Record (ConvertTo-WorkerRecoveryBranchAuditHashtable $audit)
        return @{
            ok         = $false
            skipped    = $false
            reason     = $classification.reason
            branch     = $branchName
            deleted    = $false
            escalation = $escalation
            audit      = $audit
        }
    }

    $revalidation = Invoke-WorkerRecoveryBranchCleanupCli -Subcommand 'evaluateDeletionRevalidation' -Payload @{
        branch                         = $branchName
        branchHeadOid                  = [string]$branchState.branchHeadOid
        sessionId                      = $SessionId
        canonicalPath                  = $CanonicalPath
        grant                          = if ($grant.ok) { $grant.record } else { $null }
        worktreeRecords                = @($porcelain)
        localAheadCount                = [int]$branchState.localAheadCount
        remoteAheadCount               = [int]$branchState.remoteAheadCount
        diverged                       = [bool]$branchState.diverged
        reflogEntries                  = @($branchState.reflogEntries)
        danglingReachableCount         = [int]$branchState.danglingReachableCount
        openPrByHeadRefName            = $observation.openPrByHeadRefName
        observedAtUtc                  = [string]$observation.observedAtUtc
        ttlSeconds                     = $ttl
        fetchFailed                    = [bool]$observation.fetchFailed
        rateLimited                    = [bool]$observation.rateLimited
        remoteAdvancedAfterObservation = [bool]$observation.remoteAdvancedAfterObservation
        liveDifferentOwner             = [bool]$LiveDifferentOwner
        expectedDeleteOid              = [string]$branchState.branchHeadOid
    }
    if (-not $revalidation.ok) {
        $escalation = [string]$revalidation.reason
        $audit = Invoke-WorkerRecoveryBranchCleanupCli -Subcommand 'buildBranchCleanupAudit' -Payload @{
            kind          = 'branch_preserved'
            attemptId     = $AttemptId
            sessionId     = $SessionId
            taskId        = if ($IssueNumber -gt 0) { [string]$IssueNumber } else { '' }
            branch        = $branchName
            repoIdentity  = $RepoRoot
            predicates    = @{ revalidation = $revalidation }
            observation   = $observation
            escalation    = $escalation
        }
        Write-WorkerRecoveryAudit -Namespace $ns -Record (ConvertTo-WorkerRecoveryBranchAuditHashtable $audit)
        return @{
            ok         = $false
            reason     = $revalidation.reason
            branch     = $branchName
            deleted    = $false
            escalation = $escalation
            audit      = $audit
        }
    }

    $intentAudit = Invoke-WorkerRecoveryBranchCleanupCli -Subcommand 'buildBranchCleanupAudit' -Payload @{
        kind          = 'branch_delete_intent'
        attemptId     = $AttemptId
        sessionId     = $SessionId
        taskId        = if ($IssueNumber -gt 0) { [string]$IssueNumber } else { '' }
        branch        = $branchName
        repoIdentity  = $RepoRoot
        deletedHeadOid = [string]$revalidation.expectedDeleteOid
        predicates    = @{ classification = $classification; revalidation = $revalidation }
        observation   = $observation
    }
    Write-WorkerRecoveryAudit -Namespace $ns -Record (ConvertTo-WorkerRecoveryBranchAuditHashtable $intentAudit)

    if ($ClaimPath -and $ClaimRecord) {
        $null = Update-WorkerRecoveryClaimPhase -Path $ClaimPath -Record $ClaimRecord -Phase 'branch_cleanup_pending' -Patch @{
            boundBranch = $branchName
        }
    }

    $deleted = $false
    if (-not $DryRun) {
        $expectedDeleteOid = [string]$revalidation.expectedDeleteOid
        $freshBranchState = Get-WorkerRecoveryBranchGitState -RepoRoot $RepoRoot -Branch $branchName
        if (-not $freshBranchState.ok) {
            return @{ ok = $false; reason = $freshBranchState.reason; escalation = 'branch_state_unavailable' }
        }
        if (-not $freshBranchState.exists) {
            $deleted = $true
        }
        else {
            $finalRevalidation = Invoke-WorkerRecoveryBranchCleanupCli -Subcommand 'evaluateDeletionRevalidation' -Payload @{
                branch                         = $branchName
                branchHeadOid                  = [string]$freshBranchState.branchHeadOid
                sessionId                      = $SessionId
                canonicalPath                  = $CanonicalPath
                grant                          = if ($grant.ok) { $grant.record } else { $null }
                worktreeRecords                = @($porcelain)
                localAheadCount                = [int]$freshBranchState.localAheadCount
                remoteAheadCount               = [int]$freshBranchState.remoteAheadCount
                diverged                       = [bool]$freshBranchState.diverged
                reflogEntries                  = @($freshBranchState.reflogEntries)
                danglingReachableCount         = [int]$freshBranchState.danglingReachableCount
                openPrByHeadRefName            = $observation.openPrByHeadRefName
                observedAtUtc                  = [string]$observation.observedAtUtc
                ttlSeconds                     = $ttl
                fetchFailed                    = [bool]$observation.fetchFailed
                rateLimited                    = [bool]$observation.rateLimited
                remoteAdvancedAfterObservation = [bool]$observation.remoteAdvancedAfterObservation
                liveDifferentOwner             = [bool]$LiveDifferentOwner
                expectedDeleteOid              = $expectedDeleteOid
            }
            if (-not $finalRevalidation.ok) {
                $escalation = [string]$finalRevalidation.reason
                $audit = Invoke-WorkerRecoveryBranchCleanupCli -Subcommand 'buildBranchCleanupAudit' -Payload @{
                    kind          = 'branch_preserved'
                    attemptId     = $AttemptId
                    sessionId     = $SessionId
                    taskId        = if ($IssueNumber -gt 0) { [string]$IssueNumber } else { '' }
                    branch        = $branchName
                    repoIdentity  = $RepoRoot
                    predicates    = @{ revalidation = $finalRevalidation }
                    observation   = $observation
                    escalation    = $escalation
                }
                Write-WorkerRecoveryAudit -Namespace $ns -Record (ConvertTo-WorkerRecoveryBranchAuditHashtable $audit)
                return @{
                    ok         = $false
                    reason     = $finalRevalidation.reason
                    branch     = $branchName
                    deleted    = $false
                    escalation = $escalation
                    audit      = $audit
                }
            }
            & git -C $RepoRoot update-ref -d "refs/heads/$branchName" $expectedDeleteOid 2>$null
            if ($LASTEXITCODE -eq 0) {
                $deleted = $true
            }
            else {
                $postState = Get-WorkerRecoveryBranchGitState -RepoRoot $RepoRoot -Branch $branchName
                if ($postState.exists) {
                    $escalation = 'blocked_oid_race'
                    $audit = Invoke-WorkerRecoveryBranchCleanupCli -Subcommand 'buildBranchCleanupAudit' -Payload @{
                        kind          = 'branch_preserved'
                        attemptId     = $AttemptId
                        sessionId     = $SessionId
                        branch        = $branchName
                        repoIdentity  = $RepoRoot
                        escalation    = $escalation
                    }
                    Write-WorkerRecoveryAudit -Namespace $ns -Record (ConvertTo-WorkerRecoveryBranchAuditHashtable $audit)
                    return @{
                        ok         = $false
                        reason     = $escalation
                        branch     = $branchName
                        deleted    = $false
                        escalation = $escalation
                    }
                }
                $deleted = $true
            }
        }
    }
    else {
        $deleted = $true
    }

    $completionAudit = Invoke-WorkerRecoveryBranchCleanupCli -Subcommand 'buildBranchCleanupAudit' -Payload @{
        kind           = 'branch_deleted'
        attemptId      = $AttemptId
        sessionId      = $SessionId
        taskId         = if ($IssueNumber -gt 0) { [string]$IssueNumber } else { '' }
        branch         = $branchName
        repoIdentity   = $RepoRoot
        deletedHeadOid = [string]$revalidation.expectedDeleteOid
        predicates     = @{ classification = $classification; revalidation = $revalidation }
        observation    = $observation
        respawnHandoffId = $AttemptId
    }
    Write-WorkerRecoveryAudit -Namespace $ns -Record (ConvertTo-WorkerRecoveryBranchAuditHashtable $completionAudit)
    return @{
        ok       = $true
        reason   = 'branch_deleted'
        branch   = $branchName
        deleted  = $deleted
        audit    = $completionAudit
        escalation = $null
    }
}
