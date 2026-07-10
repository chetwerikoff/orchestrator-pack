#requires -Version 5.1
<#
  Claim-pr resume safety: live-owner check + single-flight mutex (Issue #458).
#>

$Script:AutonomousClaimPrResumeMutexStaleSeconds = 5

. (Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1')

function Get-AutonomousClaimPrResumeNamespace {
    param([string]$ProjectId = 'orchestrator-pack')

    $project = ([string]$ProjectId).Trim()
    if (-not $project) { $project = 'orchestrator-pack' }
    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    return (Join-Path (Join-Path (Join-Path $base 'projects') $project) 'claim-pr-resume-claims')
}

function Get-AutonomousClaimPrResumeLockDir {
    param(
        [string]$Namespace,
        [int]$PrNumber
    )
    return (Join-Path (Join-Path $Namespace '.locks') "pr-$PrNumber")
}

function Get-AutonomousClaimPrResumeMutexOwnerPath {
    param([string]$LockDir)
    return (Join-Path $LockDir 'owner.json')
}

function Test-AutonomousClaimPrResumeProcessAlive {
    param([object]$Owner)

    try {
        $ownerPid = [int]$Owner.pid
        if ($ownerPid -le 0) { return $false }
        $process = Get-Process -Id $ownerPid -ErrorAction Stop
        return [bool]$process
    }
    catch {
        return $false
    }
}

function Read-AutonomousClaimPrResumeMutexOwner {
    param([string]$LockDir)

    $ownerPath = Get-AutonomousClaimPrResumeMutexOwnerPath -LockDir $LockDir
    try {
        if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf)) {
            return @{ ok = $false; reason = 'missing' }
        }
        $record = Get-Content -LiteralPath $ownerPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        return @{ ok = $true; record = $record }
    }
    catch {
        return @{ ok = $false; reason = 'unreadable' }
    }
}

function Test-AutonomousClaimPrResumeMutexAbandoned {
    param([string]$LockDir)

    if (-not (Test-Path -LiteralPath $LockDir -PathType Container)) {
        return $false
    }
    $owner = Read-AutonomousClaimPrResumeMutexOwner -LockDir $LockDir
    if ($owner.ok) {
        return -not (Test-AutonomousClaimPrResumeProcessAlive -Owner $owner.record)
    }
    try {
        $item = Get-Item -LiteralPath $LockDir -ErrorAction Stop
        $ageSeconds = ((Get-Date).ToUniversalTime() - $item.LastWriteTimeUtc).TotalSeconds
        return ($ageSeconds -ge $Script:AutonomousClaimPrResumeMutexStaleSeconds)
    }
    catch {
        return $false
    }
}

