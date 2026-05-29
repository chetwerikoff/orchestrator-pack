#requires -Version 5.1
<#
.SYNOPSIS
  Read-only AO snapshot before orchestrator recovery escalation.

.DESCRIPTION
  Shells ao status, ao review list, and ao events (stuck + lifecycle) and prints
  a one-screen summary. No ao send, kills, or file writes.
  See docs/orchestrator-recovery-runbook.md.
#>
[CmdletBinding()]
param(
    [string]$OrchestratorSessionId = '',
    [string]$ProjectId = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Test-WorkerLaunchFailure.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')

$TerminalWorkerStatuses = @(
    'done', 'merged', 'terminated', 'killed', 'errored', 'cleanup', 'closed'
)

$ActiveReviewStatuses = @(
    'needs_triage', 'waiting_update', 'queued', 'preparing', 'running'
)

$WorkerReviewReportStates = @(
    'addressing_reviews', 'fixing_ci', 'ready_for_review'
)

function Get-OrchestratorSessionId {
    param([string]$CliValue)
    if ($CliValue) { return $CliValue.Trim() }
    $fromEnv = $env:AO_ORCHESTRATOR_SESSION_ID
    if ($fromEnv) { return $fromEnv.Trim() }
    return 'op-orchestrator'
}

function Invoke-AoJson {
    param([string[]]$AoArgs)

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & ao @AoArgs 2>&1
        if ($LASTEXITCODE -ne 0) {
            $text = ($raw | Out-String).Trim()
            throw "ao $($AoArgs -join ' ') failed (exit $LASTEXITCODE): $text"
        }
        $text = ($raw | ForEach-Object {
                if ($_ -is [string]) { $_ }
                elseif ($null -ne $_) { $_.ToString() }
            }) -join "`n"
        $start = $text.IndexOf('{')
        if ($start -lt 0) {
            throw "ao $($AoArgs -join ' ') produced no JSON output"
        }
        return $text.Substring($start) | ConvertFrom-Json
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
}

function Format-Ago {
    param([string]$Iso)
    if (-not $Iso) { return 'n/a' }
    try {
        $dt = [datetime]::Parse($Iso, $null, [Globalization.DateTimeStyles]::RoundtripKind)
        $span = (Get-Date).ToUniversalTime() - $dt.ToUniversalTime()
        if ($span.TotalMinutes -lt 60) {
            return ('{0:F0}m ago' -f $span.TotalMinutes)
        }
        if ($span.TotalHours -lt 48) {
            return ('{0:F1}h ago' -f $span.TotalHours)
        }
        return ('{0:F1}d ago' -f $span.TotalDays)
    }
    catch {
        return $Iso
    }
}

$orchId = Get-OrchestratorSessionId -CliValue $OrchestratorSessionId

Write-Host '== Orchestrator recovery diagnostic (read-only) =='
Write-Host ("Orchestrator session: {0}" -f $orchId)
Write-Host ("Time (local): {0}" -f (Get-Date).ToString('o'))
Write-Host ''

# --- status ---
$statusArgs = @('status', '--json', '--reports', 'full')
if ($ProjectId) { $statusArgs += @('-p', $ProjectId) }
$statusPayload = Invoke-AoJson -AoArgs $statusArgs
$sessions = @($statusPayload.data)
if (-not $sessions -and $statusPayload.sessions) {
    $sessions = @($statusPayload.sessions)
}

$orch = $sessions | Where-Object { $_.name -eq $orchId -or $_.sessionId -eq $orchId } | Select-Object -First 1
if (-not $orch) {
    $orch = $sessions | Where-Object { $_.role -eq 'orchestrator' } | Select-Object -First 1
}

Write-Host '-- Orchestrator --'
if ($orch) {
    $orchName = if ($orch.name) { $orch.name } else { $orch.sessionId }
    Write-Host ("  id:       {0}" -f $orchName)
    Write-Host ("  status:   {0}" -f $orch.status)
    Write-Host ("  activity: {0}" -f ($(if ($orch.activity) { $orch.activity } else { '-' })))
    Write-Host ("  last:     {0}" -f $orch.lastActivity)
    $reportCount = @($orch.reports).Count
    Write-Host ("  reports:  {0} entries" -f $reportCount)
}
else {
    Write-Host '  (orchestrator session not found in ao status)'
}

$allWorkers = @($sessions | Where-Object { $_.role -eq 'worker' })
$workers = @($allWorkers | Where-Object {
        ($TerminalWorkerStatuses -notcontains $_.status)
    })

function Test-LaunchFailureWorkerCandidate {
    param($Worker)

    $noPr = (-not $Worker.prNumber) -and (-not $Worker.pr)
    if (-not $noPr) { return $false }
    if (@('detecting', 'stuck', 'exited', 'errored') -contains $Worker.status) {
        return $true
    }
    if ($Worker.activity -eq 'exited') {
        return $true
    }
    return $false
}

$launchFailureWorkers = @(
    $allWorkers | Where-Object { Test-LaunchFailureWorkerCandidate $_ } |
        ForEach-Object { if ($_.name) { $_.name } else { $_.sessionId } }
)

Write-Host ''
Write-Host ("-- Active workers ({0}) --" -f $workers.Count)
if ($workers.Count -eq 0) {
    Write-Host '  none'
}
else {
    foreach ($w in $workers) {
        $wName = if ($w.name) { $w.name } else { $w.sessionId }
        $pr = if ($w.prNumber) { "PR #$($w.prNumber)" } elseif ($w.pr) { $w.pr } else { '-' }
        $issue = if ($w.issue) { "issue #$($w.issue)" } else { '-' }
        $lastReport = '-'
        if ($w.reports -and $w.reports.Count -gt 0) {
            $last = $w.reports[0]
            $lastReport = $last.reportState
            if (-not $lastReport) { $lastReport = $last.report_state }
        }
        Write-Host ("  {0,-18} status={1,-12} {2,-10} {3,-12} lastReport={4}" -f `
                $wName, $w.status, $pr, $issue, $lastReport)
    }
}

if ($launchFailureWorkers.Count -gt 0) {
    Write-Host ''
    Write-Host ("-- Possible worker launch-failure ({0}) --" -f $launchFailureWorkers.Count)
    Write-Host '  Worker exited, errored, or detecting with no PR shortly after spawn may be'
    Write-Host '  prompt-delivery failure (Signature A/B), not orchestrator stuck.'
    Write-Host '  Inspect session terminal for: printf not recognized, unknown option -ne,'
    Write-Host '  or command line is too long.'
    Write-Host '  See docs/migration_notes.md (Worker prompt-delivery launch failure).'
    Write-Host '  Offline: pwsh -File scripts/check-worker-launch-failure.ps1 -FixturePath <pty.txt>'
    foreach ($name in $launchFailureWorkers) {
        Write-Host ("  - {0}" -f $name)
    }
}

$reviewReports = @($workers | Where-Object {
        if (-not $_.reports) { return $false }
        $last = $_.reports[0]
        $state = $last.reportState
        if (-not $state) { $state = $last.report_state }
        return ($WorkerReviewReportStates -contains $state)
    })
if ($reviewReports.Count -gt 0) {
    Write-Host ''
    Write-Host ("-- Workers in review-related report state ({0}) --" -f $reviewReports.Count)
    foreach ($w in $reviewReports) {
        $wName = if ($w.name) { $w.name } else { $w.sessionId }
        $last = $w.reports[0]
        $state = $last.reportState
        if (-not $state) { $state = $last.report_state }
        Write-Host ("  {0}: {1}" -f $wName, $state)
    }
}

# --- review list ---
Write-Host ''
# ao review list takes [project] as a positional argument (not -p); place it before --json.
$reviewArgs = @('review', 'list')
if ($ProjectId) { $reviewArgs += $ProjectId }
$reviewArgs += '--json'
$reviewPayload = Invoke-AoJson -AoArgs $reviewArgs
$runs = @($reviewPayload.runs)
if (-not $runs -and $reviewPayload.data) { $runs = @($reviewPayload.data) }
if ($ProjectId) {
    $runs = @($runs | Where-Object { $_.projectId -eq $ProjectId })
}

$actionable = @($runs | Where-Object { $ActiveReviewStatuses -contains $_.status })
$needsTriage = @($actionable | Where-Object { $_.status -eq 'needs_triage' })
$waitingUpdate = @($actionable | Where-Object { $_.status -eq 'waiting_update' })

Write-Host ("-- Review runs needing attention ({0} active of {1} total) --" -f $actionable.Count, $runs.Count)
if ($actionable.Count -eq 0) {
    Write-Host '  none in needs_triage / waiting_update / in-flight review'
}
else {
    foreach ($r in $actionable | Select-Object -First 12) {
        $pr = if ($r.prNumber) { "PR #$($r.prNumber)" } else { '-' }
        Write-Host ("  {0,-38} {1,-16} open={2} sent={3} {4} worker={5}" -f `
                $r.id.Substring(0, [Math]::Min(38, $r.id.Length)), `
                $r.status, `
                $r.openFindingCount, `
                $r.sentFindingCount, `
                $pr, `
                $r.linkedSessionId)
    }
    if ($actionable.Count -gt 12) {
        Write-Host ("  ... and {0} more" -f ($actionable.Count - 12))
    }
}

$failedEmpty = @(
    $runs | Where-Object {
            @('failed', 'cancelled') -contains $_.status -and
            [int]$_.findingCount -eq 0 -and
            [int]$_.openFindingCount -eq 0
        } |
        Sort-Object { [datetime]$_.completedAt } -Descending
)

Write-Host ''
Write-Host ("-- Empty failed reviews (failed/cancelled, findingCount=0): {0} --" -f $failedEmpty.Count)
if ($failedEmpty.Count -eq 0) {
    Write-Host '  none - good (still verify latest head has status clean, not only absence of failures)'
}
else {
    Write-Host '  NOT clean - reviewer command or Codex/Claude infra failed before findings were emitted.'
    foreach ($r in $failedEmpty | Select-Object -First 6) {
        $pr = if ($r.prNumber) { "PR #$($r.prNumber)" } else { '-' }
        $reason = ($r.terminationReason -split "`n")[0]
        if ($reason.Length -gt 100) { $reason = $reason.Substring(0, 97) + '...' }
        Write-Host ("  {0}  {1,-10} {2}  worker={3}" -f $r.reviewerSessionId, $r.status, $pr, $r.linkedSessionId)
        Write-Host ("           {0}" -f $reason)
    }
    if ($failedEmpty.Count -gt 6) {
        Write-Host ("  ... and {0} more (ao review list --json, field terminationReason)" -f ($failedEmpty.Count - 6))
    }
}

$packRoot = Split-Path -Parent $PSScriptRoot
$liveYaml = Join-Path $packRoot 'agent-orchestrator.yaml'
$exampleYaml = Join-Path $packRoot 'agent-orchestrator.yaml.example'
$configPath = if (Test-Path -LiteralPath $liveYaml -PathType Leaf) { $liveYaml } else { $exampleYaml }
$expectedCommand = Get-PackReviewCommandFromYaml -YamlPath $configPath
$latestRun = $runs | Sort-Object { [datetime]$_.completedAt } -Descending | Select-Object -First 1

Write-Host ''
Write-Host '-- REVIEW_COMMAND alignment --'
if ($expectedCommand) {
    Write-Host ("  config: {0}" -f $configPath)
    $cmdPreview = $expectedCommand
    if ($cmdPreview.Length -gt 110) { $cmdPreview = $cmdPreview.Substring(0, 107) + '...' }
    Write-Host ("  REVIEW_COMMAND: {0}" -f $cmdPreview)
    if ($latestRun -and $latestRun.terminationReason) {
        $drift = Test-ReviewCommandInTerminationReason -ReviewCommand $expectedCommand -TerminationReason $latestRun.terminationReason
        if ($drift) {
            Write-Host ("  WARN: latest run terminationReason does not mention expected script ({0}) - command drift?" -f $drift)
        }
        elseif (@('failed', 'cancelled') -contains $latestRun.status) {
            Write-Host '  WARN: latest run failed - read full terminationReason; do not treat zero findings as clean.'
        }
        elseif ($latestRun.status -eq 'clean') {
            Write-Host '  OK: latest run is clean.'
        }
    }
}
else {
    Write-Host '  (could not parse REVIEW_COMMAND from YAML)'
}

# --- events: stuck ---
Write-Host ''
$stuckArgs = @('events', 'list', '--since', '30m', '--kind', 'session.stuck', '--json')
if ($ProjectId) { $stuckArgs += @('-p', $ProjectId) }
$stuckPayload = Invoke-AoJson -AoArgs $stuckArgs
$stuckEvents = @($stuckPayload.events)
$orchStuck = @($stuckEvents | Where-Object { $_.sessionId -eq $orchId })

Write-Host ("-- session.stuck events (last 30m): {0} total, {1} for orchestrator --" -f $stuckEvents.Count, $orchStuck.Count)
foreach ($e in $orchStuck | Select-Object -First 5) {
    Write-Host ("  {0}  {1}" -f (Format-Ago $e.ts), $(if ($e.summary) { $e.summary } else { $e.kind }))
}
if ($orchStuck.Count -eq 0 -and $stuckEvents.Count -gt 0) {
    Write-Host '  (stuck events exist for other sessions — see ao events list)'
}

# --- events: lifecycle on orchestrator ---
$lifeArgs = @(
    'events', 'list', '--since', '2h', '--type', 'lifecycle.transition',
    '-s', $orchId, '--json', '-n', '5'
)
if ($ProjectId) { $lifeArgs += @('-p', $ProjectId) }
$lifePayload = Invoke-AoJson -AoArgs $lifeArgs
$lifeEvents = @($lifePayload.events)

Write-Host ''
Write-Host ("-- Orchestrator lifecycle.transition (last 2h, newest first, {0}) --" -f $lifeEvents.Count)
foreach ($e in $lifeEvents | Select-Object -First 5) {
    $detail = $e.summary
    if (-not $detail -and $e.data) {
        $detail = ('{0} -> {1}' -f $e.data.from, $e.data.to)
    }
    Write-Host ("  {0}  {1}" -f (Format-Ago $e.ts), $detail)
}
if ($lifeEvents.Count -eq 0) {
    Write-Host '  none - long idle may support stuck diagnosis if workers/reviews are active'
}

# --- recommendation line ---
Write-Host ''
$likelyStuck = $false
if ($orch -and @('stuck', 'probe_failure') -contains $orch.status) { $likelyStuck = $true }
if ($orchStuck.Count -gt 0) { $likelyStuck = $true }

$hasInflight = ($workers.Count -gt 0) -or ($actionable.Count -gt 0) -or ($reviewReports.Count -gt 0)

if (-not $hasInflight -and -not $likelyStuck) {
    Write-Host 'Assessment: likely idle — ping optional; escalation probably not needed.'
}
elseif ($likelyStuck -and $hasInflight) {
    Write-Host 'Assessment: stuck signal WITH in-flight work — follow runbook step 1 (ping), then step 2–3 if unchanged.'
}
elseif ($likelyStuck) {
    Write-Host 'Assessment: stuck signal, no active workers/reviews — step 1 ping, then step 3 if no transition.'
}
elseif ($hasInflight) {
    Write-Host 'Assessment: in-flight work present; orchestrator may need ping (step 1) even if not flagged stuck.'
}
else {
    Write-Host 'Assessment: re-check ao status; see docs/orchestrator-recovery-runbook.md.'
}

Write-Host ''
Write-Host 'Next: docs/orchestrator-recovery-runbook.md (read-only until step 3)'
