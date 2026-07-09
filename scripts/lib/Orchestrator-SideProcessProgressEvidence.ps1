#requires -Version 5.1
<#
  Progress-evidenced heartbeat semantics for supervised side-process children (Issue #473).
#>

. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessProgress.ps1')

$Script:SideProcessProgressSchemaVersion = 2
$Script:SideProcessProgressWorkEvidenceChildId = 'review-ready-report-state-seed'
$Script:SideProcessProgressMaxWorkStepLength = 64
$Script:SideProcessProgressMaxTickIdLength = 64

function Get-OrchestratorSideProcessNowMs {
    if ($env:AO_SIDE_PROCESS_NOW_MS -and [long]::TryParse($env:AO_SIDE_PROCESS_NOW_MS, [ref]$null)) {
        return [long]$env:AO_SIDE_PROCESS_NOW_MS
    }
    return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function Get-OrchestratorSideProcessProgressSchemaVersion {
    param($Progress)

    if (-not $Progress -or $null -eq $Progress.progressSchemaVersion) {
        return 1
    }
    return [Math]::Max(1, [int]$Progress.progressSchemaVersion)
}

function Test-OrchestratorSideProcessProgressRecordTrusted {
    param(
        $Progress,
        [long]$NowMs = 0
    )

    if (-not $Progress) {
        return $false
    }

    if (-not $Progress.lastProgressMs) {
        return $false
    }

    $lastMs = 0
    if (-not [long]::TryParse([string]$Progress.lastProgressMs, [ref]$lastMs)) {
        return $false
    }

    if ($lastMs -le 0) {
        return $false
    }

    if ($NowMs -le 0) {
        $NowMs = Get-OrchestratorSideProcessNowMs
    }

    # Future-skewed records are not trusted as fresh evidence.
    if ($lastMs -gt ($NowMs + 60000)) {
        return $false
    }

    return $true
}

function Test-OrchestratorSideProcessProgressTerminalPhase {
    param([string]$Phase)

    return $Phase -in @('tick_success', 'tick_error', 'tick_complete', 'tick_skipped')
}

function Test-OrchestratorSideProcessProgressChildRequiresWorkEvidence {
    param(
        [string]$ChildId = '',
        $Progress = $null
    )

    $resolvedId = $ChildId
    if (-not $resolvedId -and $Progress -and $Progress.childId) {
        $resolvedId = [string]$Progress.childId
    }

    return ($resolvedId -eq $Script:SideProcessProgressWorkEvidenceChildId)
}

function Test-OrchestratorSideProcessProgressHasWorkEvidence {
    param($Progress)

    if (-not $Progress) {
        return $false
    }

    $phase = [string]$Progress.phase
    if (Test-OrchestratorSideProcessProgressTerminalPhase -Phase $phase) {
        return $true
    }

    if (Get-OrchestratorSideProcessProgressSchemaVersion -Progress $Progress -lt $Script:SideProcessProgressSchemaVersion) {
        return $false
    }

    if (-not $Progress.workStep) {
        return $false
    }

    if ($null -eq $Progress.workCursor -or $null -eq $Progress.workTotal) {
        return $false
    }

    $cursor = 0
    $total = 0
    if (-not [int]::TryParse([string]$Progress.workCursor, [ref]$cursor)) {
        return $false
    }
    if (-not [int]::TryParse([string]$Progress.workTotal, [ref]$total)) {
        return $false
    }
    if ($total -le 0 -or $cursor -lt 0 -or $cursor -gt $total) {
        return $false
    }

    return $true
}

function Test-OrchestratorSideProcessProgressIdentityMatches {
    param(
        $Progress,
        [int]$ChildPid,
        [string]$TickId = ''
    )

    if (-not $Progress) {
        return $false
    }

    $progressPid = 0
    if ($Progress.pid) {
        $progressPid = [int]$Progress.pid
    }

    if ($ChildPid -gt 0 -and $progressPid -gt 0 -and $progressPid -ne $ChildPid) {
        return $false
    }

    if ($TickId) {
        $recordTickId = [string]$Progress.tickId
        if (-not $recordTickId -or $recordTickId -ne $TickId) {
            return $false
        }
    }

    return $true
}

function Test-OrchestratorSideProcessProgressBelongsToChildGeneration {
    param(
        $Progress,
        [int]$ChildPid = 0,
        [long]$ChildStartedMs = 0
    )

    if (-not $Progress -or -not $Progress.lastProgressMs) {
        return $false
    }

    if ($ChildPid -gt 0 -and -not (Test-OrchestratorSideProcessProgressIdentityMatches -Progress $Progress -ChildPid $ChildPid)) {
        return $false
    }

    if ($ChildStartedMs -gt 0) {
        $lastMs = 0
        if (-not [long]::TryParse([string]$Progress.lastProgressMs, [ref]$lastMs)) {
            return $false
        }
        if ($lastMs -lt $ChildStartedMs) {
            return $false
        }
    }

    return $true
}

function Test-OrchestratorSideProcessProgressShowsForwardWork {
    param(
        $Progress,
        $PriorProgress
    )

    if (-not (Test-OrchestratorSideProcessProgressHasWorkEvidence -Progress $Progress)) {
        return $false
    }

    if (-not $PriorProgress) {
        return $true
    }

    $phase = [string]$Progress.phase
    if (Test-OrchestratorSideProcessProgressTerminalPhase -Phase $phase) {
        return $true
    }

    $cursor = [int]$Progress.workCursor
    $priorCursor = [int]$PriorProgress.workCursor
    if ($cursor -gt $priorCursor) {
        return $true
    }

    $step = [string]$Progress.workStep
    $priorStep = [string]$PriorProgress.workStep
    return ($step -and $priorStep -and $step -ne $priorStep)
}

function Resolve-OrchestratorSideProcessProgressForFreshness {
    param(
        $Progress,
        [int]$ChildPid = 0,
        [string]$TickId = '',
        [long]$NowMs = 0,
        [string]$ChildId = ''
    )

    if (-not (Test-OrchestratorSideProcessProgressRecordTrusted -Progress $Progress -NowMs $NowMs)) {
        return $null
    }

    if ($ChildPid -gt 0 -and -not (Test-OrchestratorSideProcessProgressIdentityMatches -Progress $Progress -ChildPid $ChildPid -TickId $TickId)) {
        return $null
    }

    $schema = Get-OrchestratorSideProcessProgressSchemaVersion -Progress $Progress
    $phase = [string]$Progress.phase
    if ((Test-OrchestratorSideProcessProgressChildRequiresWorkEvidence -ChildId $ChildId -Progress $Progress) -and
        $schema -lt $Script:SideProcessProgressSchemaVersion -and $phase -eq 'poll' -and
        -not (Test-OrchestratorSideProcessProgressHasWorkEvidence -Progress $Progress)) {
        return $null
    }

    return $Progress
}

function Get-OrchestratorSideProcessProgressFreshnessVerdict {
    param(
        $Progress,
        [int]$ChildPid = 0,
        [int]$StallThresholdMs = 0,
        [long]$NowMs = 0,
        [string]$TickId = '',
        $PriorProgress = $null,
        [string]$ChildId = ''
    )

    if ($NowMs -le 0) {
        $NowMs = Get-OrchestratorSideProcessNowMs
    }

    if (-not $Progress) {
        return @{
            Fresh  = $false
            Status = 'no_progress'
            Reason = 'no progress heartbeat'
        }
    }

    if (-not (Test-OrchestratorSideProcessProgressRecordTrusted -Progress $Progress -NowMs $NowMs)) {
        return @{
            Fresh  = $false
            Status = 'corrupt_progress'
            Reason = 'untrusted progress record'
        }
    }

    $progressPid = 0
    if ($Progress.pid) {
        $progressPid = [int]$Progress.pid
    }
    if ($ChildPid -gt 0 -and $progressPid -gt 0 -and $progressPid -ne $ChildPid) {
        return @{
            Fresh  = $false
            Status = 'stale_identity'
            Reason = 'stale progress from prior process'
        }
    }

    if ($TickId) {
        $recordTickId = [string]$Progress.tickId
        if ($recordTickId -and $recordTickId -ne $TickId) {
            return @{
                Fresh  = $false
                Status = 'stale_identity'
                Reason = 'stale progress from prior tick'
            }
        }
    }

    $resolved = Resolve-OrchestratorSideProcessProgressForFreshness -Progress $Progress -ChildPid $ChildPid -TickId $TickId -NowMs $NowMs -ChildId $ChildId
    if (-not $resolved) {
        return @{
            Fresh  = $false
            Status = 'stale_poll'
            Reason = 'sparse poll progress without work evidence'
        }
    }

    if ($PriorProgress -and -not (Test-OrchestratorSideProcessProgressShowsForwardWork -Progress $resolved -PriorProgress $PriorProgress)) {
        $phase = [string]$resolved.phase
        if (-not (Test-OrchestratorSideProcessProgressTerminalPhase -Phase $phase)) {
            return @{
                Fresh  = $false
                Status = 'livelock'
                Reason = 'heartbeat without forward work evidence'
            }
        }
    }

    if ($StallThresholdMs -gt 0) {
        $lastMs = [long]$resolved.lastProgressMs
        if (($NowMs - $lastMs) -ge $StallThresholdMs) {
            return @{
                Fresh  = $false
                Status = 'hang'
                Reason = 'no fresh tick progress'
            }
        }
    }

    return @{
        Fresh  = $true
        Status = 'fresh'
        Reason = ''
    }
}

function Write-OrchestratorSideProcessWorkHeartbeat {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ChildId,
        [Parameter(Mandatory = $true)]
        [string]$Phase,
        [Parameter(Mandatory = $true)]
        [string]$WorkStep,
        [Parameter(Mandatory = $true)]
        [int]$WorkCursor,
        [Parameter(Mandatory = $true)]
        [int]$WorkTotal,
        [string]$TickId = '',
        [hashtable]$Extra = @{}
    )

    $boundedStep = $WorkStep
    if ($boundedStep.Length -gt $Script:SideProcessProgressMaxWorkStepLength) {
        $boundedStep = $boundedStep.Substring(0, $Script:SideProcessProgressMaxWorkStepLength)
    }

    $boundedTickId = $TickId
    if ($boundedTickId.Length -gt $Script:SideProcessProgressMaxTickIdLength) {
        $boundedTickId = $boundedTickId.Substring(0, $Script:SideProcessProgressMaxTickIdLength)
    }

    $payload = @{
        progressSchemaVersion = $Script:SideProcessProgressSchemaVersion
        workStep              = $boundedStep
        workCursor            = [Math]::Max(0, $WorkCursor)
        workTotal             = [Math]::Max(1, $WorkTotal)
    }
    if ($boundedTickId) {
        $payload.tickId = $boundedTickId
    }

    foreach ($key in $Extra.Keys) {
        $payload[$key] = $Extra[$key]
    }

    Write-OrchestratorSideProcessProgress -ChildId $ChildId -Phase $Phase -Extra $payload
}