function Enter-AutonomousClaimPrResumeMutex {
    param(
        [int]$PrNumber,
        [string]$ProjectId = 'orchestrator-pack'
    )

    $namespace = Get-AutonomousClaimPrResumeNamespace -ProjectId $ProjectId
    New-Item -ItemType Directory -Path (Join-Path $namespace '.locks') -Force -ErrorAction SilentlyContinue | Out-Null
    $lockDir = Get-AutonomousClaimPrResumeLockDir -Namespace $namespace -PrNumber $PrNumber

    if (Test-AutonomousClaimPrResumeMutexAbandoned -LockDir $lockDir) {
        Remove-Item -LiteralPath $lockDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    try {
        New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
    }
    catch {
        return @{ acquired = $false; reason = 'claim_pr_resume_already_in_progress'; lockDir = $lockDir }
    }

    $hostName = 'unknown-host'
    try { $hostName = [System.Net.Dns]::GetHostName() } catch { }
    $owner = @{
        pid           = $PID
        host          = $hostName
        processGuid   = [guid]::NewGuid().ToString('n')
        acquiredAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        prNumber      = $PrNumber
    }
    $ownerPath = Get-AutonomousClaimPrResumeMutexOwnerPath -LockDir $lockDir
    $tmp = Join-Path $lockDir ".$([guid]::NewGuid().ToString('n')).tmp"
    ($owner | ConvertTo-Json -Compress -Depth 5) | Set-Content -LiteralPath $tmp -Encoding UTF8
    try {
        [System.IO.File]::Move($tmp, $ownerPath, $false)
    }
    catch [System.Management.Automation.MethodException] {
        [System.IO.File]::Move($tmp, $ownerPath)
    }
    catch {
        Remove-Item -LiteralPath $lockDir -Recurse -Force -ErrorAction SilentlyContinue
        return @{ acquired = $false; reason = 'claim_pr_resume_already_in_progress'; lockDir = $lockDir }
    }

    $verify = Read-AutonomousClaimPrResumeMutexOwner -LockDir $lockDir
    if (-not $verify.ok -or [string]$verify.record.processGuid -ne [string]$owner.processGuid) {
        return @{ acquired = $false; reason = 'claim_pr_resume_already_in_progress'; lockDir = $lockDir }
    }

    return @{ acquired = $true; reason = 'mutex_acquired'; lockDir = $lockDir; owner = $owner }
}

function Release-AutonomousClaimPrResumeMutex {
    param([hashtable]$Mutex)

    if (-not $Mutex -or -not $Mutex.lockDir) { return }
    Remove-Item -LiteralPath $Mutex.lockDir -Recurse -Force -ErrorAction SilentlyContinue
}

function Get-AutonomousGateResolvedAoCommand {
    $packRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path
    $realAo = 'ao'
    $configPath = Join-Path $packRoot '.ao' 'autonomous-real-binaries.json'
    if (Test-Path -LiteralPath $configPath) {
        try {
            $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
            $configured = [string]$config.ao
            if ($configured -and $configured -ne 'ao' -and (Test-Path -LiteralPath $configured)) {
                $realAo = (Resolve-Path -LiteralPath $configured).Path
            }
        }
        catch { }
    }
    return $realAo
}

function Invoke-AutonomousGateResolvedAoCliJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$AoArgs,
        [string]$FailureLabel = ''
    )

    $realAo = Get-AutonomousGateResolvedAoCommand
    $label = if ($FailureLabel) { $FailureLabel } else { "resolved ao $($AoArgs -join ' ')" }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = if ($realAo -eq 'ao') { & ao @AoArgs 2>&1 } else { & $realAo @AoArgs 2>&1 }
        if ($LASTEXITCODE -ne 0) {
            throw "$label failed (exit $LASTEXITCODE)"
        }
        $text = ($raw | ForEach-Object {
                if ($_ -is [string]) { $_ }
                elseif ($null -ne $_) { $_.ToString() }
            }) -join "`n"
        $start = $text.IndexOf('{')
        if ($start -lt 0) {
            throw "$label produced no JSON output"
        }
        return $text.Substring($start) | ConvertFrom-Json
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
}

function Get-AutonomousGateStatusSessions {
    param([switch]$IncludeTerminated)

    $aoCommand = Get-AutonomousGateResolvedAoCommand
    if ($IncludeTerminated) {
        return @(Get-WorkerStatusDecisionSessionsIncludingTerminated -AoCommand $aoCommand)
    }
    return @(Get-WorkerStatusDecisionSessions -AoCommand $aoCommand)
}

function Get-AutonomousGateSessionPrNumber {
    param([object]$Session)

    $sessionPrNumber = 0
    if ($null -ne $Session.prNumber) {
        $sessionPrNumber = [int]$Session.prNumber
    }
    elseif ($Session.pr -match 'pull/(\d+)') {
        $sessionPrNumber = [int]$Matches[1]
    }
    elseif ($Session.pr -match '^#?(\d+)$') {
        $sessionPrNumber = [int]$Matches[1]
    }
    return $sessionPrNumber
}

