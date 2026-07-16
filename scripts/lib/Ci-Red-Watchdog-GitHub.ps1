#requires -Version 5.1
<# GitHub/check-run evidence helpers for the CI-red watchdog (Issue #755). #>

function Get-CiRedWatchdogProperty {
    param(
        [object]$Object,
        [string[]]$Names
    )
    foreach ($name in $Names) {
        if ($null -eq $Object) { continue }
        if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($name)) {
            $value = $Object[$name]
            if ($null -ne $value -and "$value" -ne '') { return $value }
        }
        elseif ($Object.PSObject.Properties.Name -contains $name) {
            $value = $Object.$name
            if ($null -ne $value -and "$value" -ne '') { return $value }
        }
    }
    return $null
}

function Get-CiRedWatchdogMapEntry {
    param(
        [object]$Map,
        [string]$Key
    )
    if ($null -eq $Map) { return $null }
    if ($Map -is [System.Collections.IDictionary]) {
        if ($Map.Contains($Key)) { return $Map[$Key] }
        return $null
    }
    if ($Map.PSObject.Properties.Name -contains $Key) { return $Map.$Key }
    return $null
}

function Get-CiRedWatchdogChecksForPr {
    param(
        [object]$ChecksBundle,
        [int]$PrNumber
    )
    $map = Get-CiRedWatchdogProperty -Object $ChecksBundle -Names @('ciChecksByPr')
    $direct = Get-CiRedWatchdogMapEntry -Map $map -Key ([string]$PrNumber)
    if ($null -ne $direct) { return @($direct) }
    foreach ($row in @($map)) {
        if ([int](Get-CiRedWatchdogProperty -Object $row -Names @('prNumber', 'pr')) -eq $PrNumber) {
            return @((Get-CiRedWatchdogProperty -Object $row -Names @('checks')))
        }
    }
    return @()
}

function Get-CiRedWatchdogRequiredContextsForPr {
    param(
        [object]$ChecksBundle,
        [int]$PrNumber
    )
    $map = Get-CiRedWatchdogProperty -Object $ChecksBundle -Names @('requiredCheckNamesByPr')
    $direct = Get-CiRedWatchdogMapEntry -Map $map -Key ([string]$PrNumber)
    if ($null -ne $direct) { return @($direct) }
    foreach ($row in @($map)) {
        if ([int](Get-CiRedWatchdogProperty -Object $row -Names @('prNumber', 'pr')) -eq $PrNumber) {
            return @((Get-CiRedWatchdogProperty -Object $row -Names @('requiredCheckNames', 'contexts', 'checks')))
        }
    }
    return @()
}

function Resolve-CiRedWatchdogRequiredContext {
    param([object]$Value)
    if ($Value -is [string]) {
        return @{ MatchName = $Value.Trim(); Identity = $Value.Trim(); AppId = '' }
    }
    $name = [string](Get-CiRedWatchdogProperty -Object $Value -Names @('context', 'name'))
    $appId = [string](Get-CiRedWatchdogProperty -Object $Value -Names @('app_id', 'appId'))
    if (-not $name) { return $null }
    $identity = if ($appId) { "$name@app:$appId" } else { $name }
    return @{ MatchName = $name; Identity = $identity; AppId = $appId }
}

function Test-CiRedWatchdogFailureConclusion {
    param([object]$Check)
    $value = [string](Get-CiRedWatchdogProperty -Object $Check -Names @('conclusion', 'state', 'bucket'))
    return $value.ToLowerInvariant() -in @('failure', 'failed', 'fail', 'cancelled', 'timed_out', 'action_required', 'startup_failure')
}

function Get-CiRedWatchdogRepoSlug {
    param([string]$RepoRoot)
    try {
        if (Get-Command Get-RepoIdentity -ErrorAction SilentlyContinue) {
            $identity = Get-RepoIdentity
            if ($identity -is [string] -and $identity -match '^[^/]+/[^/]+$') { return $identity }
            $slug = [string](Get-CiRedWatchdogProperty -Object $identity -Names @('repo', 'repository', 'slug', 'nameWithOwner', 'repoFullName', 'repositoryFullName'))
            if ($slug -match '^[^/]+/[^/]+$') { return $slug }
        }
    }
    catch { }
    Push-Location -LiteralPath $RepoRoot
    try {
        $slug = ([string](& gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>$null | Select-Object -First 1)).Trim()
        if ($LASTEXITCODE -eq 0 -and $slug -match '^[^/]+/[^/]+$') { return $slug }
    }
    finally {
        Pop-Location
    }
    return ''
}

