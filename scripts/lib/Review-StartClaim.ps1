#requires -Version 5.1
<#
  Cross-process single-flight claims for automated `ao review run` starters.

  The active claim file is created with an atomic File.Move(temp, active) so a
  complete JSON record becomes visible in one step. Lifecycle changes that can
  race (stale recovery / terminalization) are serialized with a per-key lock
  directory created via New-Item -ItemType Directory.
#>

$Script:ReviewStartClaimDefaultStaleMinutes = 10
$Script:ReviewStartClaimSafeFloorMinutes = 2
$Script:ReviewStartClaimTerminalRetentionCount = 64
$Script:ReviewStartClaimMutexStaleSeconds = 5
$Script:ReviewStartClaimCoveredRunStatuses = @('queued', 'preparing', 'running', 'reviewing', 'clean', 'needs_triage', 'waiting_update')

function Resolve-ReviewStartClaimNamespace {
    param([string]$StateRoot = '')

    if ($env:AO_REVIEW_CLAIM_DIR) {
        return $env:AO_REVIEW_CLAIM_DIR.Trim()
    }
    if ($StateRoot) {
        return (Join-Path $StateRoot 'review-start-claims')
    }
    if ($env:AO_SIDE_PROCESS_STATE_DIR) {
        return (Join-Path $env:AO_SIDE_PROCESS_STATE_DIR.Trim() 'review-start-claims')
    }
    return (Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-start-claims')
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
    return @{
        surface     = $Surface
        pid         = $PID
        host        = $hostName
        generation  = $generation
        processGuid = [guid]::NewGuid().ToString('n')
    }
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

    $ageSeconds = ((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $LockDir).LastWriteTimeUtc).TotalSeconds
    return ($ageSeconds -ge (Get-ReviewStartClaimMutexStaleSeconds))
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

function Test-ReviewStartClaimRecoveredStaleTerminalExists {
    param(
        [string]$Namespace,
        [int]$PrNumber,
        [string]$HeadSha
    )

    $leaf = Split-Path -Leaf (Get-ReviewStartClaimPath -Namespace $Namespace -PrNumber $PrNumber -HeadSha $HeadSha)
    $pattern = "$leaf.recovered_stale.*.json"
    return [bool]@(Get-ChildItem -LiteralPath (Get-ReviewStartClaimTerminalDir -Namespace $Namespace) -File -Filter $pattern -ErrorAction SilentlyContinue).Count
}

function Test-ReviewStartClaimRunVisible {
    param([array]$ReviewRuns, [int]$PrNumber, [string]$HeadSha)
    $normalized = ConvertTo-ReviewStartClaimHeadSha -HeadSha $HeadSha
    foreach ($run in @($ReviewRuns)) {
        if ($null -eq $run) { continue }
        $runPr = 0
        if (-not [int]::TryParse([string]$run.prNumber, [ref]$runPr)) { continue }
        if ($runPr -ne $PrNumber) { continue }
        $target = ([string]$run.targetSha).Trim().ToLowerInvariant()
        if ($target -ne $normalized) { continue }
        $status = ([string]$run.status).Trim().ToLowerInvariant()
        if ($status -in $Script:ReviewStartClaimCoveredRunStatuses) {
            return $true
        }
    }
    return $false
}

function Test-ReviewStartClaimRetryEligible {
    param([array]$ReviewRuns, [int]$PrNumber, [string]$HeadSha)
    return -not (Test-ReviewStartClaimRunVisible -ReviewRuns $ReviewRuns -PrNumber $PrNumber -HeadSha $HeadSha)
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
    Remove-Item -LiteralPath $ActivePath -Force -ErrorAction SilentlyContinue
    return $target
}

function New-ReviewStartClaimActiveRecord {
    param([int]$PrNumber, [string]$HeadSha, [string]$Surface, [string]$Reason = '', [object]$RecoveredFrom = $null)
    $normalized = ConvertTo-ReviewStartClaimHeadSha -HeadSha $HeadSha
    return @{
        schemaVersion = 1
        key           = "pr-$PrNumber-$normalized"
        prNumber      = $PrNumber
        headSha       = $normalized
        state         = 'active'
        holder        = New-ReviewStartClaimHolder -Surface $Surface
        acquiredAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        startReason   = $Reason
        recoveredFrom = $RecoveredFrom
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

function Acquire-ReviewStartClaim {
    param(
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$Surface,
        [array]$ReviewRuns = @(),
        [string]$Namespace = '',
        [string]$StateRoot = '',
        [string]$StartReason = '',
        [scriptblock]$LogWriter = $null
    )

    try {
        $resolved = if ($Namespace) { $Namespace } else { Resolve-ReviewStartClaimNamespace -StateRoot $StateRoot }
        Initialize-ReviewStartClaimNamespace -Namespace $resolved
        $normalized = ConvertTo-ReviewStartClaimHeadSha -HeadSha $HeadSha
        $path = Get-ReviewStartClaimPath -Namespace $resolved -PrNumber $PrNumber -HeadSha $normalized
        $lockDir = Get-ReviewStartClaimLockDir -Namespace $resolved -PrNumber $PrNumber -HeadSha $normalized
        $staleMinutes = Get-ReviewStartClaimStaleMinutes -LogWriter $LogWriter

        $record = New-ReviewStartClaimActiveRecord -PrNumber $PrNumber -HeadSha $normalized -Surface $Surface -Reason $StartReason
        try {
            Write-ReviewStartClaimAtomic -Path $path -Record $record
            return @{ acquired = $true; recovered = $false; claim = $record; path = $path; namespace = $resolved; key = $record.key }
        }
        catch [System.IO.IOException] {
            $existing = Read-ReviewStartClaimRecord -Path $path
            if (-not $existing.ok) {
                return @{ acquired = $false; reason = 'ambiguous_claim'; escalation = $true; detail = $existing.reason; path = $path; namespace = $resolved; key = "pr-$PrNumber-$normalized" }
            }
            if (Test-ReviewStartClaimRecoveredStaleTerminalExists -Namespace $resolved -PrNumber $PrNumber -HeadSha $normalized) {
                return @{ acquired = $false; reason = 'claimed'; holder = $existing.record.holder; claim = $existing.record; path = $path; namespace = $resolved; key = $existing.record.key }
            }
            if (Test-ReviewStartClaimRunVisible -ReviewRuns $ReviewRuns -PrNumber $PrNumber -HeadSha $normalized) {
                if ([string]$existing.record.state -eq 'active') {
                    $terminalPath = Move-ReviewStartClaimToTerminal -Namespace $resolved -ActivePath $path -Record $existing.record -Outcome 'run_started' -Extra @{
                        coverage = 'covered_by_run'
                        coveredBy = 'claim_skip'
                    }
                    return @{ acquired = $false; reason = 'covered_by_run'; holder = $existing.record.holder; claim = $existing.record; path = $terminalPath; namespace = $resolved; key = $existing.record.key }
                }
                return @{ acquired = $false; reason = 'covered_by_run'; holder = $existing.record.holder; claim = $existing.record; path = $path; namespace = $resolved; key = $existing.record.key }
            }
            $age = ((Get-Date).ToUniversalTime() - $existing.acquiredAtUtc).TotalMinutes
            if ($age -lt $staleMinutes) {
                return @{ acquired = $false; reason = 'claimed'; holder = $existing.record.holder; claim = $existing.record; path = $path; namespace = $resolved; key = $existing.record.key }
            }
            if (-not (Enter-ReviewStartClaimMutex -LockDir $lockDir)) {
                return @{ acquired = $false; reason = 'claimed'; holder = $existing.record.holder; claim = $existing.record; path = $path; namespace = $resolved; key = $existing.record.key }
            }
            try {
                $again = Read-ReviewStartClaimRecord -Path $path
                if (-not $again.ok) {
                    return @{ acquired = $false; reason = 'ambiguous_claim'; escalation = $true; detail = $again.reason; path = $path; namespace = $resolved; key = "pr-$PrNumber-$normalized" }
                }
                if (-not (Test-ReviewStartClaimRecordSameGeneration -Expected $existing.record -Actual $again.record)) {
                    return @{ acquired = $false; reason = 'claimed'; holder = $again.record.holder; claim = $again.record; path = $path; namespace = $resolved; key = $again.record.key }
                }
                if (Test-ReviewStartClaimRecoveredStaleTerminalExists -Namespace $resolved -PrNumber $PrNumber -HeadSha $normalized) {
                    return @{ acquired = $false; reason = 'claimed'; holder = $again.record.holder; claim = $again.record; path = $path; namespace = $resolved; key = $again.record.key }
                }
                if (Test-ReviewStartClaimRunVisible -ReviewRuns $ReviewRuns -PrNumber $PrNumber -HeadSha $normalized) {
                    if ([string]$again.record.state -eq 'active') {
                        $terminalPath = Move-ReviewStartClaimToTerminal -Namespace $resolved -ActivePath $path -Record $again.record -Outcome 'run_started' -Extra @{
                            coverage = 'covered_by_run'
                            coveredBy = 'claim_skip'
                        }
                        return @{ acquired = $false; reason = 'covered_by_run'; holder = $again.record.holder; claim = $again.record; path = $terminalPath; namespace = $resolved; key = $again.record.key }
                    }
                    return @{ acquired = $false; reason = 'covered_by_run'; holder = $again.record.holder; claim = $again.record; path = $path; namespace = $resolved; key = $again.record.key }
                }
                $ageAgain = ((Get-Date).ToUniversalTime() - $again.acquiredAtUtc).TotalMinutes
                if ($ageAgain -lt $staleMinutes) {
                    return @{ acquired = $false; reason = 'claimed'; holder = $again.record.holder; claim = $again.record; path = $path; namespace = $resolved; key = $again.record.key }
                }
                $terminalPath = Move-ReviewStartClaimToTerminal -Namespace $resolved -ActivePath $path -Record $again.record -Outcome 'recovered_stale' -Extra @{
                    recoveredBy = New-ReviewStartClaimHolder -Surface $Surface
                }
                $newRecord = New-ReviewStartClaimActiveRecord -PrNumber $PrNumber -HeadSha $normalized -Surface $Surface -Reason $StartReason -RecoveredFrom @{
                    path = $terminalPath
                    holder = $again.record.holder
                    acquiredAtUtc = $again.record.acquiredAtUtc
                }
                Write-ReviewStartClaimAtomic -Path $path -Record $newRecord
                return @{ acquired = $true; recovered = $true; claim = $newRecord; path = $path; namespace = $resolved; key = $newRecord.key; recoveredRecord = $again.record }
            }
            finally {
                Exit-ReviewStartClaimMutex -LockDir $lockDir
            }
        }
        catch {
            return @{ acquired = $false; reason = 'storage_failure'; escalation = $true; detail = [string]$_; path = $path; namespace = $resolved; key = "pr-$PrNumber-$normalized" }
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

function Resolve-ReviewStartClaimEscalation {
    param(
        [int]$PrNumber,
        [string]$HeadSha,
        [array]$ReviewRuns = @(),
        [string]$Namespace = '',
        [string]$StateRoot = '',
        [scriptblock]$LogWriter = $null
    )
    $resolved = if ($Namespace) { $Namespace } else { Resolve-ReviewStartClaimNamespace -StateRoot $StateRoot }
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
