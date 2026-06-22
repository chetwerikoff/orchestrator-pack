#requires -Version 5.1
<#
.SYNOPSIS
  Supervised report-state poll child for review-start seeding (Issue #391).

.DESCRIPTION
  Seconds-scale poll over ao status (including terminated sessions), binds accepted
  ready_for_review reports to current PR heads, seeds scoped #235 watches, and invokes
  bounded reeval with machine-distinct startReason report_state_seed.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [string]$StateDir = '',
    [int]$PollSeconds = 5,
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'
$Script:SeedLogPrefix = 'review-ready-report-state-seed'

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) {
    $RepoRoot = $PackRoot
}

. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-ReviewReadyReportStateSeed.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-ReviewReadyReportStateSeed.ps1')

function Write-ReviewReadyReportStateSeedLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:SeedLogPrefix): $Message"
}

function Get-ReviewReadyReportStateSeedStateRoot {
    if ($StateDir) { return $StateDir }
    if ($env:AO_SIDE_PROCESS_STATE_DIR) { return $env:AO_SIDE_PROCESS_STATE_DIR.Trim() }
    return ''
}

function Get-FixtureReviewReadyReportStateSeedPayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $payload = @{
        openPrs    = @($fixture.openPrs)
        reviewRuns = @($fixture.reviewRuns)
        sessions   = @($fixture.sessions)
    }
    foreach ($name in @(
            'ciChecksByPr', 'requiredCheckNamesByPr', 'requiredCheckLookupFailedByPr',
            'bindingByKey', 'seededKeys', 'deferredScanKeys', 'handoffRecords',
            'terminalClaimKeys', 'watchEntries', 'tickCapacity', 'nowMs', 'reviewCommand'
        )) {
        if ($null -ne $fixture.$name) {
            $payload[$name] = $fixture.$name
        }
    }
    return $payload
}

$stateRoot = Get-ReviewReadyReportStateSeedStateRoot
$pollMs = [Math]::Max(1, $PollSeconds) * 1000
$configYaml = Join-Path $PackRoot 'agent-orchestrator.yaml'
if (-not (Test-Path -LiteralPath $configYaml -PathType Leaf)) {
    $configYaml = Join-Path $PackRoot 'agent-orchestrator.yaml.example'
}
$reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $configYaml

Write-ReviewReadyReportStateSeedLog "starting (project=$ProjectId, poll=${PollSeconds}s, stateRoot=$stateRoot, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"
Write-ReviewReadyReportStateSeedLog 'pollClass=report_state_poll seedStartReason=report_state_seed'

if ($FixturePath) {
    $payload = Get-FixtureReviewReadyReportStateSeedPayload -Path $FixturePath
    if ($payload.reviewCommand) {
        $reviewCommand = $payload.reviewCommand
    }
    $result = Invoke-ReviewReadyReportStateSeedTick -StateRoot $stateRoot -ProjectId $ProjectId `
        -RepoRoot $RepoRoot -ReviewCommand $reviewCommand -FixturePayload $payload -DryRun:$DryRun `
        -LogWriter { param([string]$Message) Write-ReviewReadyReportStateSeedLog $Message }
    Write-ReviewReadyReportStateSeedLog "fixture tick complete (started=$($result.started), seeded=$($result.seeded))"
    exit 0
}

if (-not $reviewCommand) {
    throw 'Could not resolve REVIEW_COMMAND from agent-orchestrator.yaml'
}

try {
    do {
        Write-OrchestratorSideProcessProgress -ChildId 'review-ready-report-state-seed' -Phase 'poll'
        try {
            $result = Invoke-ReviewReadyReportStateSeedTick -StateRoot $stateRoot -ProjectId $ProjectId `
                -RepoRoot $RepoRoot -ReviewCommand $reviewCommand -DryRun:$DryRun `
                -LogWriter { param([string]$Message) Write-ReviewReadyReportStateSeedLog $Message }
            Write-ReviewReadyReportStateSeedLog "tick complete (started=$($result.started), seeded=$($result.seeded), candidates=$($result.candidates))"
            Write-OrchestratorSideProcessTickSuccess -ChildId 'review-ready-report-state-seed'
        }
        catch {
            Write-ReviewReadyReportStateSeedLog "tick error: $_"
            Write-OrchestratorSideProcessTickError -ChildId 'review-ready-report-state-seed' -ErrorMessage "$_"
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-ReviewReadyReportStateSeedLog 'stopped'
}
