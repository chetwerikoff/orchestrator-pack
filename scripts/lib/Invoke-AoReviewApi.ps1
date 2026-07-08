#requires -Version 5.1
<#
.SYNOPSIS
  AO 0.10 daemon HTTP helpers for session-scoped review trigger/list (Issue #623).
#>

. (Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

$Script:AoReviewApiCli = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path 'docs/ao-0-10-review-api.mjs'

function Invoke-AoReviewApiCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:AoReviewApiCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'ao-0-10-review-api' -JsonDepth 30
}

function Get-AoDaemonApiBaseUrl {
    param(
        [string]$Override = '',
        [hashtable]$HealthPayload = $null
    )

    if ($Override) {
        return $Override.TrimEnd('/')
    }
    if ($env:AO_DAEMON_BASE_URL) {
        return $env:AO_DAEMON_BASE_URL.Trim().TrimEnd('/')
    }

    $health = if ($HealthPayload) { $HealthPayload } else { Get-AoDaemonHealthJson }
    $port = [int]$health.port
    if ($port -le 0) {
        throw 'ao status --json missing daemon port for review API calls'
    }
    return "http://127.0.0.1:$port"
}

function Read-AoHttpResponseBodyText {
    param(
        [Parameter(Mandatory = $true)]
        $Response,
        [string]$FallbackText = ''
    )

    if ($null -eq $Response) {
        return $FallbackText
    }

    if ($Response -is [Microsoft.PowerShell.Commands.WebResponseObject]) {
        return [string]$Response.Content
    }

    if ($Response -is [System.Net.Http.HttpResponseMessage]) {
        return $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    }

    if ($Response.PSObject.Methods.Name -contains 'GetResponseStream') {
        $stream = $Response.GetResponseStream()
        if ($null -eq $stream) { return $FallbackText }
        $reader = New-Object System.IO.StreamReader($stream)
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    }

    return $FallbackText
}

function ConvertTo-AoDaemonHttpJsonResult {
    param(
        [Parameter(Mandatory = $true)][int]$StatusCode,
        [string]$BodyText = ''
    )

    if ([string]::IsNullOrWhiteSpace($BodyText)) {
        return @{ httpStatus = $StatusCode }
    }
    $parsed = $BodyText | ConvertFrom-Json
    if ($parsed -is [pscustomobject]) {
        $parsed | Add-Member -NotePropertyName httpStatus -NotePropertyValue $StatusCode -Force
    }
    return $parsed
}

function Invoke-AoDaemonHttpJson {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST', 'PUT')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        $Body = $null,
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null,
        [int[]]$AllowedStatus = @(200)
    )

    $base = Get-AoDaemonApiBaseUrl -Override $BaseUrl -HealthPayload $HealthPayload
    $uri = "$base$Path"
    $useSkipHttpErrorCheck = $PSVersionTable.PSVersion.Major -ge 7
    $params = @{
        Method      = $Method
        Uri         = $uri
        ContentType = 'application/json'
    }
    if ($useSkipHttpErrorCheck) {
        $params.SkipHttpErrorCheck = $true
    }
    if ($null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
    }

    try {
        $response = Invoke-WebRequest @params -UseBasicParsing
    }
    catch {
        if ($useSkipHttpErrorCheck) {
            throw "AO daemon $Method $Path failed: $_"
        }
        $resp = $_.Exception.Response
        if ($null -eq $resp) {
            throw "AO daemon $Method $Path failed: $_"
        }
        $statusCode = [int]$resp.StatusCode
        $text = Read-AoHttpResponseBodyText -Response $resp -FallbackText ([string]$_.ErrorDetails.Message)
        if ($AllowedStatus -contains $statusCode) {
            return ConvertTo-AoDaemonHttpJsonResult -StatusCode $statusCode -BodyText $text
        }
        throw "AO daemon $Method $Path failed (HTTP $statusCode): $text"
    }

    $status = [int]$response.StatusCode
    if ($AllowedStatus -notcontains $status) {
        $bodyText = Read-AoHttpResponseBodyText -Response $response
        throw "AO daemon $Method $Path failed (HTTP $status): $bodyText"
    }
    return ConvertTo-AoDaemonHttpJsonResult -StatusCode $status -BodyText ([string]$response.Content)
}

