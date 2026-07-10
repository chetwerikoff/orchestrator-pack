#requires -Version 5.1
<#
.SYNOPSIS
  Read-only AO snapshot before orchestrator recovery escalation.

.DESCRIPTION
  Shells ao status, GET /reviews fan-out (Get-AoReviewRuns), and ao events (stuck + lifecycle) and prints
  a one-screen summary. No ao send, kills, or file writes.
  See docs/orchestrator-recovery-runbook.md.
#>
[CmdletBinding()]
param(
    [string]$OrchestratorSessionId = '',
    [string]$ProjectId = '',
    [switch]$Strict,
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'
$packRoot = [string](Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'lib/Test-WorkerLaunchFailure.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-OrchestratorWorktreeHygiene.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-OrchestratorLaunchHealth.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')

$TerminalWorkerStatuses = @(
    'done', 'merged', 'terminated', 'killed', 'errored', 'cleanup', 'closed'
)

$ActiveReviewStatuses = @(
    'changes_requested', 'needs_review', 'running', 'queued', 'preparing', 'reviewing'
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

function Test-ReviewCommandInFailureDetail {
    param(
        [string]$ReviewCommand,
        [string]$FailureDetail
    )
    if ([string]::IsNullOrWhiteSpace($ReviewCommand) -or [string]::IsNullOrWhiteSpace($FailureDetail)) {
        return $null
    }
    $scriptName = $null
    if ($ReviewCommand -match '([^\\/]+\.(?:ps1|mjs|ts))') {
        $scriptName = $Matches[1]
    }
    if ($scriptName -and $FailureDetail -notmatch [regex]::Escape($scriptName)) {
        return $scriptName
    }
    return $null
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

function Invoke-StrictGateExit {
    param(
        [array]$Runs,
        [string]$ReviewCommand,
        [string]$ExpectedReviewer = '',
        [switch]$FixtureMode
    )

    $violations = Get-PackReviewGateViolations -Runs $Runs -ReviewCommand $ReviewCommand -ExpectedReviewer $ExpectedReviewer -FixtureMode:$FixtureMode
    if ($violations.Count -eq 0) {
        Write-Host ''
        Write-Host '[PASS] Strict gate: no empty-review trap, command drift, or selector mismatch on latest run'
        return 0
    }

    Write-Host ''
    Write-Host '[FAIL] Strict gate violations (same rules as invoke-pack-review-strict-gate.ps1):'
    foreach ($v in $violations) {
        Write-Host ("  [{0}] {1}" -f $v.Kind, $v.Message)
    }

    return 1
}

if ($FixturePath) {
    $fixtureResolved = (Resolve-Path -LiteralPath $FixturePath).Path
    $payload = Get-Content -LiteralPath $fixtureResolved -Raw | ConvertFrom-Json
    $reviewCommand = [string]$payload.reviewCommand
    $runs = @($payload.runs)

    Write-Host '== Orchestrator recovery diagnostic (fixture) =='
    Write-Host ("Fixture: {0}" -f $fixtureResolved)
    Write-Host ''

    $fixtureExpectedReviewer = [string]$payload.expectedReviewer
    if ($Strict) {
        exit (Invoke-StrictGateExit -Runs $runs -ReviewCommand $reviewCommand -ExpectedReviewer $fixtureExpectedReviewer -FixtureMode)
    }

    $violations = Get-PackReviewGateViolations -Runs $runs -ReviewCommand $reviewCommand -ExpectedReviewer $fixtureExpectedReviewer -FixtureMode
    if ($violations.Count -eq 0) {
        Write-Host 'Assessment: fixture latest run passes strict gate rules'
    }
    else {
        foreach ($v in $violations) {
            Write-Host ("WARN [{0}] {1}" -f $v.Kind, $v.Message)
        }
    }

    exit 0
}

Write-Host '== Orchestrator recovery diagnostic (read-only) =='
Write-Host ("Orchestrator session: {0}" -f $orchId)
Write-Host ("Time (local): {0}" -f (Get-Date).ToString('o'))
Write-Host ''

# --- status ---
$reportProject = if ($ProjectId) { $ProjectId } else { 'orchestrator-pack' }
$sessions = @(Get-WorkerStatusDecisionSessions -Project $reportProject)
$reportSourceSummary = 'ao status --json --reports full'
if ($sessions.Count -gt 0 -and $sessions[0].reportSourcePath) {
    $reportSourceSummary = [string]$sessions[0].reportSourcePath
}
Write-Host ("Report source: {0}" -f $reportSourceSummary)

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

$orchPaths = Get-OrchestratorAoProjectPaths -SessionId $orchId
$orchPromptWarn = Get-OrchestratorPromptLaunchFeasibilityWarning -PromptFilePath $orchPaths.PromptPath
if ($orchPromptWarn) {
    Write-Host ''
    Write-Host '-- Orchestrator prompt size --'
    Write-Host "  WARN $orchPromptWarn"
}

if (Test-OrchestratorLaunchFailureCandidate -OrchestratorSession $orch) {
    Write-Host ''
    Write-Host '-- Possible orchestrator launch-failure --'
    Write-Host '  Orchestrator detecting/stuck/exited shortly after ao start or restore may be'
    Write-Host '  prompt-delivery failure (Signature A/B), not idle orchestrator.'
    Write-Host '  Inspect orchestrator PTY for: printf not recognized, unknown option -ne,'
    Write-Host '  or command line is too long.'
    Write-Host '  restoreFallbackReason: cursor.getRestoreCommand returned null is expected for Cursor.'
    Write-Host '  See docs/migration_notes.md (Orchestrator prompt-delivery launch failure, Issue #91).'
    Write-Host '  Offline: pwsh -File scripts/check-orchestrator-launch-failure.ps1 -FixturePath <pty.txt>'
    Write-Host '  After cleanup: pwsh -File scripts/wait-orchestrator-launch.ps1'
}

$hygiene = Get-OrchestratorStaleWorktreeFindings -RepoRoot $packRoot -SessionId $orchId
if ($hygiene.Findings.Count -gt 0) {
    Write-Host ''
    Write-Host ("-- Stale orchestrator worktree/branch ({0}) --" -f $hygiene.Findings.Count)
    Write-Host '  Run before ao start if spawn logs show workspace.branch_collision:'
    Write-Host '  pwsh -File scripts/orchestrator-worktree-preflight.ps1'
    foreach ($f in $hygiene.Findings) {
        Write-Host ("  [{0}] {1}" -f $f.Kind, $f.Detail)
        Write-Host ("         {0}" -f $f.Command)
    }
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
        $source = if ($w.reportSourcePath) { [string]$w.reportSourcePath } else { $reportSourceSummary }
        Write-Host ("  {0}: {1} (reports from {2})" -f $wName, $state, $source)
    }
}

# --- review runs (AO 0.10 fan-out) ---
Write-Host ''
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')

$runs = @(Get-AoReviewRuns -Project $ProjectId)

$actionable = @($runs | Where-Object {
        $st = if ($null -ne $_.prReviewStatus) { [string]$_.prReviewStatus } else { [string]$_.status }
        $ActiveReviewStatuses -contains $st
    })
$undelivered = @($actionable | Where-Object {
        $st = if ($null -ne $_.prReviewStatus) { [string]$_.prReviewStatus } else { [string]$_.status }
        $st -eq 'changes_requested' -and -not $_.deliveredAt
    })
$deliveredChanges = @($actionable | Where-Object {
        $st = if ($null -ne $_.prReviewStatus) { [string]$_.prReviewStatus } else { [string]$_.status }
        $st -eq 'changes_requested' -and $_.deliveredAt
    })

Write-Host ("-- Review runs needing attention ({0} active of {1} total) --" -f $actionable.Count, $runs.Count)
if ($actionable.Count -eq 0) {
    Write-Host '  none in undelivered/delivered changes_requested / in-flight review'
}
else {
    foreach ($r in $actionable | Select-Object -First 12) {
        $pr = if ($r.prNumber) { "PR #$($r.prNumber)" } else { '-' }
        $st = if ($null -ne $r.prReviewStatus) { [string]$r.prReviewStatus } else { [string]$r.status }
        $id = [string]$r.id
        if ($id.Length -gt 38) { $id = $id.Substring(0, 38) }
        Write-Host ("  {0,-38} {1,-16} open={2} delivered={3} {4} worker={5}" -f `
                $id, `
                $st, `
                $r.openFindingCount, `
                $r.deliveredFindingCount, `
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
    Write-Host '  none - good (still verify latest head has status up_to_date, not only absence of failures)'
}
else {
    Write-Host '  NOT up_to_date - reviewer command or Codex/Claude infra failed before findings were emitted.'
    foreach ($r in $failedEmpty | Select-Object -First 6) {
        $pr = if ($r.prNumber) { "PR #$($r.prNumber)" } else { '-' }
        $reason = ([string]$r.body -split "`n")[0]
        if ($reason.Length -gt 100) { $reason = $reason.Substring(0, 97) + '...' }
        Write-Host ("  {0}  {1,-10} {2}  worker={3}" -f $r.reviewerSessionId, $r.status, $pr, $r.linkedSessionId)
        Write-Host ("           {0}" -f $reason)
    }
    if ($failedEmpty.Count -gt 6) {
        Write-Host ("  ... and {0} more (Get-AoReviewRuns, field body/failureDetail)" -f ($failedEmpty.Count - 6))
    }
}

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
    if ($latestRun) {
        $latestStatus = if ($null -ne $latestRun.prReviewStatus) { [string]$latestRun.prReviewStatus } else { [string]$latestRun.status }
        if ($latestStatus -eq 'up_to_date') {
            Write-Host '  OK: latest run is up_to_date.'
        }
        else {
            $failureDetail = [string]$latestRun.body
            if ($failureDetail) {
                $drift = Test-ReviewCommandInFailureDetail -ReviewCommand $expectedCommand -FailureDetail $failureDetail
                if ($drift) {
                    Write-Host ("  WARN: latest run failure detail does not mention expected script ({0}) - command drift?" -f $drift)
                }
                elseif (@('failed', 'cancelled') -contains $latestRun.status) {
                    Write-Host '  WARN: latest run failed - read full body/failureDetail; do not treat zero findings as up_to_date.'
                }
            }
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

if ($Strict) {
    if (-not $expectedCommand) {
        Write-Host ''
        Write-Host '[FAIL] Strict gate: could not parse REVIEW_COMMAND from YAML'
        exit 1
    }

    $expectedReviewer = Get-PackReviewerFromSelector
    exit (Invoke-StrictGateExit -Runs $runs -ReviewCommand $expectedCommand -ExpectedReviewer $expectedReviewer)
}
