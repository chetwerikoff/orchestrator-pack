#requires -Version 5.1

$Script:RuntimeStatusValidRoles = @('worker', 'orchestrator')

function Invoke-RuntimeWorkerCli {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateSet('readiness','list','find')][string]$Command,
        [string]$Adapter = '',
        [string]$Cwd = '',
        [int]$TimeoutMs = 0,
        [string]$Workspace = 'active',
        [string]$Runtime = '',
        [string]$Id = '',
        [string]$Generation = ''
    )
    $packRoot = [string](Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
    $launcher = Join-Path $packRoot 'scripts/lib/Invoke-TypeScriptCli.ts'
    $cli = Join-Path $packRoot 'scripts/runtime/runtime-cli.ts'
    $args = @('--experimental-strip-types', $launcher, '--repo-root', $packRoot, '--script', $cli, '--', $Command)
    if ($Adapter) { $args += @('--adapter', $Adapter) }
    if ($Cwd) { $args += @('--cwd', $Cwd) }
    if ($TimeoutMs -gt 0) { $args += @('--timeout-ms', [string]$TimeoutMs) }
    if ($Command -eq 'list' -and $Workspace) { $args += @('--workspace', $Workspace) }
    if ($Command -eq 'find') {
        $args += @('--runtime', $Runtime, '--id', $Id, '--generation', $Generation)
    }
    $raw = & node @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "runtime-cli $Command failed (exit $LASTEXITCODE): $($raw -join [Environment]::NewLine)" }
    $text = ($raw | ForEach-Object { [string]$_ }) -join "`n"
    if (-not $text.Trim()) { throw "runtime-cli $Command returned empty stdout" }
    return $text | ConvertFrom-Json
}

function Get-RuntimeReadiness { param([string]$Adapter = '', [string]$Cwd = '', [int]$TimeoutMs = 0) return Invoke-RuntimeWorkerCli -Command readiness -Adapter $Adapter -Cwd $Cwd -TimeoutMs $TimeoutMs }
function Get-RuntimeWorkers { param([string]$Adapter = '', [string]$Cwd = '', [int]$TimeoutMs = 0, [string]$Workspace = 'active') return Invoke-RuntimeWorkerCli -Command list -Adapter $Adapter -Cwd $Cwd -TimeoutMs $TimeoutMs -Workspace $Workspace }
function Find-RuntimeWorker { param([Parameter(Mandatory=$true)][string]$Runtime,[Parameter(Mandatory=$true)][string]$Id,[Parameter(Mandatory=$true)][string]$Generation,[string]$Adapter = '',[string]$Cwd = '',[int]$TimeoutMs = 0) return Invoke-RuntimeWorkerCli -Command find -Runtime $Runtime -Id $Id -Generation $Generation -Adapter $Adapter -Cwd $Cwd -TimeoutMs $TimeoutMs }

function Get-RuntimeStatusSessionIdentifier {
    param($Row)

    if (-not $Row) { return '' }
    foreach ($key in @('id', 'name', 'sessionId')) {
        $value = [string]$Row.$key
        if (-not [string]::IsNullOrWhiteSpace($value)) { return $value.Trim() }
    }
    if ($Row.PSObject.Properties.Name -contains 'identity') {
        $value = [string]$Row.identity.id
        if (-not [string]::IsNullOrWhiteSpace($value)) { return $value.Trim() }
    }
    return ''
}

function Get-RuntimeStatusSessionIdentity {
    param($Row)

    if (-not $Row) { return $null }
    $identity = if ($Row.PSObject.Properties.Name -contains 'identity') { $Row.identity } else { $Row }
    $runtime = [string]$identity.runtime
    $id = [string]$identity.id
    $generation = [string]$identity.generation
    if ([string]::IsNullOrWhiteSpace($id)) { $id = Get-RuntimeStatusSessionIdentifier -Row $Row }
    if ([string]::IsNullOrWhiteSpace($runtime) -or [string]::IsNullOrWhiteSpace($id) -or [string]::IsNullOrWhiteSpace($generation)) {
        return $null
    }
    return [pscustomobject]@{ runtime = $runtime.Trim(); id = $id.Trim(); generation = $generation.Trim() }
}

