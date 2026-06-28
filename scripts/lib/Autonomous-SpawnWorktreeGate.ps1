#requires -Version 5.1
<#
  Spawn-owned worktree grant mint/consume for autonomous ao spawn (Issue #470).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-ReviewWorktreeGate.ps1')

$Script:SpawnWorktreeGrantCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/spawn-worktree-grant.mjs'
$Script:SpawnWorktreeGrantSchemaVersion = 1
$Script:SpawnWorktreeGrantEnvVar = 'AO_SPAWN_WORKTREE_GRANT_ID'
$Script:AutonomousSpawnWorktreeActiveGrant = $null

function Invoke-SpawnWorktreeGrantCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:SpawnWorktreeGrantCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'spawn-worktree-grant' -JsonDepth 30
}

function Get-AutonomousSpawnWorktreeProjectId {
    $project = if ($env:AO_PROJECT_ID) { $env:AO_PROJECT_ID.Trim() }
    elseif ($env:AO_PROJECT) { $env:AO_PROJECT.Trim() }
    else { 'orchestrator-pack' }
    if (-not $project) { return 'orchestrator-pack' }
    return $project
}

function Get-AutonomousSpawnWorktreeStateRoot {
    param([string]$ProjectId = '')

    if (-not $ProjectId) {
        $ProjectId = Get-AutonomousSpawnWorktreeProjectId
    }
    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    return (Join-Path (Join-Path $base 'projects') $ProjectId)
}

function Get-AutonomousSpawnWorktreeGrantNamespace {
    param([string]$ProjectId = '')

    return (Join-Path (Get-AutonomousSpawnWorktreeStateRoot -ProjectId $ProjectId) 'spawn-worktree-grants')
}

function Get-AutonomousSpawnWorktreePrefix {
    param([string]$ProjectId = '')

    return (Join-Path (Get-AutonomousSpawnWorktreeStateRoot -ProjectId $ProjectId) 'worktrees')
}

function Get-AutonomousSpawnWorktreeTargetLockDir {
    param(
        [string]$Namespace,
        [string]$TargetKey
    )

    $safeKey = ($TargetKey -replace '[^A-Za-z0-9._-]+', '_')
    return (Join-Path (Join-Path $Namespace '.locks') $safeKey)
}

function New-AutonomousSpawnWorktreeHolder {
    return @{
        pid           = $PID
        host          = [System.Environment]::MachineName
        processGuid   = [guid]::NewGuid().ToString('n')
        surface       = 'autonomous-spawn-worktree-gate'
        acquiredAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Test-AutonomousSpawnWorktreeHolderAlive {
    param([object]$Holder)

    if (-not $Holder) { return $false }
    try {
        $ownerPid = [int]$Holder.pid
        if ($ownerPid -le 0) { return $false }
        $process = Get-Process -Id $ownerPid -ErrorAction Stop
        return [bool]$process
    }
    catch {
        return $false
    }
}

function Read-AutonomousSpawnWorktreeGrantRecord {
    param([string]$Path)

    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return @{ ok = $false; reason = 'missing' }
        }
        $record = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        return @{ ok = $true; record = $record }
    }
    catch {
        return @{ ok = $false; reason = 'unreadable' }
    }
}

