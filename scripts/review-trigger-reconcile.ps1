#requires -Version 5.1
<#
.SYNOPSIS
  Low-frequency state-derived review-trigger reconciliation (Issue #163, #195).

.DESCRIPTION
  Independent process from the LLM orchestrator turn loop. Enumerates open PR heads via gh,
  compares coverage from ao review list --json, and starts ao review run only when the head
  is ready for review (Issue #195) — never ao spawn, --claim-pr, ao session kill, or ao send.

  Composes with Issue #98/#189 idempotency and reviewer-workspace-preflight.ps1.

  See docs/orchestrator-autoloop-go-live.md and docs/orchestrator-recovery-runbook.md.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [int]$IntervalMinutes = 0,
    [int]$PollSeconds = 60,
    [string]$StateFile = '',
    [string]$YamlPath = '',
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'
$Script:ReconcileLogPrefix = 'review-trigger-reconcile'

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) {
    $RepoRoot = $PackRoot
}

$ReconcileFilterCli = Join-Path $PackRoot 'docs/review-trigger-reconcile.mjs'
$CiGreenWakeFilterCli = Join-Path $PackRoot 'docs/ci-green-wake-reconcile.mjs'
$Script:DefaultIntervalMinutes = 10

. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')

function Get-ReconcileIntervalMinutes {
    if ($IntervalMinutes -gt 0) { return $IntervalMinutes }
    $envMinutes = $env:AO_REVIEW_TRIGGER_RECONCILE_INTERVAL_MINUTES
    if ($envMinutes -and [int]::TryParse($envMinutes, [ref]$null)) {
        return [int]$envMinutes
    }
    return $Script:DefaultIntervalMinutes
}

function Get-ReconcileStatePath {
    param([string]$CliPath)
    if ($CliPath) { return $CliPath }
    if ($env:AO_REVIEW_TRIGGER_RECONCILE_STATE) { return $env:AO_REVIEW_TRIGGER_RECONCILE_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-reconcile-state.json'
}

function Write-ReconcileLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReconcileLogPrefix): $Message"
}

function Invoke-ReconcileFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $ReconcileFilterCli -Subcommand $Subcommand `
        -Payload $Payload -Label $Script:ReconcileLogPrefix -JsonDepth 30
}

function Get-ReconcileState {
    param([string]$Path)

    $default = @{ lastTickMs = $null; degradedCi = @{} }
    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $default
}

function Set-ReconcileState {
    param(
        [string]$Path,
        [object]$State
    )

    Set-MechanicalJsonStateFile -Path $Path -State $State -JsonDepth 30
}

function ConvertFrom-GhJsonArrayOutput {
    param([object]$RawOutput)

    $text = ($RawOutput | ForEach-Object {
            if ($_ -is [string]) { $_ }
            elseif ($null -ne $_) { $_.ToString() }
        }) -join "`n"
    $start = $text.IndexOf('[')
    if ($start -lt 0) {
        return @()
    }

    return @($text.Substring($start) | ConvertFrom-Json)
}

function Invoke-GhOpenPrList {
    Push-Location -LiteralPath $RepoRoot
    try {
        $raw = gh pr list --state open --json number,headRefOid --limit 200 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "gh pr list failed (exit $LASTEXITCODE): $raw"
        }

        return @($raw | ConvertFrom-Json)
    }
    finally {
        Pop-Location
    }
}

function Invoke-GhPrChecks {
    param([int]$PrNumber)

    Push-Location -LiteralPath $RepoRoot
    try {
        $raw = gh pr checks $PrNumber --json name,state,bucket,link,startedAt,completedAt,workflow,description 2>&1
        $exitCode = $LASTEXITCODE
        $checks = ConvertFrom-GhJsonArrayOutput -RawOutput $raw
        if ($exitCode -ne 0 -and $checks.Count -eq 0) {
            Write-ReconcileLog "warn: gh pr checks PR #$PrNumber exit $exitCode with no parseable JSON; treating as degraded visibility"
        }
        return @($checks)
    }
    finally {
        Pop-Location
    }
}

