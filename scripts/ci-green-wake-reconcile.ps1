#requires -Version 5.1
<#
.SYNOPSIS
  State-derived CI-green worker wake reconciliation (Issue #191).

.DESCRIPTION
  Independent process from the LLM orchestrator turn loop. Enumerates open PR heads,
  evaluates required CI + worker pre-hand-off state, and ao send nudges to the live
  head-owning worker when CI is green — never ao spawn, --claim-pr, or ao session kill.

  AO 0.9.x has no CI-green reaction key for send-to-agent; this script is the
  non-turn-gated fast path (default 1-minute tick; worst-case latency ~60s + poll,
  far below report-stale ~30m). reactions.ci-failed and report-stale remain upstream
  backstops. Does not recover dead workers (#98).

  See docs/orchestrator-autoloop-go-live.md and docs/migration_notes.md.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [int]$IntervalMinutes = 0,
    [int]$PollSeconds = 60,
    [string]$StateFile = '',
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'
$Script:ReconcileLogPrefix = 'ci-green-wake-reconcile'

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) {
    $RepoRoot = $PackRoot
}

$WakeFilterCli = Join-Path $PackRoot 'docs/ci-green-wake-reconcile.mjs'
$Script:DefaultIntervalMinutes = 1

. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Ci-Green-Wake-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')

function Get-CiGreenWakeIntervalMinutes {
    if ($IntervalMinutes -gt 0) { return $IntervalMinutes }
    $envMinutes = $env:AO_CI_GREEN_WAKE_RECONCILE_INTERVAL_MINUTES
    if ($envMinutes -and [int]::TryParse($envMinutes, [ref]$null)) {
        return [int]$envMinutes
    }
    return $Script:DefaultIntervalMinutes
}

function Get-CiGreenWakeStatePath {
    param([string]$CliPath)
    if ($CliPath) { return $CliPath }
    if ($env:AO_CI_GREEN_WAKE_RECONCILE_STATE) { return $env:AO_CI_GREEN_WAKE_RECONCILE_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-ci-green-wake-state.json'
}

function Write-CiGreenWakeLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReconcileLogPrefix): $Message"
}