function Write-AutonomousSpawnWorktreeGrantAtomic {
    param(
        [string]$Namespace,
        [string]$GrantId,
        [object]$Record
    )

    New-Item -ItemType Directory -Path $Namespace -Force -ErrorAction SilentlyContinue | Out-Null
    $path = Join-Path $Namespace "$GrantId.json"
    $tmp = "$path.tmp.$PID"
    ($Record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $path -Force
    return $path
}

function Get-AutonomousSpawnWorktreeExtraAuthorizedNames {
    param(
        [string]$Action,
        [int]$PrNumber = 0,
        [string]$ProjectId = 'orchestrator-pack'
    )

    $names = @()
    if ($Action -eq 'claim-pr-resume' -and $PrNumber -gt 0) {
        $claimsDir = Join-Path (Get-AutonomousSpawnWorktreeStateRoot -ProjectId $ProjectId) 'pr-ownership-claims'
        $claimPath = Join-Path $claimsDir "pr-$PrNumber.json"
        if (Test-Path -LiteralPath $claimPath -PathType Leaf) {
            try {
                $claim = Get-Content -LiteralPath $claimPath -Raw | ConvertFrom-Json
                $ownerSessionId = [string]$claim.ownerSessionId
                if ($ownerSessionId) {
                    $names += $ownerSessionId
                }
                $claimWorktree = [string]$claim.worktree
                if ($claimWorktree) {
                    $names += (Split-Path -Leaf $claimWorktree)
                }
            }
            catch { }
        }
    }
    return $names
}

function Enter-AutonomousSpawnWorktreeTargetLock {
    param(
        [string]$Namespace,
        [string]$TargetKey,
        [object]$Holder
    )

    $lockDir = Get-AutonomousSpawnWorktreeTargetLockDir -Namespace $Namespace -TargetKey $TargetKey
    if (Test-Path -LiteralPath $lockDir -PathType Container) {
        $ownerPath = Join-Path $lockDir 'owner.json'
        if (Test-Path -LiteralPath $ownerPath -PathType Leaf) {
            try {
                $owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
                if (Test-AutonomousSpawnWorktreeHolderAlive -Holder $owner) {
                    if ([string]$owner.processGuid -ne [string]$Holder.processGuid) {
                        return @{ acquired = $false; reason = 'spawn_target_busy' }
                    }
                }
            }
            catch { }
        }
        Remove-Item -LiteralPath $lockDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    try {
        New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
        $ownerPath = Join-Path $lockDir 'owner.json'
        ($Holder | ConvertTo-Json -Compress -Depth 10) | Set-Content -LiteralPath $ownerPath -Encoding UTF8
        return @{ acquired = $true; reason = 'lock_acquired'; lockDir = $lockDir }
    }
    catch {
        return @{ acquired = $false; reason = 'spawn_target_busy' }
    }
}

function Release-AutonomousSpawnWorktreeTargetLock {
    param([hashtable]$Lock)

    if (-not $Lock -or -not $Lock.lockDir) { return }
    Remove-Item -LiteralPath $Lock.lockDir -Recurse -Force -ErrorAction SilentlyContinue
}



function Resolve-AutonomousSpawnWorktreeDefaultBranchBaseRef {
    param(
        [string]$RepoRoot,
        [string]$DefaultBranch = 'main'
    )

    return Invoke-SpawnWorktreeGrantCli -Subcommand 'resolveDefaultBranchBaseRef' -Payload @{
        repoRoot       = [string]$RepoRoot
        defaultBranch  = [string]$DefaultBranch
        fixtureMode    = [bool]$env:AO_SPAWN_WORKTREE_FIXTURE_MODE
    }
}

function Resolve-AutonomousSpawnClaimPrHead {
    param(
        [int]$PrNumber,
        [string]$SourceRepositoryRoot = '',
        [switch]$FixtureMode
    )

    if ($env:AO_SPAWN_FIXTURE_PR_HEAD_OID) {
        $fixtureOid = [string]$env:AO_SPAWN_FIXTURE_PR_HEAD_OID
        if ($fixtureOid) {
            return @{
                ok          = $true
                headRefOid  = $fixtureOid.Trim().ToLower()
                prRefToken  = if ($env:AO_SPAWN_FIXTURE_PR_REF_TOKEN) { [string]$env:AO_SPAWN_FIXTURE_PR_REF_TOKEN } else { "pr-$PrNumber" }
            }
        }
    }

    if ($FixtureMode -and $SourceRepositoryRoot) {
        $resolved = Invoke-SpawnWorktreeGrantCli -Subcommand 'resolveCommitRef' -Payload @{
            repoRoot  = [string]$SourceRepositoryRoot
            refToken  = 'HEAD'
        }
        if ($resolved.ok) {
            return @{
                ok          = $true
                headRefOid  = [string]$resolved.commitOid
                prRefToken  = "fixture-pr-$PrNumber"
            }
        }
    }

    try {
        $json = (& gh pr view $PrNumber --json headRefOid,headRefName 2>$null | ConvertFrom-Json)
        $headRefOid = [string]$json.headRefOid
        if (-not $headRefOid) {
            return @{ ok = $false; reason = 'expected_pr_head_missing' }
        }
        return @{
            ok          = $true
            headRefOid  = $headRefOid.Trim().ToLower()
            prRefToken  = [string]$json.headRefName
        }
    }
    catch {
        return @{ ok = $false; reason = 'expected_pr_head_missing' }
    }
}

function Write-AutonomousSpawnWorktreeHeadRefAudit {
    param(
        [string]$ProjectId,
        [object]$AuditRecord
    )

    if (-not $AuditRecord) { return }
    $auditDir = Join-Path (Get-AutonomousSpawnWorktreeStateRoot -ProjectId $ProjectId) 'head-ref-audit'
    New-Item -ItemType Directory -Path $auditDir -Force -ErrorAction SilentlyContinue | Out-Null
    $line = ($AuditRecord | ConvertTo-Json -Compress -Depth 8)
    Add-Content -LiteralPath (Join-Path $auditDir 'events.jsonl') -Value $line -Encoding UTF8
}

function Verify-AutonomousSpawnClaimPrPostCheckout {
    param(
        [object]$GrantRecord,
        [string]$WorkspaceRoot = ''
    )

    if (-not $GrantRecord) {
        return @{ ok = $false; reason = 'grant_missing' }
    }
    if ([string]$GrantRecord.action -ne 'claim-pr-resume') {
        return @{ ok = $true; reason = 'not_claim_pr' }
    }

    $workspace = $WorkspaceRoot
    if (-not $workspace) {
        $workspace = [string]$GrantRecord.consumedCanonicalPath
    }
    if (-not $workspace) {
        return @{ ok = $false; reason = 'workspace_root_unresolvable' }
    }

    $evaluation = Invoke-SpawnWorktreeGrantCli -Subcommand 'evaluateClaimPrPostCheckout' -Payload @{
        workspaceRoot    = [string]$workspace
        expectedPrHeadOid = [string]$GrantRecord.expectedPrHeadOid
        prNumber         = [int]$GrantRecord.prNumber
        prRefToken       = [string]$GrantRecord.expectedPrRefToken
    }
    $projectId = [string]$GrantRecord.projectId
    if (-not $projectId) {
        $projectId = Get-AutonomousSpawnWorktreeProjectId
    }
    Write-AutonomousSpawnWorktreeHeadRefAudit -ProjectId $projectId -AuditRecord @{
        atUtc                  = (Get-Date).ToUniversalTime().ToString('o')
        kind                   = 'claim_pr_post_checkout'
        outcome                = if ($evaluation.ok) { 'allow' } else { 'deny' }
        reason                 = [string]$evaluation.reason
        prNumber               = [int]$GrantRecord.prNumber
        prRefToken             = [string]$evaluation.prRefToken
        expectedPrHeadOid      = [string]$evaluation.expectedPrHeadOid
        actualWorkspaceHeadOid = [string]$evaluation.actualWorkspaceHeadOid
        grantId                = [string]$GrantRecord.grantId
        workspaceRoot          = [string]$workspace
    }
    return $evaluation
}

function Resolve-AutonomousSpawnWorktreeSourceRepositoryRoot {
    try {
        $topLevel = [string](& git rev-parse --show-toplevel 2>$null).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $topLevel) {
            return @{ ok = $false; reason = 'repository_root_unresolvable' }
        }
        $resolved = Resolve-AutonomousReviewWorktreeExistingAncestorPath -TargetPath $topLevel
        if (-not $resolved.ok) {
            return @{ ok = $false; reason = 'repository_root_unresolvable' }
        }
        return @{ ok = $true; path = [string]$resolved.path }
    }
    catch {
        return @{ ok = $false; reason = 'repository_root_unresolvable' }
    }
}

function Mint-AutonomousSpawnWorktreeGrant {
    param(
        [string[]]$Argv,
        [string]$Action = '',
        [string]$ProjectId = ''
    )

    if (-not $ProjectId) {
        $ProjectId = Get-AutonomousSpawnWorktreeProjectId
    }
    $parsed = Invoke-SpawnWorktreeGrantCli -Subcommand 'parseSpawnTarget' -Payload @{ argv = @($Argv) }
    if (-not $parsed.targetKey) {
        return @{ ok = $false; reason = 'spawn_target_missing' }
    }
    if ($Action -and [string]$parsed.action -ne $Action) {
        return @{ ok = $false; reason = 'spawn_action_mismatch' }
    }

    $holder = New-AutonomousSpawnWorktreeHolder
    $namespace = Get-AutonomousSpawnWorktreeGrantNamespace -ProjectId $ProjectId
    $lock = Enter-AutonomousSpawnWorktreeTargetLock -Namespace $Namespace -TargetKey ([string]$parsed.targetKey) -Holder $holder
    if (-not $lock.acquired) {
        return @{ ok = $false; reason = [string]$lock.reason }
    }

    $prNumber = 0
    if ($null -ne $parsed.prNumber) {
        $prNumber = [int]$parsed.prNumber
    }
    $extraNames = Get-AutonomousSpawnWorktreeExtraAuthorizedNames -Action ([string]$parsed.action) `
        -PrNumber $prNumber -ProjectId $ProjectId
    $sourceRepo = Resolve-AutonomousSpawnWorktreeSourceRepositoryRoot
    if (-not $sourceRepo.ok) {
        Release-AutonomousSpawnWorktreeTargetLock -Lock $lock
        return @{ ok = $false; reason = [string]$sourceRepo.reason }
    }
    $grantId = [guid]::NewGuid().ToString('n')
    $baseRef = Resolve-AutonomousSpawnWorktreeDefaultBranchBaseRef -RepoRoot ([string]$sourceRepo.path)
    if (-not $baseRef.ok) {
        Release-AutonomousSpawnWorktreeTargetLock -Lock $lock
        return @{ ok = $false; reason = [string]$baseRef.reason }
    }
    $buildPayload = @{
        argv                         = @($Argv)
        grantId                      = $grantId
        projectId                    = $ProjectId
        holder                       = $holder
        extraAuthorizedWorktreeNames = @($extraNames)
        expectedHeadRef              = [string]$baseRef.refToken
        sourceRepositoryRoot         = [string]$sourceRepo.path
    }
    if ([string]$parsed.action -eq 'claim-pr-resume') {
        $prHead = Resolve-AutonomousSpawnClaimPrHead -PrNumber $prNumber -SourceRepositoryRoot ([string]$sourceRepo.path) -FixtureMode:([bool]$env:AO_SPAWN_WORKTREE_FIXTURE_MODE)
        if (-not $prHead.ok) {
            Release-AutonomousSpawnWorktreeTargetLock -Lock $lock
            return @{ ok = $false; reason = [string]$prHead.reason }
        }
        $buildPayload.expectedPrHeadOid = [string]$prHead.headRefOid
        $buildPayload.expectedPrRefToken = [string]$prHead.prRefToken
    }
    $built = Invoke-SpawnWorktreeGrantCli -Subcommand 'buildGrant' -Payload $buildPayload
    if (-not $built.ok) {
        Release-AutonomousSpawnWorktreeTargetLock -Lock $lock
        return @{ ok = $false; reason = [string]$built.reason }
    }

    $grantPath = Write-AutonomousSpawnWorktreeGrantAtomic -Namespace $Namespace -GrantId $grantId -Record $built.grant
    $env:AO_SPAWN_WORKTREE_GRANT_ID = $grantId
    $script:AutonomousSpawnWorktreeActiveGrant = @{
        grantId   = $grantId
        grantPath = $grantPath
        namespace = $namespace
        lock      = $lock
        holder    = $holder
    }
    [Console]::Error.WriteLine(
        "autonomous spawn worktree grant mint: grantId=$grantId action=$($built.grant.action) target=$($built.grant.targetKey)"
    )
    return @{
        ok        = $true
        reason    = 'spawn_worktree_grant_minted'
        grantId   = $grantId
        grantPath = $grantPath
        grant     = $built.grant
        lock      = $lock
    }
}

function Find-AutonomousSpawnWorktreeGrantById {
    param(
        [string]$GrantId,
        [string]$ProjectId = ''
    )

    if (-not $GrantId) {
        return @{ ok = $false; reason = 'grant_id_missing' }
    }
    if (-not $ProjectId) {
        $ProjectId = Get-AutonomousSpawnWorktreeProjectId
    }
    $namespace = Get-AutonomousSpawnWorktreeGrantNamespace -ProjectId $ProjectId
    $path = Join-Path $namespace "$GrantId.json"
    $read = Read-AutonomousSpawnWorktreeGrantRecord -Path $path
    if (-not $read.ok) {
        return @{ ok = $false; reason = 'grant_not_found' }
    }
    return @{ ok = $true; record = $read.record; path = $path; namespace = $namespace; projectId = $ProjectId }
}

function Get-GitSpawnWorktreeAddPathFromArgv {
    param([string[]]$Argv)

    $index = Get-GitArgvSubcommandIndex -Argv $Argv
    if ($index + 2 -ge $Argv.Count) {
        return $null
    }
    $cursor = $index + 2
    while ($cursor -lt $Argv.Count) {
        $token = [string]$Argv[$cursor]
        if ($token -match '^(?i)(-b|--branch|--detach|-f|--force|--checkout|--lock|--orphan)$') {
            $cursor += $(if ($token -match '^(?i)(-b|--branch)$') { 2 } else { 1 })
            continue
        }
        if ($token.StartsWith('-')) {
            return $null
        }
        return $token
    }
    return $null
}

function Test-AutonomousSpawnWorktreeTargetPathHardened {
    param(
        [string]$TargetPath,
        [string]$ProjectId
    )

    $prefix = Get-AutonomousSpawnWorktreePrefix -ProjectId $ProjectId
    $pathCheck = Test-AutonomousCanonicalWorktreeTargetUnderPrefix -TargetPath $TargetPath -PrefixPath $prefix
    if (-not $pathCheck.allowed) {
        return $pathCheck
    }

    $preexists = Test-Path -LiteralPath $pathCheck.canonicalPath
    return @{
        allowed         = $true
        reason          = 'path_ok'
        canonicalPath   = $pathCheck.canonicalPath
        targetPreexists = [bool]$preexists
    }
}



function Write-AutonomousSpawnWorktreeGrantConsumeLockPayload {
    param(
        [string]$Path,
        [string]$Content
    )

    $encoding = [System.Text.UTF8Encoding]::new($false)
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $writer = New-Object System.IO.StreamWriter($stream, $encoding)
        try {
            $writer.Write($Content)
        }
        finally {
            $writer.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Get-AutonomousSpawnWorktreeGrantConsumeLockPath {
    param(
        [string]$Namespace,
        [string]$GrantId
    )

    $safeGrantId = ($GrantId -replace '[^A-Za-z0-9._-]+', '_')
    return (Join-Path (Join-Path $Namespace '.consume-locks') "$safeGrantId.lock")
}

function Enter-AutonomousSpawnWorktreeGrantConsumeMutex {
    param([string]$LockPath)

    $lockParent = Split-Path -Parent $LockPath
    if (-not (Test-Path -LiteralPath $lockParent -PathType Container)) {
        New-Item -ItemType Directory -Path $lockParent -Force | Out-Null
    }

    $record = @{
        pid           = $PID
        acquiredAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
    $json = ($record | ConvertTo-Json -Compress -Depth 5)

    try {
        Write-AutonomousSpawnWorktreeGrantConsumeLockPayload -Path $LockPath -Content $json
        return $true
    }
    catch [System.IO.IOException] {
        try {
            if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
                $owner = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
                if ($owner -and [int]$owner.pid -eq $PID) {
                    return $true
                }
                if (-not (Test-AutonomousSpawnWorktreeHolderAlive -Holder $owner)) {
                    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
                    Write-AutonomousSpawnWorktreeGrantConsumeLockPayload -Path $LockPath -Content $json
                    return $true
                }
            }
        }
        catch { }
        return $false
    }
}

function Exit-AutonomousSpawnWorktreeGrantConsumeMutex {
    param([string]$LockPath)

    if ($LockPath -and (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
    }
}

function Consume-AutonomousSpawnWorktreeGrant {
    param(
        [hashtable]$GrantLookup,
        [string[]]$Argv,
        [string]$CanonicalPath,
        [bool]$TargetPreexists
    )

    if (-not $GrantLookup -or -not $GrantLookup.ok) {
        return @{ ok = $false; reason = 'grant_lookup_invalid' }
    }

    $projectId = [string]$GrantLookup.projectId
    $grantId = [string]$GrantLookup.record.grantId
    if (-not $grantId) {
        return @{ ok = $false; reason = 'grant_id_missing' }
    }

    $lockPath = Get-AutonomousSpawnWorktreeGrantConsumeLockPath -Namespace ([string]$GrantLookup.namespace) -GrantId $grantId
    if (-not (Enter-AutonomousSpawnWorktreeGrantConsumeMutex -LockPath $lockPath)) {
        return @{ ok = $false; reason = 'grant_consume_busy' }
    }

    try {
        $prefix = Get-AutonomousSpawnWorktreePrefix -ProjectId $projectId
        $prefixResolved = Resolve-AutonomousReviewWorktreeExistingAncestorPath -TargetPath $prefix
        if (-not $prefixResolved.ok) {
            return @{ ok = $false; reason = 'prefix_unresolvable' }
        }

        $read = Read-AutonomousSpawnWorktreeGrantRecord -Path $GrantLookup.path
        if (-not $read.ok) {
            return @{ ok = $false; reason = 'grant_consume_race' }
        }
        if ($read.record.consumed) {
            return @{ ok = $false; reason = 'grant_already_consumed' }
        }
        if (-not (Test-AutonomousSpawnWorktreeHolderAlive -Holder $read.record.holder)) {
            return @{ ok = $false; reason = 'grant_holder_not_live' }
        }

        $effectiveRepo = Resolve-AutonomousSpawnWorktreeSourceRepositoryRoot
        $evaluation = Invoke-SpawnWorktreeGrantCli -Subcommand 'evaluateConsume' -Payload @{
            grant                     = $read.record
            argv                      = @($Argv)
            canonicalPath             = $CanonicalPath
            worktreesPrefix           = $prefixResolved.path
            targetPreexists           = [bool]$TargetPreexists
            effectiveRepositoryRoot   = if ($effectiveRepo.ok) { [string]$effectiveRepo.path } else { '' }
        }
        if (-not $evaluation.ok) {
            return @{ ok = $false; reason = [string]$evaluation.reason }
        }

        $updated = @{}
        $read.record.PSObject.Properties | ForEach-Object { $updated[$_.Name] = $_.Value }
        $updated.consumed = $true
        $updated.consumedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        $updated.consumedCanonicalPath = $CanonicalPath
        if ($evaluation.normalizedCommitOid) {
            $updated.normalizedCommitOid = [string]$evaluation.normalizedCommitOid
        }
        if ($evaluation.headRefAudit) {
            $updated.headRefAudit = $evaluation.headRefAudit
            Write-AutonomousSpawnWorktreeHeadRefAudit -ProjectId $projectId -AuditRecord @{
                atUtc    = (Get-Date).ToUniversalTime().ToString('o')
                kind     = 'spawn_worktree_allow'
                outcome  = 'allow'
                reason   = [string]$evaluation.reason
                audit    = $evaluation.headRefAudit
            }
        }
        Write-AutonomousSpawnWorktreeGrantAtomic -Namespace $GrantLookup.namespace -GrantId $grantId -Record ($updated | ConvertTo-Json -Compress -Depth 20 | ConvertFrom-Json)

        return @{
            ok                    = $true
            reason                = 'spawn_worktree_allow'
            grantId               = $grantId
            projectId             = $projectId
            path                  = $CanonicalPath
            normalizedCommitOid   = [string]$evaluation.normalizedCommitOid
            headRefAudit          = $evaluation.headRefAudit
        }
    }
    finally {
        Exit-AutonomousSpawnWorktreeGrantConsumeMutex -LockPath $lockPath
    }
}


function Rewrite-AutonomousSpawnWorktreeAddCommitArgv {
    param(
        [string[]]$Argv,
        [string]$NormalizedCommitOid
    )

    $oid = [string]$NormalizedCommitOid
    if (-not $oid -or $oid.Length -ne 40) {
        return @($Argv)
    }

    $list = @($Argv)
    $index = 0
    while ($index -lt $list.Count) {
        $token = [string]$list[$index]
        if ($token -in @('-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace')) {
            $index += 2
            continue
        }
        if ($token.StartsWith('--') -and $token.Contains('=')) {
            $index += 1
            continue
        }
        if ($token.StartsWith('-')) {
            $index += 1
            continue
        }
        break
    }
    if ($index -ge $list.Count -or [string]$list[$index] -ne 'worktree') { return @($Argv) }
    if ($index + 1 -ge $list.Count -or [string]$list[$index + 1] -ne 'add') { return @($Argv) }

    $cursor = $index + 2
    $sawPath = $false
    while ($cursor -lt $list.Count) {
        $token = [string]$list[$cursor]
        if ($token -match '^(?i)--detach$') { $cursor += 1; continue }
        if ($token -match '^(?i)(-b|--branch)$') { $cursor += 2; continue }
        if ($token -match '^(?i)(-f|--force|--checkout|--lock|--orphan)$') { $cursor += 1; continue }
        if ($token.StartsWith('-')) { return @($Argv) }
        if (-not $sawPath) { $sawPath = $true; $cursor += 1; continue }
        $rewritten = @($list)
        $rewritten[$cursor] = $oid.ToLower()
        return $rewritten
    }
    return @($Argv)
}

function Test-AutonomousSpawnWorktreeGrantBoundAllow {
    param([string[]]$Argv)

    $grantId = [string]$env:AO_SPAWN_WORKTREE_GRANT_ID
    if (-not $grantId) {
        return @{ allowed = $false; reason = 'grant_env_missing' }
    }

    $pathFromArgv = Get-GitSpawnWorktreeAddPathFromArgv -Argv $Argv
    if (-not $pathFromArgv) {
        return @{ allowed = $false; reason = 'missing_path' }
    }

    $lookup = Find-AutonomousSpawnWorktreeGrantById -GrantId $grantId
    if (-not $lookup.ok) {
        return @{ allowed = $false; reason = [string]$lookup.reason }
    }

    $projectId = [string]$lookup.record.projectId
    if (-not $projectId) {
        $projectId = Get-AutonomousSpawnWorktreeProjectId
    }
    $pathCheck = Test-AutonomousSpawnWorktreeTargetPathHardened -TargetPath $pathFromArgv -ProjectId $projectId
    if (-not $pathCheck.allowed) {
        return @{ allowed = $false; reason = $pathCheck.reason }
    }

    $consume = Consume-AutonomousSpawnWorktreeGrant -GrantLookup $lookup -Argv $Argv `
        -CanonicalPath $pathCheck.canonicalPath -TargetPreexists $pathCheck.targetPreexists
    if (-not $consume.ok) {
        return @{ allowed = $false; reason = $consume.reason }
    }

    return @{
        allowed               = $true
        reason                = 'spawn_worktree_allow'
        grantId               = $consume.grantId
        projectId             = $consume.projectId
        path                  = $consume.path
        normalizedCommitOid   = [string]$consume.normalizedCommitOid
        headRefAudit          = $consume.headRefAudit
    }
}

function Clear-AutonomousSpawnWorktreeActiveGrant {
    $active = $script:AutonomousSpawnWorktreeActiveGrant
    if (-not $active) { return }

    if ($active.grantPath -and (Test-Path -LiteralPath $active.grantPath -PathType Leaf)) {
        try {
            $read = Read-AutonomousSpawnWorktreeGrantRecord -Path $active.grantPath
            if ($read.ok -and -not $read.record.consumed) {
                Remove-Item -LiteralPath $active.grantPath -Force -ErrorAction SilentlyContinue
            }
        }
        catch { }
    }

    if ($active.lock) {
        Release-AutonomousSpawnWorktreeTargetLock -Lock $active.lock
    }

    Remove-Item Env:\AO_SPAWN_WORKTREE_GRANT_ID -ErrorAction SilentlyContinue
    $script:AutonomousSpawnWorktreeActiveGrant = $null
}

function Write-AutonomousBoundaryEscapeAudit {
    param(
        [string]$PackScriptsDir = '',
        [hashtable]$ExtraEnv = @{}
    )

    try {
        if (-not $PackScriptsDir) {
            $PackScriptsDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
        }
        $payload = @{
            env            = @{}
            packScriptsDir = $PackScriptsDir
        }
        foreach ($name in @('AO_TMUX_NAME', 'AO_AUTONOMOUS_ORCHESTRATOR_SURFACE', '__AO_AUTONOMOUS_SURFACE_BOOTSTRAP', 'PATH')) {
            $payload.env[$name] = if ($ExtraEnv.ContainsKey($name)) { [string]$ExtraEnv[$name] } else { [string][Environment]::GetEnvironmentVariable($name) }
        }
        $signal = Invoke-SpawnWorktreeGrantCli -Subcommand 'evaluateBoundaryEscape' -Payload $payload
        if ($signal.detected) {
            $projectId = Get-AutonomousSpawnWorktreeProjectId
            $auditDir = Join-Path (Get-AutonomousSpawnWorktreeStateRoot -ProjectId $projectId) 'boundary-escape-audit'
            New-Item -ItemType Directory -Path $auditDir -Force -ErrorAction SilentlyContinue | Out-Null
            $line = @{
                atUtc   = (Get-Date).ToUniversalTime().ToString('o')
                reason  = [string]$signal.reason
                signals = @($signal.signals)
            } | ConvertTo-Json -Compress
            Add-Content -LiteralPath (Join-Path $auditDir 'events.jsonl') -Value $line -Encoding UTF8
            [Console]::Error.WriteLine("autonomous boundary escape audit: reason=$($signal.reason) signals=$($signal.signals -join ',')")
            return @{ audited = $true; signal = $signal }
        }
        return @{ audited = $false; signal = $signal }
    }
    catch {
        return @{ audited = $false; reason = 'audit_unavailable' }
    }
}
