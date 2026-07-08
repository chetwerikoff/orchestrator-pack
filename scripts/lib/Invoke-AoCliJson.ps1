#requires -Version 5.1
<#
.SYNOPSIS
  Parse JSON from ao CLI commands that may prefix non-JSON log lines.
  AO 0.10 session/status facade (Issue #619).
#>

$Script:AoSessionAdapterValidRoles = @('worker', 'orchestrator')
$Script:AoSessionAdapterReportSurfaceError = 'ao status --json --reports full unavailable on AO 0.10 (GitHub #611): report-surface-unavailable'
$Script:AoReportFullCliProbeState = $null
$Script:AoEventsCliProbeState = $null
$Script:AoEventsDegradedClassification = $null
$Script:AoReportFullSourceCli = 'ao status --json --reports full'
$Script:AoReportFullSourceCliTerminated = 'ao status --json --reports full --include-terminated'
$Script:AoReportFullSourceAudit = '$.agent-report-audit/<session>.ndjson'


function ConvertFrom-AoCliPrefixedOutput {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [string]$FailureLabel
    )

    $label = [string]$FailureLabel
    $start = $Text.IndexOf('{')
    if ($start -lt 0) {
        throw "$label produced no JSON output"
    }

    $jsonText = $Text.Substring($start)
    try {
        return $jsonText | ConvertFrom-Json
    }
    catch {
        $detail = $_.Exception.Message
        throw "$label parse failed: $detail"
    }
}

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
        return ConvertFrom-AoCliPrefixedOutput -Text $text -FailureLabel $label
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

    if ($null -eq $Payload) {
        return @()
    }

    $runs = @()
    if ($Payload -is [System.Array]) {
        # Get-AoReviewRuns already returns normalized run rows (AO 0.10 fan-out).
        $runs = @($Payload)
    }
    elseif ($Payload.PSObject.Properties.Name -contains 'runs') {
        $runs = @($Payload.runs)
    }
    elseif ($Payload.PSObject.Properties.Name -contains 'data') {
        $runs = @($Payload.data)
    }
    else {
        $runs = @($Payload)
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

function Get-AoReviewRuns {
    param([string]$Project = '')

    if (-not (Get-Command Get-AoReviewRunsFromWorkerSessions -ErrorAction SilentlyContinue)) {
        . (Join-Path $PSScriptRoot 'Invoke-AoReviewApi.ps1')
    }
    return @(Get-AoReviewRunsFromWorkerSessions -Project $Project)
}

function Get-AoBaseDir {
    if ($env:AO_BASE_DIR -and -not [string]::IsNullOrWhiteSpace($env:AO_BASE_DIR)) {
        return $env:AO_BASE_DIR.Trim()
    }
    return Join-Path $HOME '.agent-orchestrator'
}

function Get-AoAgentReportAuditDir {
    param([string]$Project = '')

    $projectId = if ($Project) { $Project.Trim() } else { 'orchestrator-pack' }
    return Join-Path (Get-AoBaseDir) 'projects' $projectId 'sessions' '.agent-report-audit'
}

function Get-AoSessionReportAuditLookupKeys {
    param($Session)

    $keys = New-Object 'System.Collections.Generic.List[string]'
    foreach ($prop in @('name', 'id', 'sessionId', 'displayName', 'terminalHandleId')) {
        if (-not $Session.PSObject.Properties.Name -contains $prop) { continue }
        $value = [string]$Session.$prop
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        if (-not $keys.Contains($value)) {
            $keys.Add($value) | Out-Null
        }
    }
    return @($keys)
}

function ConvertTo-AoWorkerReportRowFromAuditEntry {
    param($Entry)

    if (-not $Entry) { return $null }
    $row = [ordered]@{}
    foreach ($prop in $Entry.PSObject.Properties) {
        $row[$prop.Name] = $prop.Value
    }
    if ($Entry.timestamp -and -not $row['reportedAt']) {
        $row['reportedAt'] = [string]$Entry.timestamp
    }
    if ($Entry.reportState -and -not $row['report_state']) {
        $row['report_state'] = [string]$Entry.reportState
    }
    return [pscustomobject]$row
}

function Read-AoAgentReportAuditReports {
    param(
        [string]$Project = '',
        $Session
    )

    $auditDir = Get-AoAgentReportAuditDir -Project $Project
    if (-not (Test-Path -LiteralPath $auditDir -PathType Container)) {
        return @{ reports = @(); auditPath = $null }
    }

    foreach ($key in @(Get-AoSessionReportAuditLookupKeys -Session $Session)) {
        $auditPath = Join-Path $auditDir "$key.ndjson"
        if (-not (Test-Path -LiteralPath $auditPath -PathType Leaf)) { continue }

        $reports = [System.Collections.Generic.List[object]]::new()
        foreach ($line in @(Get-Content -LiteralPath $auditPath -Encoding UTF8)) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $entry = $line | ConvertFrom-Json
            if (-not $entry.reportState) { continue }
            $reports.Add((ConvertTo-AoWorkerReportRowFromAuditEntry -Entry $entry)) | Out-Null
        }
        return @{ reports = @($reports); auditPath = $auditPath }
    }

    return @{ reports = @(); auditPath = $null }
}