function Get-GhRequiredCheckNamesForPr {
    param([int]$PrNumber)

    Push-Location -LiteralPath $RepoRoot
    try {
        $baseRef = gh pr view $PrNumber --json baseRefName -q .baseRefName 2>&1
        if ($LASTEXITCODE -ne 0 -or -not $baseRef) {
            return @{ names = $null; lookupFailed = $true }
        }

        $repoSlug = gh repo view --json nameWithOwner -q .nameWithOwner 2>&1
        if ($LASTEXITCODE -ne 0 -or -not $repoSlug) {
            return @{ names = $null; lookupFailed = $true }
        }

        $protectionRaw = gh api "repos/$repoSlug/branches/$baseRef/protection" 2>&1
        $protectionExit = $LASTEXITCODE
        if ($protectionExit -ne 0) {
            $protectionText = ($protectionRaw | ForEach-Object { $_.ToString() }) -join "`n"
            if ($protectionText -match 'Branch not protected|404') {
                return @{ names = $null; lookupFailed = $false }
            }
            Write-ReconcileLog "warn: branch protection lookup failed PR #$PrNumber (exit $protectionExit); treating required CI as degraded"
            return @{ names = $null; lookupFailed = $true }
        }

        $protection = $protectionRaw | ConvertFrom-Json
        $rsc = $protection.required_status_checks
        if (-not $rsc) {
            return @{ names = $null; lookupFailed = $false }
        }

        $merged = Invoke-MechanicalNodeFilterCli -FilterCliPath $CiGreenWakeFilterCli -Subcommand 'merge-required-names' -Payload @{
            contexts = @($rsc.contexts)
            checks   = @($rsc.checks)
        } -Label 'ci-green-wake-reconcile' -JsonDepth 20
        if (-not $merged -or @($merged).Count -eq 0) {
            return @{ names = $null; lookupFailed = $false }
        }

        return @{ names = @($merged); lookupFailed = $false }
    }
    finally {
        Pop-Location
    }
}

function Get-ReconcileChecksByPr {
    param([array]$OpenPrs)

    $ciChecksByPr = @{}
    $requiredCheckNamesByPr = @{}
    $requiredCheckLookupFailedByPr = @{}
    foreach ($pr in @($OpenPrs)) {
        $n = [int]$pr.number
        if (-not $n) {
            continue
        }

        try {
            $ciChecksByPr[[string]$n] = @(Invoke-GhPrChecks -PrNumber $n)
        }
        catch {
            Write-ReconcileLog "warn: checks fetch failed PR #$n : $_"
            $ciChecksByPr[[string]$n] = @()
        }

        $requiredLookup = Get-GhRequiredCheckNamesForPr -PrNumber $n
        if ($requiredLookup.lookupFailed) {
            $requiredCheckLookupFailedByPr[[string]$n] = $true
        }
        elseif ($requiredLookup.names) {
            $requiredCheckNamesByPr[[string]$n] = @($requiredLookup.names)
        }
    }

    return @{
        ciChecksByPr                  = $ciChecksByPr
        requiredCheckNamesByPr        = $requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $requiredCheckLookupFailedByPr
    }
}

function Get-FixtureReconcilePayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $payload = @{
        openPrs       = @($fixture.openPrs)
        reviewRuns    = @($fixture.reviewRuns)
        sessions      = @($fixture.sessions)
        reviewCommand = [string]$fixture.reviewCommand
    }
    if ($fixture.ciChecksByPr) {
        $payload.ciChecksByPr = $fixture.ciChecksByPr
    }
    if ($fixture.requiredCheckNamesByPr) {
        $payload.requiredCheckNamesByPr = $fixture.requiredCheckNamesByPr
    }
    if ($fixture.requiredCheckLookupFailedByPr) {
        $payload.requiredCheckLookupFailedByPr = $fixture.requiredCheckLookupFailedByPr
    }
    if ($fixture.tracking) {
        $payload.tracking = $fixture.tracking
    }
    return $payload
}

function Get-PreRunRecheckSnapshot {
    param(
        [int]$PrNumber,
        [string]$Project
    )

    $openPrs = Invoke-GhOpenPrList
    $reviewRuns = Get-AoReviewRuns -Project $Project
    $sessions = Get-AoStatusSessions
    $checksBundle = Get-ReconcileChecksByPr -OpenPrs @(
        @($openPrs | Where-Object { [int]$_.number -eq $PrNumber })
    )

    return @{
        openPrs                         = @($openPrs)
        reviewRuns                      = @($reviewRuns)
        sessions                        = @($sessions)
        ciChecksByPr                    = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr          = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr   = $checksBundle.requiredCheckLookupFailedByPr
    }
}

function Invoke-ReviewerWorkspacePreflight {
    $preflight = Join-Path $PackRoot 'scripts/reviewer-workspace-preflight.ps1'
    if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) {
        return
    }

    & $preflight -RepoRoot $RepoRoot
    if ($LASTEXITCODE -ne 0) {
        throw "reviewer-workspace-preflight failed (exit $LASTEXITCODE)"
    }
}