function Get-AoSessionReviewsJson {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null,
        $FixturePayload = $null
    )

    if ($FixturePayload) { return $FixturePayload }
    $listPath = "/api/v1/sessions/$([uri]::EscapeDataString($SessionId))/reviews"
    return Invoke-AoDaemonHttpJson -Method GET -Path $listPath -BaseUrl $BaseUrl -HealthPayload $HealthPayload
}

function Invoke-AoSessionReviewTrigger {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null,
        $FixturePayload = $null,
        [int[]]$AllowedStatus = @(200, 201, 422)
    )

    if ($FixturePayload) {
        return $FixturePayload
    }

    $triggerPath = "/api/v1/sessions/$([uri]::EscapeDataString($SessionId))/reviews/trigger"
    return Invoke-AoDaemonHttpJson -Method POST -Path $triggerPath -BaseUrl $BaseUrl `
        -HealthPayload $HealthPayload -AllowedStatus $AllowedStatus
}

function ConvertTo-AoReviewRunsFromSessionReviews {
    param(
        $Payload,
        [string]$LinkedSessionId = '',
        [string]$ProjectId = ''
    )

    $result = Invoke-AoReviewApiCli -Subcommand 'flatten-runs' -Payload @{
        payload         = $Payload
        linkedSessionId = $LinkedSessionId
    }
    $runs = @($result.runs)
    if ($ProjectId) {
        foreach ($run in $runs) {
            if (-not $run.projectId) { $run | Add-Member -NotePropertyName projectId -NotePropertyValue $ProjectId -Force }
        }
    }
    return $runs
}

function Get-AoReviewRunsFromWorkerSessions {
    param(
        [string]$Project = '',
        [array]$Sessions = @(),
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null
    )

    $workerSessions = @($Sessions | Where-Object {
            $role = [string]$_.role
            if ($role -and $role -ne 'worker') { return $false }
            if ($Project -and $_.projectId -and [string]$_.projectId -ne $Project) { return $false }
            return $true
        })

    if ($workerSessions.Count -eq 0 -and -not $Sessions) {
        $workerSessions = @(Get-AoStatusSessions -Project $Project | Where-Object {
                $role = [string]$_.role
                -not $role -or $role -eq 'worker'
            })
    }

    $allRuns = @()
    $fetchAttempts = 0
    $fetchFailures = [System.Collections.Generic.List[string]]::new()
    foreach ($session in $workerSessions) {
        $sessionId = [string]$session.id
        if (-not $sessionId) { $sessionId = [string]$session.name }
        if (-not $sessionId) { continue }
        $fetchAttempts++
        try {
            $payload = Get-AoSessionReviewsJson -SessionId $sessionId -BaseUrl $BaseUrl -HealthPayload $HealthPayload
            $allRuns += ConvertTo-AoReviewRunsFromSessionReviews -Payload $payload -LinkedSessionId $sessionId -ProjectId $Project
        }
        catch {
            $fetchFailures.Add("$sessionId`: $($_.Exception.Message)") | Out-Null
            continue
        }
    }
    if ($fetchAttempts -gt 0 -and $fetchFailures.Count -eq $fetchAttempts) {
        throw "Get-AoReviewRuns fan-out failed for all $fetchAttempts worker session(s): $($fetchFailures -join '; ')"
    }
    return $allRuns
}

function Unwrap-AoProjectConfigPayload {
    param($Payload)

    if ($null -eq $Payload) { return $Payload }
    if ($Payload.project) { return $Payload.project }
    return $Payload
}