function Test-RuntimeWorkerRowNeedsSessionGetDetail {
    param($Row)

    if (-not $Row) { return $false }
    $prNumber = 0
    if ($null -ne $Row.prNumber) { [void][int]::TryParse([string]$Row.prNumber, [ref]$prNumber) }
    if ($prNumber -gt 0) { return $false }
    $displayName = [string]$Row.displayName
    if ($displayName -match '^\d+$') { return $false }
    $role = [string]$Row.role
    if ($role -and $role -notin @('worker', 'coding')) { return $false }
    return -not [string]::IsNullOrWhiteSpace((Get-RuntimeStatusSessionIdentifier -Row $Row))
}

function ConvertTo-RuntimeStatusFixtureSessionRow {
    param($Row)

    if (-not $Row) { return $null }
    $id = Get-RuntimeStatusSessionIdentifier -Row $Row
    $projectId = [string]$Row.projectId
    if ([string]::IsNullOrWhiteSpace($projectId)) { $projectId = [string]$Row.project }
    $normalized = [ordered]@{}
    foreach ($prop in $Row.PSObject.Properties) { $normalized[$prop.Name] = $prop.Value }
    if ($id) {
        $normalized['id'] = $id
        if (-not $normalized['name']) { $normalized['name'] = $id }
        if (-not $normalized['sessionId']) { $normalized['sessionId'] = $id }
    }
    if (-not [string]::IsNullOrWhiteSpace($projectId)) {
        $normalized['projectId'] = $projectId.Trim()
        if (-not $normalized['project']) { $normalized['project'] = $projectId.Trim() }
    }
    if ($Row.issueId -and -not $normalized['issue']) { $normalized['issue'] = [string]$Row.issueId }
    return [pscustomobject]$normalized
}

function Assert-RuntimeStatusFixturePayload {
    param($Payload, [string]$Label)

    if (-not $Payload) { return }
    if ($Payload.PSObject.Properties.Name -notcontains 'data' -or $null -eq $Payload.data) {
        throw "${Label}: missing required top-level data[]"
    }
}

function Assert-RuntimeStatusFixtureSessionRow {
    param($Row)

    if (-not $Row) { throw 'runtime worker fixture: null session row' }
    $id = [string]$Row.id
    if ([string]::IsNullOrWhiteSpace($id)) { throw 'runtime worker fixture: session row missing non-empty id' }
    $role = [string]$Row.role
    if ([string]::IsNullOrWhiteSpace($role) -or ($Script:RuntimeStatusValidRoles -notcontains $role)) {
        throw "runtime worker fixture: session row $id has invalid role '$role'"
    }
    if ([string]::IsNullOrWhiteSpace([string]$Row.status)) { throw "runtime worker fixture: session row $id missing status" }
    if ($Row.PSObject.Properties.Name -notcontains 'isTerminated' -or $Row.isTerminated -isnot [bool]) {
        throw "runtime worker fixture: session row $id isTerminated must be boolean"
    }
    if ($Row.PSObject.Properties.Name -contains 'reports') {
        throw "runtime worker fixture: session row $id must not carry reports field"
    }
}

function Merge-RuntimeStatusFixtureSessionRows {
    param(
        [object[]]$WorkerRows = @(),
        [object[]]$OrchestratorRows = @(),
        [string]$Project = '',
        [switch]$IncludeTerminated
    )

    $merged = @{}
    foreach ($row in @($WorkerRows) + @($OrchestratorRows)) {
        if (-not $row) { continue }
        $normalized = ConvertTo-RuntimeStatusFixtureSessionRow -Row $row
        $projectId = [string]$normalized.projectId
        if ($Project -and $projectId -ne $Project) { continue }
        if (-not $IncludeTerminated -and [bool]$normalized.isTerminated) { continue }
        Assert-RuntimeStatusFixtureSessionRow -Row $normalized
        $id = [string]$normalized.id
        if ($merged.ContainsKey($id)) { throw "runtime worker fixture: duplicate session id '$id'" }
        $merged[$id] = $normalized
    }
    return @($merged.Values)
}

function ConvertTo-RuntimeStatusSessionsFromWorkers {
    param([object[]]$Workers = @(), [string]$Project = '')

    $seen = @{}
    return @(
        foreach ($worker in @($Workers)) {
            $identity = Get-RuntimeStatusSessionIdentity -Row $worker
            if (-not $identity) { throw 'runtime worker inventory returned incomplete composite identity' }
            if ($seen.ContainsKey($identity.id)) { throw "runtime worker inventory returned duplicate id '$($identity.id)'" }
            $seen[$identity.id] = $true
            $title = [string]$worker.title
            [pscustomobject][ordered]@{
                id = $identity.id
                name = $identity.id
                sessionId = $identity.id
                role = 'worker'
                status = 'unknown'
                isTerminated = $false
                projectId = $Project
                project = $Project
                runtime = $identity.runtime
                generation = $identity.generation
                workspacePath = [string]$worker.workspacePath
                title = if ([string]::IsNullOrWhiteSpace($title)) { $null } else { $title }
                displayName = if ($title -match '^\d+$') { $title } else { '' }
                provenance = [string]$worker.provenance
            }
        }
    )
}

