#requires -Version 5.1

. (Join-Path $PSScriptRoot 'Invoke-OrchestratorEscalationEmit.ps1')
<#
  Cross-process single-flight claims for automated ao-review run starters.

  The active claim file is created with an atomic File.Move(temp, active) so a
  complete JSON record becomes visible in one step. Lifecycle changes that can
  race (stale recovery / terminalization) are serialized with a per-key lock
  directory created via New-Item -ItemType Directory.
#>

$Script:ReviewStartClaimDefaultStaleMinutes = 10
$Script:ReviewStartClaimSafeFloorMinutes = 2
$Script:ReviewStartClaimTerminalRetentionCount = 64
$Script:ReviewStartClaimMutexStaleSeconds = 5
$Script:ReviewStartClaimCoveredRunStatuses = @('queued', 'preparing', 'running', 'reviewing', 'up_to_date', 'commented', 'changes_requested')
$Script:ReviewStartClaimInFlightRunStatuses = @('queued', 'preparing', 'running', 'reviewing')
$Script:ReviewStartClaimTerminalFailureRunStatuses = @('failed', 'cancelled')

function ConvertTo-ReviewStartClaimNormalizedRunStatus {
    param(
        [object]$Run,
        [string]$Status = ''
    )

    $raw = if ($Status) {
        [string]$Status
    }
    elseif ($null -ne $Run) {
        if ($null -ne $Run.prReviewStatus) { [string]$Run.prReviewStatus } else { [string]$Run.status }
    }
    else {
        ''
    }
    $status = $raw.Trim().ToLowerInvariant()
    switch ($status) {
        'clean' { return 'up_to_date' }
        { $_ -eq ('needs_' + 'triage') } { return 'changes_requested' }
        'waiting_update' { return 'changes_requested' }
        'triage' { return 'changes_requested' }
        'reviewing' { return 'running' }
        'sent_to_agent' { return 'changes_requested' }
        default { return $status }
    }
}

function Test-ReviewStartClaimStatusInFlight {
    param([string]$Status)

    return ($Status -in $Script:ReviewStartClaimInFlightRunStatuses)
}


function Get-ReviewStartClaimProjectNamespace {
    param([string]$ProjectId = 'orchestrator-pack')

    $project = ([string]$ProjectId).Trim()
    if (-not $project) { $project = 'orchestrator-pack' }
    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    return (Join-Path (Join-Path (Join-Path $base 'projects') $project) 'review-start-claims')
}

function Resolve-ReviewStartClaimNamespace {
    param(
        [string]$ProjectId = 'orchestrator-pack',
        [string]$Namespace = ''
    )

    if ($Namespace) {
        return $Namespace
    }
    if ($env:AO_REVIEW_CLAIM_DIR) {
        return $env:AO_REVIEW_CLAIM_DIR.Trim()
    }
    return (Get-ReviewStartClaimProjectNamespace -ProjectId $ProjectId)
}

function Get-ReviewStartClaimStaleMinutes {
    param([scriptblock]$LogWriter = $null)

    $minutes = $Script:ReviewStartClaimDefaultStaleMinutes
    if ($env:AO_REVIEW_CLAIM_STALE_MINUTES) {
        $parsed = 0
        if ([int]::TryParse($env:AO_REVIEW_CLAIM_STALE_MINUTES, [ref]$parsed)) {
            $minutes = $parsed
        }
    }
    if ($minutes -lt $Script:ReviewStartClaimSafeFloorMinutes) {
        if ($LogWriter) {
            & $LogWriter "review-start-claim: WARN stale interval ${minutes}m below safe floor $($Script:ReviewStartClaimSafeFloorMinutes)m; clamped"
        }
        return $Script:ReviewStartClaimSafeFloorMinutes
    }
    return $minutes
}

function ConvertTo-ReviewStartClaimHeadSha {
    param([string]$HeadSha)
    $normalized = ([string]$HeadSha).Trim().ToLowerInvariant()
    if ($normalized -notmatch '^[0-9a-f]{40}$') {
        throw "ambiguous head SHA for review-start claim: '$HeadSha' (expected full 40-hex SHA)"
    }
    return $normalized
}

function Get-ReviewStartClaimKey {
    param([int]$PrNumber, [string]$HeadSha)
    return "pr-$PrNumber-$((ConvertTo-ReviewStartClaimHeadSha -HeadSha $HeadSha))"
}

function Get-ReviewStartClaimPath {
    param([string]$Namespace, [int]$PrNumber, [string]$HeadSha)
    return (Join-Path $Namespace "$((Get-ReviewStartClaimKey -PrNumber $PrNumber -HeadSha $HeadSha)).json")
}

function Get-ReviewStartClaimLockDir {
    param([string]$Namespace, [int]$PrNumber, [string]$HeadSha)
    return (Join-Path (Join-Path $Namespace '.locks') (Get-ReviewStartClaimKey -PrNumber $PrNumber -HeadSha $HeadSha))
}

function Get-ReviewStartClaimTerminalDir {
    param([string]$Namespace)
    return (Join-Path $Namespace 'terminal')
}

function Get-ReviewStartClaimMutexOwnerPath {
    param([string]$LockDir)
    return (Join-Path $LockDir 'owner.json')
}

function Get-ReviewStartClaimTerminalRetentionCount {
    $count = $Script:ReviewStartClaimTerminalRetentionCount
    if ($env:AO_REVIEW_CLAIM_TERMINAL_COUNT) {
        $parsed = 0
        if ([int]::TryParse($env:AO_REVIEW_CLAIM_TERMINAL_COUNT, [ref]$parsed)) {
            $count = $parsed
        }
    }
    if ($count -lt 1) { return 1 }
    return $count
}