function Format-AoSessionReportSourcePath {
    param(
        [string]$SessionId,
        [string]$SourceKind,
        [string]$AuditPath = ''
    )

    $id = [string]$SessionId
    if (-not $id) { $id = '<session>' }
    switch ($SourceKind) {
        'cli-report-full' {
            return "`$.data[?name==$id].reports[*] from $Script:AoReportFullSourceCli"
        }
        'cli-report-full-terminated' {
            return "`$.data[?name==$id].reports[*] from $Script:AoReportFullSourceCliTerminated"
        }
        'fixture-report-full' {
            return "`$.data[?name==$id].reports[*] from $Script:AoReportFullSourceCli (fixture)"
        }
        'fixture-report-full-terminated' {
            return "`$.data[?name==$id].reports[*] from $Script:AoReportFullSourceCliTerminated (fixture)"
        }
        'audit-backed' {
            if ($AuditPath) {
                return "`$.agent-report-audit/$([System.IO.Path]::GetFileName($AuditPath)) (audit-backed)"
            }
            return $Script:AoReportFullSourceAudit
        }
        default {
            return $Script:AoReportFullSourceAudit
        }
    }
}

function Test-AoReportFullCliAvailable {
    param([string]$AoCommand = 'ao')

    if ($null -ne $Script:AoReportFullCliProbeState) {
        return [bool]$Script:AoReportFullCliProbeState
    }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = if ($AoCommand -eq 'ao') {
            & ao status --json --reports full 2>&1
        }
        else {
            & $AoCommand status --json --reports full 2>&1
        }
        $text = ($raw | ForEach-Object {
                if ($_ -is [string]) { $_ }
                elseif ($null -ne $_) { $_.ToString() }
            }) -join "`n"
        if ($LASTEXITCODE -ne 0 -or $text -match 'unknown flag:\s*--reports') {
            $Script:AoReportFullCliProbeState = $false
            return $false
        }
        $Script:AoReportFullCliProbeState = $true
        return $true
    }
    catch {
        $Script:AoReportFullCliProbeState = $false
        return $false
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
}

function New-AoEventsDegradedClassification {
    param(
        [string]$Reason = 'removed_cli_surface',
        [string]$Detail = ''
    )
    return [pscustomobject]@{
        degraded = $true
        reason = $Reason
        classification = $Reason
        detail = $Detail
    }
}

function Set-AoEventsDegradedClassification {
    param(
        [string]$Reason = 'removed_cli_surface',
        [string]$Detail = ''
    )
    $Script:AoEventsDegradedClassification = New-AoEventsDegradedClassification -Reason $Reason -Detail $Detail
    return $Script:AoEventsDegradedClassification
}

function Get-AoEventsDegradedClassification {
    if ($null -eq $Script:AoEventsDegradedClassification) {
        return [pscustomobject]@{
            degraded = $false
            reason = ''
            classification = ''
            detail = ''
        }
    }
    return $Script:AoEventsDegradedClassification
}

function Test-AoEventsCliAvailable {
    param([string]$AoCommand = 'ao')

    if ($null -ne $Script:AoEventsCliProbeState) {
        return [bool]$Script:AoEventsCliProbeState
    }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = if ($AoCommand -eq 'ao') {
            & ao events list --since 1m --limit 1 --json 2>&1
        }
        else {
            & $AoCommand events list --since 1m --limit 1 --json 2>&1
        }
        $text = ($raw | ForEach-Object {
                if ($_ -is [string]) { $_ }
                elseif ($null -ne $_) { $_.ToString() }
            }) -join "`n"
        if ($LASTEXITCODE -ne 0 -or $text -match '(unknown|unrecognized|invalid).*(command|subcommand|events)') {
            $Script:AoEventsCliProbeState = $false
            Set-AoEventsDegradedClassification -Reason 'removed_cli_surface' -Detail $text | Out-Null
            return $false
        }
        $Script:AoEventsCliProbeState = $true
        $Script:AoEventsDegradedClassification = $null
        return $true
    }
    catch {
        $Script:AoEventsCliProbeState = $false
        Set-AoEventsDegradedClassification -Reason 'removed_cli_surface' -Detail $_.Exception.Message | Out-Null
        return $false
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
}

