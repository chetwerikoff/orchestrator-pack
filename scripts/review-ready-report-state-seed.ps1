#requires -Version 5.1
<#
.SYNOPSIS
  Supervised report-state poll child for review-start seeding (Issues #391, #748).

.DESCRIPTION
  Seconds-scale poll over ao status (including terminated sessions), binds accepted
  ready_for_review reports to current PR heads, seeds scoped #235 watches, and invokes
  bounded reeval with machine-distinct startReason report_state_seed.

.NOTES
  Issue #748 migration is quiesce -> replace -> restart. Stop all supervised children
  before replacing the pack, then restart the complete generation from the primary
  checkout. Do not rolling-restart mixed old readers/writers with the new sole owner.
  Rollback uses the same stop-all boundary before restoring the previous generation.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [string]$StateDir = '',
    [int]$PollSeconds = 5,
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = '',
    [string]$SupervisedRepoSlug = ''
)

$ErrorActionPreference = 'Stop'
$Script:SeedLogPrefix = 'review-ready-report-state-seed'

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) {
    $RepoRoot = $PackRoot
}

. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-ReadyReportStateSeedProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
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

. (Join-Path $PSScriptRoot 'lib/Review-ReadySeedFixturePayload.ps1')

function Get-FixtureReviewReadyReportStateSeedPayload {
    param([string]$Path)
    return (Get-ReviewReadySeedFixturePayload -Fixture (Resolve-ReviewReadySeedFixture -FixturePath $Path))
}

function ConvertTo-WorkerStatusRefreshOperatorStatus {
    param($Diagnostic)

    if (-not $Diagnostic) { return $null }
    return @{
        schemaVersion     = 'worker-status-refresh-operator/v1'
        observedAtMs      = [long]$Diagnostic.observedAtMs
        owner             = ConvertTo-WorkerStatusRefreshSafeToken -Value ([string]$Diagnostic.owner) -Fallback 'unspecified'
        outcome           = ConvertTo-WorkerStatusRefreshSafeToken -Value ([string]$Diagnostic.outcome) -Fallback 'unknown'
        reasonCode        = ConvertTo-WorkerStatusRefreshSafeToken -Value ([string]$Diagnostic.reasonCode) -Fallback 'none'
        sessionCount      = [int]$Diagnostic.sessionCount
        writeAttemptCount = [int]$Diagnostic.writeAttemptCount
        successCount      = [int]$Diagnostic.successCount
        gateClosedCount   = [int]$Diagnostic.gateClosedCount
        skippedCount      = [int]$Diagnostic.skippedCount
        exceptionCount    = [int]$Diagnostic.exceptionCount
        failureCount      = [int]$Diagnostic.failureCount
        evictionRemoved   = [int]$Diagnostic.evictionRemoved
        evictionFailed    = [bool]$Diagnostic.evictionFailed
        githubDegraded    = [bool]$Diagnostic.githubDegraded
    }
}

function Invoke-ReviewReadyOwnedWorkerStatusRefresh {
    param(
        [hashtable]$FixturePayload = $null,
        [switch]$DryRunMode
    )

    if ($DryRunMode -and -not ($FixturePayload -and $FixturePayload.workerStatusRefresh)) {
        return $null
    }
    if ($FixturePayload -and -not $FixturePayload.workerStatusRefresh) {
        return $null
    }

    $refreshParams = @{
        Project            = $ProjectId
        RepoSlug           = $SupervisedRepoSlug
        IncludeTerminated  = $true
        Owner              = 'review-ready-report-state-seed'
    }
    if ($FixturePayload) {
        $refreshParams['Sessions'] = @($FixturePayload.sessions)
        $refreshParams['GithubSnapshot'] = @{
            openPrs                       = @($FixturePayload.openPrs)
            reviewRuns                    = @($FixturePayload.reviewRuns)
            ciChecksByPr                  = $FixturePayload.ciChecksByPr
            requiredCheckNamesByPr        = $FixturePayload.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $FixturePayload.requiredCheckLookupFailedByPr
            repoRoot                      = $RepoRoot
            degraded                      = $false
        }
        if ($FixturePayload.nowMs) {
            $refreshParams['NowMs'] = [long]$FixturePayload.nowMs
            $refreshParams['RepoTickGeneration'] = [long]$FixturePayload.nowMs
        }
        if ($FixturePayload.workerStatusRefresh.storePath) {
            $refreshParams['StorePath'] = [string]$FixturePayload.workerStatusRefresh.storePath
        }
    }

    $diagnostic = Invoke-WorkerStatusRefresh @refreshParams
    Write-ReviewReadyReportStateSeedLog (Format-WorkerStatusRefreshDiagnostic -Diagnostic $diagnostic)
    return $diagnostic
}

$stateRoot = Get-ReviewReadyReportStateSeedStateRoot
$pollMs = [Math]::Max(1, $PollSeconds) * 1000
$configYaml = Join-Path $PackRoot 'agent-orchestrator.yaml'
if (-not (Test-Path -LiteralPath $configYaml -PathType Leaf)) {
    $configYaml = Join-Path $PackRoot 'agent-orchestrator.yaml.example'
}
$reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $configYaml

Write-ReviewReadyReportStateSeedLog "starting (project=$ProjectId, poll=${PollSeconds}s, stateRoot=$stateRoot, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"
Write-ReviewReadyReportStateSeedLog 'pollClass=report_state_poll seedStartReason=report_state_seed workerStatusRefreshOwner=review-ready-report-state-seed'