function Prune-ReviewStartClaimTerminalRecords {
    param([string]$Namespace)

    $limit = Get-ReviewStartClaimTerminalRetentionCount
    $terminalDir = Get-ReviewStartClaimTerminalDir -Namespace $Namespace
    $records = @(Get-ChildItem -LiteralPath $terminalDir -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
    if ($records.Count -le $limit) { return }

    foreach ($file in @($records[$limit..($records.Count - 1)])) {
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    }
}

function Get-ReviewStartClaimMutexStaleSeconds {
    $seconds = $Script:ReviewStartClaimMutexStaleSeconds
    if ($env:AO_REVIEW_CLAIM_MUTEX_STALE_SECONDS) {
        $parsed = 0
        if ([int]::TryParse($env:AO_REVIEW_CLAIM_MUTEX_STALE_SECONDS, [ref]$parsed)) {
            $seconds = $parsed
        }
    }
    if ($seconds -lt 1) { return 1 }
    return $seconds
}

function New-ReviewStartClaimHolder {
    param([string]$Surface)
    $hostName = try { [System.Net.Dns]::GetHostName() } catch { 'unknown-host' }
    $generation = if ($env:AO_CHILD_GENERATION) { $env:AO_CHILD_GENERATION } elseif ($env:AO_SESSION_ID) { $env:AO_SESSION_ID } else { '' }
    $holder = @{
        surface     = $Surface
        pid         = $PID
        host        = $hostName
        generation  = $generation
        processGuid = [guid]::NewGuid().ToString('n')
    }
    if ($IsLinux) {
        . (Join-Path $PSScriptRoot 'Review-RunLiveness.ps1')
        $startTicks = Get-ReviewRecoveryProcessStartTicks -ProcessId $PID
        $bootHash = Get-ReviewRecoveryBootIdHash
        if ($startTicks) { $holder.startTimeTicks = $startTicks }
        if ($bootHash) { $holder.bootIdHash = $bootHash }
    }
    return $holder
}

function Format-ReviewStartClaimHolder {
    param([object]$Holder)
    if (-not $Holder) { return '<unknown-holder>' }
    $parts = @()
    foreach ($name in @('surface', 'pid', 'host', 'generation', 'processGuid')) {
        if ($null -ne $Holder.$name -and [string]$Holder.$name) {
            $parts += "$name=$($Holder.$name)"
        }
    }
    return ($parts -join ',')
}

function New-ReviewStartClaimMutexOwnerRecord {
    param([string]$LockDir)
    $hostName = try { [System.Net.Dns]::GetHostName() } catch { 'unknown-host' }
    return @{
        pid          = $PID
        host         = $hostName
        processGuid  = [guid]::NewGuid().ToString('n')
        acquiredAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        lockDir      = $LockDir
    }
}

function Write-ReviewStartClaimMutexOwner {
    param(
        [string]$LockDir,
        [hashtable]$Owner
    )
    $ownerPath = Get-ReviewStartClaimMutexOwnerPath -LockDir $LockDir
    $tmp = Join-Path $LockDir ".$([guid]::NewGuid().ToString('n')).tmp"
    ($Owner | ConvertTo-Json -Compress -Depth 10) | Set-Content -LiteralPath $tmp -Encoding UTF8
    try {
        [System.IO.File]::Move($tmp, $ownerPath, $false)
    }
    catch [System.Management.Automation.MethodException] {
        [System.IO.File]::Move($tmp, $ownerPath)
    }
}

function Read-ReviewStartClaimMutexOwner {
    param([string]$LockDir)
    $ownerPath = Get-ReviewStartClaimMutexOwnerPath -LockDir $LockDir
    try {
        if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf)) {
            return @{ ok = $false; reason = 'missing' }
        }
        $raw = Get-Content -LiteralPath $ownerPath -Raw -ErrorAction Stop
        if (-not $raw -or -not $raw.Trim()) { return @{ ok = $false; reason = 'empty' } }
        $record = $raw | ConvertFrom-Json -ErrorAction Stop
        foreach ($required in @('pid', 'host', 'processGuid', 'acquiredAtUtc')) {
            if ($null -eq $record.$required -or -not [string]$record.$required) {
                return @{ ok = $false; reason = "missing_$required" }
            }
        }
        $acquired = $null
        try { $acquired = [datetimeoffset]::Parse([string]$record.acquiredAtUtc).UtcDateTime } catch { return @{ ok = $false; reason = 'bad_timestamp' } }
        return @{ ok = $true; record = $record; acquiredAtUtc = $acquired }
    }
    catch {
        return @{ ok = $false; reason = 'unreadable'; error = [string]$_ }
    }
}

function Test-ReviewStartClaimProcessAlive {
    param([object]$Owner)
    try {
        $pid = [int]$Owner.pid
        if ($pid -le 0) { return $false }
        $process = Get-Process -Id $pid -ErrorAction Stop
        return [bool]$process
    }
    catch {
        return $false
    }
}

function Test-ReviewStartClaimMutexAbandoned {
    param([string]$LockDir)

    if (-not (Test-Path -LiteralPath $LockDir -PathType Container)) {
        return $false
    }
    $owner = Read-ReviewStartClaimMutexOwner -LockDir $LockDir
    if ($owner.ok) {
        if (Test-ReviewStartClaimProcessAlive -Owner $owner.record) {
            return $false
        }
        return $true
    }

    if (-not (Test-Path -LiteralPath $LockDir -PathType Container)) {
        return $false
    }
    try {
        $item = Get-Item -LiteralPath $LockDir -ErrorAction Stop
        $ageSeconds = ((Get-Date).ToUniversalTime() - $item.LastWriteTimeUtc).TotalSeconds
        return ($ageSeconds -ge (Get-ReviewStartClaimMutexStaleSeconds))
    }
    catch {
        return $false
    }
}

function Recover-ReviewStartClaimMutex {
    param([string]$LockDir)

    if (-not (Test-ReviewStartClaimMutexAbandoned -LockDir $LockDir)) {
        return $false
    }
    Remove-Item -LiteralPath $LockDir -Recurse -Force -ErrorAction SilentlyContinue
    return -not (Test-Path -LiteralPath $LockDir -PathType Container)
}

function Initialize-ReviewStartClaimNamespace {
    param([string]$Namespace)
    if (-not $Namespace) { throw 'review-start claim namespace is empty' }
    New-Item -ItemType Directory -Path $Namespace -Force -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $Namespace '.locks') -Force -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path (Get-ReviewStartClaimTerminalDir -Namespace $Namespace) -Force -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $Namespace 'audit') -Force -ErrorAction Stop | Out-Null
}

function Read-ReviewStartClaimRecord {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @{ ok = $false; reason = 'missing' } }
        $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
        if (-not $raw -or -not $raw.Trim()) { return @{ ok = $false; reason = 'empty' } }
        $record = $raw | ConvertFrom-Json -ErrorAction Stop
        foreach ($required in @('schemaVersion', 'key', 'prNumber', 'headSha', 'holder', 'acquiredAtUtc', 'state')) {
            if ($null -eq $record.$required -or -not [string]$record.$required) {
                return @{ ok = $false; reason = "missing_$required" }
            }
        }
        if ([string]$record.headSha -ne (ConvertTo-ReviewStartClaimHeadSha -HeadSha ([string]$record.headSha))) {
            return @{ ok = $false; reason = 'bad_head_sha' }
        }
        $acquired = $null
        try { $acquired = [datetimeoffset]::Parse([string]$record.acquiredAtUtc).UtcDateTime } catch { return @{ ok = $false; reason = 'bad_timestamp' } }
        if ($acquired -gt (Get-Date).ToUniversalTime().AddMinutes(1)) {
            return @{ ok = $false; reason = 'future_timestamp' }
        }
        return @{ ok = $true; record = $record; acquiredAtUtc = $acquired }
    }
    catch {
        return @{ ok = $false; reason = 'unreadable'; error = [string]$_ }
    }
}

