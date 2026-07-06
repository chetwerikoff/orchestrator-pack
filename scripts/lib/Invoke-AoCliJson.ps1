#requires -Version 5.1
<#
.SYNOPSIS
  Parse JSON from ao CLI commands that may prefix non-JSON log lines.
  AO 0.10 session/status facade (Issue #619).
#>

$Script:AoSessionAdapterValidRoles = @('worker', 'orchestrator')
$Script:AoSessionAdapterReportSurfaceError = 'ao status --json --reports full unavailable on AO 0.10 (GitHub #611): report-surface-unavailable'

function Invoke-AoCliJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$AoArgs,
        [string]$FailureLabel = '',
        [string]$AoCommand = 'ao'
    )

    $label = if ($FailureLabel) { $FailureLabel } else { "$AoCommand $($AoArgs -join ' ')" }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = if ($AoCommand -eq 'ao') { & ao @AoArgs 2>&1 } else { & $AoCommand @AoArgs 2>&1 }
        if ($LASTEXITCODE -ne 0) {
            $text = ($raw | Out-String).Trim()
            throw "$label failed (exit $LASTEXITCODE): $text"
        }

        $text = ($raw | ForEach-Object {
                if ($_ -is [string]) { $_ }
                elseif ($null -ne $_) { $_.ToString() }
            }) -join "`n"
        $start = $text.IndexOf('{')
        if ($start -lt 0) {
            throw "$label produced no JSON output"
        }

        return $text.Substring($start) | ConvertFrom-Json
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
}

function Get-AoReviewRunsFromPayload {
    param(
        $Payload,
        [string]$Project = ''
    )

    $runs = @($Payload.runs)
    if (-not $runs -and $Payload.data) {
        $runs = @($Payload.data)
    }

    if ($Project) {
        $runs = @($runs | Where-Object { $_.projectId -eq $Project })
    }

    return $runs
}

function Get-AoStatusSessionsFromPayload {
    param($Payload)

    $sessions = @($Payload.data)
    if (-not $sessions -and $Payload.sessions) {
        $sessions = @($Payload.sessions)
    }

    return $sessions
}

function Get-AoReviewListJson {
    param([string]$Project = '')

    $args = @('review', 'list')
    if ($Project) { $args += $Project }
    $args += '--json'
    return Invoke-AoCliJson -AoArgs $args -FailureLabel 'ao review list'
}

function Get-AoReviewRuns {
    param([string]$Project = '')

    $payload = Get-AoReviewListJson -Project $Project
    return Get-AoReviewRunsFromPayload -Payload $payload -Project $Project
}

function Throw-AoReportSurfaceUnavailable {
    param([string]$EntryPoint)

    throw "$Script:AoSessionAdapterReportSurfaceError (entry=$EntryPoint)"
}

function Get-AoStatusReportsJson {
    Throw-AoReportSurfaceUnavailable -EntryPoint 'Get-AoStatusReportsJson'
}

function Get-AoStatusReportsIncludingTerminatedJson {
    Throw-AoReportSurfaceUnavailable -EntryPoint 'Get-AoStatusReportsIncludingTerminatedJson'
}

function Get-AoDaemonHealthJson {
    return Invoke-AoCliJson -AoArgs @('status', '--json') -FailureLabel 'ao status'
}

function Assert-AoListPayloadShape {
    param(
        $Payload,
        [string]$Label
    )

    if (-not $Payload) {
        throw "${Label}: empty payload"
    }
    if ($Payload.PSObject.Properties.Name -notcontains 'data') {
        throw "${Label}: missing required top-level data[]"
    }
    if ($null -eq $Payload.data) {
        throw "${Label}: data must not be null"
    }
}

function Get-AoSessionLsJson {
    param(
        [string]$Project = '',
        [switch]$IncludeTerminated,
        [string]$AoCommand = 'ao'
    )

    $args = @('session', 'ls', '--json')
    if ($Project) { $args += @('-p', $Project) }
    if ($IncludeTerminated) { $args += '--include-terminated' }
    $payload = Invoke-AoCliJson -AoArgs $args -FailureLabel 'ao session ls' -AoCommand $AoCommand
    Assert-AoListPayloadShape -Payload $payload -Label 'ao session ls'
    return $payload
}