if ($FixturePath) {
    $payload = Get-FixtureReviewReadyReportStateSeedPayload -Path $FixturePath
    if ($payload.reviewCommand) {
        $reviewCommand = $payload.reviewCommand
    }
    $refreshDiagnostic = Invoke-ReviewReadyOwnedWorkerStatusRefresh -FixturePayload $payload -DryRunMode:$DryRun
    if ($payload.workerStatusRefresh -and $payload.workerStatusRefresh.storePath) {
        $fixtureNowMs = if ($payload.nowMs) { [long]$payload.nowMs } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
        $payload.sessions = @(Merge-AoSessionRowsWithWorkerStatusStore -Sessions @($payload.sessions) `
                -StorePath ([string]$payload.workerStatusRefresh.storePath) -NowMs $fixtureNowMs `
                -RepoTickGeneration $fixtureNowMs)
    }
    $progressBundle = New-ReviewReadyReportStateSeedProgressWriter
    $result = Invoke-ReviewReadyReportStateSeedTick -StateRoot $stateRoot -ProjectId $ProjectId `
        -RepoRoot $RepoRoot -ReviewCommand $reviewCommand -FixturePayload $payload -DryRun:$DryRun -SupervisedRepoSlug $SupervisedRepoSlug `
        -ProgressWriter $progressBundle.Write -TickId $progressBundle.TickId `
        -LogWriter { param([string]$Message) Write-ReviewReadyReportStateSeedLog $Message }
    & $progressBundle.Write 'tick_finish'
    $operatorStatus = ConvertTo-WorkerStatusRefreshOperatorStatus -Diagnostic $refreshDiagnostic
    if ($operatorStatus) {
        Write-OrchestratorSideProcessProgress -ChildId 'review-ready-report-state-seed' -Phase 'tick_success' `
            -TickOutcome 'success' -Extra @{ workerStatusRefresh = $operatorStatus }
    }
    Write-ReviewReadyReportStateSeedLog "fixture tick complete (started=$($result.started), seeded=$($result.seeded), candidates=$($result.candidates))"
    exit 0
}

if (-not $reviewCommand) {
    throw 'Could not resolve REVIEW_COMMAND from agent-orchestrator.yaml'
}

try {
    do {
        $tickAdmission = Enter-ReviewReadyReportStateSeedTick -StateRoot $stateRoot
        if (-not $tickAdmission.acquired) {
            Write-ReviewReadyReportStateSeedLog 'tick skipped: prior tick still active'
            Write-OrchestratorSideProcessProgress -ChildId 'review-ready-report-state-seed' -Phase 'tick_skipped' -TickOutcome 'skipped'
            if ($Once) { break }
            Start-Sleep -Milliseconds $pollMs
            continue
        }

        $progressBundle = New-ReviewReadyReportStateSeedProgressWriter -TickId $tickAdmission.tickId
        $refreshDiagnostic = $null
        try {
            Write-OrchestratorSideProcessWorkHeartbeat -ChildId 'review-ready-report-state-seed' -Phase 'poll' `
                -WorkStep 'poll_start' -WorkCursor 1 -WorkTotal (Get-ReviewReadyReportStateSeedWorkTotal) `
                -TickId $progressBundle.TickId
            try {
                $refreshDiagnostic = Invoke-ReviewReadyOwnedWorkerStatusRefresh -DryRunMode:$DryRun
                $result = Invoke-ReviewReadyReportStateSeedTick -StateRoot $stateRoot -ProjectId $ProjectId `
                    -RepoRoot $RepoRoot -ReviewCommand $reviewCommand -DryRun:$DryRun -SupervisedRepoSlug $SupervisedRepoSlug `
                    -ProgressWriter $progressBundle.Write -TickId $progressBundle.TickId `
                    -LogWriter { param([string]$Message) Write-ReviewReadyReportStateSeedLog $Message }
                & $progressBundle.Write 'tick_finish'
                Write-ReviewReadyReportStateSeedLog "tick complete (started=$($result.started), seeded=$($result.seeded), candidates=$($result.candidates))"
                $successExtra = @{
                    progressSchemaVersion = 2
                    tickId                = $progressBundle.TickId
                }
                $operatorStatus = ConvertTo-WorkerStatusRefreshOperatorStatus -Diagnostic $refreshDiagnostic
                if ($operatorStatus) {
                    $successExtra['workerStatusRefresh'] = $operatorStatus
                }
                Write-OrchestratorSideProcessTickSuccess -ChildId 'review-ready-report-state-seed' -Extra $successExtra
            }
            catch {
                Write-ReviewReadyReportStateSeedLog "tick error: $_"
                $errorExtra = @{
                    progressSchemaVersion = 2
                    tickId                = $progressBundle.TickId
                }
                $operatorStatus = ConvertTo-WorkerStatusRefreshOperatorStatus -Diagnostic $refreshDiagnostic
                if ($operatorStatus) {
                    $errorExtra['workerStatusRefresh'] = $operatorStatus
                }
                Write-OrchestratorSideProcessTickError -ChildId 'review-ready-report-state-seed' -ErrorMessage "$_" -Extra $errorExtra
            }
        }
        finally {
            Exit-ReviewReadyReportStateSeedTick -StateRoot $stateRoot
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-ReviewReadyReportStateSeedLog 'stopped'
}
