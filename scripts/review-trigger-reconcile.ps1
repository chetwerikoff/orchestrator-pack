#requires -Version 5.1
<#
.SYNOPSIS
  Low-frequency state-derived review-trigger reconciliation (Issue #163).

.DESCRIPTION
  Independent process from the LLM orchestrator turn loop. Enumerates open PR heads via gh,
  compares coverage from ao review list --json, and starts ao review run for uncovered heads
  when a worker session is already linked — never ao spawn, --claim-pr, ao session kill, or
  ao send.

  Composes with Issue #98 idempotency (coverage logic) and reviewer-workspace-preflight.ps1.

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

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) {
    $RepoRoot = $PackRoot
}

$ReconcileFilterCli = Join-Path $PackRoot 'docs/review-trigger-reconcile.mjs'
$Script:DefaultIntervalMinutes = 20

. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')

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
    Write-Host "[$stamp] review-trigger-reconcile: $Message"
}

function Invoke-ReconcileFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    $json = $Payload | ConvertTo-Json -Depth 20 -Compress
    $output = $json | & node $ReconcileFilterCli $Subcommand 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "review-trigger-reconcile.mjs $Subcommand exited ${LASTEXITCODE}: $output"
    }

    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    return $text | ConvertFrom-Json
}

function Get-ReconcileState {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @{ lastTickMs = $null }
    }

    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        return @{ lastTickMs = $null }
    }
}

function Set-ReconcileState {
    param(
        [string]$Path,
        [long]$LastTickMs
    )

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    @{ lastTickMs = $LastTickMs } | ConvertTo-Json -Compress | Set-Content -LiteralPath $Path -Encoding utf8
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

function Get-AoStatusWorkerSessions {
    $payload = Get-AoStatusReportsJson
    return @($payload.data)
}

function Get-FixtureReconcilePayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    return @{
        openPrs       = @($fixture.openPrs)
        reviewRuns    = @($fixture.reviewRuns)
        sessions      = @($fixture.sessions)
        reviewCommand = [string]$fixture.reviewCommand
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

function Test-ForbiddenLifecycleCommand {
    param([string]$CommandLine)

    $blocked = @(
        'ao spawn',
        '--claim-pr',
        'ao session kill',
        'ao send'
    )
    foreach ($frag in $blocked) {
        if ($CommandLine -match [regex]::Escape($frag)) {
            throw "forbidden lifecycle fragment in command: $frag"
        }
    }
}

function Invoke-PlannedReviewRun {
    param(
        [string]$SessionId,
        [string]$ReviewCommand,
        [int]$PrNumber,
        [string]$HeadSha,
        [switch]$DryRunMode
    )

    $runArgs = @('review', 'run', $SessionId, '--execute', '--command', $ReviewCommand)
    $commandLine = "ao $($runArgs -join ' ')"
    Test-ForbiddenLifecycleCommand -CommandLine $commandLine

    if ($DryRunMode) {
        Write-ReconcileLog "dry-run would run: $commandLine (PR #$PrNumber head=$HeadSha)"
        return
    }

    Invoke-ReviewerWorkspacePreflight
    Write-ReconcileLog "starting review: PR #$PrNumber head=$HeadSha session=$SessionId"
    & ao @runArgs
    if ($LASTEXITCODE -ne 0) {
        throw "ao review run failed (exit $LASTEXITCODE) for PR #$PrNumber"
    }
}

function Invoke-ReconcileTick {
    param(
        [string]$Project,
        [string]$ConfigYaml,
        [switch]$DryRunMode,
        [string]$Fixture
    )

    if ($Fixture) {
        $payload = Get-FixtureReconcilePayload -Path $Fixture
        $reviewCommand = $payload.reviewCommand
        if (-not $reviewCommand) {
            $reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $ConfigYaml
        }
    }
    else {
        $openPrs = Invoke-GhOpenPrList
        $reviewList = Get-AoReviewListJson -Project $Project
        $reviewRuns = @($reviewList.runs)
        $sessions = Get-AoStatusWorkerSessions
        $payload = @{
            openPrs    = $openPrs
            reviewRuns = $reviewRuns
            sessions   = $sessions
        }
        $reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $ConfigYaml
    }

    if (-not $reviewCommand) {
        throw 'Could not resolve REVIEW_COMMAND from agent-orchestrator.yaml'
    }

    $plan = Invoke-ReconcileFilterCli -Subcommand 'plan' -Payload $payload
    $started = 0
    foreach ($action in @($plan)) {
        if ($action.type -eq 'skip') {
            Write-ReconcileLog "skip PR #$($action.prNumber): $($action.reason)"
            continue
        }
        if ($action.type -ne 'start_review') {
            continue
        }

        Invoke-PlannedReviewRun -SessionId $action.sessionId -ReviewCommand $reviewCommand `
            -PrNumber $action.prNumber -HeadSha $action.headSha -DryRunMode:$DryRunMode
        $started++
    }

    return $started
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
    $count = Invoke-ReconcileTick -Project $ProjectId -ConfigYaml $configYaml -DryRunMode:$DryRun -Fixture $FixturePath
    Write-ReconcileLog "fixture tick complete (started=$count)"
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
            try {
                $count = Invoke-ReconcileTick -Project $ProjectId -ConfigYaml $configYaml -DryRunMode:$DryRun
                Set-ReconcileState -Path $statePath -LastTickMs $nowMs
                Write-ReconcileLog "tick complete (started=$count)"
            }
            catch {
                Write-ReconcileLog "tick error: $_"
            }
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-ReconcileLog 'stopped'
}
