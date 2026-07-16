#requires -Version 5.1
<#
.SYNOPSIS
  Pack-derived worker-status refresh and decision reader (Issues #720, #748).
#>

$Script:WorkerStatusRefreshDetailLimit = 8
$Script:WorkerStatusRefreshDetailEvidenceMaxAgeMs = 15 * 60 * 1000
$Script:WorkerStatusRefreshSessionDetailPolicyPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'worker-status-detail-policy.json'
$Script:WorkerStatusRefreshWriteMaxAttempts = 40
$Script:WorkerStatusRefreshWriteRetryDelayMs = 25
$Script:WorkerStatusRefreshReasonAllowlist = @(
    'binding_miss',
    'eviction_exception',
    'kill_switch_active',
    'missing_input',
    'missing_session_id',
    'monotonic_refused',
    'session_detail_cursor_read_failed',
    'session_detail_cursor_write_failed',
    'session_detail_cache_expired',
    'session_detail_cache_identity_mismatch',
    'session_detail_deadline_reached',
    'session_detail_limit_reached',
    'session_detail_lookup_failed',
    'session_detail_lookup_timeout',
    'no_live_sessions',
    'session_pr_binding_resolver_missing',
    'sibling_not_ready',
    'stale_generation',
    'worker_report_store_missing',
    'write_exception',
    'write_rejected'
)

function ConvertTo-WorkerStatusRefreshSafeToken {
    param(
        [string]$Value,
        [string]$Fallback = 'unknown'
    )

    $token = [string]$Value
    if ([string]::IsNullOrWhiteSpace($token)) {
        $token = $Fallback
    }
    $token = $token.Trim() -replace '[^A-Za-z0-9_.:-]', '_'
    if ($token.Length -gt 96) {
        $token = $token.Substring(0, 96)
    }
    return $token
}

function Resolve-WorkerStatusRefreshReasonCode {
    param(
        [string]$Reason,
        [string]$Fallback = 'write_rejected'
    )

    $candidate = ConvertTo-WorkerStatusRefreshSafeToken -Value $Reason -Fallback $Fallback
    if ($Script:WorkerStatusRefreshReasonAllowlist -contains $candidate) {
        return $candidate
    }
    return $Fallback
}

function Get-WorkerStatusRefreshSourceSessions {
    param(
        [string]$Project = '',
        [string]$RepoSlug = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao',
        [switch]$IncludeTerminated
    )

    if ($ReportFullPayload) {
        if ($IncludeTerminated) {
            return @(Get-AoStatusSessionsWithReportsIncludingTerminated -ReportFullPayload $ReportFullPayload)
        }
        return @(Get-AoStatusSessionsWithReports -ReportFullPayload $ReportFullPayload)
    }

    $sessions = if ($IncludeTerminated) {
        @(Get-AoStatusSessionsIncludingTerminated -Project $Project `
                -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
                -AoCommand $AoCommand)
    }
    else {
        @(Get-AoStatusSessions -Project $Project `
                -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
                -AoCommand $AoCommand)
    }

    $resolvedRepoSlug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug
    return @(Merge-AoSessionRowsWithWorkerReportStore -Sessions $sessions -RepoSlug $resolvedRepoSlug)
}

function New-WorkerStatusRefreshDiagnostic {
    param(
        [string]$Owner,
        [int]$SessionCount,
        [long]$NowMs
    )

    return @{
        schemaVersion       = 'worker-status-refresh-diagnostic/v1'
        owner               = ConvertTo-WorkerStatusRefreshSafeToken -Value $Owner -Fallback 'unspecified'
        observedAtMs        = $NowMs
        outcome             = 'pending'
        reasonCode          = ''
        sessionCount        = $SessionCount
        writeAttemptCount   = 0
        writeRetryCount     = 0
        successCount        = 0
        gateClosedCount     = 0
        skippedCount        = 0
        exceptionCount      = 0
        failureCount        = 0
        evictionRemoved     = 0
        evictionFailed      = $false
        githubDegraded             = $false
        detailEligibleCount        = 0
        detailAttemptCount         = 0
        detailSuccessCount         = 0
        detailFailureCount         = 0
        detailTimeoutCount         = 0
        detailSkippedByLimitCount     = 0
        detailSkippedByDeadlineCount  = 0
        detailDeadlineReached         = $false
        detailElapsedMs               = 0
        detailPolicyMaxCalls          = 0
        detailPolicyTimeoutMs         = 0
        detailPolicyDeadlineMs        = 0
        detailCursorStart             = 0
        detailCursorNext              = 0
        detailCursorReadFailed        = $false
        detailCursorWriteFailed       = $false
        detailCacheHitCount           = 0
        detailCacheEntryCount         = 0
        detailCacheExpiredCount       = 0
        detailCacheIdentityMismatchCount = 0
        details                       = @()
    }
}

function Add-WorkerStatusRefreshDiagnosticDetail {
    param(
        [System.Collections.IDictionary]$Diagnostic,
        [string]$SessionId,
        [string]$ReasonCode
    )

    if (@($Diagnostic.details).Count -ge $Script:WorkerStatusRefreshDetailLimit) {
        return
    }
    $Diagnostic.details = @($Diagnostic.details) + @(
        @{
            sessionId  = ConvertTo-WorkerStatusRefreshSafeToken -Value $SessionId -Fallback 'unknown_session'
            reasonCode = Resolve-WorkerStatusRefreshReasonCode -Reason $ReasonCode
        }
    )
}

function Format-WorkerStatusRefreshDiagnostic {
    param($Diagnostic)

    if (-not $Diagnostic) {
        return 'worker-status-refresh: outcome=missing_diagnostic'
    }
    $details = @($Diagnostic.details | ForEach-Object {
            '{0}:{1}' -f `
                (ConvertTo-WorkerStatusRefreshSafeToken -Value ([string]$_.sessionId) -Fallback 'unknown_session'), `
                (Resolve-WorkerStatusRefreshReasonCode -Reason ([string]$_.reasonCode))
        })
    $detailText = if ($details.Count -gt 0) { $details -join ',' } else { 'none' }
    $reasonToken = ConvertTo-WorkerStatusRefreshSafeToken -Value ([string]$Diagnostic.reasonCode) -Fallback 'none'
    return ('worker-status-refresh: owner={0} outcome={1} reason={2} sessions={3} attempted={4} retries={5} success={6} gateClosed={7} skipped={8} exceptions={9} failures={10} evictionRemoved={11} evictionFailed={12} githubDegraded={13} detailEligible={14} detailAttempts={15} detailSuccess={16} detailFailures={17} detailTimeouts={18} detailSkippedLimit={19} detailSkippedDeadline={20} detailDeadlineReached={21} detailElapsedMs={22} detailPolicy={23}/{24}/{25} detailCursor={26}->{27} detailCursorReadFailed={28} detailCursorWriteFailed={29} detailCache={30}/{31} details={32}' -f `
            (ConvertTo-WorkerStatusRefreshSafeToken -Value ([string]$Diagnostic.owner) -Fallback 'unspecified'), `
            (ConvertTo-WorkerStatusRefreshSafeToken -Value ([string]$Diagnostic.outcome) -Fallback 'unknown'), `
            $reasonToken, `
            [int]$Diagnostic.sessionCount, [int]$Diagnostic.writeAttemptCount, [int]$Diagnostic.writeRetryCount, `
            [int]$Diagnostic.successCount, [int]$Diagnostic.gateClosedCount, [int]$Diagnostic.skippedCount, `
            [int]$Diagnostic.exceptionCount, [int]$Diagnostic.failureCount, [int]$Diagnostic.evictionRemoved, `
            [bool]$Diagnostic.evictionFailed, [bool]$Diagnostic.githubDegraded, `
            [int]$Diagnostic.detailEligibleCount, [int]$Diagnostic.detailAttemptCount, `
            [int]$Diagnostic.detailSuccessCount, [int]$Diagnostic.detailFailureCount, `
            [int]$Diagnostic.detailTimeoutCount, [int]$Diagnostic.detailSkippedByLimitCount, `
            [int]$Diagnostic.detailSkippedByDeadlineCount, [bool]$Diagnostic.detailDeadlineReached, `
            [long]$Diagnostic.detailElapsedMs, [int]$Diagnostic.detailPolicyMaxCalls, `
            [int]$Diagnostic.detailPolicyTimeoutMs, [int]$Diagnostic.detailPolicyDeadlineMs, `
            [int]$Diagnostic.detailCursorStart, [int]$Diagnostic.detailCursorNext, `
            [bool]$Diagnostic.detailCursorReadFailed, [bool]$Diagnostic.detailCursorWriteFailed, `
            [int]$Diagnostic.detailCacheHitCount, [int]$Diagnostic.detailCacheEntryCount, $detailText)
}

function Get-WorkerStatusRefreshSessionId {
    param($Session)

    if ($Session.id) { return [string]$Session.id }
    if ($Session.name) { return [string]$Session.name }
    return [string]$Session.sessionId
}

function ConvertTo-WorkerStatusRefreshAcceptedDisplayName {
    param([string]$Value)

    $candidate = [string]$Value
    if ([string]::IsNullOrWhiteSpace($candidate)) { return '' }
    $candidate = $candidate.Trim()
    if ($candidate -notmatch '^\d+$') { return '' }
    $number = 0L
    if (-not [long]::TryParse($candidate, [ref]$number) -or $number -le 0) { return '' }
    return $number.ToString([Globalization.CultureInfo]::InvariantCulture)
}

function Get-WorkerStatusRefreshSessionDetailIdentity {
    param($Session)

    if (-not $Session) {
        return @{ reusable = $false; signature = ''; issue = ''; head = ''; branch = ''; generation = '' }
    }

    $firstText = {
        param([string[]]$Names)
        foreach ($name in $Names) {
            $value = ''
            if ($Session -is [System.Collections.IDictionary] -and $Session.Contains($name)) {
                $value = [string]$Session[$name]
            }
            else {
                $property = $Session.PSObject.Properties[$name]
                if ($property) { $value = [string]$property.Value }
            }
            if (-not [string]::IsNullOrWhiteSpace($value)) { return $value.Trim() }
        }
        return ''
    }.GetNewClosure()

    $sessionId = Get-WorkerStatusRefreshSessionId -Session $Session
    $issue = & $firstText @('issueNumber', 'issueId')
    $head = & $firstText @('ownedHeadSha', 'headSha', 'headRefOid', 'prHeadSha', 'branchHeadSha')
    $branch = & $firstText @('headRefName', 'branchName', 'branch', 'ownedBranch', 'worktreeBranch')
    $generation = & $firstText @('sessionGeneration', 'generation', 'createdAtMs', 'startedAtMs', 'spawnedAtMs', 'createdAt', 'startedAt')
    $reusable = (-not [string]::IsNullOrWhiteSpace($head) -or
        -not [string]::IsNullOrWhiteSpace($generation) -or
        (-not [string]::IsNullOrWhiteSpace($branch) -and -not [string]::IsNullOrWhiteSpace($issue)))
    if (-not $reusable) {
        return @{ reusable = $false; signature = ''; issue = $issue; head = $head; branch = $branch; generation = $generation }
    }

    $text = @(
        "session=$sessionId",
        "issue=$issue",
        "head=$($head.ToLowerInvariant())",
        "branch=$($branch.ToLowerInvariant())",
        "generation=$generation"
    ) -join "`n"
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return @{
        reusable = $true
        signature = (([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant())
        issue = $issue
        head = $head
        branch = $branch
        generation = $generation
    }
}

function Test-WorkerStatusRefreshSessionDetailEligible {
    param($Session)

    if (-not $Session) { return $false }
    if (-not (Test-AoSessionRowNeedsSessionGetDetail -Row $Session)) { return $false }
    $role = [string]$Session.role
    if ($role.ToLowerInvariant() -ne 'worker') { return $false }
    if ($Session.PSObject.Properties.Name -contains 'isTerminated' -and [bool]$Session.isTerminated) {
        return $false
    }
    $status = [string]$Session.status
    if ($status -match '^(?i:terminated|killed|exited|dead|closed)$') {
        return $false
    }
    return $true
}

function Get-WorkerStatusRefreshSessionDetailPolicy {
    param([System.Collections.IDictionary]$Override = $null)

    $raw = $Override
    if (-not $raw) {
        if (-not (Test-Path -LiteralPath $Script:WorkerStatusRefreshSessionDetailPolicyPath -PathType Leaf)) {
            throw "worker-status detail policy missing: $($Script:WorkerStatusRefreshSessionDetailPolicyPath)"
        }
        $raw = Get-Content -LiteralPath $Script:WorkerStatusRefreshSessionDetailPolicyPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    $schemaVersion = [int]$raw.schemaVersion
    $maxCalls = [int]$raw.maxCallsPerTick
    $timeoutMs = [int]$raw.perCallTimeoutMs
    $deadlineMs = [int]$raw.globalDeadlineMs
    $drainMs = [int]$raw.postKillDrainMs
    if ($schemaVersion -ne 1) { throw 'worker-status detail policy schemaVersion must be 1' }
    if ($maxCalls -le 0 -or $maxCalls -gt 200) { throw 'worker-status detail policy maxCallsPerTick out of range' }
    if ($timeoutMs -le 0 -or $timeoutMs -gt 60000) { throw 'worker-status detail policy perCallTimeoutMs out of range' }
    if ($deadlineMs -le 0 -or $deadlineMs -ge 20000) { throw 'worker-status detail policy globalDeadlineMs must stay below the 20s supervisor stall budget' }
    if ($drainMs -lt 0 -or $drainMs -gt 2000) { throw 'worker-status detail policy postKillDrainMs out of range' }
    return @{
        schemaVersion = $schemaVersion
        maxCallsPerTick = $maxCalls
        perCallTimeoutMs = $timeoutMs
        globalDeadlineMs = $deadlineMs
        postKillDrainMs = $drainMs
    }
}

function Get-WorkerStatusRefreshMonotonicMs {
    param([scriptblock]$NowProvider = $null)
    if ($NowProvider) { return [long](& $NowProvider) }
    return [long][Environment]::TickCount64
}

function Get-WorkerStatusRefreshDetailCursorPath {
    param(
        [string]$StorePath = '',
        [string]$CursorPath = ''
    )
    if ($CursorPath) { return $CursorPath }
    $resolvedStore = if ($StorePath) { $StorePath } else { Get-WorkerStatusStorePath }
    return "$resolvedStore.detail-cursor.json"
}

function Get-WorkerStatusRefreshDetailEligibleSignature {
    param([object[]]$Eligible)
    $text = (@($Eligible | ForEach-Object { Get-WorkerStatusRefreshSessionId -Session $_ }) -join "`n")
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}

function Get-WorkerStatusRefreshDetailCursorInitializationPath {
    param([string]$CursorPath)
    if (-not $CursorPath) { return '' }
    return "$CursorPath.initialized"
}

function Read-WorkerStatusRefreshDetailCursorInitialization {
    param([string]$CursorPath)

    $path = Get-WorkerStatusRefreshDetailCursorInitializationPath -CursorPath $CursorPath
    if (-not $path) { return @{ ok = $false; missing = $false; path = ''; phase = '' } }
    try {
        if (-not [IO.File]::Exists($path)) {
            if ([IO.Directory]::Exists($path)) {
                return @{ ok = $false; missing = $false; path = $path; phase = '' }
            }
            return @{ ok = $true; missing = $true; path = $path; phase = '' }
        }
        $record = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        $schemaVersion = 0
        $initializedAtMs = 0L
        if (-not [int]::TryParse([string]$record.schemaVersion, [ref]$schemaVersion) -or
            ($schemaVersion -ne 1 -and $schemaVersion -ne 2)) {
            return @{ ok = $false; missing = $false; path = $path; phase = '' }
        }
        if (-not [long]::TryParse([string]$record.initializedAtMs, [ref]$initializedAtMs) -or $initializedAtMs -le 0) {
            return @{ ok = $false; missing = $false; path = $path; phase = '' }
        }
        $phase = if ($schemaVersion -eq 1) { 'ready' } else { [string]$record.phase }
        if ($phase -ne 'initializing' -and $phase -ne 'ready') {
            return @{ ok = $false; missing = $false; path = $path; phase = '' }
        }
        return @{ ok = $true; missing = $false; path = $path; phase = $phase; initializedAtMs = $initializedAtMs }
    }
    catch {
        return @{ ok = $false; missing = $false; path = $path; phase = '' }
    }
}

function Write-WorkerStatusRefreshDetailCursorInitialization {
    param(
        [string]$CursorPath,
        [long]$NowMs,
        [ValidateSet('initializing', 'ready')]
        [string]$Phase = 'ready'
    )

    $path = Get-WorkerStatusRefreshDetailCursorInitializationPath -CursorPath $CursorPath
    if (-not $path) { throw 'worker-status detail cursor initialization path missing' }
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $temp = "$path.$PID.tmp"
    try {
        @{
            schemaVersion = 2
            phase = $Phase
            initializedAtMs = [Math]::Max(1L, $NowMs)
            updatedAtMs = [Math]::Max(1L, $NowMs)
        } | ConvertTo-Json -Compress | Set-Content -LiteralPath $temp -Encoding UTF8 -NoNewline
        Move-Item -LiteralPath $temp -Destination $path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temp -PathType Leaf) {
            Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        }
    }
}

function Read-WorkerStatusRefreshDetailCursor {
    param(
        [string]$Path,
        [string]$Signature,
        [int]$EligibleCount
    )

    $failed = { return @{ ok = $false; missing = $false; markerMissing = $false; initializationIncomplete = $false; nextIndex = 0; evidenceById = @{} } }
    try {
        if (-not $Path) { return & $failed }
        $markerState = Read-WorkerStatusRefreshDetailCursorInitialization -CursorPath $Path
        if (-not $markerState.ok) { return & $failed }

        if (-not [IO.File]::Exists($Path)) {
            if ([IO.Directory]::Exists($Path)) { return & $failed }
            if ($markerState.missing) {
                return @{
                    ok = $true
                    missing = $true
                    markerMissing = $true
                    initializationIncomplete = $true
                    nextIndex = 0
                    evidenceById = @{}
                }
            }
            if ([string]$markerState.phase -eq 'initializing') {
                return @{
                    ok = $true
                    missing = $true
                    markerMissing = $false
                    initializationIncomplete = $true
                    nextIndex = 0
                    evidenceById = @{}
                }
            }
            return & $failed
        }

        $record = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        $schemaVersion = 0
        if (-not [int]::TryParse([string]$record.schemaVersion, [ref]$schemaVersion) -or
            ($schemaVersion -ne 1 -and $schemaVersion -ne 2 -and $schemaVersion -ne 3)) {
            return & $failed
        }
        if ([string]::IsNullOrWhiteSpace([string]$record.signature)) { return & $failed }
        $storedIndex = 0
        if (-not [int]::TryParse([string]$record.nextIndex, [ref]$storedIndex) -or $storedIndex -lt 0) {
            return & $failed
        }

        $evidenceById = @{}
        if ($schemaVersion -ge 2) {
            $evidenceRows = @($record.evidence)
            if ($evidenceRows.Count -gt 200) { return & $failed }
            foreach ($entry in $evidenceRows) {
                $sessionId = [string]$entry.sessionId
                $displayName = ConvertTo-WorkerStatusRefreshAcceptedDisplayName -Value ([string]$entry.displayName)
                if ([string]::IsNullOrWhiteSpace($sessionId) -or -not $displayName) { return & $failed }
                $acceptedAtMs = 0L
                if ($entry.PSObject.Properties.Name -contains 'acceptedAtMs') {
                    [void][long]::TryParse([string]$entry.acceptedAtMs, [ref]$acceptedAtMs)
                }
                $identitySignature = ''
                if ($schemaVersion -eq 3) {
                    $identitySignature = ([string]$entry.identitySignature).Trim().ToLowerInvariant()
                    if ($identitySignature -notmatch '^[a-f0-9]{64}$' -or $acceptedAtMs -le 0) { return & $failed }
                }
                $evidenceById[$sessionId] = @{
                    displayName = $displayName
                    acceptedAtMs = [Math]::Max(0L, $acceptedAtMs)
                    identitySignature = $identitySignature
                }
            }
        }

        $nextIndex = if ($EligibleCount -gt 0 -and [string]$record.signature -eq $Signature) {
            $storedIndex % $EligibleCount
        }
        else { 0 }
        return @{
            ok = $true
            missing = $false
            markerMissing = [bool]$markerState.missing
            initializationIncomplete = (-not $markerState.missing -and [string]$markerState.phase -eq 'initializing')
            nextIndex = $nextIndex
            evidenceById = $evidenceById
        }
    }
    catch {
        return & $failed
    }
}

function Write-WorkerStatusRefreshDetailCursor {
    param(
        [string]$Path,
        [string]$Signature,
        [int]$NextIndex,
        [System.Collections.IDictionary]$EvidenceById,
        [long]$NowMs
    )
    if (-not $Path) { throw 'worker-status detail cursor path missing' }
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $evidence = @(
        @($EvidenceById.Keys | Sort-Object | Select-Object -First 200) | ForEach-Object {
            $sessionId = [string]$_
            $entry = $EvidenceById[$sessionId]
            $displayName = ConvertTo-WorkerStatusRefreshAcceptedDisplayName -Value ([string]$entry.displayName)
            $identitySignature = ([string]$entry.identitySignature).Trim().ToLowerInvariant()
            $acceptedAtMs = [long]$entry.acceptedAtMs
            if ([string]::IsNullOrWhiteSpace($sessionId) -or -not $displayName -or
                $identitySignature -notmatch '^[a-f0-9]{64}$' -or $acceptedAtMs -le 0) {
                throw 'worker-status detail cursor contains invalid accepted evidence'
            }
            @{
                sessionId = $sessionId
                displayName = $displayName
                acceptedAtMs = $acceptedAtMs
                identitySignature = $identitySignature
            }
        }
    )
    $temp = "$Path.$PID.tmp"
    try {
        @{
            schemaVersion = 3
            signature = $Signature
            nextIndex = [Math]::Max(0, $NextIndex)
            updatedAtMs = $NowMs
            evidence = $evidence
        } | ConvertTo-Json -Compress -Depth 5 | Set-Content -LiteralPath $temp -Encoding UTF8 -NoNewline
        Move-Item -LiteralPath $temp -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temp -PathType Leaf) {
            Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-WorkerStatusRefreshDetailHeartbeat {
    param(
        [scriptblock]$ProgressWriter,
        [string]$Step,
        [int]$Cursor,
        [int]$Total
    )
    if (-not $ProgressWriter) { return }
    & $ProgressWriter @{
        WorkStep = $Step
        WorkCursor = [Math]::Max(0, $Cursor)
        WorkTotal = [Math]::Max(1, $Total)
    }
}

function ConvertTo-WorkerStatusRefreshProcessArgument {
    param([string]$Value)

    $part = [string]$Value
    if ($part -notmatch '[\s"]') { return $part }
    return '"' + $part.Replace('"', '\"') + '"'
}

function Invoke-WorkerStatusRefreshSessionDetailLookup {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [string]$Project = 'orchestrator-pack',
        [string]$AoCommand = 'ao',
        [int]$TimeoutMs,
        [int]$DrainTimeoutMs = 250
    )

    $sessionArgs = @('session', 'get', $SessionId, '--json')
    if ($Project) { $sessionArgs += @('-p', $Project) }
    $command = $AoCommand
    $processArgs = @($sessionArgs)
    if ($AoCommand -match '(?i)\.ps1$') {
        $command = 'pwsh'
        $literalArgs = @($AoCommand) + $sessionArgs | ForEach-Object {
            "'" + ([string]$_).Replace("'", "''") + "'"
        }
        $invocation = '& ' + ($literalArgs -join ' ')
        $encodedInvocation = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($invocation))
        $processArgs = @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedInvocation)
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $command
    $psi.Arguments = ($processArgs | ForEach-Object {
            ConvertTo-WorkerStatusRefreshProcessArgument -Value ([string]$_)
        }) -join ' '
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    if (Get-Command Set-OpkVitestProcessStartInfoEnvironment -ErrorAction SilentlyContinue) {
        Set-OpkVitestProcessStartInfoEnvironment -ProcessStartInfo $psi
    }

    $proc = $null
    try {
        try { $proc = [System.Diagnostics.Process]::Start($psi) }
        catch {
            return @{ ok = $false; timedOut = $false; reason = 'session_detail_lookup_failed'; displayName = ''; detail = 'lookup_exception' }
        }

        $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
        $stderrTask = $proc.StandardError.ReadToEndAsync()
        $timedOut = -not $proc.WaitForExit([Math]::Max(1, $TimeoutMs))
        if ($timedOut) {
            try { $proc.Kill($true) }
            catch { try { $proc.Kill() } catch { } }
            try { [void]$proc.WaitForExit([Math]::Max(1, $DrainTimeoutMs)) } catch { }
        }
        try { [void]$stdoutTask.Wait([Math]::Max(1, $DrainTimeoutMs)) } catch { }
        try { [void]$stderrTask.Wait([Math]::Max(1, $DrainTimeoutMs)) } catch { }
        $stdout = if ($stdoutTask.IsCompleted) { [string]$stdoutTask.Result } else { '' }
        $stderr = if ($stderrTask.IsCompleted) { [string]$stderrTask.Result } else { '' }

        if ($timedOut) {
            return @{ ok = $false; timedOut = $true; reason = 'session_detail_lookup_timeout'; displayName = ''; detail = "timeout_ms=$TimeoutMs" }
        }
        if ($proc.ExitCode -ne 0) {
            return @{ ok = $false; timedOut = $false; reason = 'session_detail_lookup_failed'; displayName = ''; detail = "exit_code=$($proc.ExitCode)" }
        }

        $payload = $null
        try { $payload = ConvertFrom-AoCliPrefixedOutput -Text $stdout -FailureLabel 'ao session get' }
        catch {
            try { $payload = ConvertFrom-AoCliPrefixedOutput -Text (@($stdout, $stderr) -join "`n") -FailureLabel 'ao session get' }
            catch {
                return @{ ok = $false; timedOut = $false; reason = 'session_detail_lookup_failed'; displayName = ''; detail = 'lookup_exception' }
            }
        }
        $displayName = ConvertTo-WorkerStatusRefreshAcceptedDisplayName -Value ([string]$payload.session.displayName)
        if (-not $displayName) {
            return @{ ok = $false; timedOut = $false; reason = 'session_detail_lookup_failed'; displayName = ''; detail = 'invalid_display_name' }
        }
        return @{ ok = $true; timedOut = $false; reason = ''; displayName = $displayName; detail = '' }
    }
    finally {
        if ($proc) { $proc.Dispose() }
    }
}

function Add-WorkerStatusRefreshSessionDetails {
    param(
        [object[]]$Sessions,
        [string]$Project = 'orchestrator-pack',
        [string]$AoCommand = 'ao',
        [string]$StorePath = '',
        [string]$CursorPath = '',
        [System.Collections.IDictionary]$Diagnostic,
        [System.Collections.IDictionary]$PolicyOverride = $null,
        [scriptblock]$ProgressWriter = $null,
        [scriptblock]$DetailLookup = $null,
        [scriptblock]$NowProvider = $null,
        [scriptblock]$CursorPersistenceHook = $null
    )

    $policy = Get-WorkerStatusRefreshSessionDetailPolicy -Override $PolicyOverride
    $Diagnostic.detailPolicyMaxCalls = [int]$policy.maxCallsPerTick
    $Diagnostic.detailPolicyTimeoutMs = [int]$policy.perCallTimeoutMs
    $Diagnostic.detailPolicyDeadlineMs = [int]$policy.globalDeadlineMs

    $eligible = @($Sessions | Where-Object {
            Test-WorkerStatusRefreshSessionDetailEligible -Session $_
        } | Sort-Object { Get-WorkerStatusRefreshSessionId -Session $_ })
    $Diagnostic.detailEligibleCount = $eligible.Count
    if ($eligible.Count -eq 0) { return @($Sessions) }

    $eligibleById = @{}
    foreach ($session in $eligible) {
        $sessionId = Get-WorkerStatusRefreshSessionId -Session $session
        if ($sessionId) { $eligibleById[$sessionId] = $session }
    }

    $limit = [Math]::Min($eligible.Count, [int]$policy.maxCallsPerTick)
    $signature = Get-WorkerStatusRefreshDetailEligibleSignature -Eligible $eligible
    $resolvedCursorPath = Get-WorkerStatusRefreshDetailCursorPath -StorePath $StorePath -CursorPath $CursorPath
    $cursorState = Read-WorkerStatusRefreshDetailCursor -Path $resolvedCursorPath -Signature $signature -EligibleCount $eligible.Count
    if (-not $cursorState.ok) {
        $Diagnostic.detailCursorReadFailed = $true
        $Diagnostic.failureCount++
        Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $Diagnostic -SessionId 'detail_cursor' `
            -ReasonCode 'session_detail_cursor_read_failed'
        return @($Sessions)
    }

    $startIndex = [int]$cursorState.nextIndex
    $Diagnostic.detailCursorStart = $startIndex
    $attemptRows = @(
        for ($offset = 0; $offset -lt $limit; $offset++) {
            $eligible[($startIndex + $offset) % $eligible.Count]
        }
    )
    $Diagnostic.detailSkippedByLimitCount = [Math]::Max(0, $eligible.Count - $attemptRows.Count)

    $wallClockNowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $detailsById = @{}
    $evidenceById = @{}
    foreach ($entry in $cursorState.evidenceById.GetEnumerator()) {
        $sessionId = [string]$entry.Key
        if (-not $eligibleById.ContainsKey($sessionId)) { continue }
        $displayName = ConvertTo-WorkerStatusRefreshAcceptedDisplayName -Value ([string]$entry.Value.displayName)
        if (-not $displayName) { continue }
        $acceptedAtMs = [long]$entry.Value.acceptedAtMs
        $ageMs = $wallClockNowMs - $acceptedAtMs
        if ($acceptedAtMs -le 0 -or $ageMs -lt 0 -or $ageMs -gt $Script:WorkerStatusRefreshDetailEvidenceMaxAgeMs) {
            $Diagnostic.detailCacheExpiredCount++
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $Diagnostic -SessionId $sessionId `
                -ReasonCode 'session_detail_cache_expired'
            continue
        }
        $identity = Get-WorkerStatusRefreshSessionDetailIdentity -Session $eligibleById[$sessionId]
        $storedIdentity = ([string]$entry.Value.identitySignature).Trim().ToLowerInvariant()
        if (-not $identity.reusable -or -not $storedIdentity -or $storedIdentity -ne ([string]$identity.signature)) {
            $Diagnostic.detailCacheIdentityMismatchCount++
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $Diagnostic -SessionId $sessionId `
                -ReasonCode 'session_detail_cache_identity_mismatch'
            continue
        }
        $accepted = @{
            displayName = $displayName
            acceptedAtMs = $acceptedAtMs
            identitySignature = [string]$identity.signature
        }
        $detailsById[$sessionId] = $accepted
        $evidenceById[$sessionId] = $accepted
        $Diagnostic.detailCacheHitCount++
    }

    $startedAt = Get-WorkerStatusRefreshMonotonicMs -NowProvider $NowProvider
    $heartbeatTotal = [Math]::Max(1, $attemptRows.Count * 2)
    $attemptedRows = 0

    foreach ($session in $attemptRows) {
        $elapsed = (Get-WorkerStatusRefreshMonotonicMs -NowProvider $NowProvider) - $startedAt
        $remaining = [long]$policy.globalDeadlineMs - $elapsed
        if ($remaining -le 0) {
            $Diagnostic.detailDeadlineReached = $true
            break
        }
        $sessionId = Get-WorkerStatusRefreshSessionId -Session $session
        if (-not $sessionId) { continue }
        $ordinal = $attemptedRows + 1
        Write-WorkerStatusRefreshDetailHeartbeat -ProgressWriter $ProgressWriter `
            -Step 'worker_status_detail_start' -Cursor (($ordinal * 2) - 1) -Total $heartbeatTotal
        $Diagnostic.detailAttemptCount++
        $attemptedRows++
        $callTimeoutMs = [int][Math]::Max(1, [Math]::Min([long]$policy.perCallTimeoutMs, $remaining))
        $lookup = if ($DetailLookup) {
            & $DetailLookup $sessionId $Project $AoCommand $callTimeoutMs ([int]$policy.postKillDrainMs)
        }
        else {
            Invoke-WorkerStatusRefreshSessionDetailLookup -SessionId $sessionId -Project $Project `
                -AoCommand $AoCommand -TimeoutMs $callTimeoutMs -DrainTimeoutMs ([int]$policy.postKillDrainMs)
        }
        Write-WorkerStatusRefreshDetailHeartbeat -ProgressWriter $ProgressWriter `
            -Step 'worker_status_detail_done' -Cursor ($ordinal * 2) -Total $heartbeatTotal
        $acceptedDisplayName = if ($lookup.ok) {
            ConvertTo-WorkerStatusRefreshAcceptedDisplayName -Value ([string]$lookup.displayName)
        }
        else { '' }
        if (-not $lookup.ok -or -not $acceptedDisplayName) {
            $Diagnostic.detailFailureCount++
            $Diagnostic.failureCount++
            if ($lookup.timedOut) { $Diagnostic.detailTimeoutCount++ }
            $reasonCode = if ($lookup.reason) { [string]$lookup.reason } else { 'session_detail_lookup_failed' }
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $Diagnostic -SessionId $sessionId `
                -ReasonCode $reasonCode
            continue
        }
        $Diagnostic.detailSuccessCount++
        $identity = Get-WorkerStatusRefreshSessionDetailIdentity -Session $session
        $accepted = @{
            displayName = $acceptedDisplayName
            acceptedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            identitySignature = if ($identity.reusable) { [string]$identity.signature } else { '' }
        }
        $detailsById[$sessionId] = $accepted
        if ($identity.reusable) {
            $evidenceById[$sessionId] = $accepted
        }
        else {
            [void]$evidenceById.Remove($sessionId)
        }
    }

    $Diagnostic.detailElapsedMs = (Get-WorkerStatusRefreshMonotonicMs -NowProvider $NowProvider) - $startedAt
    $Diagnostic.detailSkippedByDeadlineCount = [Math]::Max(0, $attemptRows.Count - $attemptedRows)
    if ($Diagnostic.detailSkippedByDeadlineCount -gt 0) {
        $Diagnostic.detailDeadlineReached = $true
        $Diagnostic.failureCount += $Diagnostic.detailSkippedByDeadlineCount
        $firstDeferred = $attemptRows[$attemptedRows]
        Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $Diagnostic `
            -SessionId (Get-WorkerStatusRefreshSessionId -Session $firstDeferred) `
            -ReasonCode 'session_detail_deadline_reached'
    }
    if ($Diagnostic.detailSkippedByLimitCount -gt 0) {
        $firstSkipped = $eligible[($startIndex + $attemptRows.Count) % $eligible.Count]
        Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $Diagnostic `
            -SessionId (Get-WorkerStatusRefreshSessionId -Session $firstSkipped) `
            -ReasonCode 'session_detail_limit_reached'
    }

    $nextIndex = if ($eligible.Count -gt 0) { ($startIndex + $attemptedRows) % $eligible.Count } else { 0 }
    $Diagnostic.detailCursorNext = $nextIndex
    $Diagnostic.detailCacheEntryCount = $evidenceById.Count
    if ($attemptedRows -gt 0) {
        try {
            $cursorWriteNowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            if ($cursorState.missing -and $cursorState.markerMissing) {
                Write-WorkerStatusRefreshDetailCursorInitialization -CursorPath $resolvedCursorPath `
                    -NowMs $cursorWriteNowMs -Phase 'initializing'
                if ($CursorPersistenceHook) { & $CursorPersistenceHook 'after_initializing_marker' }
            }
            Write-WorkerStatusRefreshDetailCursor -Path $resolvedCursorPath -Signature $signature `
                -NextIndex $nextIndex -EvidenceById $evidenceById `
                -NowMs $cursorWriteNowMs
            if ($CursorPersistenceHook) { & $CursorPersistenceHook 'after_cursor_write' }
            if ($cursorState.missing -or $cursorState.markerMissing -or $cursorState.initializationIncomplete) {
                Write-WorkerStatusRefreshDetailCursorInitialization -CursorPath $resolvedCursorPath `
                    -NowMs $cursorWriteNowMs -Phase 'ready'
                if ($CursorPersistenceHook) { & $CursorPersistenceHook 'after_ready_marker' }
            }
        }
        catch {
            $Diagnostic.detailCursorWriteFailed = $true
            $Diagnostic.detailCursorNext = $startIndex
            $Diagnostic.failureCount++
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $Diagnostic -SessionId 'detail_cursor' `
                -ReasonCode 'session_detail_cursor_write_failed'
        }
    }

    return @(
        foreach ($session in @($Sessions)) {
            $sessionId = Get-WorkerStatusRefreshSessionId -Session $session
            if (-not $sessionId -or -not $detailsById.ContainsKey($sessionId)) {
                $session
                continue
            }
            $row = [ordered]@{}
            foreach ($prop in $session.PSObject.Properties) { $row[$prop.Name] = $prop.Value }
            $row['displayName'] = [string]$detailsById[$sessionId].displayName
            [pscustomobject]$row
        }
    )
}

function Get-WorkerStatusRefreshOsLiveness {
    param(
        $OsLivenessMap,
        [string]$SessionId
    )

    if ($OsLivenessMap -is [System.Collections.IDictionary]) {
        if ($OsLivenessMap.Contains($SessionId)) {
            return $OsLivenessMap[$SessionId]
        }
        return $null
    }
    if ($OsLivenessMap) {
        $property = $OsLivenessMap.PSObject.Properties[$SessionId]
        if ($property) { return $property.Value }
    }
    return $null
}

function Invoke-WorkerStatusRefreshRowWrite {
    param(
        [hashtable]$WriteInput,
        [string]$StorePath,
        [long]$NowMs
    )

    $retryCount = 0
    for ($attempt = 1; $attempt -le $Script:WorkerStatusRefreshWriteMaxAttempts; $attempt++) {
        try {
            $result = Write-WorkerStatusRow -WriteInput $WriteInput -StorePath $StorePath -NowMs $NowMs
        }
        catch {
            return @{
                result     = $null
                retryCount = $retryCount
                exception  = $true
            }
        }
        if ($result) {
            return @{
                result     = $result
                retryCount = $retryCount
                exception  = $false
            }
        }
        if ($attempt -lt $Script:WorkerStatusRefreshWriteMaxAttempts) {
            $retryCount++
            Start-Sleep -Milliseconds $Script:WorkerStatusRefreshWriteRetryDelayMs
        }
    }
    return @{
        result     = $null
        retryCount = $retryCount
        exception  = $false
    }
}

function Invoke-WorkerStatusRefresh {
    param(
        [string]$Project = '',
        [string]$RepoSlug = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao',
        [switch]$IncludeTerminated,
        [object[]]$Sessions = $null,
        $GithubSnapshot = $null,
        [long]$RepoTickGeneration = 0,
        [string]$StorePath = '',
        [long]$NowMs = 0,
        [string]$Owner = 'unspecified',
        [System.Collections.IDictionary]$DetailPolicy = $null,
        [string]$DetailCursorPath = '',
        [scriptblock]$ProgressWriter = $null,
        [scriptblock]$DetailLookup = $null,
        [scriptblock]$DetailNowProvider = $null,
        [scriptblock]$DetailCursorPersistenceHook = $null
    )

    if (-not $NowMs) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $sourceSessions = if ($null -ne $Sessions) {
        @($Sessions)
    }
    else {
        @(Get-WorkerStatusRefreshSourceSessions -Project $Project -RepoSlug $RepoSlug `
                -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
                -ReportFullPayload $ReportFullPayload -AoCommand $AoCommand -IncludeTerminated:$IncludeTerminated)
    }
    $diagnostic = New-WorkerStatusRefreshDiagnostic -Owner $Owner -SessionCount (@($sourceSessions).Count) -NowMs $NowMs

    if (Test-WorkerStatusKillSwitchActive) {
        $diagnostic.outcome = 'gate_closed'
        $diagnostic.reasonCode = 'kill_switch_active'
        $diagnostic.gateClosedCount = @($sourceSessions).Count
        foreach ($session in @($sourceSessions)) {
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
                -SessionId (Get-WorkerStatusRefreshSessionId -Session $session) -ReasonCode 'kill_switch_active'
        }
        $Script:LastWorkerStatusRefreshDiagnostic = $diagnostic
        return $diagnostic
    }

    $readiness = Test-WorkerStatusSiblingReadiness
    if (-not $readiness.ok) {
        $reasonCode = 'sibling_not_ready'
        if ($null -ne $readiness.workerReportStorePresent -and -not [bool]$readiness.workerReportStorePresent) {
            $reasonCode = 'worker_report_store_missing'
        }
        elseif ($null -ne $readiness.sessionPrBindingResolverPresent -and -not [bool]$readiness.sessionPrBindingResolverPresent) {
            $reasonCode = 'session_pr_binding_resolver_missing'
        }
        $diagnostic.outcome = 'gate_closed'
        $diagnostic.reasonCode = $reasonCode
        $diagnostic.gateClosedCount = @($sourceSessions).Count
        foreach ($session in @($sourceSessions)) {
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
                -SessionId (Get-WorkerStatusRefreshSessionId -Session $session) -ReasonCode $reasonCode
        }
        $Script:LastWorkerStatusRefreshDiagnostic = $diagnostic
        return $diagnostic
    }

    $isLiveRefresh = ($null -eq $Sessions -and
        $null -eq $WorkerListPayload -and
        $null -eq $OrchestratorListPayload -and
        $null -eq $ReportFullPayload)
    if ($isLiveRefresh) {
        $sourceSessions = @(Add-WorkerStatusRefreshSessionDetails -Sessions $sourceSessions `
                -Project $Project -AoCommand $AoCommand -StorePath $StorePath -CursorPath $DetailCursorPath `
                -Diagnostic $diagnostic -PolicyOverride $DetailPolicy -ProgressWriter $ProgressWriter `
                -DetailLookup $DetailLookup -NowProvider $DetailNowProvider `
                -CursorPersistenceHook $DetailCursorPersistenceHook)
        if ($diagnostic.detailCursorReadFailed -or $diagnostic.detailCursorWriteFailed) {
            $diagnostic.outcome = 'gate_closed'
            $diagnostic.reasonCode = if ($diagnostic.detailCursorReadFailed) {
                'session_detail_cursor_read_failed'
            }
            else { 'session_detail_cursor_write_failed' }
            $diagnostic.gateClosedCount = @($sourceSessions).Count
            $diagnostic.skippedCount = @($sourceSessions).Count
            $Script:LastWorkerStatusRefreshDiagnostic = $diagnostic
            return $diagnostic
        }
    }

    $resolvedRepoSlug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug
    $resolvedGithubSnapshot = $GithubSnapshot
    if (-not $resolvedGithubSnapshot) {
        $resolvedGithubSnapshot = Get-WorkerStatusRecomputeGithubSnapshot -Project $Project -Sessions $sourceSessions
    }
    if (-not $resolvedGithubSnapshot) {
        $resolvedGithubSnapshot = New-WorkerStatusEmptyGithubSnapshot
    }
    $diagnostic.githubDegraded = [bool]$resolvedGithubSnapshot.degraded

    if (-not (Get-Command Get-WorkerOsLivenessMap -ErrorAction SilentlyContinue)) {
        . (Join-Path $PSScriptRoot 'Get-WorkerOsLiveness.ps1')
    }
    $osLivenessMap = Get-WorkerOsLivenessMap -Sessions $sourceSessions

    foreach ($session in @($sourceSessions)) {
        $sessionId = Get-WorkerStatusRefreshSessionId -Session $session
        if (-not $sessionId) {
            $diagnostic.skippedCount++
            $diagnostic.failureCount++
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
                -SessionId 'unknown_session' -ReasonCode 'missing_session_id'
            continue
        }

        $diagnostic.writeAttemptCount++
        $writeInput = @{
            session                = $session
            reports                = @($session.reports)
            repoSlug               = $resolvedRepoSlug
            githubSnapshot         = $resolvedGithubSnapshot
            osLiveness             = Get-WorkerStatusRefreshOsLiveness -OsLivenessMap $osLivenessMap -SessionId $sessionId
            writerGenerationVector = Get-WorkerStatusWriterGenerationVector -SessionId $sessionId `
                    -RepoTickGeneration $RepoTickGeneration -GithubSnapshot $resolvedGithubSnapshot
        }
        $writeOutcome = Invoke-WorkerStatusRefreshRowWrite -WriteInput $writeInput -StorePath $StorePath -NowMs $NowMs
        $diagnostic.writeRetryCount += [int]$writeOutcome.retryCount
        if ($writeOutcome.exception) {
            $diagnostic.exceptionCount++
            $diagnostic.failureCount++
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
                -SessionId $sessionId -ReasonCode 'write_exception'
            continue
        }

        $result = $writeOutcome.result
        if (-not $result -or $null -eq $result.ok -or -not [bool]$result.ok) {
            $rawReason = if ($result -and $result.reason) { [string]$result.reason } else { 'write_rejected' }
            $reasonCode = Resolve-WorkerStatusRefreshReasonCode -Reason $rawReason
            $diagnostic.skippedCount++
            $diagnostic.failureCount++
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
                -SessionId $sessionId -ReasonCode $reasonCode
            continue
        }
        $diagnostic.successCount++
    }

    try {
        $eviction = Invoke-WorkerStatusStoreEviction -Sessions $sourceSessions -StorePath $StorePath -NowMs $NowMs
        if ($eviction) {
            $diagnostic.evictionRemoved = [int]$eviction.removed
        }
    }
    catch {
        $diagnostic.evictionFailed = $true
        $diagnostic.failureCount++
        Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
            -SessionId 'store' -ReasonCode 'eviction_exception'
    }

    if (@($sourceSessions).Count -eq 0) {
        $diagnostic.outcome = 'empty_fleet'
        $diagnostic.reasonCode = 'no_live_sessions'
    }
    elseif ($diagnostic.detailTimeoutCount -gt 0) {
        $diagnostic.outcome = 'partial_failure'
        $diagnostic.reasonCode = 'session_detail_lookup_timeout'
    }
    elseif ($diagnostic.detailDeadlineReached) {
        $diagnostic.outcome = 'partial_failure'
        $diagnostic.reasonCode = 'session_detail_deadline_reached'
    }
    elseif ($diagnostic.detailFailureCount -gt 0) {
        $diagnostic.outcome = 'partial_failure'
        $diagnostic.reasonCode = 'session_detail_lookup_failed'
    }
    elseif ($diagnostic.detailSkippedByLimitCount -gt 0) {
        $diagnostic.outcome = 'partial_failure'
        $diagnostic.reasonCode = 'session_detail_limit_reached'
    }
    elseif ($diagnostic.exceptionCount -gt 0 -or $diagnostic.failureCount -gt 0) {
        $diagnostic.outcome = 'partial_failure'
        $diagnostic.reasonCode = if ($diagnostic.exceptionCount -gt 0) { 'write_exception' } else { 'write_rejected' }
    }
    else {
        $diagnostic.outcome = 'success'
        $diagnostic.reasonCode = ''
    }
    $Script:LastWorkerStatusRefreshDiagnostic = $diagnostic
    return $diagnostic
}

function New-WorkerStatusDecisionUnknownRows {
    param(
        [object[]]$Sessions,
        [string]$Reason
    )

    return @($Sessions | ForEach-Object {
            $row = [ordered]@{}
            foreach ($prop in $_.PSObject.Properties) {
                $row[$prop.Name] = $prop.Value
            }
            $row['status'] = 'unknown'
            $row['workerStatus'] = 'unknown'
            $row['workerStatusDerived'] = 'unknown'
            $row['workerStatusSource'] = $Script:PackWorkerStatusStoreSurface
            $row['workerStatusWinningSource'] = 'degraded'
            $row['workerStatusStale'] = $true
            $row['workerStatusDegradedReason'] = $Reason
            $row['degradedReason'] = $Reason
            $row['workerStatusDiagnostics'] = @($Reason)
            if (-not $row['reports']) { $row['reports'] = @() }
            [pscustomobject]$row
        })
}

function Get-WorkerStatusDecisionSessionsCore {
    param(
        [string]$Project = '',
        [string]$RepoSlug = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao',
        [switch]$IncludeTerminated,
        [long]$RepoTickGeneration = 0
    )

    $sessions = @(Get-WorkerStatusRefreshSourceSessions -Project $Project -RepoSlug $RepoSlug `
            -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
            -ReportFullPayload $ReportFullPayload -AoCommand $AoCommand -IncludeTerminated:$IncludeTerminated)

    if (Test-WorkerStatusKillSwitchActive) {
        return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'kill_switch_active')
    }
    $readiness = Test-WorkerStatusSiblingReadiness
    if (-not $readiness.ok) {
        return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'sibling_not_ready')
    }

    return @(Merge-AoSessionRowsWithWorkerStatusStore -Sessions $sessions -RepoTickGeneration $RepoTickGeneration)
}

function Get-WorkerStatusReadOnlyProjection {
    param(
        [string]$Project = 'orchestrator-pack',
        [string]$RepoSlug = '',
        [string]$AoCommand = 'ao',
        [long]$RepoTickGeneration = 0
    )

    $sessions = @(Get-AoStatusSessions -Project $Project -AoCommand $AoCommand)
    if (Test-WorkerStatusKillSwitchActive) {
        return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'kill_switch_active')
    }
    $readiness = Test-WorkerStatusSiblingReadiness
    if (-not $readiness.ok) {
        return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'sibling_not_ready')
    }
    return @(Merge-AoSessionRowsWithWorkerStatusStore -Sessions $sessions -RepoTickGeneration $RepoTickGeneration)
}

function Get-WorkerStatusDecisionSessions {
    param(
        [string]$Project = '',
        [string]$RepoSlug = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao',
        [long]$RepoTickGeneration = 0
    )

    return @(Get-WorkerStatusDecisionSessionsCore -Project $Project -RepoSlug $RepoSlug `
            -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
            -ReportFullPayload $ReportFullPayload -AoCommand $AoCommand `
            -RepoTickGeneration $RepoTickGeneration)
}

function Get-WorkerStatusDecisionSessionsIncludingTerminated {
    param(
        [string]$Project = '',
        [string]$RepoSlug = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao',
        [long]$RepoTickGeneration = 0
    )

    return @(Get-WorkerStatusDecisionSessionsCore -Project $Project -RepoSlug $RepoSlug `
            -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
            -ReportFullPayload $ReportFullPayload -AoCommand $AoCommand -IncludeTerminated `
            -RepoTickGeneration $RepoTickGeneration)
}

function Assert-WorkerStatusDecisionReadAllowed {
    param(
        [string]$ScriptPath,
        [string]$RawText = ''
    )

    $text = $RawText
    if (-not $text -and $ScriptPath -and (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        $text = Get-Content -LiteralPath $ScriptPath -Raw
    }
    if ($text -match 'Get-AoStatusSessionsWithReports') {
        throw 'worker status decision reads must use Get-WorkerStatusDecisionSessions* instead of Get-AoStatusSessionsWithReports*'
    }
    return $true
}