function Get-AoOrchestratorLsJson {
    param([string]$AoCommand = 'ao')

    $payload = Invoke-AoCliJson -AoArgs @('orchestrator', 'ls', '--json') -FailureLabel 'ao orchestrator ls' -AoCommand $AoCommand
    Assert-AoListPayloadShape -Payload $payload -Label 'ao orchestrator ls'
    return $payload
}

function Get-AoSessionGetJson {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [string]$Project = '',
        [string]$AoCommand = 'ao'
    )

    $args = @('session', 'get', $SessionId, '--json')
    if ($Project) { $args += @('-p', $Project) }
    return Invoke-AoCliJson -AoArgs $args -FailureLabel 'ao session get' -AoCommand $AoCommand
}

function Test-AoSessionRowProjectMatches {
    param(
        $Row,
        [string]$Project
    )

    if (-not $Project) { return $true }
    $projectId = [string]$Row.projectId
    if ([string]::IsNullOrWhiteSpace($projectId)) { return $false }
    return ($projectId -eq $Project)
}

function Normalize-AoSessionRow {
    param($Row)

    if (-not $Row) { return $null }

    $id = ''
    foreach ($key in @('id', 'name', 'sessionId')) {
        $value = [string]$Row.$key
        if ($value) {
            $id = $value.Trim()
            break
        }
    }

    $projectId = [string]$Row.projectId
    if ([string]::IsNullOrWhiteSpace($projectId)) {
        $legacyProject = [string]$Row.project
        if ($legacyProject) { $projectId = $legacyProject.Trim() }
    }

    $normalized = [ordered]@{}
    foreach ($prop in $Row.PSObject.Properties) {
        $normalized[$prop.Name] = $prop.Value
    }
    if ($id) {
        $normalized['id'] = $id
        if (-not $normalized['name']) { $normalized['name'] = $id }
        if (-not $normalized['sessionId']) { $normalized['sessionId'] = $id }
    }
    if ($projectId) {
        $normalized['projectId'] = $projectId
        if (-not $normalized['project']) { $normalized['project'] = $projectId }
    }
    if ($Row.issueId -and -not $normalized['issue']) {
        $normalized['issue'] = [string]$Row.issueId
    }

    return [pscustomobject]$normalized
}

function Test-AoSessionRowFacadeValid {
    param(
        $Row,
        [switch]$RequireTerminatedFlag
    )

    if (-not $Row) {
        throw 'ao session adapter: null session row'
    }

    $id = [string]$Row.id
    if ([string]::IsNullOrWhiteSpace($id)) {
        throw 'ao session adapter: session row missing non-empty id'
    }

    $role = [string]$Row.role
    if ([string]::IsNullOrWhiteSpace($role) -or ($Script:AoSessionAdapterValidRoles -notcontains $role)) {
        throw "ao session adapter: session row $id has invalid role '$role'"
    }

    if ($null -eq $Row.status -or [string]::IsNullOrWhiteSpace([string]$Row.status)) {
        throw "ao session adapter: session row $id missing status"
    }

    if ($RequireTerminatedFlag) {
        if ($Row.PSObject.Properties.Name -notcontains 'isTerminated') {
            throw "ao session adapter: session row $id missing isTerminated"
        }
        if ($Row.isTerminated -isnot [bool]) {
            throw "ao session adapter: session row $id isTerminated must be boolean"
        }
    }

    if ($Row.PSObject.Properties.Name -contains 'reports') {
        throw "ao session adapter: session row $id must not carry reports field on AO 0.10"
    }

    return $true
}

function Merge-AoStatusSessionRows {
    param(
        [object[]]$WorkerRows,
        [object[]]$OrchestratorRows,
        [string]$Project = '',
        [switch]$IncludeTerminated
    )

    $merged = @{}
    foreach ($row in @($WorkerRows) + @($OrchestratorRows)) {
        if (-not $row) { continue }
        $normalized = Normalize-AoSessionRow -Row $row
        if (-not (Test-AoSessionRowProjectMatches -Row $normalized -Project $Project)) {
            continue
        }

        if (-not $IncludeTerminated -and $normalized.PSObject.Properties.Name -contains 'isTerminated') {
            if ($normalized.isTerminated) { continue }
        }

        [void](Test-AoSessionRowFacadeValid -Row $normalized -RequireTerminatedFlag)

        $id = [string]$normalized.id
        if ($merged.ContainsKey($id)) {
            throw "ao session adapter: duplicate session id '$id' across worker and orchestrator lists"
        }
        $merged[$id] = $normalized
    }

    return @($merged.Values)
}