function Test-PreRunHeadReadyRecheck {
    param(
        [hashtable]$PlannedAction,
        [string]$Project,
        [hashtable]$FixtureSnapshot
    )

    $fresh = if ($FixtureSnapshot) {
        $FixtureSnapshot
    }
    else {
        Get-PreRunRecheckSnapshot -PrNumber $PlannedAction.prNumber -Project $Project
    }

    $prKey = [string]$PlannedAction.prNumber
    $recheck = Invoke-ReconcileFilterCli -Subcommand 'preRunRecheck' -Payload @{
        planned = @{
            prNumber  = $PlannedAction.prNumber
            headSha   = $PlannedAction.headSha
            sessionId = $PlannedAction.sessionId
        }
        fresh   = @{
            reviewRuns                    = @($fresh.reviewRuns)
            sessions                      = @($fresh.sessions)
            ciChecks                      = @($fresh.ciChecksByPr[$prKey])
            requiredCheckNames            = @($fresh.requiredCheckNamesByPr[$prKey])
            requiredCheckLookupFailed     = [bool]$fresh.requiredCheckLookupFailedByPr[$prKey]
        }
    }

    return $recheck
}

function Invoke-PlannedReviewRun {
    param(
        [string]$SessionId,
        [string]$ReviewCommand,
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$Project,
        [switch]$DryRunMode,
        [hashtable]$FixtureSnapshot
    )

    $runArgs = @('review', 'run', $SessionId, '--execute', '--command', $ReviewCommand)
    $commandLine = "ao $($runArgs -join ' ')"
    Test-ReviewMechanicalForbiddenCommand -CommandLine $commandLine

    if ($DryRunMode) {
        Write-ReconcileLog "dry-run would run: $commandLine (PR #$PrNumber head=$HeadSha)"
        return
    }

    $recheck = Test-PreRunHeadReadyRecheck -PlannedAction @{
        prNumber  = $PrNumber
        headSha   = $HeadSha
        sessionId = $SessionId
    } -Project $Project -FixtureSnapshot $FixtureSnapshot

    if (-not $recheck.emitReviewRun) {
        Write-ReconcileLog "pre-run re-check aborted review for PR #$PrNumber head=$HeadSha ($($recheck.reason))"
        return
    }

    Invoke-ReviewerWorkspacePreflight
    Write-ReconcileLog "starting review: PR #$PrNumber head=$HeadSha session=$SessionId"
    & ao @runArgs
    if ($LASTEXITCODE -ne 0) {
        throw "ao review run failed (exit $LASTEXITCODE) for PR #$PrNumber"
    }
}

function Merge-DegradedCiTracking {
    param(
        [hashtable]$Existing,
        [array]$Actions,
        [long]$NowMs
    )

    $merged = @{}
    foreach ($key in $Existing.Keys) {
        $merged[$key] = $Existing[$key]
    }

    foreach ($action in @($Actions)) {
        if ($action.type -ne 'track_degraded_ci') {
            continue
        }
        $trackKey = "$($action.prNumber):$($action.headSha)".ToLowerInvariant()
        $merged[$trackKey] = @{
            attempts       = [int]$action.attempts
            lastAttemptMs  = [long]$action.lastAttemptMs
        }
    }

    return $merged
}