function Test-ReviewStartClaimRecordSameGeneration {
    param(
        [object]$Expected,
        [object]$Actual
    )
    if (-not $Expected -or -not $Actual) { return $false }
    return (
        ([string]$Expected.holder.processGuid -eq [string]$Actual.holder.processGuid) -and
        ([string]$Expected.acquiredAtUtc -eq [string]$Actual.acquiredAtUtc)
    )
}

function Test-ReviewStartClaimRunMatchesKey {
    param(
        [object]$Run,
        [int]$PrNumber,
        [string]$NormalizedHeadSha
    )

    if ($null -eq $Run) { return $false }
    $runPr = 0
    if (-not [int]::TryParse([string]$Run.prNumber, [ref]$runPr)) { return $false }
    if ($runPr -ne $PrNumber) { return $false }
    $target = ([string]$Run.targetSha).Trim().ToLowerInvariant()
    return ($target -eq $NormalizedHeadSha)
}

function Test-ReviewStartClaimRunIsCovering {
    param([object]$Run)

    $latestRaw = [string]$Run.latestRunStatus
    if (-not [string]::IsNullOrWhiteSpace($latestRaw)) {
        $latestStatus = ConvertTo-ReviewStartClaimNormalizedRunStatus -Status $latestRaw.Trim()
        if ($latestStatus -in $Script:ReviewStartClaimTerminalFailureRunStatuses) {
            return $false
        }
        if (Test-ReviewStartClaimStatusInFlight -Status $latestStatus) {
            return $true
        }
    }

    $status = ConvertTo-ReviewStartClaimNormalizedRunStatus -Run $Run
    if ($status -in @('ineligible', 'outdated')) {
        return $false
    }
    if ($status -in $Script:ReviewStartClaimTerminalFailureRunStatuses) {
        return $false
    }
    if (Test-ReviewStartClaimStatusInFlight -Status $status) {
        return $true
    }

    return ($status -in $Script:ReviewStartClaimCoveredRunStatuses)
}

function Test-ReviewStartClaimRunVisible {
    param([array]$ReviewRuns, [int]$PrNumber, [string]$HeadSha)
    $normalized = ConvertTo-ReviewStartClaimHeadSha -HeadSha $HeadSha
    foreach ($run in @($ReviewRuns)) {
        if (-not (Test-ReviewStartClaimRunMatchesKey -Run $run -PrNumber $PrNumber -NormalizedHeadSha $normalized)) { continue }
        if (Test-ReviewStartClaimRunIsCovering -Run $run) {
            return $true
        }
    }
    return $false
}

function Test-ReviewStartClaimRetryEligible {
    param([array]$ReviewRuns, [int]$PrNumber, [string]$HeadSha)
    return -not (Test-ReviewStartClaimRunVisible -ReviewRuns $ReviewRuns -PrNumber $PrNumber -HeadSha $HeadSha)
}

function Enter-ReviewStartClaimMutexWithRetry {
    param(
        [string]$LockDir,
        [int]$MaxAttempts = 120,
        [int]$SleepMs = 25
    )

    for ($attempt = 0; $attempt -lt $MaxAttempts; $attempt++) {
        if (Enter-ReviewStartClaimMutex -LockDir $LockDir) {
            return $true
        }
        Start-Sleep -Milliseconds $SleepMs
    }
    return $false
}

function Get-ReviewStartClaimContendedResult {
    param(
        [string]$Path,
        [string]$Namespace,
        [string]$Key,
        [int]$MaxAttempts = 400
    )

    for ($attempt = 0; $attempt -lt $MaxAttempts; $attempt++) {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $existing = Read-ReviewStartClaimRecord -Path $Path
            if ($existing.ok) {
                return @{ acquired = $false; reason = 'claimed'; holder = $existing.record.holder; claim = $existing.record; path = $Path; namespace = $Namespace; key = $existing.record.key }
            }
        }
        Start-Sleep -Milliseconds 25
    }
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Read-ReviewStartClaimRecord -Path $Path
        if ($existing.ok) {
            return @{ acquired = $false; reason = 'claimed'; holder = $existing.record.holder; claim = $existing.record; path = $Path; namespace = $Namespace; key = $existing.record.key }
        }
    }
    return @{ acquired = $false; reason = 'claimed'; path = $Path; namespace = $Namespace; key = $Key }
}

function Get-ReviewStartClaimRunCreatedAtUtc {
    param([object]$Run)

    foreach ($field in @('createdAt', 'createdAtUtc', 'startedAt')) {
        $raw = [string]$Run.$field
        if (-not $raw) { continue }
        try {
            return [datetimeoffset]::Parse($raw).UtcDateTime
        }
        catch {
            continue
        }
    }
    return [datetime]::MinValue
}

function Get-ReviewStartClaimVisibleRunId {
    param([array]$ReviewRuns, [int]$PrNumber, [string]$HeadSha)

    if (-not (Test-ReviewStartClaimRunVisible -ReviewRuns $ReviewRuns -PrNumber $PrNumber -HeadSha $HeadSha)) {
        return $null
    }
    $normalized = ConvertTo-ReviewStartClaimHeadSha -HeadSha $HeadSha
    $bestInFlightId = $null
    $bestInFlightCreated = [datetime]::MinValue
    $bestTerminalId = $null
    $bestTerminalCreated = [datetime]::MinValue
    $index = 0
    foreach ($run in @($ReviewRuns)) {
        $index++
        if (-not (Test-ReviewStartClaimRunMatchesKey -Run $run -PrNumber $PrNumber -NormalizedHeadSha $normalized)) { continue }
        if (-not (Test-ReviewStartClaimRunIsCovering -Run $run)) { continue }
        $runId = [string]$run.id
        if (-not $runId) { $runId = [string]$run.runId }
        if (-not $runId) { continue }
        $status = ConvertTo-ReviewStartClaimNormalizedRunStatus -Run $run
        $created = Get-ReviewStartClaimRunCreatedAtUtc -Run $run
        if ($created -eq [datetime]::MinValue) { $created = [datetime]::MinValue.AddSeconds($index) }
        if ($status -in $Script:ReviewStartClaimInFlightRunStatuses) {
            if ($null -eq $bestInFlightId -or $created -ge $bestInFlightCreated) {
                $bestInFlightId = $runId
                $bestInFlightCreated = $created
            }
            continue
        }
        if ($null -eq $bestTerminalId -or $created -ge $bestTerminalCreated) {
            $bestTerminalId = $runId
            $bestTerminalCreated = $created
        }
    }
    if ($bestInFlightId) { return $bestInFlightId }
    return $bestTerminalId
}