function Invoke-CiGreenWakeFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $WakeFilterCli -Subcommand $Subcommand `
        -Payload $Payload -Label $Script:ReconcileLogPrefix -JsonDepth 30
}

function Get-CiGreenWakeState {
    param([string]$Path)

    $default = @{ heads = @{}; nudged = @{}; lastTickMs = $null }
    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $default
}

function Set-CiGreenWakeState {
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
            Write-CiGreenWakeLog "warn: gh pr checks PR #$PrNumber exit $exitCode with no parseable JSON; treating as pending"
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
            return $null
        }

        $repoSlug = gh repo view --json nameWithOwner -q .nameWithOwner 2>&1
        if ($LASTEXITCODE -ne 0 -or -not $repoSlug) {
            return $null
        }

        $protectionRaw = gh api "repos/$repoSlug/branches/$baseRef/protection" 2>&1
        if ($LASTEXITCODE -ne 0) {
            return $null
        }

        $protection = $protectionRaw | ConvertFrom-Json
        $rsc = $protection.required_status_checks
        if (-not $rsc) {
            return $null
        }

        $names = Invoke-CiGreenWakeFilterCli -Subcommand 'merge-required-names' -Payload @{
            contexts = @($rsc.contexts)
            checks   = @($rsc.checks)
        }
        if (-not $names -or @($names).Count -eq 0) {
            return $null
        }

        return @($names)
    }
    finally {
        Pop-Location
    }
}

function Get-CiGreenWakeChecksByPr {
    param([array]$OpenPrs)

    $ciChecksByPr = @{}
    $requiredCheckNamesByPr = @{}
    foreach ($pr in @($OpenPrs)) {
        $n = [int]$pr.number
        if (-not $n) {
            continue
        }

        try {
            $ciChecksByPr[[string]$n] = @(Invoke-GhPrChecks -PrNumber $n)
        }
        catch {
            Write-CiGreenWakeLog "warn: checks fetch failed PR #$n : $_"
            $ciChecksByPr[[string]$n] = @()
        }

        $requiredNames = Get-GhRequiredCheckNamesForPr -PrNumber $n
        if ($requiredNames) {
            $requiredCheckNamesByPr[[string]$n] = @($requiredNames)
        }
    }

    return @{
        ciChecksByPr           = $ciChecksByPr
        requiredCheckNamesByPr = $requiredCheckNamesByPr
    }
}

function Get-CiGreenWakePreSendSnapshot {
    param(
        [int]$PrNumber,
        [string]$Project
    )

    $openPrs = Invoke-GhOpenPrList
    $sessions = Get-AoStatusSessions
    $checksBundle = Get-CiGreenWakeChecksByPr -OpenPrs @(
        @($openPrs | Where-Object { [int]$_.number -eq $PrNumber })
    )

    return @{
        openPrs                = @($openPrs)
        sessions               = @($sessions)
        ciChecksByPr           = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr = $checksBundle.requiredCheckNamesByPr
    }
}

function Get-FixtureCiGreenWakePayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    return @{
        openPrs                = @($fixture.openPrs)
        sessions               = @($fixture.sessions)
        ciChecksByPr           = $fixture.ciChecksByPr
        requiredCheckNamesByPr = $fixture.requiredCheckNamesByPr
        tracking               = $fixture.tracking
    }
}

function Invoke-PlannedCiGreenWakeSend {
    param(
        [object]$Action,
        [object]$FreshPayload,
        [string]$Project,
        [switch]$DryRunMode,
        [switch]$UseFixtureSnapshot
    )

    if ($UseFixtureSnapshot) {
        if (-not $FreshPayload) {
            throw 'FreshPayload is required when UseFixtureSnapshot is set'
        }
    }
    else {
        $FreshPayload = Get-CiGreenWakePreSendSnapshot -PrNumber ([int]$Action.prNumber) -Project $Project
    }

    $recheck = Invoke-CiGreenWakeFilterCli -Subcommand 'recheck' -Payload @{
        planned = @{
            sessionId = [string]$Action.sessionId
            prNumber  = [int]$Action.prNumber
            headSha   = [string]$Action.headSha
        }
        fresh = $FreshPayload
    }

    if (-not $recheck.ok) {
        Write-CiGreenWakeLog "pre-send recheck failed PR #$($Action.prNumber): $($recheck.reason)"
        return @{ sent = $false; reason = $recheck.reason }
    }

    $sendArgs = @('send', [string]$Action.sessionId, [string]$Action.message)
    $commandLine = "ao $($sendArgs -join ' ')"
    Test-CiGreenWakeMechanicalForbiddenCommand -CommandLine $commandLine

    if ($DryRunMode) {
        Write-CiGreenWakeLog "dry-run would send: PR #$($Action.prNumber) head=$($Action.headSha) session=$($Action.sessionId) transition=$($Action.transitionId)"
        return @{ sent = $true; reason = 'dry_run' }
    }

    Write-CiGreenWakeLog "nudging worker: PR #$($Action.prNumber) head=$($Action.headSha) session=$($Action.sessionId) transition=$($Action.transitionId)"
    & ao @sendArgs
    if ($LASTEXITCODE -ne 0) {
        throw "ao send failed (exit $LASTEXITCODE) for PR #$($Action.prNumber)"
    }

    return @{ sent = $true; reason = 'sent' }
}

function Invoke-CiGreenWakeTick {
    param(
        [string]$Project,
        [string]$StatePath,
        [switch]$DryRunMode,
        [string]$Fixture
    )

    $tracking = Get-CiGreenWakeState -Path $StatePath

    $ciChecksByPr = @{}
    $requiredCheckNamesByPr = @{}

    if ($Fixture) {
        $payload = Get-FixtureCiGreenWakePayload -Path $Fixture
        $openPrs = $payload.openPrs
        $sessions = $payload.sessions
        $ciChecksByPr = $payload.ciChecksByPr
        if ($payload.requiredCheckNamesByPr) {
            $requiredCheckNamesByPr = $payload.requiredCheckNamesByPr
        }
        if ($payload.tracking) {
            $tracking = $payload.tracking
        }
    }
    else {
        $openPrs = Invoke-GhOpenPrList
        $sessions = Get-AoStatusSessions
        $checksBundle = Get-CiGreenWakeChecksByPr -OpenPrs @($openPrs)
        $ciChecksByPr = $checksBundle.ciChecksByPr
        $requiredCheckNamesByPr = $checksBundle.requiredCheckNamesByPr
    }

    $planPayload = @{
        openPrs                = @($openPrs)
        sessions               = @($sessions)
        ciChecksByPr           = $ciChecksByPr
        requiredCheckNamesByPr = $requiredCheckNamesByPr
        tracking               = $tracking
    }

    $plan = Invoke-CiGreenWakeFilterCli -Subcommand 'plan' -Payload $planPayload
    $useFixtureSnapshot = [bool]$Fixture
    $fixtureFreshPayload = $null
    if ($useFixtureSnapshot) {
        $fixtureFreshPayload = @{
            openPrs                = @($openPrs)
            sessions               = @($sessions)
            ciChecksByPr           = $ciChecksByPr
            requiredCheckNamesByPr = $requiredCheckNamesByPr
        }
    }

    $sent = 0
    $nudged = @{}
    if ($tracking.nudged) {
        foreach ($prop in $tracking.nudged.PSObject.Properties) {
            $nudged[$prop.Name] = $prop.Value
        }
    }

    foreach ($action in @($plan.actions)) {
        if ($action.type -eq 'skip') {
            Write-CiGreenWakeLog "skip PR #$($action.prNumber): $($action.reason)"
            continue
        }
        if ($action.type -ne 'nudge') {
            continue
        }

        $result = Invoke-PlannedCiGreenWakeSend -Action $action -FreshPayload $fixtureFreshPayload `
            -Project $Project -DryRunMode:$DryRunMode -UseFixtureSnapshot:$useFixtureSnapshot
        if ($result.sent) {
            if (-not $DryRunMode) {
                $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                $nudged[[string]$action.transitionId] = @{
                    sessionId = [string]$action.sessionId
                    sentAtMs  = $nowMs
                }
            }
            $sent++
        }
    }

    $headRecords = @{}
    if ($plan.headRecords) {
        foreach ($prop in $plan.headRecords.PSObject.Properties) {
            $headRecords[$prop.Name] = $prop.Value
        }
    }

    $merged = @{
        heads      = $headRecords
        nudged     = $nudged
        lastTickMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    if (-not $DryRunMode) {
        Set-CiGreenWakeState -Path $StatePath -State $merged
    }

    return $sent
}