function Invoke-ReconcileTick {
    param(
        [string]$Project,
        [string]$ConfigYaml,
        [switch]$DryRunMode,
        [string]$Fixture,
        [hashtable]$TrackingState
    )

    $fixtureSnapshot = $null
    if ($Fixture) {
        $payload = Get-FixtureReconcilePayload -Path $Fixture
        $reviewCommand = $payload.reviewCommand
        if (-not $reviewCommand) {
            $reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $ConfigYaml
        }
        $fixtureSnapshot = @{
            reviewRuns                    = $payload.reviewRuns
            sessions                      = $payload.sessions
            ciChecksByPr                  = $payload.ciChecksByPr
            requiredCheckNamesByPr        = $payload.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $payload.requiredCheckLookupFailedByPr
        }
    }
    else {
        $openPrs = Invoke-GhOpenPrList
        $reviewRuns = Get-AoReviewRuns -Project $Project
        $sessions = Get-AoStatusSessions
        $checksBundle = Get-ReconcileChecksByPr -OpenPrs @($openPrs)
        $payload = @{
            openPrs                       = @($openPrs)
            reviewRuns                    = @($reviewRuns)
            sessions                      = @($sessions)
            ciChecksByPr                  = $checksBundle.ciChecksByPr
            requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
        }
        $reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $ConfigYaml
    }

    if (-not $reviewCommand) {
        throw 'Could not resolve REVIEW_COMMAND from agent-orchestrator.yaml'
    }

    $planPayload = $payload.Clone()
    $planPayload.tracking = $TrackingState
    $planPayload.nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    $plan = Invoke-ReconcileFilterCli -Subcommand 'plan' -Payload $planPayload
    $started = 0
    foreach ($action in @($plan)) {
        if ($action.type -eq 'skip') {
            Write-ReconcileLog "skip PR #$($action.prNumber): $($action.reason)"
            continue
        }
        if ($action.type -eq 'escalate_degraded_ci') {
            Write-ReconcileLog "ESCALATE PR #$($action.prNumber): $($action.message)"
            continue
        }
        if ($action.type -eq 'track_degraded_ci') {
            Write-ReconcileLog "degraded-ci retry PR #$($action.prNumber) head=$($action.headSha) attempt=$($action.attempts)"
            continue
        }
        if ($action.type -ne 'start_review') {
            continue
        }

        Invoke-PlannedReviewRun -SessionId $action.sessionId -ReviewCommand $reviewCommand `
            -PrNumber $action.prNumber -HeadSha $action.headSha -Project $Project `
            -DryRunMode:$DryRunMode -FixtureSnapshot $fixtureSnapshot
        $started++
    }

    return @{
        started = $started
        plan    = @($plan)
    }
}

$intervalMinutes = Get-ReconcileIntervalMinutes
$intervalMs = [Math]::Max(1, $intervalMinutes) * 60 * 1000
$pollMs = [Math]::Max(5, $PollSeconds) * 1000
$statePath = Get-ReconcileStatePath -CliPath $StateFile
$configYaml = if ($YamlPath) {
    (Resolve-Path -LiteralPath $YamlPath).Path
}
else {
    $live = Join-Path $PackRoot 'agent-orchestrator.yaml'
    if (Test-Path -LiteralPath $live -PathType Leaf) { $live } else { Join-Path $PackRoot 'agent-orchestrator.yaml.example' }
}

Write-ReconcileLog "starting (project=$ProjectId, interval=${intervalMinutes}m, state=$statePath, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"

if ($FixturePath) {
    $state = Get-ReconcileState -Path $statePath
    $tracking = @{ degradedCi = @{} }
    if ($state.degradedCi) {
        $tracking.degradedCi = @{}
        foreach ($prop in $state.degradedCi.PSObject.Properties) {
            $tracking.degradedCi[$prop.Name] = $prop.Value
        }
    }
    $result = Invoke-ReconcileTick -Project $ProjectId -ConfigYaml $configYaml -DryRunMode:$DryRun `
        -Fixture $FixturePath -TrackingState $tracking
    Write-ReconcileLog "fixture tick complete (started=$($result.started))"
    exit 0
}

try {
    do {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $state = Get-ReconcileState -Path $statePath
        $lastTickMs = $null
        if ($state.lastTickMs) {
            $lastTickMs = [long]$state.lastTickMs
        }

        $gate = Invoke-ReconcileFilterCli -Subcommand 'interval' -Payload @{
            nowMs      = $nowMs
            lastTickMs = $lastTickMs
            intervalMs = $intervalMs
        }

        if (-not $gate.ok) {
            Write-ReconcileLog "tick skipped: $($gate.reason)"
        }
        else {
            $tickTracking = @{ degradedCi = @{} }
            if ($state.degradedCi) {
                foreach ($prop in $state.degradedCi.PSObject.Properties) {
                    $tickTracking.degradedCi[$prop.Name] = $prop.Value
                }
            }
            try {
                $result = Invoke-ReconcileTick -Project $ProjectId -ConfigYaml $configYaml `
                    -DryRunMode:$DryRun -TrackingState $tickTracking
                Write-ReconcileLog "tick complete (started=$($result.started))"
            }
            catch {
                Write-ReconcileLog "tick error: $_"
                $result = $null
            }
            finally {
                if (-not $DryRun) {
                    $degradedCi = $tickTracking.degradedCi
                    if ($result -and $result.plan) {
                        $degradedCi = Merge-DegradedCiTracking -Existing $tickTracking.degradedCi `
                            -Actions $result.plan -NowMs $nowMs
                    }
                    Set-ReconcileState -Path $statePath -State @{
                        lastTickMs = $nowMs
                        degradedCi = $degradedCi
                    }
                }
                else {
                    Write-ReconcileLog 'dry-run: interval state not updated'
                }
            }
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-ReconcileLog 'stopped'
}