function Throw-AoReportSurfaceUnavailable {
    param([string]$EntryPoint)

    throw "$Script:AoSessionAdapterReportSurfaceError (entry=$EntryPoint)"
}

function Get-AoStatusReportsJson {
    param(
        [string]$Project = '',
        [string]$AoCommand = 'ao'
    )

    if (-not (Test-AoReportFullCliAvailable -AoCommand $AoCommand)) {
        Throw-AoReportSurfaceUnavailable -EntryPoint 'Get-AoStatusReportsJson'
    }

    $args = @('status', '--json', '--reports', 'full')
    if ($Project) { $args += @('-p', $Project) }
    return Invoke-AoCliJson -AoArgs $args -FailureLabel 'ao status --reports full' -AoCommand $AoCommand
}

function Get-AoStatusReportsIncludingTerminatedJson {
    param(
        [string]$Project = '',
        [string]$AoCommand = 'ao'
    )

    if (-not (Test-AoReportFullCliAvailable -AoCommand $AoCommand)) {
        Throw-AoReportSurfaceUnavailable -EntryPoint 'Get-AoStatusReportsIncludingTerminatedJson'
    }

    $args = @('status', '--json', '--reports', 'full', '--include-terminated')
    if ($Project) { $args += @('-p', $Project) }
    return Invoke-AoCliJson -AoArgs $args -FailureLabel 'ao status --reports full --include-terminated' -AoCommand $AoCommand
}