function Get-AutonomousGateSessionId {
    param([object]$Session)

    foreach ($key in @('name', 'id', 'sessionId')) {
        $value = [string]$Session.$key
        if ($value) {
            return $value.Trim()
        }
    }
    return ''
}

function Test-AutonomousGateSessionRoleIsWorkerLike {
    param([object]$Session)

    return [string]$Session.role -match '^(?i)(worker|coding)$'
}

function Test-AutonomousGateSessionStatusIsTerminal {
    param([object]$Session)

    return [string]$Session.status -match '^(?i)(terminated|killed|exited|dead|closed)$'
}

function Get-AutonomousClaimPrProjectPaths {
    param([string]$ProjectId = 'orchestrator-pack')

    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    $projectRoot = Join-Path (Join-Path $base 'projects') $ProjectId
    return @{
        ProjectRoot          = $projectRoot
        WorktreesDir         = Join-Path $projectRoot 'worktrees'
        OwnershipClaimsDir   = Join-Path $projectRoot 'pr-ownership-claims'
        SessionsDir          = Join-Path $projectRoot 'sessions'
    }
}

function Test-AutonomousClaimPrWorktreePathExists {
    param(
        [string]$Path,
        [string]$SessionId,
        [string]$WorktreesDir
    )

    if ($Path -and (Test-Path -LiteralPath $Path)) {
        return $true
    }
    if ($SessionId -and $WorktreesDir) {
        $defaultPath = Join-Path $WorktreesDir $SessionId
        if (Test-Path -LiteralPath $defaultPath) {
            return $true
        }
    }
    return $false
}

function Test-AutonomousClaimPrStalePrArtifacts {
    param(
        [int]$PrNumber,
        [object[]]$FixtureSessions = @(),
        [hashtable]$FixtureResidualWorktrees = @{},
        [switch]$FixtureMode,
        [string]$ProjectId = 'orchestrator-pack'
    )

    $sessions = @()
    if ($FixtureMode) {
        $sessions = @($FixtureSessions)
    }
    else {
        try {
            $sessions = @(Get-AutonomousGateStatusSessions -IncludeTerminated)
        }
        catch {
            return @{ staleArtifactPresent = $false; livenessKnown = $false }
        }
    }

    $paths = Get-AutonomousClaimPrProjectPaths -ProjectId $ProjectId
    $candidateSessionIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

    foreach ($session in $sessions) {
        if (-not (Test-AutonomousGateSessionRoleIsWorkerLike -Session $session)) { continue }
        if ((Get-AutonomousGateSessionPrNumber -Session $session) -ne $PrNumber) { continue }
        if (-not (Test-AutonomousGateSessionStatusIsTerminal -Session $session)) { continue }
        $sessionId = Get-AutonomousGateSessionId -Session $session
        if ($sessionId) {
            [void]$candidateSessionIds.Add($sessionId)
        }
    }

    if (-not $FixtureMode) {
        $claimPath = Join-Path $paths.OwnershipClaimsDir "pr-$PrNumber.json"
        if (Test-Path -LiteralPath $claimPath -PathType Leaf) {
            try {
                $claim = Get-Content -LiteralPath $claimPath -Raw | ConvertFrom-Json
                $ownerSessionId = [string]$claim.ownerSessionId
                if ($ownerSessionId) {
                    [void]$candidateSessionIds.Add($ownerSessionId)
                }
                $claimWorktree = [string]$claim.worktree
                if ($claimWorktree -and (Test-Path -LiteralPath $claimWorktree)) {
                    return @{
                        staleArtifactPresent = $true
                        livenessKnown        = $true
                        detail               = "ownership_claim_worktree=$claimWorktree"
                    }
                }
            }
            catch { }
        }
    }

    foreach ($sessionId in $candidateSessionIds) {
        $hasResidual = $false
        if ($FixtureMode) {
            $hasResidual = $FixtureResidualWorktrees.ContainsKey($sessionId) -and [bool]$FixtureResidualWorktrees[$sessionId]
        }
        else {
            $sessionWorktree = ''
            $sessionMetaPath = Join-Path $paths.SessionsDir "$sessionId.json"
            if (Test-Path -LiteralPath $sessionMetaPath -PathType Leaf) {
                try {
                    $meta = Get-Content -LiteralPath $sessionMetaPath -Raw | ConvertFrom-Json
                    $sessionWorktree = [string]$meta.worktree
                    if (-not $sessionWorktree -and $meta.runtimeHandle.data.workspacePath) {
                        $sessionWorktree = [string]$meta.runtimeHandle.data.workspacePath
                    }
                }
                catch { }
            }
            $hasResidual = Test-AutonomousClaimPrWorktreePathExists -Path $sessionWorktree -SessionId $sessionId -WorktreesDir $paths.WorktreesDir
        }
        if ($hasResidual) {
            return @{
                staleArtifactPresent = $true
                livenessKnown        = $true
                detail               = "residual_worktree_session=$sessionId"
            }
        }
    }

    return @{ staleArtifactPresent = $false; livenessKnown = $true; detail = '' }
}