function Get-AoProjectConfigJson {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectId,
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null,
        $FixturePayload = $null
    )

    if ($FixturePayload) {
        return Unwrap-AoProjectConfigPayload -Payload $FixturePayload
    }
    $path = "/api/v1/projects/$([uri]::EscapeDataString($ProjectId))"
    $result = Invoke-AoDaemonHttpJson -Method GET -Path $path -BaseUrl $BaseUrl -HealthPayload $HealthPayload
    return Unwrap-AoProjectConfigPayload -Payload $result
}

function Set-AoProjectReviewerHarness {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectId,
        [Parameter(Mandatory = $true)][string]$Harness,
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null
    )

    $path = "/api/v1/projects/$([uri]::EscapeDataString($ProjectId))/config"
    $body = @{ reviewers = @(@{ harness = $Harness }) }
    return Invoke-AoDaemonHttpJson -Method PUT -Path $path -Body $body -BaseUrl $BaseUrl `
        -HealthPayload $HealthPayload -AllowedStatus @(200)
}

function Test-ReviewBeforeCleanupGate {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [string]$HeadSha = '',
        [int]$PrNumber = 0,
        $ListPayload = $null,
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null
    )

    $payload = if ($ListPayload) { $ListPayload } else {
        Get-AoSessionReviewsJson -SessionId $SessionId -BaseUrl $BaseUrl -HealthPayload $HealthPayload
    }
    return Invoke-AoReviewApiCli -Subcommand 'cleanup-gate' -Payload @{
        listPayload = $payload
        headSha     = $HeadSha
        prNumber    = $PrNumber
    }
}

function Assert-ReviewBeforeCleanupGate {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [string]$HeadSha = '',
        [int]$PrNumber = 0,
        $ListPayload = $null,
        [string]$Context = 'cleanup'
    )

    $gate = Test-ReviewBeforeCleanupGate -SessionId $SessionId -HeadSha $HeadSha -PrNumber $PrNumber -ListPayload $ListPayload
    if ($gate.proceed) { return $gate }
    $reason = [string]$gate.reason
    $status = [string]$gate.status
    throw "review-before-cleanup-gate: blocked $Context for session=$SessionId pr=$PrNumber head=$HeadSha ($reason status=$status runId=$($gate.runId))"
}

function Invoke-AoReviewTriggerForWorker {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null,
        $FixturePayload = $null,
        $ProjectConfigFixture = $null,
        [switch]$SkipHarnessGuard
    )

    if (-not $SkipHarnessGuard -and -not $FixturePayload) {
        if ($null -ne $ProjectConfigFixture) {
            $projectConfig = Unwrap-AoProjectConfigPayload -Payload $ProjectConfigFixture
        }
        else {
            $projectConfig = Get-AoProjectConfigJson -ProjectId $ProjectId -BaseUrl $BaseUrl -HealthPayload $HealthPayload
        }
        $guard = Invoke-AoReviewApiCli -Subcommand 'harness-guard' -Payload @{
            payload         = $projectConfig
            expectedHarness = 'codex'
        }
        if ($guard.abort) {
            return @{
                ok         = $false
                httpStatus = 0
                reason     = [string]$guard.reason
                classified = $true
                harness    = $guard.harness
            }
        }
    }

    $response = if ($FixturePayload) { $FixturePayload } else {
        Invoke-AoSessionReviewTrigger -SessionId $SessionId -BaseUrl $BaseUrl -HealthPayload $HealthPayload
    }
    $httpStatus = 0
    if ($null -ne $response -and $response.httpStatus) {
        $httpStatus = [int]$response.httpStatus
    }
    $classified = Invoke-AoReviewApiCli -Subcommand 'trigger-classify' -Payload @{
        payload    = $response
        httpStatus = $httpStatus
    }
    if ($classified.ok) { return $classified }
    if ($httpStatus -eq 422) {
        return @{ ok = $false; httpStatus = 422; reason = 'review_trigger_invalid'; detail = $response }
    }
    throw "review trigger failed for session=$SessionId (http=$httpStatus)"
}

function Get-ReviewTriggerInvocationLine {
    param([Parameter(Mandatory = $true)][string]$SessionId)
    return "ao-review run $SessionId"
}