$intervalMinutes = Get-CiGreenWakeIntervalMinutes
$intervalMs = [Math]::Max(1, $intervalMinutes) * 60 * 1000
$pollMs = [Math]::Max(5, $PollSeconds) * 1000
$statePath = Get-CiGreenWakeStatePath -CliPath $StateFile

Write-CiGreenWakeLog "starting (project=$ProjectId, interval=${intervalMinutes}m, state=$statePath, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"
Write-CiGreenWakeLog "feasibility: AO 0.9.x has no CI-green send-to-agent reaction; this process is the fast path (worst-case ~${PollSeconds}s poll + ${intervalMinutes}m tick, << report-stale ~30m)"

if ($FixturePath) {
    $count = Invoke-CiGreenWakeTick -Project $ProjectId -StatePath $statePath -DryRunMode:$DryRun -Fixture $FixturePath
    Write-CiGreenWakeLog "fixture tick complete (sent=$count)"
    exit 0
}

try {
    do {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $state = Get-CiGreenWakeState -Path $statePath
        $lastTickMs = $null
        if ($state.lastTickMs) {
            $lastTickMs = [long]$state.lastTickMs
        }

        $gate = Invoke-CiGreenWakeFilterCli -Subcommand 'interval' -Payload @{
            nowMs      = $nowMs
            lastTickMs = $lastTickMs
            intervalMs = $intervalMs
        }

        if (-not $gate.ok) {
            Write-CiGreenWakeLog "tick skipped: $($gate.reason)"
        }
        else {
            try {
                $count = Invoke-CiGreenWakeTick -Project $ProjectId -StatePath $statePath -DryRunMode:$DryRun
                Write-CiGreenWakeLog "tick complete (sent=$count)"
            }
            catch {
                Write-CiGreenWakeLog "tick error: $_"
            }
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    Write-CiGreenWakeLog 'stopped'
}