function Test-AutonomousClaimPrLiveOwner {
    param(
        [int]$PrNumber,
        [object[]]$FixtureSessions = @(),
        [switch]$FixtureMode
    )

    $sessions = @()
    if ($FixtureMode) {
        $sessions = @($FixtureSessions)
    }
    else {
        try {
            $sessions = @(Get-AutonomousGateStatusSessions -IncludeTerminated)
        }
        catch {
            return @{ liveOwnerPresent = $false; livenessKnown = $false }
        }
    }

    $liveMatches = @(
        foreach ($session in $sessions) {
            $role = [string]$session.role
            if ($role -notmatch '^(?i)(worker|coding)$') { continue }
            $status = [string]$session.status
            if ($status -match '^(?i)(terminated|killed|exited|dead|closed)$') { continue }
            if ((Get-AutonomousGateSessionPrNumber -Session $session) -eq $PrNumber) {
                $session
            }
        }
    )

    if ($liveMatches.Count -gt 0) {
        return @{ liveOwnerPresent = $true; livenessKnown = $true }
    }
    return @{ liveOwnerPresent = $false; livenessKnown = $true }
}

function Test-AutonomousClaimPrResumePreconditions {
    param(
        [int]$PrNumber,
        [object[]]$FixtureSessions = @(),
        [hashtable]$FixtureResidualWorktrees = @{},
        [switch]$FixtureMode
    )

    if ($PrNumber -le 0) {
        return @{ safe = $false; reason = 'claim_pr_resume_invalid_pr' }
    }

    $mutex = Enter-AutonomousClaimPrResumeMutex -PrNumber $PrNumber
    if (-not $mutex.acquired) {
        return @{ safe = $false; reason = [string]$mutex.reason }
    }

    $owner = Test-AutonomousClaimPrLiveOwner -PrNumber $PrNumber -FixtureSessions $FixtureSessions -FixtureMode:$FixtureMode
    if ($owner.liveOwnerPresent -or -not $owner.livenessKnown) {
        Release-AutonomousClaimPrResumeMutex -Mutex $mutex
        return @{ safe = $false; reason = 'claim_pr_resume_cleanup_required' }
    }

    $stale = Test-AutonomousClaimPrStalePrArtifacts -PrNumber $PrNumber -FixtureSessions $FixtureSessions `
        -FixtureResidualWorktrees $FixtureResidualWorktrees -FixtureMode:$FixtureMode
    if (-not $stale.livenessKnown -or $stale.staleArtifactPresent) {
        Release-AutonomousClaimPrResumeMutex -Mutex $mutex
        return @{ safe = $false; reason = 'claim_pr_resume_cleanup_required' }
    }

    return @{ safe = $true; reason = 'claim_pr_resume_safe'; mutex = $mutex }
}