function Get-RuntimeStatusSessions {
    param(
        [string]$Project = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        [string]$Adapter = '',
        [string]$Cwd = '',
        [int]$TimeoutMs = 60000
    )

    if ($null -ne $WorkerListPayload -or $null -ne $OrchestratorListPayload) {
        Assert-RuntimeStatusFixturePayload -Payload $WorkerListPayload -Label 'runtime worker fixture'
        Assert-RuntimeStatusFixturePayload -Payload $OrchestratorListPayload -Label 'runtime orchestrator fixture'
        return @(Merge-RuntimeStatusFixtureSessionRows `
            -WorkerRows $(if ($WorkerListPayload) { @($WorkerListPayload.data) } else { @() }) `
            -OrchestratorRows $(if ($OrchestratorListPayload) { @($OrchestratorListPayload.data) } else { @() }) `
            -Project $Project)
    }

    $inventory = Get-RuntimeWorkers -Adapter $Adapter -Cwd $Cwd -TimeoutMs $TimeoutMs -Workspace $(if ($Cwd) { $Cwd } else { 'active' })
    if ([string]$inventory.status -ne 'ok') {
        throw "runtime worker inventory failed: $([string]$inventory.operation):$([string]$inventory.status):$([string]$inventory.reason)"
    }
    return @(ConvertTo-RuntimeStatusSessionsFromWorkers -Workers @($inventory.value) -Project $Project)
}

function Get-RuntimeStatusSessionsIncludingTerminated {
    param(
        [string]$Project = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null
    )

    if ($null -eq $WorkerListPayload -and $null -eq $OrchestratorListPayload) {
        throw 'runtime worker terminated inventory is unsupported by the current RuntimeAdapter contract'
    }
    Assert-RuntimeStatusFixturePayload -Payload $WorkerListPayload -Label 'runtime worker fixture'
    Assert-RuntimeStatusFixturePayload -Payload $OrchestratorListPayload -Label 'runtime orchestrator fixture'
    return @(Merge-RuntimeStatusFixtureSessionRows `
        -WorkerRows $(if ($WorkerListPayload) { @($WorkerListPayload.data) } else { @() }) `
        -OrchestratorRows $(if ($OrchestratorListPayload) { @($OrchestratorListPayload.data) } else { @() }) `
        -Project $Project -IncludeTerminated)
}

function Get-RuntimeStatusSessionsWithReportsFromPayload {
    param($Payload, [string]$SourceKind = 'fixture-report-full')

    if (-not $Payload) { return @() }
    $sessions = if ($Payload.PSObject.Properties.Name -contains 'data') { @($Payload.data) } elseif ($Payload.PSObject.Properties.Name -contains 'sessions') { @($Payload.sessions) } else { @() }
    return @(
        foreach ($session in $sessions) {
            if (-not $session) { continue }
            $sessionId = Get-RuntimeStatusSessionIdentifier -Row $session
            $row = [ordered]@{}
            foreach ($prop in $session.PSObject.Properties) { $row[$prop.Name] = $prop.Value }
            if (-not $row['reports']) { $row['reports'] = @() }
            $row['reportSourcePath'] = "fixture:$SourceKind:$sessionId"
            $row['reportSnapshotKind'] = $SourceKind
            [pscustomobject]$row
        }
    )
}

function Get-RuntimeStatusSessionsWithReports {
    param($ReportFullPayload = $null)
    if (-not $ReportFullPayload) { throw 'report-full payload is required for persisted worker-status evidence' }
    return @(Get-RuntimeStatusSessionsWithReportsFromPayload -Payload $ReportFullPayload -SourceKind 'fixture-report-full')
}

function Get-RuntimeStatusSessionsWithReportsIncludingTerminated {
    param($ReportFullPayload = $null)
    if (-not $ReportFullPayload) { throw 'report-full payload is required for terminated persisted worker-status evidence' }
    return @(Get-RuntimeStatusSessionsWithReportsFromPayload -Payload $ReportFullPayload -SourceKind 'fixture-report-full-terminated')
}