function Merge-AoSessionRowsWithReportAudit {
    param(
        [object[]]$Sessions,
        [string]$Project = '',
        [string]$SourceKind = 'audit-backed'
    )

    $merged = @()
    foreach ($session in @($Sessions)) {
        if (-not $session) { continue }
        $audit = Read-AoAgentReportAuditReports -Project $Project -Session $session
        $sessionId = [string]$session.id
        if (-not $sessionId) { $sessionId = [string]$session.name }
        if (-not $sessionId) { $sessionId = [string]$session.sessionId }

        $row = [ordered]@{}
        if ($session -is [System.Collections.IDictionary]) {
            foreach ($key in @($session.Keys)) {
                $row[[string]$key] = $session[$key]
            }
        }
        else {
            foreach ($prop in $session.PSObject.Properties) {
                $row[$prop.Name] = $prop.Value
            }
        }
        if (@($audit.reports).Count -gt 0) {
            $row['reports'] = @($audit.reports)
            $row['reportSourcePath'] = Format-AoSessionReportSourcePath -SessionId $sessionId `
                -SourceKind $SourceKind -AuditPath ([string]$audit.auditPath)
            $row['reportSnapshotKind'] = 'audit-backed'
        }
        elseif (@($session.reports).Count -gt 0) {
            $row['reports'] = @($session.reports)
            $row['reportSourcePath'] = Format-AoSessionReportSourcePath -SessionId $sessionId `
                -SourceKind 'fixture-session-reports'
            $row['reportSnapshotKind'] = 'fixture-session-reports'
        }
        else {
            $row['reports'] = @()
            $row['reportSourcePath'] = Format-AoSessionReportSourcePath -SessionId $sessionId `
                -SourceKind $SourceKind -AuditPath ([string]$audit.auditPath)
            $row['reportSnapshotKind'] = 'audit-backed'
        }
        $merged += [pscustomobject]$row
    }
    return $merged
}

function Get-AoStatusSessionsWithReportsFromPayload {
    param(
        $Payload,
        [string]$SourceKind = 'cli-report-full'
    )

    $sessions = @(Get-AoStatusSessionsFromPayload -Payload $Payload)
    $decorated = @()
    foreach ($session in $sessions) {
        if (-not $session) { continue }
        $sessionId = [string]$session.id
        if (-not $sessionId) { $sessionId = [string]$session.name }
        if (-not $sessionId) { $sessionId = [string]$session.sessionId }
        $row = [ordered]@{}
        foreach ($prop in $session.PSObject.Properties) {
            $row[$prop.Name] = $prop.Value
        }
        if (-not $row['reports']) { $row['reports'] = @() }
        $row['reportSourcePath'] = Format-AoSessionReportSourcePath -SessionId $sessionId -SourceKind $SourceKind
        $row['reportSnapshotKind'] = 'report-full-cli'
        $decorated += [pscustomobject]$row
    }
    return $decorated
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
function Get-AoSessionRowIdentifier {
    param($Row)

    if (-not $Row) { return '' }
    foreach ($key in @('sessionId', 'id', 'name')) {
        $value = [string]$Row.$key
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value.Trim()
        }
    }
    return ''
}

function Test-AoSessionRowNeedsSessionGetDetail {
    param($Row)

    if (-not $Row) { return $false }
    $prNumber = 0
    if ($null -ne $Row.prNumber) {
        [void][int]::TryParse([string]$Row.prNumber, [ref]$prNumber)
    }
    if ($prNumber -gt 0) { return $false }
    $displayName = [string]$Row.displayName
    if ($displayName -match '^\d+$') { return $false }
    $role = [string]$Row.role
    if ($role -and $role -notin @('worker', 'coding')) { return $false }
    return -not [string]::IsNullOrWhiteSpace((Get-AoSessionRowIdentifier -Row $Row))
}

function Build-AoSessionDetailsById {
    param(
        [object[]]$Sessions,
        [string]$Project = 'orchestrator-pack',
        [string]$AoCommand = 'ao'
    )

    $details = @{}
    foreach ($row in @($Sessions)) {
        if (-not (Test-AoSessionRowNeedsSessionGetDetail -Row $row)) {
            $sessionId = Get-AoSessionRowIdentifier -Row $row
            $displayName = [string]$row.displayName
            if ($sessionId -and $displayName) {
                $details[$sessionId] = @{ displayName = $displayName }
            }
            continue
        }
        $sessionId = Get-AoSessionRowIdentifier -Row $row
        if (-not $sessionId) { continue }
        try {
            $payload = Get-AoSessionGetJson -SessionId $sessionId -Project $Project -AoCommand $AoCommand
            $displayName = [string]$payload.session.displayName
            if ($displayName) {
                $details[$sessionId] = @{ displayName = $displayName }
            }
        }
        catch {
            continue
        }
    }
    return $details
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

function Get-AoStatusSessionsWithReports {
    param(
        [string]$Project = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao'
    )

    if ($ReportFullPayload) {
        return @(Get-AoStatusSessionsWithReportsFromPayload -Payload $ReportFullPayload -SourceKind 'fixture-report-full')
    }

    if (Test-AoReportFullCliAvailable -AoCommand $AoCommand) {
        $payload = Get-AoStatusReportsJson -Project $Project -AoCommand $AoCommand
        return @(Get-AoStatusSessionsWithReportsFromPayload -Payload $payload -SourceKind 'cli-report-full')
    }

    $sessions = @(Get-AoStatusSessions -Project $Project `
            -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
            -AoCommand $AoCommand)
    return @(Merge-AoSessionRowsWithReportAudit -Sessions $sessions -Project $Project -SourceKind 'audit-backed')
}

function Get-AoStatusSessionsWithReportsIncludingTerminated {
    param(
        [string]$Project = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao'
    )

    if ($ReportFullPayload) {
        return @(Get-AoStatusSessionsWithReportsFromPayload -Payload $ReportFullPayload `
                -SourceKind 'cli-report-full-terminated')
    }

    if (Test-AoReportFullCliAvailable -AoCommand $AoCommand) {
        $payload = Get-AoStatusReportsIncludingTerminatedJson -Project $Project -AoCommand $AoCommand
        return @(Get-AoStatusSessionsWithReportsFromPayload -Payload $payload `
                -SourceKind 'cli-report-full-terminated')
    }

    $sessions = @(Get-AoStatusSessionsIncludingTerminated -Project $Project `
            -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
            -AoCommand $AoCommand)
    return @(Merge-AoSessionRowsWithReportAudit -Sessions $sessions -Project $Project `
            -SourceKind 'audit-backed')
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
    param(
        [int]$SinceMinutes = 30,
        [string]$AoCommand = 'ao'
    )

    if (-not (Test-AoEventsCliAvailable -AoCommand $AoCommand)) {
        $classification = Get-AoEventsDegradedClassification
        if ($classification.degraded) {
            $detail = [string]$classification.detail
            if ($detail) {
                Write-Host "[ao-events] removed_cli_surface: $detail"
            }
            else {
                Write-Host '[ao-events] removed_cli_surface: ao events list unavailable'
            }
        }
        return @()
    }

    try {
        $payload = Invoke-AoCliJson -AoArgs @(
        'events', 'list', '--since', "${SinceMinutes}m", '--limit', '500', '--json'
        ) -FailureLabel 'ao events list' -AoCommand $AoCommand
        $Script:AoEventsDegradedClassification = $null
        return @($payload.events)
    }
    catch {
        Set-AoEventsDegradedClassification -Reason 'removed_cli_surface' -Detail $_.Exception.Message | Out-Null
        return @()
    }
}