function Test-ReviewStartClaimMatchesTerminalizedRun {
    param(
        [object]$ClaimRecord,
        [string]$RunId,
        [string]$RunCreatedAtUtc = ''
    )

    $bound = [string]$ClaimRecord.boundRunId
    if ($bound) {
        return ($bound -eq $RunId)
    }
    if (-not $RunCreatedAtUtc) {
        return $false
    }
    try {
        $acquired = [datetimeoffset]::Parse([string]$ClaimRecord.acquiredAtUtc).UtcDateTime
        $created = [datetimeoffset]::Parse($RunCreatedAtUtc).UtcDateTime
        return ($acquired -le $created)
    }
    catch {
        return $false
    }
}

function Bind-ReviewStartClaimToVisibleRun {
    param(
        [hashtable]$ClaimResult,
        [array]$ReviewRuns = @()
    )

    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return @{ ok = $false; reason = 'no_claim' } }
    $runId = Get-ReviewStartClaimVisibleRunId -ReviewRuns $ReviewRuns -PrNumber ([int]$ClaimResult.claim.prNumber) -HeadSha ([string]$ClaimResult.claim.headSha)
    if (-not $runId) { return @{ ok = $false; reason = 'no_visible_run' } }

    $lockDir = Get-ReviewStartClaimLockDir -Namespace $ClaimResult.namespace -PrNumber ([int]$ClaimResult.claim.prNumber) -HeadSha ([string]$ClaimResult.claim.headSha)
    if (-not (Enter-ReviewStartClaimMutex -LockDir $lockDir)) { return @{ ok = $false; reason = 'busy' } }
    try {
        $read = Read-ReviewStartClaimRecord -Path $ClaimResult.path
        if (-not $read.ok) { return @{ ok = $false; reason = 'ambiguous_claim'; detail = $read.reason } }
        if ([string]$read.record.holder.processGuid -ne [string]$ClaimResult.claim.holder.processGuid) {
            return @{ ok = $false; reason = 'lost_ownership'; holder = $read.record.holder }
        }
        if ([string]$read.record.boundRunId -and [string]$read.record.boundRunId -ne $runId) {
            return @{ ok = $false; reason = 'bound_to_other_run'; boundRunId = [string]$read.record.boundRunId }
        }
        $record = @{}
        $read.record.PSObject.Properties | ForEach-Object { $record[$_.Name] = $_.Value }
        $record.boundRunId = $runId
        ($record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $ClaimResult.path -Encoding UTF8
        $ClaimResult.claim.boundRunId = $runId
        return @{ ok = $true; boundRunId = $runId }
    }
    finally {
        Exit-ReviewStartClaimMutex -LockDir $lockDir
    }
}

function Enter-ReviewStartClaimMutex {
    param([string]$LockDir)
    try {
        New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
        Write-ReviewStartClaimMutexOwner -LockDir $LockDir -Owner (New-ReviewStartClaimMutexOwnerRecord -LockDir $LockDir)
        return $true
    }
    catch {
        if (Recover-ReviewStartClaimMutex -LockDir $LockDir) {
            try {
                New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
                Write-ReviewStartClaimMutexOwner -LockDir $LockDir -Owner (New-ReviewStartClaimMutexOwnerRecord -LockDir $LockDir)
                return $true
            }
            catch {
                return $false
            }
        }
        return $false
    }
}

