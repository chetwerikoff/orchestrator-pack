#requires -Version 5.1
<#
  Cross-process single-flight claims for orchestrator→worker nudges (Issue #384).
#>

$Script:WorkerNudgeClaimDefaultStaleMinutes = 2
$Script:WorkerNudgeClaimSafeFloorMinutes = 1
$Script:WorkerNudgeClaimTerminalRetentionCount = 64
$Script:WorkerNudgeClaimMutexStaleSeconds = 5
$Script:WorkerNudgeClaimDefaultLeaseMs = 120000
$Script:WorkerNudgeClaimReportStaleMs = 30 * 60 * 1000

function Get-WorkerNudgeClaimProjectNamespace {
    param([string]$ProjectId = 'orchestrator-pack')

    $project = ([string]$ProjectId).Trim()
    if (-not $project) { $project = 'orchestrator-pack' }
    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    return (Join-Path (Join-Path (Join-Path $base 'projects') $project) 'worker-nudge-claims')
}


function Get-WorkerNudgeCanonicalClaimNamespace {
    param(
        [string]$CandidatePath,
        [string]$ProjectId = 'orchestrator-pack'
    )

    $libDir = $PSScriptRoot
    . (Join-Path $libDir 'Worker-AutonomousNudgeGate.ps1')
    $candidate = ([string]$CandidatePath).Trim()
    if (-not $candidate) {
        return (Get-WorkerNudgeClaimProjectNamespace -ProjectId $ProjectId)
    }
    try {
        $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
    }
    catch {
        $resolved = $candidate
    }
    $canonical = Invoke-WorkerNudgeFilterCli -Subcommand 'canonicalizeStorePath' -Payload @{ storePath = $resolved }
    $storeId = [string]$canonical.storeId
    if (-not $storeId) {
        return (Get-WorkerNudgeClaimProjectNamespace -ProjectId $ProjectId)
    }
    $root = Get-WorkerNudgeClaimProjectNamespace -ProjectId $ProjectId
    return (Join-Path (Join-Path $root 'by-store-id') $storeId)
}

function Resolve-WorkerNudgeClaimNamespace {
    param(
        [string]$ProjectId = 'orchestrator-pack',
        [string]$Namespace = ''
    )

    if ($Namespace) { return $Namespace }
    if ($env:AO_WORKER_NUDGE_CLAIM_DIR) {
        return (Get-WorkerNudgeCanonicalClaimNamespace -CandidatePath $env:AO_WORKER_NUDGE_CLAIM_DIR.Trim() -ProjectId $ProjectId)
    }
    return (Get-WorkerNudgeClaimProjectNamespace -ProjectId $ProjectId)
}

function Get-WorkerNudgeClaimStaleMinutes {
    param([scriptblock]$LogWriter = $null)

    $minutes = $Script:WorkerNudgeClaimDefaultStaleMinutes
    if ($env:AO_WORKER_NUDGE_CLAIM_STALE_MINUTES) {
        $parsed = 0
        if ([int]::TryParse($env:AO_WORKER_NUDGE_CLAIM_STALE_MINUTES, [ref]$parsed)) {
            $minutes = $parsed
        }
    }
    if ($minutes -lt $Script:WorkerNudgeClaimSafeFloorMinutes) {
        if ($LogWriter) {
            & $LogWriter "worker-nudge-claim: WARN stale interval ${minutes}m below safe floor $($Script:WorkerNudgeClaimSafeFloorMinutes)m; clamped"
        }
        return $Script:WorkerNudgeClaimSafeFloorMinutes
    }
    return $minutes
}

function Get-WorkerNudgeClaimLeaseMs {
    param([scriptblock]$LogWriter = $null)

    $lease = $Script:WorkerNudgeClaimDefaultLeaseMs
    if ($env:AO_WORKER_NUDGE_CLAIM_LEASE_MS) {
        $parsed = 0
        if ([int]::TryParse($env:AO_WORKER_NUDGE_CLAIM_LEASE_MS, [ref]$parsed) -and $parsed -gt 0) {
            $lease = $parsed
        }
    }
    $maxLease = $Script:WorkerNudgeClaimReportStaleMs
    if ($lease -gt $maxLease) {
        if ($LogWriter) {
            & $LogWriter "worker-nudge-claim: WARN claim lease ${lease}ms exceeds report-stale bound ${maxLease}ms; clamped"
        }
        $lease = $maxLease
    }
    return $lease
}

function ConvertTo-WorkerNudgeClaimSafeSegment {
    param([string]$Value)
    $segment = ([string]$Value).Trim()
    if (-not $segment) { return 'empty' }
    return ($segment -replace '[^\w\-.:]', '_')
}

function Get-WorkerNudgeClaimKey {
    param(
        [int]$PrNumber,
        [string]$CycleKey,
        [string]$IntentClass,
        [string]$WorkerTarget
    )
    return "pr-$PrNumber-$(ConvertTo-WorkerNudgeClaimSafeSegment $IntentClass)-$(ConvertTo-WorkerNudgeClaimSafeSegment $CycleKey)-$(ConvertTo-WorkerNudgeClaimSafeSegment $WorkerTarget)"
}

function Get-WorkerNudgeClaimPath {
    param(
        [string]$Namespace,
        [int]$PrNumber,
        [string]$CycleKey,
        [string]$IntentClass,
        [string]$WorkerTarget
    )
    $key = Get-WorkerNudgeClaimKey -PrNumber $PrNumber -CycleKey $CycleKey -IntentClass $IntentClass -WorkerTarget $WorkerTarget
    return (Join-Path $Namespace "$key.json")
}

function Get-WorkerNudgeClaimLockDir {
    param(
        [string]$Namespace,
        [int]$PrNumber,
        [string]$CycleKey,
        [string]$IntentClass,
        [string]$WorkerTarget
    )
    $key = Get-WorkerNudgeClaimKey -PrNumber $PrNumber -CycleKey $CycleKey -IntentClass $IntentClass -WorkerTarget $WorkerTarget
    return (Join-Path $Namespace ".lock-$key")
}

function Get-WorkerNudgeClaimTerminalDir {
    param([string]$Namespace)
    return (Join-Path $Namespace 'terminal')
}

function Get-WorkerNudgeClaimStorePathCanonical {
    param([string]$Path)

    if (-not $Path) { return '' }
    $resolved = [string]$Path
    try {
        if (Test-Path -LiteralPath $Path) {
            $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
        }
    }
    catch { }
    $libDir = $PSScriptRoot
    . (Join-Path $libDir 'Worker-AutonomousNudgeGate.ps1')
    $canonical = Invoke-WorkerNudgeFilterCli -Subcommand 'canonicalizeStorePath' -Payload @{ storePath = $resolved }
    return [string]$canonical.canonicalPath
}

function Test-WorkerNudgeClaimTokenIdentityFields {
    param([object]$Token)

    if (-not $Token) { return $false }
    $prNumber = 0
    if (-not [int]::TryParse([string]$Token.prNumber, [ref]$prNumber) -or $prNumber -le 0) { return $false }
    foreach ($field in @('cycleKey', 'intentClass', 'workerTarget', 'tupleKey', 'processGuid', 'claimId')) {
        if (-not [string]$Token.$field) { return $false }
    }
    if ([long]$Token.claimLeaseExpiresAtMs -le 0) { return $false }
    return $true
}

function Resolve-WorkerNudgeClaimProjectId {
    param(
        [string]$ProjectId = '',
        [string]$Namespace = ''
    )

    $explicit = ([string]$ProjectId).Trim()
    if ($explicit) { return $explicit }

    $ns = ([string]$Namespace).Trim()
    if ($ns) {
        $canonical = Get-WorkerNudgeClaimStorePathCanonical -Path $ns
        if ($canonical -match '/projects/([^/]+)/worker-nudge-claims') {
            return $matches[1]
        }
    }
    return 'orchestrator-pack'
}

function Resolve-WorkerNudgeClaimTokenProjectId {
    param([object]$Token)

    if (-not $Token) { return 'orchestrator-pack' }
    if ($Token.PSObject.Properties.Name -contains 'projectId') {
        $fromToken = ([string]$Token.projectId).Trim()
        if ($fromToken) { return $fromToken }
    }
    return 'orchestrator-pack'
}

function Add-WorkerNudgeClaimProjectId {
    param(
        [hashtable]$Result,
        [string]$ProjectId
    )

    if (-not $Result) { return $Result }
    $resolvedProjectId = Resolve-WorkerNudgeClaimProjectId -ProjectId $ProjectId -Namespace ([string]$Result.namespace)
    $Result.projectId = $resolvedProjectId
    return $Result
}

function Resolve-WorkerNudgeClaimTokenBinding {
    param(
        [object]$Token,
        [string]$ProjectId = ''
    )

    if (-not (Test-WorkerNudgeClaimTokenIdentityFields -Token $Token)) {
        return @{ ok = $false; reason = 'token_identity_incomplete' }
    }

    $tokenProjectId = Resolve-WorkerNudgeClaimTokenProjectId -Token $Token
    $overrideProjectId = ([string]$ProjectId).Trim()
    if ($overrideProjectId -and $overrideProjectId -ne $tokenProjectId) {
        return @{ ok = $false; reason = 'token_project_mismatch' }
    }

    $canonicalNamespace = Resolve-WorkerNudgeClaimNamespace -ProjectId $tokenProjectId
    $canonicalPath = Get-WorkerNudgeClaimPath -Namespace $canonicalNamespace `
        -PrNumber ([int]$Token.prNumber) -CycleKey ([string]$Token.cycleKey) `
        -IntentClass ([string]$Token.intentClass) -WorkerTarget ([string]$Token.workerTarget)

    $canonicalNamespacePath = Get-WorkerNudgeClaimStorePathCanonical -Path $canonicalNamespace
    $expectedClaimPath = Get-WorkerNudgeClaimStorePathCanonical -Path $canonicalPath
    if ($Token.PSObject.Properties.Name -contains 'namespace') {
        $tokenNamespace = [string]$Token.namespace
        if ($tokenNamespace) {
            $tokenNamespacePath = Get-WorkerNudgeClaimStorePathCanonical -Path $tokenNamespace
            if ($tokenNamespacePath -ne $canonicalNamespacePath) {
                return @{ ok = $false; reason = 'token_namespace_unbound' }
            }
        }
    }
    if ($Token.PSObject.Properties.Name -contains 'path') {
        $tokenClaimPathRaw = [string]$Token.path
        if ($tokenClaimPathRaw) {
            $tokenClaimPath = Get-WorkerNudgeClaimStorePathCanonical -Path $tokenClaimPathRaw
            if ($tokenClaimPath -ne $expectedClaimPath) {
                return @{ ok = $false; reason = 'token_path_unbound' }
            }
        }
    }

    return @{
        ok        = $true
        namespace = $canonicalNamespace
        path      = $canonicalPath
        projectId = $tokenProjectId
    }
}

function Test-WorkerNudgeClaimTokenMatchesRecord {
    param(
        [object]$Token,
        [object]$Record
    )

    if ([int]$Record.prNumber -ne [int]$Token.prNumber) { return 'token_pr_mismatch' }
    if ([string]$Record.cycleKey -ne [string]$Token.cycleKey) { return 'token_cycle_mismatch' }
    if ([string]$Record.intentClass -ne [string]$Token.intentClass) { return 'token_intent_mismatch' }
    if ([string]$Record.workerTarget -ne [string]$Token.workerTarget) { return 'token_worker_target_mismatch' }
    if ([string]$Record.tupleKey -ne [string]$Token.tupleKey) { return 'token_tuple_mismatch' }
    if ([string]$Record.holder.processGuid -ne [string]$Token.processGuid) { return 'token_holder_mismatch' }
    if ([string]$Record.tokenNonce -and [string]$Token.claimId -and [string]$Record.tokenNonce -ne [string]$Token.claimId) {
        return 'token_claim_mismatch'
    }
    if ([long]$Record.claimLeaseExpiresAtMs -ne [long]$Token.claimLeaseExpiresAtMs) {
        return 'token_lease_mismatch'
    }
    return $null
}


function Get-WorkerNudgeClaimMutexOwnerPath {
    param([string]$LockDir)
    return (Join-Path $LockDir 'owner.json')
}

function New-WorkerNudgeClaimHolder {
    param([string]$Surface = 'unknown')
    return @{
        processGuid = [guid]::NewGuid().ToString('n')
        pid         = $PID
        surface     = $Surface
        host        = [System.Environment]::MachineName
    }
}


function Write-WorkerNudgeClaimMutexOwnerExclusive {
    param([string]$LockDir)
    if (-not (Test-Path -LiteralPath $LockDir)) {
        try {
            New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
        }
        catch {
            if (-not (Test-Path -LiteralPath $LockDir)) { return $false }
        }
    }
    $ownerPath = Get-WorkerNudgeClaimMutexOwnerPath -LockDir $LockDir
    $record = @{
        pid           = $PID
        acquiredAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
    $json = ($record | ConvertTo-Json -Compress -Depth 5)
    try {
        $stream = [System.IO.File]::Open($ownerPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $stream.Write($bytes, 0, $bytes.Length)
        }
        finally {
            $stream.Dispose()
        }
        return $true
    }
    catch [System.IO.IOException] {
        $existing = Read-WorkerNudgeClaimMutexOwner -LockDir $LockDir
        if ($existing -and [int]$existing.pid -eq $PID) { return $true }
        return $false
    }
}

function Write-WorkerNudgeClaimMutexOwner {
    param([string]$LockDir, [object]$Record)
    if (-not (Test-Path -LiteralPath $LockDir)) {
        New-Item -ItemType Directory -Path $LockDir -Force | Out-Null
    }
    $ownerPath = Get-WorkerNudgeClaimMutexOwnerPath -LockDir $LockDir
    ($Record | ConvertTo-Json -Compress -Depth 10) | Set-Content -LiteralPath $ownerPath -Encoding UTF8
}

function Read-WorkerNudgeClaimMutexOwner {
    param([string]$LockDir)
    $ownerPath = Get-WorkerNudgeClaimMutexOwnerPath -LockDir $LockDir
    if (-not (Test-Path -LiteralPath $ownerPath)) { return $null }
    try {
        return (Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Test-WorkerNudgeClaimProcessAlive {
    param([int]$CandidatePid)
    if ($CandidatePid -le 0) { return $false }
    try {
        $proc = Get-Process -Id $CandidatePid -ErrorAction Stop
        return $null -ne $proc -and -not $proc.HasExited
    }
    catch {
        return $false
    }
}

function Test-WorkerNudgeClaimMutexAbandoned {
    param([string]$LockDir)
    if (-not (Test-Path -LiteralPath $LockDir)) { return $false }
    $owner = Read-WorkerNudgeClaimMutexOwner -LockDir $LockDir
    if (-not $owner) {
        try {
            $dirInfo = Get-Item -LiteralPath $LockDir -Force
            $ageSeconds = ((Get-Date).ToUniversalTime() - $dirInfo.CreationTimeUtc).TotalSeconds
            if ($ageSeconds -lt $Script:WorkerNudgeClaimMutexStaleSeconds) {
                return $false
            }
        }
        catch { }
        return $true
    }
    return -not (Test-WorkerNudgeClaimProcessAlive -CandidatePid ([int]$owner.pid))
}

function Recover-WorkerNudgeClaimMutex {
    param([string]$LockDir)
    if (Test-Path -LiteralPath $LockDir) {
        Remove-Item -LiteralPath $LockDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Enter-WorkerNudgeClaimMutex {
    param([string]$LockDir)
    for ($attempt = 0; $attempt -lt 24; $attempt++) {
        if (Write-WorkerNudgeClaimMutexOwnerExclusive -LockDir $LockDir) {
            return $true
        }
        if (Test-WorkerNudgeClaimMutexAbandoned -LockDir $LockDir) {
            Recover-WorkerNudgeClaimMutex -LockDir $LockDir
            continue
        }
        Start-Sleep -Milliseconds (50 * ($attempt + 1))
    }
    return $false
}

function Exit-WorkerNudgeClaimMutex {
    param([string]$LockDir)
    if (Test-Path -LiteralPath $LockDir) {
        Remove-Item -LiteralPath $LockDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Initialize-WorkerNudgeClaimNamespace {
    param([string]$Namespace)
    if (-not (Test-Path -LiteralPath $Namespace)) {
        New-Item -ItemType Directory -Path $Namespace -Force | Out-Null
    }
    $terminal = Get-WorkerNudgeClaimTerminalDir -Namespace $Namespace
    if (-not (Test-Path -LiteralPath $terminal)) {
        New-Item -ItemType Directory -Path $terminal -Force | Out-Null
    }
}

function Read-WorkerNudgeClaimRecord {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @{ ok = $false; reason = 'missing' }
    }
    try {
        $record = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        $acquiredAtUtc = [datetime]::MinValue
        if ($record.acquiredAtUtc) {
            [void][datetime]::TryParse([string]$record.acquiredAtUtc, [ref]$acquiredAtUtc)
        }
        return @{ ok = $true; record = $record; acquiredAtUtc = $acquiredAtUtc }
    }
    catch {
        return @{ ok = $false; reason = 'unparseable' }
    }
}

function ConvertTo-WorkerNudgeClaimRecordHashtable {
    param([object]$Record)

    if ($Record -is [hashtable]) {
        return @{} + $Record
    }

    $ht = @{}
    foreach ($prop in $Record.PSObject.Properties) {
        $ht[$prop.Name] = $prop.Value
    }
    return $ht
}

function Write-WorkerNudgeClaimAtomic {
    param(
        [string]$Path,
        [object]$Record,
        [switch]$AllowOverwrite
    )

    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $tmp = Join-Path $dir ".$([guid]::NewGuid().ToString('n')).tmp"
    ($Record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $tmp -Encoding UTF8
    try {
        if ($AllowOverwrite -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
            Remove-Item -LiteralPath $Path -Force
        }
        [System.IO.File]::Move($tmp, $Path)
    }
    catch {
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        if (-not $AllowOverwrite -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
            throw [System.IO.IOException]::new("claim already exists: $Path")
        }
        throw
    }
}

function Find-WorkerNudgeClaimTerminalRecord {
    param(
        [string]$Namespace,
        [string]$Key,
        [string]$TupleKey = ''
    )

    $terminalDir = Get-WorkerNudgeClaimTerminalDir -Namespace $Namespace
    if (-not (Test-Path -LiteralPath $terminalDir)) {
        return $null
    }

    foreach ($file in Get-ChildItem -LiteralPath $terminalDir -File -Filter '*.json' | Sort-Object LastWriteTimeUtc -Descending) {
        try {
            $record = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            $phase = if ($record.phase) { [string]$record.phase } else { [string]$record.state }
            # FAILED_DEFINITIVE is retryable; only SENT/UNCERTAIN suppress reacquire.
            if ($phase -notin @('SENT', 'UNCERTAIN')) {
                continue
            }
            if ([string]$record.key -eq $Key) {
                return @{ record = $record; path = $file.FullName; phase = $phase }
            }
            if ($TupleKey -and [string]$record.tupleKey -eq $TupleKey) {
                return @{ record = $record; path = $file.FullName; phase = $phase }
            }
        }
        catch {
            continue
        }
    }

    return $null
}

function New-WorkerNudgeClaimActiveRecord {
    param(
        [int]$PrNumber,
        [string]$CycleKey,
        [string]$IntentClass,
        [string]$WorkerTarget,
        [string]$SessionId,
        [string]$TargetId,
        [string]$TargetGeneration,
        [string]$Surface,
        [string]$TupleKey
    )
    $leaseMs = Get-WorkerNudgeClaimLeaseMs
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $key = Get-WorkerNudgeClaimKey -PrNumber $PrNumber -CycleKey $CycleKey -IntentClass $IntentClass -WorkerTarget $WorkerTarget
    return @{
        schemaVersion         = 1
        key                   = $key
        tupleKey              = $TupleKey
        prNumber              = $PrNumber
        cycleKey              = $CycleKey
        intentClass           = $IntentClass
        workerTarget          = $WorkerTarget
        sessionId             = $SessionId
        targetId              = $TargetId
        targetGeneration      = $TargetGeneration
        phase                 = 'CLAIMED'
        state                 = 'CLAIMED'
        holder                = New-WorkerNudgeClaimHolder -Surface $Surface
        acquiredAtUtc         = (Get-Date).ToUniversalTime().ToString('o')
        claimLeaseExpiresAtMs = $nowMs + $leaseMs
        tokenNonce            = [guid]::NewGuid().ToString('n')
    }
}

function Test-WorkerNudgeClaimHolderOwnsPath {
    param([string]$Path, [object]$Holder)
    $read = Read-WorkerNudgeClaimRecord -Path $Path
    if (-not $read.ok) { return $false }
    return ([string]$read.record.holder.processGuid -eq [string]$Holder.processGuid)
}

function Move-WorkerNudgeClaimToTerminal {
    param(
        [string]$Namespace,
        [string]$ActivePath,
        [object]$Record,
        [string]$Outcome,
        [hashtable]$Extra = @{}
    )
    $terminalDir = Get-WorkerNudgeClaimTerminalDir -Namespace $Namespace
    $terminalPath = Join-Path $terminalDir "$($Record.key)-$Outcome-$([guid]::NewGuid().ToString('n')).json"
    $terminal = @{ }
    foreach ($prop in $Record.PSObject.Properties) {
        $terminal[$prop.Name] = $prop.Value
    }
    foreach ($key in $Extra.Keys) {
        $terminal[$key] = $Extra[$key]
    }
    $terminal.phase = $Outcome
    $terminal.state = $Outcome
    $terminal.finalizedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    ($terminal | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $terminalPath -Encoding UTF8
    if (Test-Path -LiteralPath $ActivePath) {
        Remove-Item -LiteralPath $ActivePath -Force
    }
    return $terminalPath
}

function New-WorkerNudgeClaimToken {
    param([hashtable]$ClaimResult)
    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return '' }
    $claim = $ClaimResult.claim
    $projectId = Resolve-WorkerNudgeClaimProjectId -ProjectId ([string]$ClaimResult.projectId) -Namespace ([string]$ClaimResult.namespace)
    $payload = @{
        v                     = 1
        projectId             = $projectId
        claimId               = [string]$claim.tokenNonce
        prNumber              = [int]$claim.prNumber
        cycleKey              = [string]$claim.cycleKey
        intentClass           = [string]$claim.intentClass
        workerTarget          = [string]$claim.workerTarget
        sessionId             = [string]$claim.sessionId
        tupleKey              = [string]$claim.tupleKey
        phase                 = [string]$claim.phase
        processGuid           = [string]$claim.holder.processGuid
        claimLeaseExpiresAtMs = [long]$claim.claimLeaseExpiresAtMs
    }
    $json = $payload | ConvertTo-Json -Compress -Depth 10
    return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
}

function ConvertFrom-WorkerNudgeClaimToken {
    param([string]$ClaimToken)
    if (-not $ClaimToken) { return $null }
    try {
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ClaimToken))
        return ($json | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Test-ValidateWorkerNudgeClaimToken {
    param(
        [string]$ClaimToken,
        [ValidateSet('preflight', 'send', 'finalize')]
        [string]$Stage = 'preflight'
    )

    $token = ConvertFrom-WorkerNudgeClaimToken -ClaimToken $ClaimToken
    if (-not $token) {
        return @{ ok = $false; reason = 'token_malformed' }
    }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($nowMs -gt [long]$token.claimLeaseExpiresAtMs) {
        return @{ ok = $false; reason = 'token_expired' }
    }
    $binding = Resolve-WorkerNudgeClaimTokenBinding -Token $token
    if (-not $binding.ok) {
        return @{ ok = $false; reason = [string]$binding.reason }
    }
    $path = [string]$binding.path
    $read = Read-WorkerNudgeClaimRecord -Path $path
    if (-not $read.ok) {
        return @{ ok = $false; reason = 'claim_missing' }
    }
    $recordMismatch = Test-WorkerNudgeClaimTokenMatchesRecord -Token $token -Record $read.record
    if ($recordMismatch) {
        return @{ ok = $false; reason = $recordMismatch }
    }
    if ($Stage -eq 'send' -and [string]$read.record.phase -ne 'CLAIMED') {
        $reason = if ([string]$read.record.phase -eq 'SEND_ATTEMPTED') { 'token_replayed' } else { 'token_phase_invalid' }
        return @{ ok = $false; reason = $reason }
    }
    if ($Stage -eq 'finalize' -and [string]$read.record.phase -notin @('CLAIMED', 'SEND_ATTEMPTED')) {
        return @{ ok = $false; reason = 'token_phase_invalid' }
    }
    return @{
        ok        = $true
        token     = $token
        claim     = $read.record
        path      = $path
        namespace = [string]$binding.namespace
        projectId = [string]$binding.projectId
    }
}

function Resolve-WorkerNudgeClaimAgainstExisting {
    param(
        [string]$Namespace,
        [string]$Path,
        [object]$Existing,
        [double]$StaleMinutes,
        [string]$Surface,
        [hashtable]$NewRecord
    )

    $phase = [string]$Existing.record.phase
    if ($phase -in @('SENT', 'UNCERTAIN')) {
        return @{ acquired = $false; reason = 'already_served'; claim = $Existing.record; path = $Path; namespace = $Namespace; key = $Existing.record.key }
    }

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $leaseExpired = ($phase -eq 'CLAIMED' -and [long]$Existing.record.claimLeaseExpiresAtMs -le $nowMs)
    if ($phase -eq 'CLAIMED' -and -not $leaseExpired) {
        return @{ acquired = $false; reason = 'claimed'; holder = $Existing.record.holder; claim = $Existing.record; path = $Path; namespace = $Namespace; key = $Existing.record.key }
    }

    if ($phase -eq 'SEND_ATTEMPTED') {
        $terminalPath = Move-WorkerNudgeClaimToTerminal -Namespace $Namespace -ActivePath $Path -Record $Existing.record -Outcome 'UNCERTAIN' -Extra @{ recoveredBy = New-WorkerNudgeClaimHolder -Surface $Surface }
        return @{ acquired = $false; reason = 'uncertain_prior'; terminalPath = $terminalPath; namespace = $Namespace; key = $Existing.record.key }
    }

    $age = ((Get-Date).ToUniversalTime() - $Existing.acquiredAtUtc).TotalMinutes
    if (-not $leaseExpired -and $age -lt $StaleMinutes -and $phase -eq 'CLAIMED') {
        return @{ acquired = $false; reason = 'claimed'; holder = $Existing.record.holder; claim = $Existing.record; path = $Path; namespace = $Namespace; key = $Existing.record.key }
    }

    $outcome = if ($phase -eq 'FAILED_DEFINITIVE') { 'released_stale' } else { 'recovered_stale' }
    Move-WorkerNudgeClaimToTerminal -Namespace $Namespace -ActivePath $Path -Record $Existing.record -Outcome $outcome -Extra @{ recoveredBy = New-WorkerNudgeClaimHolder -Surface $Surface } | Out-Null
    Write-WorkerNudgeClaimAtomic -Path $Path -Record $NewRecord
    if (-not (Test-WorkerNudgeClaimHolderOwnsPath -Path $Path -Holder $NewRecord.holder)) {
        return @{ acquired = $false; reason = 'lost_race'; path = $Path; namespace = $Namespace; key = $NewRecord.key }
    }
    Clear-WorkerNudgeClaimStoreHealth -Namespace $Namespace | Out-Null
    return @{ acquired = $true; recovered = $true; claim = $NewRecord; path = $Path; namespace = $Namespace; key = $NewRecord.key }
}

function Acquire-WorkerNudgeClaim {
    param(
        [int]$PrNumber,
        [string]$CycleKey,
        [string]$IntentClass,
        [string]$WorkerTarget,
        [string]$SessionId,
        [string]$TargetId = '',
        [string]$TargetGeneration = '',
        [string]$TupleKey = '',
        [string]$Surface = 'unknown',
        [string]$Namespace = '',
        [string]$ProjectId = 'orchestrator-pack',
        [string]$Message = '',
        [scriptblock]$LogWriter = $null
    )

    try {
        $resolved = Resolve-WorkerNudgeClaimNamespace -ProjectId $ProjectId -Namespace $Namespace
        Initialize-WorkerNudgeClaimNamespace -Namespace $resolved
        if (-not $TargetId) { $TargetId = $SessionId }
        if (-not $TargetGeneration) { $TargetGeneration = $TargetId }
        if (-not $TupleKey) {
            $TupleKey = "$PrNumber|$CycleKey|$IntentClass|$WorkerTarget"
        }
        $path = Get-WorkerNudgeClaimPath -Namespace $resolved -PrNumber $PrNumber -CycleKey $CycleKey -IntentClass $IntentClass -WorkerTarget $WorkerTarget
        $lockDir = Get-WorkerNudgeClaimLockDir -Namespace $resolved -PrNumber $PrNumber -CycleKey $CycleKey -IntentClass $IntentClass -WorkerTarget $WorkerTarget
        $staleMinutes = Get-WorkerNudgeClaimStaleMinutes -LogWriter $LogWriter
        $key = Get-WorkerNudgeClaimKey -PrNumber $PrNumber -CycleKey $CycleKey -IntentClass $IntentClass -WorkerTarget $WorkerTarget

        if (-not (Enter-WorkerNudgeClaimMutex -LockDir $lockDir)) {
            return (Add-WorkerNudgeClaimProjectId -Result @{ acquired = $false; reason = 'mutex_contended'; path = $path; namespace = $resolved; key = $key } -ProjectId $ProjectId)
        }

        try {
            $record = New-WorkerNudgeClaimActiveRecord -PrNumber $PrNumber -CycleKey $CycleKey -IntentClass $IntentClass `
                -WorkerTarget $WorkerTarget -SessionId $SessionId -TargetId $TargetId -TargetGeneration $TargetGeneration `
                -Surface $Surface -TupleKey $TupleKey
            $existing = Read-WorkerNudgeClaimRecord -Path $path
            if ($existing.ok) {
                return (Add-WorkerNudgeClaimProjectId -Result (Resolve-WorkerNudgeClaimAgainstExisting -Namespace $resolved -Path $path -Existing $existing `
                    -StaleMinutes $staleMinutes -Surface $Surface -NewRecord $record) -ProjectId $ProjectId)
            }
            if ($existing.reason -ne 'missing') {
                return @{ acquired = $false; reason = 'ambiguous_claim'; detail = $existing.reason; path = $path; namespace = $resolved; key = $key }
            }

            $terminalHit = Find-WorkerNudgeClaimTerminalRecord -Namespace $resolved -Key $key -TupleKey $TupleKey
            if ($terminalHit) {
                $terminalPhase = [string]$terminalHit.phase
                if ($terminalPhase -in @('SENT', 'UNCERTAIN')) {
                    if (Test-WorkerNudgeTerminalContentDiffers -TerminalHit $terminalHit -Message $Message) {
                        return @{
                            acquired   = $false
                            reason     = 'materially_new_content'
                            escalate   = $true
                            diagnosis  = '[worker-nudge-gate] ESCALATION: tuple already served but incoming message content differs; tuple remains suppressed.'
                            claim      = $terminalHit.record
                            path       = $terminalHit.path
                            namespace  = $resolved
                            key        = $key
                            terminal   = $true
                            phase      = $terminalPhase
                        }
                    }
                    return @{
                        acquired  = $false
                        reason    = 'already_served'
                        claim     = $terminalHit.record
                        path      = $terminalHit.path
                        namespace = $resolved
                        key       = $key
                        terminal  = $true
                        phase     = $terminalPhase
                    }
                }
            }

            Write-WorkerNudgeClaimAtomic -Path $path -Record $record
            if (-not (Test-WorkerNudgeClaimHolderOwnsPath -Path $path -Holder $record.holder)) {
                return @{ acquired = $false; reason = 'lost_race'; path = $path; namespace = $resolved; key = $key }
            }
            Clear-WorkerNudgeClaimStoreHealth -Namespace $resolved | Out-Null
            return (Add-WorkerNudgeClaimProjectId -Result @{ acquired = $true; recovered = $false; claim = $record; path = $path; namespace = $resolved; key = $record.key } -ProjectId $ProjectId)
        }
        catch [System.IO.IOException] {
            $existing = Read-WorkerNudgeClaimRecord -Path $path
            if (-not $existing.ok) {
                return @{ acquired = $false; reason = 'ambiguous_claim'; detail = $existing.reason; path = $path; namespace = $resolved; key = $key }
            }
            return (Add-WorkerNudgeClaimProjectId -Result (Resolve-WorkerNudgeClaimAgainstExisting -Namespace $resolved -Path $path -Existing $existing `
                -StaleMinutes $staleMinutes -Surface $Surface -NewRecord $record) -ProjectId $ProjectId)
        }
        finally {
            Exit-WorkerNudgeClaimMutex -LockDir $lockDir
        }
    }
    catch {
        return @{ acquired = $false; reason = 'storage_failure'; detail = [string]$_; namespace = $Namespace }
    }
}

function Set-WorkerNudgeClaimMessageContentHash {
    param(
        [hashtable]$ClaimResult,
        [string]$MessageContentHash
    )

    if (-not $ClaimResult -or -not $ClaimResult.path -or -not $MessageContentHash) {
        return @{ ok = $false; reason = 'missing_args' }
    }
    $lockDir = Get-WorkerNudgeClaimLockDir -Namespace $ClaimResult.namespace `
        -PrNumber ([int]$ClaimResult.claim.prNumber) -CycleKey ([string]$ClaimResult.claim.cycleKey) `
        -IntentClass ([string]$ClaimResult.claim.intentClass) -WorkerTarget ([string]$ClaimResult.claim.workerTarget)
    if (-not (Enter-WorkerNudgeClaimMutex -LockDir $lockDir)) {
        return @{ ok = $false; reason = 'mutex_contended' }
    }
    try {
        $read = Read-WorkerNudgeClaimRecord -Path $ClaimResult.path
        if (-not $read.ok) { return @{ ok = $false; reason = 'claim_missing' } }
        if ([string]$read.record.holder.processGuid -ne [string]$ClaimResult.claim.holder.processGuid) {
            return @{ ok = $false; reason = 'lost_ownership' }
        }
        if ([string]$read.record.phase -ne 'CLAIMED') {
            return @{ ok = $false; reason = 'token_phase_invalid' }
        }
        $record = ConvertTo-WorkerNudgeClaimRecordHashtable -Record $read.record
        $record.messageContentHash = $MessageContentHash
        Write-WorkerNudgeClaimAtomic -Path $ClaimResult.path -Record $record -AllowOverwrite
        if (-not (Test-WorkerNudgeClaimHolderOwnsPath -Path $ClaimResult.path -Holder $record.holder)) {
            return @{ ok = $false; reason = 'lost_race' }
        }
        $ClaimResult.claim = $record
        return @{ ok = $true; messageContentHash = $MessageContentHash }
    }
    finally {
        Exit-WorkerNudgeClaimMutex -LockDir $lockDir
    }
}

function Set-WorkerNudgeClaimSendAttempted {
    param([hashtable]$ClaimResult)
    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return @{ ok = $false; reason = 'no_claim' } }
    $lockDir = Get-WorkerNudgeClaimLockDir -Namespace $ClaimResult.namespace `
        -PrNumber ([int]$ClaimResult.claim.prNumber) -CycleKey ([string]$ClaimResult.claim.cycleKey) `
        -IntentClass ([string]$ClaimResult.claim.intentClass) -WorkerTarget ([string]$ClaimResult.claim.workerTarget)
    if (-not (Enter-WorkerNudgeClaimMutex -LockDir $lockDir)) {
        return @{ ok = $false; reason = 'mutex_contended' }
    }
    try {
        $read = Read-WorkerNudgeClaimRecord -Path $ClaimResult.path
        if (-not $read.ok) { return @{ ok = $false; reason = 'claim_missing' } }
        if ([string]$read.record.holder.processGuid -ne [string]$ClaimResult.claim.holder.processGuid) {
            return @{ ok = $false; reason = 'lost_ownership' }
        }
        if ([string]$read.record.phase -ne 'CLAIMED') {
            $reason = if ([string]$read.record.phase -eq 'SEND_ATTEMPTED') { 'token_replayed' } else { 'token_phase_invalid' }
            return @{ ok = $false; reason = $reason }
        }
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ([long]$read.record.claimLeaseExpiresAtMs -le $nowMs) {
            return @{ ok = $false; reason = 'claim_lease_expired' }
        }
        $record = ConvertTo-WorkerNudgeClaimRecordHashtable -Record $read.record
        $record.phase = 'SEND_ATTEMPTED'
        $record.state = 'SEND_ATTEMPTED'
        $record.sendAttemptedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        Write-WorkerNudgeClaimAtomic -Path $ClaimResult.path -Record $record -AllowOverwrite
        if (-not (Test-WorkerNudgeClaimHolderOwnsPath -Path $ClaimResult.path -Holder $record.holder)) {
            return @{ ok = $false; reason = 'lost_race' }
        }
        $ClaimResult.claim = $record
        return @{ ok = $true; phase = 'SEND_ATTEMPTED' }
    }
    finally {
        Exit-WorkerNudgeClaimMutex -LockDir $lockDir
    }
}


function Release-WorkerNudgeActiveClaim {
    param([hashtable]$ClaimResult)

    if (-not $ClaimResult -or -not $ClaimResult.path) {
        return @{ ok = $false; reason = 'no_claim' }
    }
    $lockDir = Get-WorkerNudgeClaimLockDir -Namespace $ClaimResult.namespace -PrNumber ([int]$ClaimResult.claim.prNumber) `
        -CycleKey ([string]$ClaimResult.claim.cycleKey) -IntentClass ([string]$ClaimResult.claim.intentClass) `
        -WorkerTarget ([string]$ClaimResult.claim.workerTarget)
    if (-not (Enter-WorkerNudgeClaimMutex -LockDir $lockDir)) {
        return @{ ok = $false; reason = 'busy' }
    }
    try {
        $read = Read-WorkerNudgeClaimRecord -Path $ClaimResult.path
        if (-not $read.ok) {
            return @{ ok = $true; reason = 'already_released' }
        }
        if ($ClaimResult.claim -and [string]$read.record.holder.processGuid -ne [string]$ClaimResult.claim.holder.processGuid) {
            return @{ ok = $false; reason = 'lost_ownership' }
        }
        if (Test-Path -LiteralPath $ClaimResult.path) {
            Remove-Item -LiteralPath $ClaimResult.path -Force
        }
        return @{ ok = $true; reason = 'released' }
    }
    finally {
        Exit-WorkerNudgeClaimMutex -LockDir $lockDir
    }
}

function Test-WorkerNudgeTerminalContentDiffers {
    param(
        [string]$Namespace,
        [hashtable]$TerminalHit,
        [string]$Message = ''
    )

    if (-not $TerminalHit -or -not $Message) {
        return $false
    }
    $record = $TerminalHit.record
    if (-not $record) { return $false }
    $hashResult = Invoke-WorkerNudgeFilterCli -Subcommand 'hashMessageContent' -Payload @{ message = $Message }
    $incomingHash = [string]$hashResult.messageContentHash
    $servedHash = [string]$record.messageContentHash
    if (-not $incomingHash -or -not $servedHash) { return $false }
    return ($incomingHash -ne $servedHash)
}

function Finalize-WorkerNudgeClaim {
    param(
        [hashtable]$ClaimResult,
        [ValidateSet('SENT', 'FAILED_DEFINITIVE', 'UNCERTAIN')]
        [string]$Outcome,
        [hashtable]$Extra = @{}
    )

    if (-not $ClaimResult -or -not $ClaimResult.path) {
        return @{ ok = $false; reason = 'no_claim' }
    }
    $lockDir = Get-WorkerNudgeClaimLockDir -Namespace $ClaimResult.namespace -PrNumber ([int]$ClaimResult.claim.prNumber) `
        -CycleKey ([string]$ClaimResult.claim.cycleKey) -IntentClass ([string]$ClaimResult.claim.intentClass) `
        -WorkerTarget ([string]$ClaimResult.claim.workerTarget)
    if (-not (Enter-WorkerNudgeClaimMutex -LockDir $lockDir)) {
        return @{ ok = $false; reason = 'busy' }
    }
    try {
        $read = Read-WorkerNudgeClaimRecord -Path $ClaimResult.path
        if (-not $read.ok) {
            return @{ ok = $false; reason = 'claim_missing' }
        }
        if ($ClaimResult.claim -and [string]$read.record.holder.processGuid -ne [string]$ClaimResult.claim.holder.processGuid) {
            return @{ ok = $false; reason = 'lost_ownership' }
        }
        $terminalPath = Move-WorkerNudgeClaimToTerminal -Namespace $ClaimResult.namespace -ActivePath $ClaimResult.path `
            -Record $read.record -Outcome $Outcome -Extra $Extra
        return @{ ok = $true; outcome = $Outcome; terminalPath = $terminalPath }
    }
    finally {
        Exit-WorkerNudgeClaimMutex -LockDir $lockDir
    }
}


function Get-WorkerNudgeClaimStoreHealthPath {
    param([string]$Namespace)
    return (Join-Path $Namespace '_health/unresolved-claim-store.json')
}

function Read-WorkerNudgeClaimStoreHealth {
    param([string]$Namespace)
    $path = Get-WorkerNudgeClaimStoreHealthPath -Namespace $Namespace
    if (-not (Test-Path -LiteralPath $path)) {
        return @{ ok = $true; unresolvedCount = 0; unresolvedSinceMs = 0 }
    }
    try {
        $raw = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        return @{
            ok                = $true
            unresolvedCount   = if ($null -ne $raw.unresolvedCount) { [int]$raw.unresolvedCount } else { 0 }
            unresolvedSinceMs = if ($null -ne $raw.unresolvedSinceMs) { [long]$raw.unresolvedSinceMs } else { 0 }
            lastReason        = if ($null -ne $raw.lastReason) { [string]$raw.lastReason } else { '' }
        }
    }
    catch {
        return @{ ok = $false; unresolvedCount = 0; unresolvedSinceMs = 0; reason = 'health_unreadable' }
    }
}

function Write-WorkerNudgeClaimStoreHealth {
    param(
        [string]$Namespace,
        [int]$UnresolvedCount,
        [long]$UnresolvedSinceMs,
        [string]$LastReason = ''
    )
    $path = Get-WorkerNudgeClaimStoreHealthPath -Namespace $Namespace
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    @{
        unresolvedCount   = $UnresolvedCount
        unresolvedSinceMs = $UnresolvedSinceMs
        lastReason        = $LastReason
        updatedAtUtc      = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $path -Encoding UTF8
}

function Clear-WorkerNudgeClaimStoreHealth {
    param([string]$Namespace)
    $path = Get-WorkerNudgeClaimStoreHealthPath -Namespace $Namespace
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
    }
}

function Invoke-WorkerNudgeClaimStoreFailure {
    param(
        [string]$Namespace,
        [string]$FailureReason,
        [int]$PrNumber = 0,
        [string]$CycleKey = '',
        [string]$Surface = 'unknown'
    )
    $libDir = $PSScriptRoot
    . (Join-Path $libDir 'Worker-AutonomousNudgeGate.ps1')
    . (Join-Path $libDir 'Worker-NudgeAudit.ps1')

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $health = Read-WorkerNudgeClaimStoreHealth -Namespace $Namespace
    $sinceMs = if ([long]$health.unresolvedSinceMs -gt 0) { [long]$health.unresolvedSinceMs } else { $nowMs }
    $eval = Invoke-WorkerNudgeFilterCli -Subcommand 'evaluateClaimStoreFailure' -Payload @{
        unresolvedCount   = [int]$health.unresolvedCount
        unresolvedSinceMs = $sinceMs
        nowMs             = $nowMs
        failureReason     = $FailureReason
    }
    Write-WorkerNudgeClaimStoreHealth -Namespace $Namespace `
        -UnresolvedCount ([int]$eval.unresolvedCount) `
        -UnresolvedSinceMs $sinceMs `
        -LastReason $FailureReason | Out-Null

    $audit = @{
        kind             = 'claim_store_failure'
        decision         = 'SUPPRESS'
        reason           = [string]$eval.reason
        failureReason    = $FailureReason
        unresolvedCount  = [int]$eval.unresolvedCount
        escalate         = [bool]$eval.escalate
        prNumber         = $PrNumber
        cycleKey         = $CycleKey
        surface          = $Surface
        atUtc            = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-WorkerNudgeGateAudit -Record $audit | Out-Null
    if ($eval.escalate -and $eval.diagnosis) {
        [Console]::Error.WriteLine([string]$eval.diagnosis)
    }
    return @{
        escalate        = [bool]$eval.escalate
        reason          = [string]$eval.reason
        unresolvedCount = [int]$eval.unresolvedCount
        diagnosis       = [string]$eval.diagnosis
    }
}

function Get-WorkerNudgeClaimRecordsForGate {
    param([string]$Namespace)
    $records = @()
    if (-not (Test-Path -LiteralPath $Namespace)) { return $records }
    foreach ($file in Get-ChildItem -LiteralPath $Namespace -File -Filter '*.json') {
        $read = Read-WorkerNudgeClaimRecord -Path $file.FullName
        if ($read.ok) { $records += $read.record }
    }
    $terminal = Get-WorkerNudgeClaimTerminalDir -Namespace $Namespace
    if (Test-Path -LiteralPath $terminal) {
        foreach ($file in Get-ChildItem -LiteralPath $terminal -File -Filter '*.json' | Select-Object -Last 64) {
            try {
                $records += (Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json)
            }
            catch { }
        }
    }
    return $records
}



function Get-WorkerPrOwnershipClaimStorePath {
    param(
        [string]$ProjectId = 'orchestrator-pack',
        [int]$PrNumber
    )
    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    $dir = Join-Path (Join-Path (Join-Path $base 'projects') $ProjectId) 'pr-ownership-claims'
    return (Join-Path $dir "pr-$PrNumber.json")
}

function Get-WorkerPrOwnershipSessionsDir {
    param([string]$ProjectId = 'orchestrator-pack')
    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    return (Join-Path (Join-Path (Join-Path $base 'projects') $ProjectId) 'sessions')
}

function Read-WorkerPrOwnershipClaimRecord {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Write-WorkerPrOwnershipClaimRecord {
    param(
        [string]$Path,
        [object]$Record
    )
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    ($Record | ConvertTo-Json -Compress -Depth 8) | Set-Content -LiteralPath $Path -Encoding UTF8
}


function Test-WorkerNudgeSessionPrFieldMatches {
    param(
        [string]$PrField,
        [int]$PrNumber
    )

    $field = [string]$PrField
    if (-not $field -or $PrNumber -le 0) {
        return $false
    }
    if ($field -match 'pull/(\d+)') {
        return ([int]$Matches[1] -eq $PrNumber)
    }
    return ($field -eq [string]$PrNumber)
}

function Resolve-WorkerNudgeTargetFromPrClaim {
    param(
        [int]$PrNumber,
        [string]$SessionId,
        [string]$HeadSha = '',
        [string]$ProjectId = 'orchestrator-pack',
        [object[]]$Sessions = @(),
        [object[]]$OpenPrs = @(),
        [string]$SessionsDir = ''
    )

    $libDir = $PSScriptRoot
    . (Join-Path $libDir 'Invoke-AoCliJson.ps1')
    . (Join-Path $libDir 'Worker-AutonomousNudgeGate.ps1')

    if (-not $Sessions -or $Sessions.Count -eq 0) {
        $Sessions = @(Get-AoStatusSessions)
    }
    if (-not $SessionsDir) {
        $SessionsDir = Get-WorkerPrOwnershipSessionsDir -ProjectId $ProjectId
    }

    $ownerResolve = Invoke-WorkerNudgeFilterCli -Subcommand 'resolvePrOwnerSession' -Payload @{
        prNumber  = $PrNumber
        sessionId = $SessionId
        headSha   = $HeadSha
        sessions  = @($Sessions)
        openPrs   = @($OpenPrs)
    }
    if (-not $ownerResolve.ok) {
        return @{ ok = $false; reason = [string]$ownerResolve.reason }
    }
    $ownerSessionId = [string]$ownerResolve.ownerSessionId
    if (-not $ownerSessionId) {
        return @{ ok = $false; reason = 'pr_owner_unresolved' }
    }

    $worktree = ''
    $sessionMeta = @{}
    $metaPath = Join-Path $SessionsDir "$ownerSessionId.json"
    if (Test-Path -LiteralPath $metaPath) {
        try {
            $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
            $worktree = [string]$meta.worktree
            if (-not $worktree -and $meta.runtimeHandle -and $meta.runtimeHandle.data) {
                $worktree = [string]$meta.runtimeHandle.data.workspacePath
            }
            if ($meta.restoredAt) { $sessionMeta.restoredAt = [string]$meta.restoredAt }
            if ($meta.resumedAt) { $sessionMeta.resumedAt = [string]$meta.resumedAt }
            if ($meta.parentSessionId) { $sessionMeta.parentSessionId = [string]$meta.parentSessionId }
            if ($meta.parent_session_id) { $sessionMeta.parent_session_id = [string]$meta.parent_session_id }
            if ($meta.resumedFromSessionId) { $sessionMeta.resumedFromSessionId = [string]$meta.resumedFromSessionId }
            if ($meta.resumedFrom) { $sessionMeta.resumedFrom = [string]$meta.resumedFrom }
        }
        catch { }
    }

    $storePath = Get-WorkerPrOwnershipClaimStorePath -ProjectId $ProjectId -PrNumber $PrNumber
    $existing = Read-WorkerPrOwnershipClaimRecord -Path $storePath
    $resumeLineage = $false
    if ($existing) {
        $resumeEval = Invoke-WorkerNudgeFilterCli -Subcommand 'inferResumeLineage' -Payload @{
            ownerSessionId = $ownerSessionId
            worktree       = $worktree
            existingClaim  = $existing
            sessionMeta    = $sessionMeta
        }
        $resumeLineage = [bool]$resumeEval.resumeLineage
    }
    $syncPayload = @{
        prNumber        = $PrNumber
        ownerSessionId  = $ownerSessionId
        worktree        = $worktree
        existingClaim   = $existing
    }
    if ($resumeLineage) {
        $syncPayload.resumeLineage = $true
    }
    $sync = Invoke-WorkerNudgeFilterCli -Subcommand 'syncPrOwnershipClaim' -Payload $syncPayload
    if (-not $sync.ok) {
        return @{ ok = $false; reason = [string]$sync.reason }
    }
    if ($sync.changed) {
        Write-WorkerPrOwnershipClaimRecord -Path $storePath -Record $sync.record
    }

    return Invoke-WorkerNudgeFilterCli -Subcommand 'resolveWorkerTarget' -Payload @{
        prNumber   = $PrNumber
        sessionId  = $SessionId
        headSha    = $HeadSha
        sessions   = @($Sessions)
        prClaims   = @($sync.record)
        claimRecord = $sync.record
    }
}

function Invoke-ConsumeWorkerNudgeClaimTokenForSend {
    param(
        [string]$ClaimToken,
        [string]$SendSessionId = ''
    )

    $token = ConvertFrom-WorkerNudgeClaimToken -ClaimToken $ClaimToken
    if (-not $token) {
        return @{ ok = $false; reason = 'token_malformed' }
    }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($nowMs -gt [long]$token.claimLeaseExpiresAtMs) {
        return @{ ok = $false; reason = 'token_expired' }
    }
    $binding = Resolve-WorkerNudgeClaimTokenBinding -Token $token
    if (-not $binding.ok) {
        return @{ ok = $false; reason = [string]$binding.reason }
    }
    $path = [string]$binding.path
    $namespace = [string]$binding.namespace

    $read = Read-WorkerNudgeClaimRecord -Path $path
    if (-not $read.ok) {
        return @{ ok = $false; reason = 'claim_missing' }
    }
    $recordMismatch = Test-WorkerNudgeClaimTokenMatchesRecord -Token $token -Record $read.record
    if ($recordMismatch) {
        return @{ ok = $false; reason = $recordMismatch }
    }
    if ($SendSessionId) {
        $expectedSessionId = [string]$read.record.sessionId
        if (-not $expectedSessionId) {
            $expectedSessionId = [string]$token.sessionId
        }
        if ($expectedSessionId -and $expectedSessionId -ne [string]$SendSessionId) {
            return @{ ok = $false; reason = 'token_send_session_mismatch' }
        }
    }
    $lockDir = Get-WorkerNudgeClaimLockDir -Namespace $namespace `
        -PrNumber ([int]$token.prNumber) -CycleKey ([string]$token.cycleKey) `
        -IntentClass ([string]$token.intentClass) -WorkerTarget ([string]$token.workerTarget)
    if (-not (Enter-WorkerNudgeClaimMutex -LockDir $lockDir)) {
        return @{ ok = $false; reason = 'mutex_contended' }
    }
    try {
        $read = Read-WorkerNudgeClaimRecord -Path $path
        if (-not $read.ok) {
            return @{ ok = $false; reason = 'claim_missing' }
        }
        $recordMismatch = Test-WorkerNudgeClaimTokenMatchesRecord -Token $token -Record $read.record
        if ($recordMismatch) {
            return @{ ok = $false; reason = $recordMismatch }
        }
        if ($SendSessionId) {
            $expectedSessionId = [string]$read.record.sessionId
            if (-not $expectedSessionId) {
                $expectedSessionId = [string]$token.sessionId
            }
            if ($expectedSessionId -and $expectedSessionId -ne [string]$SendSessionId) {
                return @{ ok = $false; reason = 'token_send_session_mismatch' }
            }
        }
        if ([string]$read.record.phase -ne 'CLAIMED') {
            $reason = if ([string]$read.record.phase -eq 'SEND_ATTEMPTED') { 'token_replayed' } else { 'token_phase_invalid' }
            return @{ ok = $false; reason = $reason }
        }
        $record = ConvertTo-WorkerNudgeClaimRecordHashtable -Record $read.record
        $record.phase = 'SEND_ATTEMPTED'
        $record.state = 'SEND_ATTEMPTED'
        $record.sendAttemptedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        Write-WorkerNudgeClaimAtomic -Path $path -Record $record -AllowOverwrite
        if (-not (Test-WorkerNudgeClaimHolderOwnsPath -Path $path -Holder $record.holder)) {
            return @{ ok = $false; reason = 'lost_race' }
        }
        $claimResult = @{
            acquired   = $true
            claim      = $record
            path       = $path
            namespace  = $namespace
            projectId  = [string]$binding.projectId
        }
        return @{ ok = $true; token = $token; claim = $record; path = $path; claimResult = $claimResult }
    }
    finally {
        Exit-WorkerNudgeClaimMutex -LockDir $lockDir
    }
}

function Resolve-WorkerNudgeClaimTokenFromPayload {
    param([hashtable]$ClaimResult)
    return (New-WorkerNudgeClaimToken -ClaimResult $ClaimResult)
}