function Invoke-CiRedWatchdogGhJson {
    param(
        [string]$RepoRoot,
        [string[]]$Arguments
    )

    $result = Invoke-GhSignalJsonCommand `
        -Arguments $Arguments `
        -ExpectedRoot 'object' `
        -WorkingDirectory $RepoRoot
    if (-not $result.ok) {
        return @{
            ok = $false
            reason = [string]$result.reason
            detail = (Format-GhSignalFailureDetail -Result $result)
            exitCode = $result.exitCode
        }
    }
    return @{
        ok = $true
        value = $result.value
        classification = [string]$result.classification
    }
}

function Convert-CiRedWatchdogGhLogRows {
    param(
        [object[]]$Lines,
        [string]$JobId,
        [string]$StepName
    )
    $rows = @()
    foreach ($rawLine in @($Lines)) {
        $line = [string]$rawLine
        $parts = $line -split "`t", 4
        if ($parts.Count -ge 4) {
            if ([string]$parts[1] -ne $StepName) { continue }
            $rows += @{ jobId = $JobId; stepName = $StepName; text = [string]$parts[3] }
            continue
        }
        if ($line.Trim()) {
            $rows += @{ jobId = $JobId; stepName = $StepName; text = $line }
        }
    }
    return @($rows)
}

function Get-CiRedWatchdogAuthoritativeCheck {
    param(
        [string]$RepoRoot,
        [string]$RepoSlug,
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$RequiredContext,
        [string]$RequiredAppId = '',
        [object]$CheckRow,
        [switch]$MetadataOnly
    )

    $fixtureCheckRunId = [string](Get-CiRedWatchdogProperty -Object $CheckRow -Names @('checkRunId', 'check_run_id', 'databaseId'))
    $fixtureAttempt = [int](Get-CiRedWatchdogProperty -Object $CheckRow -Names @('attempt', 'runAttempt', 'run_attempt'))
    $fixtureDiagnostic = [string](Get-CiRedWatchdogProperty -Object $CheckRow -Names @('diagnosticLog', 'diagnostic', 'firstFailingStepLog'))
    if ($fixtureCheckRunId -and $fixtureAttempt -gt 0) {
        $stepName = [string](Get-CiRedWatchdogProperty -Object $CheckRow -Names @('firstFailingStep', 'stepName'))
        return @{
            ok            = $true
            checkRunId    = $fixtureCheckRunId
            runId         = [string](Get-CiRedWatchdogProperty -Object $CheckRow -Names @('runId', 'workflowRunId'))
            attempt       = $fixtureAttempt
            conclusion    = [string](Get-CiRedWatchdogProperty -Object $CheckRow -Names @('conclusion', 'state', 'bucket'))
            headSha       = $HeadSha
            stepName      = $stepName
            diagnosticRaw = if ($MetadataOnly) { '' } else { $fixtureDiagnostic }
            diagnosticOk = [bool]($MetadataOnly -or $fixtureDiagnostic)
            diagnosticReason = if ($MetadataOnly -or $fixtureDiagnostic) { '' } else { 'first_failing_step_log_empty' }
        }
    }

    if (-not $RepoSlug) { return @{ ok = $false; reason = 'repo_slug_unresolved' } }
    $runsResult = Invoke-CiRedWatchdogGhJson -RepoRoot $RepoRoot -Arguments @('api', "repos/$RepoSlug/commits/$HeadSha/check-runs?per_page=100")
    if (-not $runsResult.ok) { return @{ ok = $false; reason = 'check_runs_unavailable' } }
    $checkRuns = @($runsResult.value.check_runs | Where-Object {
        if ([string]$_.name -ne $RequiredContext) { return $false }
        if (-not $RequiredAppId) { return $true }
        return [string]$_.app.id -eq $RequiredAppId
    })
    if ($checkRuns.Count -eq 0) { return @{ ok = $false; reason = 'required_check_run_missing' } }
    $checkRun = $checkRuns | Sort-Object {
        $stamp = [string](Get-CiRedWatchdogProperty -Object $_ -Names @('completed_at', 'started_at', 'created_at'))
        if ($stamp) { [DateTimeOffset]::Parse($stamp).ToUnixTimeMilliseconds() } else { [long]$_.id }
    } -Descending | Select-Object -First 1
    if (-not (Test-CiRedWatchdogFailureConclusion -Check $checkRun)) {
        return @{ ok = $false; reason = 'latest_required_check_not_failing' }
    }
    $detailsUrl = [string]$checkRun.details_url
    $runId = ''
    $jobId = ''
    if ($detailsUrl -match '/actions/runs/(\d+)') { $runId = $Matches[1] }
    if ($detailsUrl -match '/job/(\d+)') { $jobId = $Matches[1] }
    if (-not $runId) { return @{ ok = $false; reason = 'unsupported_check_provider' } }

    $runResult = Invoke-CiRedWatchdogGhJson -RepoRoot $RepoRoot -Arguments @('api', "repos/$RepoSlug/actions/runs/$runId")
    if (-not $runResult.ok) { return @{ ok = $false; reason = 'workflow_run_unavailable' } }
    $run = $runResult.value
    if ([string]$run.head_sha -ne $HeadSha) { return @{ ok = $false; reason = 'workflow_run_head_mismatch' } }
    $attempt = [int]$run.run_attempt
    if ($attempt -le 0) { return @{ ok = $false; reason = 'workflow_attempt_missing' } }
    if ($MetadataOnly) {
        return @{
            ok = $true; checkRunId = [string]$checkRun.id; runId = $runId; attempt = $attempt
            conclusion = [string]$checkRun.conclusion; headSha = $HeadSha; diagnosticOk = $true
        }
    }

    $jobsEndpoint = "repos/$RepoSlug/actions/runs/$runId/attempts/$attempt/jobs?per_page=100"
    $jobsResult = Invoke-CiRedWatchdogGhJson -RepoRoot $RepoRoot -Arguments @('api', $jobsEndpoint)
    if (-not $jobsResult.ok) {
        $jobsResult = Invoke-CiRedWatchdogGhJson -RepoRoot $RepoRoot -Arguments @('api', "repos/$RepoSlug/actions/runs/$runId/jobs?filter=latest&per_page=100")
    }
    if (-not $jobsResult.ok) { return @{ ok = $false; reason = 'workflow_jobs_unavailable' } }
    $jobs = @($jobsResult.value.jobs)
    $job = $null
    if ($jobId) { $job = $jobs | Where-Object { [string]$_.id -eq $jobId } | Select-Object -First 1 }
    if (-not $job) {
        $job = $jobs | Where-Object {
            [string]$_.name -eq $RequiredContext -and (Test-CiRedWatchdogFailureConclusion -Check $_)
        } | Sort-Object started_at | Select-Object -First 1
    }
    if (-not $job) { return @{ ok = $false; reason = 'failing_job_for_required_check_missing' } }
    $jobId = [string]$job.id
    $step = @($job.steps | Where-Object { Test-CiRedWatchdogFailureConclusion -Check $_ } | Sort-Object number | Select-Object -First 1)
    if ($step.Count -eq 0) { return @{ ok = $false; reason = 'first_failing_step_not_found' } }
    $stepName = [string]$step[0].name

    Push-Location -LiteralPath $RepoRoot
    try {
        $logLines = @(& gh run view $runId --attempt $attempt --job $jobId --log 2>&1)
        $logExit = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($logExit -ne 0) { return @{ ok = $false; reason = 'failing_step_log_unavailable' } }
    $rows = Convert-CiRedWatchdogGhLogRows -Lines $logLines -JobId $jobId -StepName $stepName
    $diagnosticRaw = (@($rows | Select-Object -First 160 | ForEach-Object { [string]$_.text }) -join "`n").Trim()
    if (-not $diagnosticRaw) { return @{ ok = $false; reason = 'first_failing_step_log_empty' } }

    return @{
        ok               = $true
        checkRunId       = [string]$checkRun.id
        runId            = $runId
        attempt          = $attempt
        conclusion       = [string]$checkRun.conclusion
        headSha          = $HeadSha
        jobId            = $jobId
        stepName         = $stepName
        diagnosticRaw    = $diagnosticRaw
        diagnosticOk     = $true
        diagnosticReason = ''
    }
}