function Exit-ReviewStartClaimMutex {
    param([string]$LockDir)
    if ($LockDir -and (Test-Path -LiteralPath $LockDir -PathType Container)) {
        Remove-Item -LiteralPath $LockDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Move-ReviewStartClaimToTerminal {
    param(
        [string]$Namespace,
        [string]$ActivePath,
        [object]$Record,
        [string]$Outcome,
        [hashtable]$Extra = @{}
    )
    $terminal = @{}
    if ($Record) {
        $Record.PSObject.Properties | ForEach-Object { $terminal[$_.Name] = $_.Value }
    }
    $terminal.state = 'terminal'
    $terminal.outcome = $Outcome
    $terminal.terminalAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    foreach ($key in $Extra.Keys) { $terminal[$key] = $Extra[$key] }
    $name = "$(Split-Path -Leaf $ActivePath).$($Outcome).$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).json"
    $target = Join-Path (Get-ReviewStartClaimTerminalDir -Namespace $Namespace) $name
    ($terminal | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $target -Encoding UTF8
    Prune-ReviewStartClaimTerminalRecords -Namespace $Namespace
    try {
        . (Join-Path $PSScriptRoot 'Review-StartEnvelopeLedger.ps1')
        Sync-ReviewStartEnvelopeLedgerFromTerminal -Namespace $Namespace -ActivePath $ActivePath -Record $Record `
            -Outcome $Outcome -Extra $Extra | Out-Null
    }
    catch {
        Write-Warning "review-start-envelope-ledger sync failed for outcome=${Outcome}: $_"
    }
    Remove-Item -LiteralPath $ActivePath -Force -ErrorAction SilentlyContinue
    return $target
}

function Get-ReviewStartClaimPriorFirstAttemptMonotonicMs {
    param([object]$Record)
    if (-not $Record) { return 0 }
    $raw = $Record.firstAttemptAtMonotonicMs
    if ($null -eq $raw -or $raw -eq '') {
        $raw = $Record.readinessStartMonotonicMs
    }
    if ($null -eq $raw -or $raw -eq '') { return 0 }
    $parsed = 0L
    if ([int64]::TryParse([string]$raw, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
    return 0
}


function Test-ReviewStartClaimTerminalOutcomeRetryEligible {
    param([string]$Outcome)
    $eligible = @{
        recovered_stale                 = $true
        recovered_orphan_liveness       = $true
        released_for_retry              = $true
        released_after_run_terminalized = $true
        aborted_by_recheck              = $true
        hold_budget_exceeded            = $true
        readiness_envelope_exceeded     = $true
        operator_resolved_rearmed         = $true
    }
    return $eligible.ContainsKey($Outcome) -and $eligible[$Outcome]
}

function Get-ReviewStartClaimPriorFirstAttemptFromRetryEligibleTerminals {
    param(
        [string]$Namespace,
        [string]$Key
    )
    $terminalDir = Get-ReviewStartClaimTerminalDir -Namespace $Namespace
    if (-not (Test-Path -LiteralPath $terminalDir)) { return 0 }
    $bestMono = 0L
    $bestAt = [DateTime]::MinValue
    Get-ChildItem -LiteralPath $terminalDir -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
        $read = Read-ReviewStartClaimRecord -Path $_.FullName
        if (-not $read.ok) { return }
        if ([string]$read.record.key -ne $Key) { return }
        $outcome = [string]$read.record.outcome
        if (-not (Test-ReviewStartClaimTerminalOutcomeRetryEligible -Outcome $outcome)) { return }
        $mono = Get-ReviewStartClaimPriorFirstAttemptMonotonicMs -Record $read.record
        if ($mono -le 0) { return }
        $terminalAt = [DateTime]::MinValue
        if ($read.record.terminalAtUtc) {
            [void][DateTime]::TryParse([string]$read.record.terminalAtUtc, [ref]$terminalAt)
        }
        if ($terminalAt -gt $bestAt -or ($terminalAt -eq $bestAt -and $mono -gt $bestMono)) {
            $bestAt = $terminalAt
            $bestMono = $mono
        }
    }
    return $bestMono
}

function New-ReviewStartClaimActiveRecord {
    param(
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$Surface,
        [string]$Reason = '',
        [object]$RecoveredFrom = $null,
        [int64]$PriorFirstAttemptMonotonicMs = 0
    )
    $normalized = ConvertTo-ReviewStartClaimHeadSha -HeadSha $HeadSha
    $mono = $null
    if ([string]$env:AO_REVIEW_START_MONOTONIC_NOW_MS) {
        $parsed = 0L
        if ([int64]::TryParse([string]$env:AO_REVIEW_START_MONOTONIC_NOW_MS, [ref]$parsed)) { $mono = $parsed }
    }
    if ($null -eq $mono) {
        . (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
        $cli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-start-envelope-external-io.mjs'
        $mono = [int64](Invoke-MechanicalNodeFilterCli -FilterCliPath $cli -Subcommand 'monotonic-now' -Payload @{} -Label 'review-start-claim-acquire' -JsonDepth 5).nowMonotonicMs
    }
    $firstAttemptMono = if ($PriorFirstAttemptMonotonicMs -gt 0) { $PriorFirstAttemptMonotonicMs } else { $mono }
    return @{
        schemaVersion               = 1
        key                         = "pr-$PrNumber-$normalized"
        prNumber                    = $PrNumber
        headSha                     = $normalized
        state                       = 'active'
        holder                      = New-ReviewStartClaimHolder -Surface $Surface
        acquiredAtUtc               = (Get-Date).ToUniversalTime().ToString('o')
        startReason                 = $Reason
        recoveredFrom               = $RecoveredFrom
        firstAttemptAtMonotonicMs   = $firstAttemptMono
        readinessStartMonotonicMs   = $mono
    }
}

function Test-ReviewStartClaimHolderOwnsPath {
    param(
        [string]$Path,
        [object]$Holder
    )

    $read = Read-ReviewStartClaimRecord -Path $Path
    if (-not $read.ok) { return $false }
    return ([string]$read.record.holder.processGuid -eq [string]$Holder.processGuid)
}

function Get-ReviewStartClaimLostRaceResult {
    param(
        [string]$Path,
        [string]$Namespace,
        [string]$Key,
        [int]$PrNumber = 0,
        [string]$HeadSha = ''
    )

    if ($PrNumber -le 0 -and $Key -match '^pr-(\d+)-(.+)$') {
        $PrNumber = [int]$Matches[1]
        $HeadSha = [string]$Matches[2]
    }

    $contended = Get-ReviewStartClaimContendedResult -Path $Path -Namespace $Namespace -Key $Key -MaxAttempts 20
    if ($contended.holder) {
        return $contended
    }
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Read-ReviewStartClaimRecord -Path $Path
        if ($existing.ok) {
            return @{
                acquired  = $false
                reason    = 'claimed'
                holder    = $existing.record.holder
                claim     = $existing.record
                path      = $Path
                namespace = $Namespace
                key       = $existing.record.key
            }
        }
    }
    $corr = "corr:review-start-claim:${PrNumber}:${HeadSha}"
    $dedupe = "dedupe:review-start-claim:${PrNumber}:${HeadSha}"
    try {
        Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-review-start-claim' `
            -SourceProcess 'review-start-claim-reaper' -CorrelationKey $corr -DedupeKey $dedupe `
            -Diagnosis @{ prNumber = $PrNumber; headSha = $HeadSha; reason = 'lost_race_without_active_record' } | Out-Null
    }
    catch {
        # Escalation publish must not block claim acquisition; router redelivers from durable state.
    }
    return @{
        acquired    = $false
        reason      = 'ambiguous_claim'
        escalation  = $true
        detail      = 'lost_race_without_active_record'
        path        = $Path
        namespace   = $Namespace
        key         = $Key
    }
}

function Write-ReviewStartClaimAtomic {
    param([string]$Path, [object]$Record)
    $dir = Split-Path -Parent $Path
    $tmp = Join-Path $dir ".$([guid]::NewGuid().ToString('n')).tmp"
    ($Record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $tmp -Encoding UTF8
    try {
        [System.IO.File]::Move($tmp, $Path, $false)
    }
    catch [System.Management.Automation.MethodException] {
        if (Test-Path -LiteralPath $Path -PathType Leaf) { throw [System.IO.IOException]::new("claim already exists: $Path") }
        [System.IO.File]::Move($tmp, $Path)
    }
}

function Resolve-ReviewStartClaimAgainstExisting {
    param(
        [string]$Namespace,
        [string]$Path,
        [int]$PrNumber,
        [string]$Normalized,
        [string]$Surface,
        [array]$ReviewRuns,
        [double]$StaleMinutes,
        [string]$StartReason,
        [object]$Existing
    )

    if (Test-ReviewStartClaimRunVisible -ReviewRuns $ReviewRuns -PrNumber $PrNumber -HeadSha $Normalized) {
        if ([string]$Existing.record.state -eq 'active') {
            $terminalPath = Move-ReviewStartClaimToTerminal -Namespace $Namespace -ActivePath $Path -Record $Existing.record -Outcome 'run_started' -Extra @{
                coverage  = 'covered_by_run'
                coveredBy = 'claim_skip'
            }
            return @{ acquired = $false; reason = 'covered_by_run'; holder = $Existing.record.holder; claim = $Existing.record; path = $terminalPath; namespace = $Namespace; key = $Existing.record.key }
        }
        try {
            . (Join-Path $PSScriptRoot 'Review-StartEnvelopeLedger.ps1')
            Reset-ReviewStartEnvelopeLedgerForCoveredHead -Namespace $Namespace -PrNumber $PrNumber -HeadSha $Normalized `
                -ReviewRuns $ReviewRuns | Out-Null
        }
        catch {
            Write-Warning "review-start-envelope-ledger covered-head reset failed: $_"
        }
        return @{ acquired = $false; reason = 'covered_by_run'; holder = $Existing.record.holder; claim = $Existing.record; path = $Path; namespace = $Namespace; key = $Existing.record.key }
    }

    if ($Existing.record.manualResolutionRequired) {
        return @{
            acquired  = $false
            reason    = 'foreign_holder_manual'
            holder    = $Existing.record.holder
            claim     = $Existing.record
            path      = $Path
            namespace = $Namespace
            key       = $Existing.record.key
            blocking  = $true
        }
    }

    $syncReclaim = Sync-ReviewStartClaimReclaimBeforeSkip -Namespace $Namespace -Path $Path -Record $Existing.record -ReviewRuns $ReviewRuns
    if ($syncReclaim.blocking -or ($syncReclaim.decision -and [string]$syncReclaim.decision.action -eq 'mark_manual')) {
        return @{
            acquired  = $false
            reason    = 'foreign_holder_manual'
            holder    = $Existing.record.holder
            claim     = $Existing.record
            path      = $Path
            namespace = $Namespace
            key       = $Existing.record.key
            blocking  = $true
        }
    }
    if ($syncReclaim.reclaimed) {
        $newRecord = New-ReviewStartClaimActiveRecord -PrNumber $PrNumber -HeadSha $Normalized -Surface $Surface -Reason $StartReason -RecoveredFrom @{
            path          = if ($syncReclaim.result.terminalPath) { $syncReclaim.result.terminalPath } else { '' }
            holder        = $Existing.record.holder
            acquiredAtUtc = $Existing.record.acquiredAtUtc
            outcome       = [string]$syncReclaim.decision.outcome
        } -PriorFirstAttemptMonotonicMs (Get-ReviewStartClaimPriorFirstAttemptMonotonicMs -Record $Existing.record)
        Write-ReviewStartClaimAtomic -Path $Path -Record $newRecord
        if (-not (Test-ReviewStartClaimHolderOwnsPath -Path $Path -Holder $newRecord.holder)) {
            return Get-ReviewStartClaimLostRaceResult -Path $Path -Namespace $Namespace -Key $newRecord.key -PrNumber $PrNumber -HeadSha $Normalized
        }
        return @{ acquired = $true; recovered = $true; claim = $newRecord; path = $Path; namespace = $Namespace; key = $newRecord.key; recoveredRecord = $Existing.record }
    }

    $age = ((Get-Date).ToUniversalTime() - $Existing.acquiredAtUtc).TotalMinutes
    if ($age -lt $StaleMinutes) {
        return @{ acquired = $false; reason = 'claimed'; holder = $Existing.record.holder; claim = $Existing.record; path = $Path; namespace = $Namespace; key = $Existing.record.key }
    }

    $terminalPath = Move-ReviewStartClaimToTerminal -Namespace $Namespace -ActivePath $Path -Record $Existing.record -Outcome 'recovered_stale' -Extra @{
        recoveredBy = New-ReviewStartClaimHolder -Surface $Surface
    }
    $newRecord = New-ReviewStartClaimActiveRecord -PrNumber $PrNumber -HeadSha $Normalized -Surface $Surface -Reason $StartReason -RecoveredFrom @{
        path          = $terminalPath
        holder        = $Existing.record.holder
        acquiredAtUtc = $Existing.record.acquiredAtUtc
    } -PriorFirstAttemptMonotonicMs (Get-ReviewStartClaimPriorFirstAttemptMonotonicMs -Record $Existing.record)
    Write-ReviewStartClaimAtomic -Path $Path -Record $newRecord
    if (-not (Test-ReviewStartClaimHolderOwnsPath -Path $Path -Holder $newRecord.holder)) {
        return Get-ReviewStartClaimLostRaceResult -Path $Path -Namespace $Namespace -Key $newRecord.key -PrNumber $PrNumber -HeadSha $Normalized
    }
    return @{ acquired = $true; recovered = $true; claim = $newRecord; path = $Path; namespace = $Namespace; key = $newRecord.key; recoveredRecord = $Existing.record }
}

function Acquire-ReviewStartClaim {
    param(
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$Surface,
        [array]$ReviewRuns = @(),
        [string]$Namespace = '',
        [string]$ProjectId = 'orchestrator-pack',
        [string]$StartReason = '',
        [scriptblock]$LogWriter = $null
    )

    try {
        $resolved = Resolve-ReviewStartClaimNamespace -ProjectId $ProjectId -Namespace $Namespace
        Initialize-ReviewStartClaimNamespace -Namespace $resolved
        $normalized = ConvertTo-ReviewStartClaimHeadSha -HeadSha $HeadSha
        $path = Get-ReviewStartClaimPath -Namespace $resolved -PrNumber $PrNumber -HeadSha $normalized
        $lockDir = Get-ReviewStartClaimLockDir -Namespace $resolved -PrNumber $PrNumber -HeadSha $normalized
        $staleMinutes = Get-ReviewStartClaimStaleMinutes -LogWriter $LogWriter
        $key = "pr-$PrNumber-$normalized"

        if (-not (Enter-ReviewStartClaimMutexWithRetry -LockDir $lockDir)) {
            return Get-ReviewStartClaimContendedResult -Path $path -Namespace $resolved -Key $key
        }

        try {
            $existing = Read-ReviewStartClaimRecord -Path $path
            if ($existing.ok) {
                return Resolve-ReviewStartClaimAgainstExisting -Namespace $resolved -Path $path -PrNumber $PrNumber `
                    -Normalized $normalized -Surface $Surface -ReviewRuns $ReviewRuns -StaleMinutes $staleMinutes `
                    -StartReason $StartReason -Existing $existing
            }
            if ($existing.reason -ne 'missing') {
                return @{ acquired = $false; reason = 'ambiguous_claim'; escalation = $true; detail = $existing.reason; path = $path; namespace = $resolved; key = $key }
            }

            $priorFirstAttempt = Get-ReviewStartClaimPriorFirstAttemptFromRetryEligibleTerminals -Namespace $resolved -Key $key
            $record = New-ReviewStartClaimActiveRecord -PrNumber $PrNumber -HeadSha $normalized -Surface $Surface -Reason $StartReason `
                -PriorFirstAttemptMonotonicMs $priorFirstAttempt
            Write-ReviewStartClaimAtomic -Path $path -Record $record
            if (-not (Test-ReviewStartClaimHolderOwnsPath -Path $path -Holder $record.holder)) {
                return Get-ReviewStartClaimLostRaceResult -Path $path -Namespace $resolved -Key $key -PrNumber $PrNumber -HeadSha $normalized
            }
            return @{ acquired = $true; recovered = $false; claim = $record; path = $path; namespace = $resolved; key = $record.key }
        }
        catch [System.IO.IOException] {
            $existing = Read-ReviewStartClaimRecord -Path $path
            if (-not $existing.ok) {
                return @{ acquired = $false; reason = 'ambiguous_claim'; escalation = $true; detail = $existing.reason; path = $path; namespace = $resolved; key = $key }
            }
            return Resolve-ReviewStartClaimAgainstExisting -Namespace $resolved -Path $path -PrNumber $PrNumber `
                -Normalized $normalized -Surface $Surface -ReviewRuns $ReviewRuns -StaleMinutes $staleMinutes `
                -StartReason $StartReason -Existing $existing
        }
        catch {
            return @{ acquired = $false; reason = 'storage_failure'; escalation = $true; detail = [string]$_; path = $path; namespace = $resolved; key = $key }
        }
        finally {
            Exit-ReviewStartClaimMutex -LockDir $lockDir
        }
    }
    catch {
        return @{ acquired = $false; reason = 'storage_failure'; escalation = $true; detail = [string]$_; namespace = $Namespace }
    }
}

function Test-ReviewStartClaimOwnership {
    param([hashtable]$ClaimResult)
    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return $false }
    $read = Read-ReviewStartClaimRecord -Path $ClaimResult.path
    if (-not $read.ok) { return $false }
    return ([string]$read.record.holder.processGuid -eq [string]$ClaimResult.claim.holder.processGuid)
}

function Complete-ReviewStartClaim {
    param(
        [hashtable]$ClaimResult,
        [string]$Outcome,
        [array]$ReviewRuns = @(),
        [hashtable]$Extra = @{}
    )
    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return @{ ok = $false; reason = 'no_claim' } }
    $lockDir = Get-ReviewStartClaimLockDir -Namespace $ClaimResult.namespace -PrNumber ([int]$ClaimResult.claim.prNumber) -HeadSha ([string]$ClaimResult.claim.headSha)
    if (-not (Enter-ReviewStartClaimMutex -LockDir $lockDir)) { return @{ ok = $false; reason = 'busy' } }
    try {
        $read = Read-ReviewStartClaimRecord -Path $ClaimResult.path
        if (-not $read.ok) { return @{ ok = $false; reason = 'ambiguous_claim'; detail = $read.reason } }
        if ([string]$read.record.holder.processGuid -ne [string]$ClaimResult.claim.holder.processGuid) {
            return @{ ok = $false; reason = 'lost_ownership'; holder = $read.record.holder }
        }
        if ($Outcome -eq 'run_started') {
            if (-not (Test-ReviewStartClaimRunVisible -ReviewRuns $ReviewRuns -PrNumber ([int]$ClaimResult.claim.prNumber) -HeadSha ([string]$ClaimResult.claim.headSha))) {
                return @{ ok = $false; reason = 'run_not_visible' }
            }
        }
        $terminalPath = Move-ReviewStartClaimToTerminal -Namespace $ClaimResult.namespace -ActivePath $ClaimResult.path -Record $read.record -Outcome $Outcome -Extra $Extra
        return @{ ok = $true; terminalPath = $terminalPath; outcome = $Outcome }
    }
    finally {
        Exit-ReviewStartClaimMutex -LockDir $lockDir
    }
}

function Release-ReviewStartClaimAfterRunFailure {
    param([hashtable]$ClaimResult, [array]$ReviewRuns = @(), [string]$Failure = '')
    $eligible = Test-ReviewStartClaimRetryEligible -ReviewRuns $ReviewRuns -PrNumber ([int]$ClaimResult.claim.prNumber) -HeadSha ([string]$ClaimResult.claim.headSha)
    if ($eligible) {
        return Complete-ReviewStartClaim -ClaimResult $ClaimResult -Outcome 'released_for_retry' -ReviewRuns $ReviewRuns -Extra @{ failure = $Failure }
    }
    return Complete-ReviewStartClaim -ClaimResult $ClaimResult -Outcome 'escalated_ambiguous' -ReviewRuns @() -Extra @{ failure = $Failure; reason = 'post_exit_state_ambiguous' }
}

function Get-ReviewStartSupervisedGhInfraTransportFailure {
    param([object]$TransportFailure)

    if (-not $TransportFailure -or $TransportFailure.ok) { return $null }
    $failureClass = [string]$TransportFailure.failureClass
    if (-not $failureClass -and $TransportFailure.classification) {
        $failureClass = [string]$TransportFailure.classification.failureClass
    }
    $reason = [string]$TransportFailure.reason
    $infraReason = $reason -match '^(structured_output_polluted|gh_command_failed|empty_child_output|malformed_child_output|scoped_gh_read_infrastructure_failure|preflight_transient_exhausted|preflight_timeout|claim_ownership_lost)'
    if ($failureClass -ne 'infra_transport' -and -not $infraReason) { return $null }
    return @{
        failureClass     = 'infra_transport'
        transportFailure = $TransportFailure
    }
}

function Get-ReviewStartTargetStateRecheckDenial {
    param([hashtable]$Snapshot)

    $denial = $Snapshot.targetStateDenial
    if (-not $denial -or $denial.ok -eq $true) { return $null }
    $reason = [string]$denial.reason
    if (-not $reason) { return $null }
    return @{
        emitReviewRun       = $false
        reason              = $reason
        targetStateDenial   = $denial
    }
}

function Get-ReviewStartSupervisedGhInfraTransportRecheckDenial {
    param([hashtable]$Snapshot)

    $infra = Get-ReviewStartSupervisedGhInfraTransportFailure -TransportFailure $Snapshot.transportFailure
    if (-not $infra) { return $null }
    return @{
        emitReviewRun              = $false
        reason                     = 'supervised_gh_transport_failure'
        supervisedGhInfraTransport = $true
        transportFailure           = $infra.transportFailure
    }
}

function Complete-ReviewStartClaimPreRunRecheckDenied {
    param(
        [hashtable]$ClaimResult,
        [hashtable]$Recheck,
        [array]$ReviewRuns = @(),
        [switch]$DryRun
    )

    if ($Recheck.supervisedGhInfraTransport) {
        if (-not $DryRun -and $ClaimResult -and $ClaimResult.acquired) {
            Complete-ReviewStartClaim -ClaimResult $ClaimResult -Outcome 'released_for_retry' -ReviewRuns $ReviewRuns -Extra @{
                reason           = [string]$Recheck.reason
                failureClass     = 'infra_transport'
                transportFailure = $Recheck.transportFailure
            } | Out-Null
        }
        return @{ outcome = 'released_for_retry'; reason = [string]$Recheck.reason }
    }

    if (-not $DryRun -and $ClaimResult -and $ClaimResult.acquired) {
        Complete-ReviewStartClaim -ClaimResult $ClaimResult -Outcome 'aborted_by_recheck' -ReviewRuns $ReviewRuns -Extra @{
            reason = [string]$Recheck.reason
        } | Out-Null
    }
    return @{ outcome = 'aborted_by_recheck'; reason = [string]$Recheck.reason }
}

function Release-ReviewStartClaimAfterRecheckException {
    param(
        [hashtable]$ClaimResult,
        [switch]$DryRun,
        [object]$ErrorRecord
    )

    if (-not $DryRun -and $ClaimResult -and $ClaimResult.acquired) {
        Complete-ReviewStartClaim -ClaimResult $ClaimResult -Outcome 'released_for_retry' -ReviewRuns @() -Extra @{
            reason = 'pre_run_recheck_exception'
            error  = [string]$ErrorRecord
        } | Out-Null
    }
}

function Release-ReviewStartClaimForTerminalizedRun {
    param(
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$Namespace = '',
        [string]$RunId = '',
        [string]$RunCreatedAtUtc = '',
        [array]$ReviewRuns = @(),
        [scriptblock]$LogWriter = $null
    )

    try {
        if (-not $RunId) { return @{ ok = $false; reason = 'missing_run_id' } }
        $normalized = ConvertTo-ReviewStartClaimHeadSha -HeadSha $HeadSha
        $resolved = Resolve-ReviewStartClaimNamespace -ProjectId $ProjectId -Namespace $Namespace
        Initialize-ReviewStartClaimNamespace -Namespace $resolved
        $path = Get-ReviewStartClaimPath -Namespace $resolved -PrNumber $PrNumber -HeadSha $normalized
        $lockDir = Get-ReviewStartClaimLockDir -Namespace $resolved -PrNumber $PrNumber -HeadSha $normalized
        if (-not (Enter-ReviewStartClaimMutex -LockDir $lockDir)) {
            return @{ ok = $false; reason = 'busy' }
        }
        try {
            $read = Read-ReviewStartClaimRecord -Path $path
            if (-not $read.ok) { return @{ ok = $false; reason = 'no_active_claim'; detail = $read.reason } }
            if ([string]$read.record.state -ne 'active') { return @{ ok = $false; reason = 'not_active' } }
            if (-not (Test-ReviewStartClaimMatchesTerminalizedRun -ClaimRecord $read.record -RunId $RunId -RunCreatedAtUtc $RunCreatedAtUtc)) {
                $bound = [string]$read.record.boundRunId
                if (-not $bound) {
                    $runs = @($ReviewRuns)
                    if (Test-ReviewStartClaimRunVisible -ReviewRuns $runs -PrNumber $PrNumber -HeadSha $normalized) {
                        $decision = @{
                            action  = 'terminalize'
                            outcome = 'orphan_covered_run_unbound'
                            reason  = 'recovery_unbound_covering_run'
                            warn    = $true
                            coveredRunId = $RunId
                        }
                        $terminal = Invoke-ReviewStartClaimTerminalizeFromDecision -Namespace $resolved -Path $path -Record $read.record `
                            -Decision $decision -DecisionSource 'run_recovery' -ReviewRuns $runs -MutexAlreadyHeld
                        if ($LogWriter) {
                            & $LogWriter "review-start-claim: WARN orphan unbound claim terminalized PR #$PrNumber head=$normalized run=$RunId audit=$($terminal.auditPath)"
                        }
                        return @{ ok = [bool]$terminal.ok; terminalPath = $terminal.terminalPath; key = $read.record.key; outcome = 'orphan_covered_run_unbound' }
                    }
                }
                return @{
                    ok         = $false
                    reason     = 'superseded_claim'
                    boundRunId = [string]$read.record.boundRunId
                    holder     = $read.record.holder
                }
            }
            $terminalPath = Move-ReviewStartClaimToTerminal -Namespace $resolved -ActivePath $path -Record $read.record -Outcome 'released_after_run_terminalized' -Extra @{
                runId = $RunId
            }
            if ($LogWriter) {
                & $LogWriter "review-start-claim: released after terminalized run PR #$PrNumber head=$normalized run=$RunId audit=$terminalPath"
            }
            return @{ ok = $true; terminalPath = $terminalPath; key = $read.record.key }
        }
        finally {
            Exit-ReviewStartClaimMutex -LockDir $lockDir
        }
    }
    catch {
        return @{ ok = $false; reason = 'storage_failure'; detail = [string]$_ }
    }
}

