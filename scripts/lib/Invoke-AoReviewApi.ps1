#requires -Version 5.1
<#
.SYNOPSIS
  Pack-owned review runner/store adapters (Issue #839).

.DESCRIPTION
  Review invocation and review-run status are pack-owned. This file remains only
  as compatibility glue for existing PowerShell consumers while the control plane
  lives in scripts/pack-review-runner.ts and scripts/lib/pack-review-run-store.ts.
#>

. (Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Invoke-TypeScriptCli.ps1')

$Script:AoReviewApiCli = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path 'docs/ao-0-10-review-api.mjs'

function Invoke-AoReviewApiCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:AoReviewApiCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'ao-0-10-review-api' -JsonDepth 30
}

function Resolve-PackReviewTrustedRoot {
    $configured = if ($env:AO_TRUSTED_PACK_ROOT) {
        $env:AO_TRUSTED_PACK_ROOT
    }
    elseif ($env:OPK_TRUSTED_PACK_ROOT) {
        $env:OPK_TRUSTED_PACK_ROOT
    }
    else {
        Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    $root = (Resolve-Path -LiteralPath $configured -ErrorAction Stop).Path
    $runner = Join-Path $root 'scripts/pack-review-runner.ts'
    $reviewer = Join-Path $root 'scripts/invoke-pack-review.ps1'
    $store = Join-Path $root 'scripts/lib/pack-review-run-store.ts'
    foreach ($path in @($runner, $reviewer, $store)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "trusted pack review surface missing at $path"
        }
    }
    return @{
        root     = $root
        runner   = $runner
        reviewer = $reviewer
        store    = $store
    }
}

function ConvertFrom-PackReviewRunnerOutput {
    param(
        [object[]]$Output,
        [int]$ExitCode,
        [string]$Label
    )

    $lines = @($Output | ForEach-Object {
            if ($_ -is [string]) { $_ }
            elseif ($null -ne $_) { $_.ToString() }
        })
    $parsed = $null
    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
        $candidate = ([string]$lines[$index]).Trim()
        if (-not $candidate.StartsWith('{')) { continue }
        try {
            $parsed = $candidate | ConvertFrom-Json -ErrorAction Stop
            break
        }
        catch {
            continue
        }
    }
    if ($null -eq $parsed) {
        $detail = ($lines -join "`n").Trim()
        throw "$Label produced no JSON result (exit $ExitCode): $detail"
    }
    if ($parsed -is [pscustomobject]) {
        $parsed | Add-Member -NotePropertyName transportExitCode -NotePropertyValue $ExitCode -Force
    }
    return $parsed
}

function Invoke-PackReviewRunnerCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload = @{}
    )

    $trusted = Resolve-PackReviewTrustedRoot
    $json = $Payload | ConvertTo-Json -Depth 40 -Compress
    $prior = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $nodeArgs = @(Get-OpkTypeScriptNodeArguments -ScriptPath $trusted.runner)
        $nodeArgs += $Subcommand
        $raw = $json | & node @nodeArgs 2>&1
        $exit = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prior
    }
    return ConvertFrom-PackReviewRunnerOutput -Output @($raw) -ExitCode $exit -Label "pack-review-runner $Subcommand"
}

function Get-AoDaemonApiBaseUrl {
    param(
        [string]$Override = '',
        [hashtable]$HealthPayload = $null
    )

    if ($Override) { return $Override.TrimEnd('/') }
    if ($env:AO_DAEMON_BASE_URL) { return $env:AO_DAEMON_BASE_URL.Trim().TrimEnd('/') }
    $health = if ($HealthPayload) { $HealthPayload } else { Get-AoDaemonHealthJson }
    $port = [int]$health.port
    if ($port -le 0) { throw 'ao status --json missing daemon port' }
    return "http://127.0.0.1:$port"
}

function Read-AoHttpResponseBodyText {
    param($Response, [string]$FallbackText = '')
    if ($null -eq $Response) { return $FallbackText }
    if ($Response -is [Microsoft.PowerShell.Commands.WebResponseObject]) { return [string]$Response.Content }
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
    param([int]$StatusCode, [string]$BodyText = '')
    if ([string]::IsNullOrWhiteSpace($BodyText)) { return @{ httpStatus = $StatusCode } }
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
    $params = @{ Method = $Method; Uri = "$base$Path"; ContentType = 'application/json' }
    if ($PSVersionTable.PSVersion.Major -ge 7) { $params.SkipHttpErrorCheck = $true }
    if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress) }
    try {
        $response = Invoke-WebRequest @params -UseBasicParsing
    }
    catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { throw "AO daemon $Method $Path failed: $_" }
        $statusCode = [int]$resp.StatusCode
        $text = Read-AoHttpResponseBodyText -Response $resp -FallbackText ([string]$_.ErrorDetails.Message)
        if ($AllowedStatus -contains $statusCode) {
            return ConvertTo-AoDaemonHttpJsonResult -StatusCode $statusCode -BodyText $text
        }
        throw "AO daemon $Method $Path failed (HTTP $statusCode): $text"
    }
    $status = [int]$response.StatusCode
    if ($AllowedStatus -notcontains $status) {
        throw "AO daemon $Method $Path failed (HTTP $status): $(Read-AoHttpResponseBodyText -Response $response)"
    }
    return ConvertTo-AoDaemonHttpJsonResult -StatusCode $status -BodyText ([string]$response.Content)
}

