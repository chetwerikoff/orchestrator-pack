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
    $params = @{
        Method      = $Method
        Uri         = $uri
        ContentType = 'application/json'
    }
    if ($null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
    }

    try {
        $response = Invoke-WebRequest @params -UseBasicParsing
    }
    catch {
        $resp = $_.Exception.Response
        if ($resp) {
            $statusCode = [int]$resp.StatusCode
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $text = $reader.ReadToEnd()
            $reader.Close()
            if ($AllowedStatus -contains $statusCode) {
                if ([string]::IsNullOrWhiteSpace($text)) { return @{ httpStatus = $statusCode } }
                return ($text | ConvertFrom-Json) | ForEach-Object {
                    $_ | Add-Member -NotePropertyName httpStatus -NotePropertyValue $statusCode -Force
                    $_
                }
            }
            throw "AO daemon $Method $Path failed (HTTP $statusCode): $text"
        }
        throw "AO daemon $Method $Path failed: $_"
    }

    $status = [int]$response.StatusCode
    if ($AllowedStatus -notcontains $status) {
        throw "AO daemon $Method $Path unexpected HTTP $status"
    }
    if ([string]::IsNullOrWhiteSpace($response.Content)) {
        return @{ httpStatus = $status }
    }
    $parsed = $response.Content | ConvertFrom-Json
    if ($parsed -is [pscustomobject]) {
        $parsed | Add-Member -NotePropertyName httpStatus -NotePropertyValue $status -Force
    }
    return $parsed
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
        $workerSessions = @(Get-AoStatusSessions -Project $Project)
    }

    $allRuns = @()
    foreach ($session in $workerSessions) {
        $sessionId = [string]$session.id
        if (-not $sessionId) { $sessionId = [string]$session.name }
        if (-not $sessionId) { continue }
        try {
            $payload = Get-AoSessionReviewsJson -SessionId $sessionId -BaseUrl $BaseUrl -HealthPayload $HealthPayload
            $allRuns += ConvertTo-AoReviewRunsFromSessionReviews -Payload $payload -LinkedSessionId $sessionId -ProjectId $Project
        }
        catch {
            continue
        }
    }
    return $allRuns
}

function Get-AoProjectConfigJson {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectId,
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null,
        $FixturePayload = $null
    )

    if ($FixturePayload) { return $FixturePayload }
    $path = "/api/v1/projects/$([uri]::EscapeDataString($ProjectId))/config"
    return Invoke-AoDaemonHttpJson -Method GET -Path $path -BaseUrl $BaseUrl -HealthPayload $HealthPayload
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
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null,
        $FixturePayload = $null
    )

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