function Resolve-ReviewStartClaimEscalation {
    param(
        [int]$PrNumber,
        [string]$HeadSha,
        [array]$ReviewRuns = @(),
        [string]$Namespace = '',
        [string]$ProjectId = 'orchestrator-pack',
        [scriptblock]$LogWriter = $null
    )
    $resolved = Resolve-ReviewStartClaimNamespace -ProjectId $ProjectId -Namespace $Namespace
    Initialize-ReviewStartClaimNamespace -Namespace $resolved
    $path = Get-ReviewStartClaimPath -Namespace $resolved -PrNumber $PrNumber -HeadSha $HeadSha
    $read = Read-ReviewStartClaimRecord -Path $path
    $outcome = if (Test-ReviewStartClaimRunVisible -ReviewRuns $ReviewRuns -PrNumber $PrNumber -HeadSha $HeadSha) { 'operator_resolved_covered' } else { 'operator_resolved_rearmed' }
    if ($read.ok) {
        $result = Move-ReviewStartClaimToTerminal -Namespace $resolved -ActivePath $path -Record $read.record -Outcome $outcome -Extra @{ resolvedBy = New-ReviewStartClaimHolder -Surface 'operator-resolution' }
    }
    elseif (Test-Path -LiteralPath $path -PathType Leaf) {
        $target = Join-Path (Get-ReviewStartClaimTerminalDir -Namespace $resolved) "$(Split-Path -Leaf $path).operator_resolved_ambiguous.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).json"
        Move-Item -LiteralPath $path -Destination $target -Force
        $result = $target
    }
    else {
        $result = ''
    }
    if ($LogWriter) { & $LogWriter "review-start-claim: operator resolved PR #$PrNumber head=$HeadSha outcome=$outcome audit=$result" }
    return @{ ok = $true; outcome = $outcome; auditPath = $result }
}

. (Join-Path $PSScriptRoot 'Review-StartClaimLifecycle.ps1')