function ConvertTo-AoReviewRunsFromSessionReviews {
    param(
        $Payload,
        [string]$LinkedSessionId = '',
        [string]$ProjectId = ''
    )
    $packRows = @()
    if ($Payload -and $Payload.packRuns) {
        $packRows = @($Payload.packRuns)
    }
    elseif ($Payload -and $Payload.runs) {
        $packRows = @($Payload.runs)
    }
    if ($packRows.Count -gt 0) { return $packRows }

    $cli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/ao-0-10-review-api.mjs'
    $result = Invoke-MechanicalNodeFilterCli -FilterCliPath $cli -Subcommand 'flatten-runs' -Payload @{
        payload         = $Payload
        linkedSessionId = $LinkedSessionId
    } -Label 'pack-review-fixture-flatten' -JsonDepth 30
    $runs = @($result.runs)
    if ($ProjectId) {
        foreach ($run in $runs) {
            if (-not $run.projectId) {
                $run | Add-Member -NotePropertyName projectId -NotePropertyValue $ProjectId -Force
            }
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
    $payload = @{ projectId = $(if ($Project) { $Project } else { 'orchestrator-pack' }) }
    if ($env:PACK_REVIEW_RUN_STORE_ROOT) { $payload.storeRoot = $env:PACK_REVIEW_RUN_STORE_ROOT }
    $result = Invoke-PackReviewRunnerCli -Subcommand 'list' -Payload $payload
    return @($result.runs)
}

function Get-AoSessionReviewsJson {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null,
        $FixturePayload = $null
    )
    if ($FixturePayload) { return $FixturePayload }
    $runs = @(Get-AoReviewRunsFromWorkerSessions | Where-Object {
            -not $_.linkedSessionId -or [string]$_.linkedSessionId -eq $SessionId
        })
    $reviews = @($runs | ForEach-Object {
            [pscustomobject]@{
                prNumber = $_.prNumber
                headSha  = $_.targetSha
                latestRun = $_
            }
        })
    return @{ reviews = $reviews; packRuns = $runs }
}

function Invoke-AoSessionReviewTrigger {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null,
        $FixturePayload = $null,
        [int[]]$AllowedStatus = @(200, 201, 422)
    )
    if ($FixturePayload) { return $FixturePayload }
    $payload = @{
        projectId = $ProjectId
        sessionId = $SessionId
        claimMode = 'preacquired'
        surface   = 'powershell-adapter'
    }
    if ($env:PACK_REVIEW_RUN_STORE_ROOT) { $payload.storeRoot = $env:PACK_REVIEW_RUN_STORE_ROOT }
    return Invoke-PackReviewRunnerCli -Subcommand 'start' -Payload $payload
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
    if ($FixturePayload) { return Unwrap-AoProjectConfigPayload -Payload $FixturePayload }
    $path = "/api/v1/projects/$([uri]::EscapeDataString($ProjectId))"
    return Unwrap-AoProjectConfigPayload -Payload (Invoke-AoDaemonHttpJson -Method GET -Path $path -BaseUrl $BaseUrl -HealthPayload $HealthPayload)
}


function Set-AoProjectReviewerHarness {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectId,
        [string]$Harness = '',
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null
    )

    if (-not [string]::IsNullOrWhiteSpace($Harness)) {
        throw 'reviewer harness activation is retired; this compatibility helper only clears reviewers'
    }
    $path = "/api/v1/projects/$([uri]::EscapeDataString($ProjectId))/config"
    $body = @{ reviewers = @() }
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
    $payload = if ($ListPayload) { $ListPayload } else { Get-AoSessionReviewsJson -SessionId $SessionId }
    $cli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/ao-0-10-review-api.mjs'
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $cli -Subcommand 'cleanup-gate' -Payload @{
        listPayload = $payload
        headSha     = $HeadSha
        prNumber    = $PrNumber
    } -Label 'review-before-cleanup-gate' -JsonDepth 20
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
    throw "review-before-cleanup-gate: blocked $Context for session=$SessionId pr=$PrNumber head=$HeadSha ($($gate.reason) status=$($gate.status) runId=$($gate.runId))"
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

    if ($FixturePayload) {
        $httpStatus = if ($FixturePayload.httpStatus) { [int]$FixturePayload.httpStatus } else { 0 }
        $cli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/ao-0-10-review-api.mjs'
        $classified = Invoke-MechanicalNodeFilterCli -FilterCliPath $cli -Subcommand 'trigger-classify' -Payload @{
            payload = $FixturePayload
            httpStatus = $httpStatus
        } -Label 'review-trigger-fixture-classify' -JsonDepth 20
        if ($classified.ok) { return $classified }
        return @{ ok = $false; httpStatus = $httpStatus; reason = 'review_trigger_invalid'; detail = $FixturePayload }
    }


    if ($null -ne $ProjectConfigFixture -and -not $SkipHarnessGuard) {
        $projectConfig = Unwrap-AoProjectConfigPayload -Payload $ProjectConfigFixture
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

    try {
        $result = Invoke-AoSessionReviewTrigger -SessionId $SessionId -ProjectId $ProjectId
        if ($result.ok) { return $result }
        return @{
            ok         = $false
            httpStatus = $(if ($result.httpStatus) { [int]$result.httpStatus } else { 500 })
            reason     = $(if ($result.reason) { [string]$result.reason } else { 'pack_review_runner_failed' })
            detail     = $result
        }
    }
    catch {
        return @{ ok = $false; httpStatus = 500; reason = 'pack_review_runner_failed'; detail = [string]$_ }
    }
}

function Get-ReviewTriggerInvocationLine {
    param([Parameter(Mandatory = $true)][string]$SessionId)
    $trusted = Resolve-PackReviewTrustedRoot
    $nodeArgs = @(Get-OpkTypeScriptNodeArguments -ScriptPath $trusted.runner)
    $nodeArgs += @('start', '--session-id', $SessionId, '--claim-mode', 'preacquired')
    return ('node ' + ($nodeArgs -join ' '))
}