function Get-AoMergedStatusSessions {
    param(
        [string]$Project = '',
        [switch]$IncludeTerminated,
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        [string]$AoCommand = 'ao'
    )

    try {
        if ($WorkerListPayload) {
            Assert-AoListPayloadShape -Payload $WorkerListPayload -Label 'fixture ao session ls'
            $workerPayload = $WorkerListPayload
        }
        else {
            $workerPayload = Get-AoSessionLsJson -Project $Project -IncludeTerminated:$IncludeTerminated -AoCommand $AoCommand
        }

        if ($OrchestratorListPayload) {
            Assert-AoListPayloadShape -Payload $OrchestratorListPayload -Label 'fixture ao orchestrator ls'
            $orchPayload = $OrchestratorListPayload
        }
        else {
            $orchPayload = Get-AoOrchestratorLsJson -AoCommand $AoCommand
        }
    }
    catch {
        throw "ao session adapter merge failed: $($_.Exception.Message)"
    }

    $workerRows = @($workerPayload.data)
    $orchRows = @($orchPayload.data)
    return Merge-AoStatusSessionRows -WorkerRows $workerRows -OrchestratorRows $orchRows `
        -Project $Project -IncludeTerminated:$IncludeTerminated
}

function Get-AoStatusSessions {
    param(
        [string]$Project = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        [string]$AoCommand = 'ao'
    )

    return Get-AoMergedStatusSessions -Project $Project `
        -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
        -AoCommand $AoCommand
}

function Get-AoStatusSessionsIncludingTerminated {
    param(
        [string]$Project = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        [string]$AoCommand = 'ao'
    )

    return Get-AoMergedStatusSessions -Project $Project -IncludeTerminated `
        -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
        -AoCommand $AoCommand
}

function Get-AoOrchestratorSessions {
    param(
        [string]$Project = '',
        [switch]$IncludeTerminated,
        $OrchestratorListPayload = $null,
        [string]$AoCommand = 'ao'
    )

    if ($OrchestratorListPayload) {
        Assert-AoListPayloadShape -Payload $OrchestratorListPayload -Label 'fixture ao orchestrator ls'
        $orchPayload = $OrchestratorListPayload
    }
    else {
        $orchPayload = Get-AoOrchestratorLsJson -AoCommand $AoCommand
    }

    $rows = @()
    foreach ($row in @($orchPayload.data)) {
        $normalized = Normalize-AoSessionRow -Row $row
        if ([string]$normalized.role -ne 'orchestrator') { continue }
        if (-not (Test-AoSessionRowProjectMatches -Row $normalized -Project $Project)) { continue }
        if (-not $IncludeTerminated -and $normalized.isTerminated) { continue }
        [void](Test-AoSessionRowFacadeValid -Row $normalized -RequireTerminatedFlag)
        $rows += $normalized
    }
    return $rows
}

function Resolve-AoOrchestratorSessionId {
    param(
        [string]$Project = '',
        [string]$Override = '',
        $OrchestratorListPayload = $null,
        [string]$AoCommand = 'ao'
    )

    if ($Override) {
        return @{ Id = $Override.Trim(); Source = 'override' }
    }

    $rows = @(Get-AoOrchestratorSessions -Project $Project `
            -OrchestratorListPayload $OrchestratorListPayload -AoCommand $AoCommand)
    $pick = $rows | Select-Object -First 1
    if (-not $pick) { return $null }
    return @{ Id = [string]$pick.id; Source = 'ao_orchestrator_ls' }
}

function Get-AoEventsSince {
    param([int]$SinceMinutes = 30)

    $payload = Invoke-AoCliJson -AoArgs @(
        'events', 'list', '--since', "${SinceMinutes}m", '--limit', '500', '--json'
    ) -FailureLabel 'ao events list'
    return @($payload.events)
}
