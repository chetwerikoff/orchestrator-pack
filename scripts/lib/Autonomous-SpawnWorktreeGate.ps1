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
    $grantId = [guid]::NewGuid().ToString('n')
    $built = Invoke-SpawnWorktreeGrantCli -Subcommand 'buildGrant' -Payload @{
        argv                         = @($Argv)
        grantId                      = $grantId
        projectId                    = $ProjectId
        holder                       = $holder
        extraAuthorizedWorktreeNames = @($extraNames)
        expectedHeadRef              = 'HEAD'
    }
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
    $prefix = Get-AutonomousSpawnWorktreePrefix -ProjectId $projectId
    $prefixResolved = Resolve-AutonomousReviewWorktreeExistingAncestorPath -TargetPath $prefix
    if (-not $prefixResolved.ok) {
        return @{ ok = $false; reason = 'prefix_unresolvable' }
    }

    $evaluation = Invoke-SpawnWorktreeGrantCli -Subcommand 'evaluateConsume' -Payload @{
        grant           = $GrantLookup.record
        argv            = @($Argv)
        canonicalPath   = $CanonicalPath
        worktreesPrefix = $prefixResolved.path
        targetPreexists = [bool]$TargetPreexists
    }
    if (-not $evaluation.ok) {
        return @{ ok = $false; reason = [string]$evaluation.reason }
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

    $updated = @{}
    $read.record.PSObject.Properties | ForEach-Object { $updated[$_.Name] = $_.Value }
    $updated.consumed = $true
    $updated.consumedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    $updated.consumedCanonicalPath = $CanonicalPath
    Write-AutonomousSpawnWorktreeGrantAtomic -Namespace $GrantLookup.namespace -GrantId ([string]$read.record.grantId) -Record ($updated | ConvertTo-Json -Compress -Depth 20 | ConvertFrom-Json)

    return @{
        ok        = $true
        reason    = 'spawn_worktree_allow'
        grantId   = [string]$read.record.grantId
        projectId = $projectId
        path      = $CanonicalPath
    }
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
        allowed   = $true
        reason    = 'spawn_worktree_allow'
        grantId   = $consume.grantId
        projectId = $consume.projectId
        path      = $consume.path
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
