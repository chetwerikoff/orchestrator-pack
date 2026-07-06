#requires -Version 7.0
<#
.SYNOPSIS
  AO 0.10 argv-shape guard (Issue #619 AC#4).
#>
[CmdletBinding()]
param(
    [switch]$LiveDoctor,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$CapturesDir = Join-Path $Root 'tests/external-output-references/captures/ao-0-10-cli'
$Lib = Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1'

function Get-ResolvedAoExecutable {
    $cmd = Get-Command ao -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    return $cmd.Source
}

function Test-AoCaptureEnvelope {
    param(
        [string]$Path,
        [string[]]$RequiredTopLevel
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "missing capture: $Path"
    }
    $payload = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    foreach ($key in $RequiredTopLevel) {
        if ($payload.PSObject.Properties.Name -notcontains $key) {
            throw "capture $Path missing top-level '$key'"
        }
    }
    return $payload
}

function Invoke-AoArgvProbe {
    param(
        [string[]]$AoArgs,
        [string]$Label
    )

    $aoPath = Get-ResolvedAoExecutable
    if (-not $aoPath) {
        Write-Host "[SKIP] argv probe '$Label': ao not found on PATH"
        return
    }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & $aoPath @AoArgs 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "argv rejected for '$Label': ao $($AoArgs -join ' ') (exit $LASTEXITCODE)"
        }
        Write-Host "[PASS] argv probe: $Label"
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
}

function Test-OrchestratorLsRejectsIncludeTerminated {
    $aoPath = Get-ResolvedAoExecutable
    if (-not $aoPath) {
        Write-Host '[SKIP] orchestrator ls --include-terminated rejection probe: ao not found'
        return
    }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & $aoPath orchestrator ls --json --include-terminated 2>&1
        if ($LASTEXITCODE -eq 0) {
            throw 'expected ao orchestrator ls --include-terminated to be rejected on AO 0.10'
        }
        Write-Host '[PASS] ao orchestrator ls rejects --include-terminated'
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
}

if ($SelfTest) {
    $tempRoot = if ($env:TEMP) { $env:TEMP } elseif ($env:TMPDIR) { $env:TMPDIR } else { '/tmp' }
    $mutated = Join-Path $tempRoot ("ao-capture-mutate-$([guid]::NewGuid()).json")
    try {
        Copy-Item -LiteralPath (Join-Path $CapturesDir 'daemon-status.raw.json') -Destination $mutated
        $bad = Get-Content -LiteralPath $mutated -Raw | ConvertFrom-Json
        $bad.PSObject.Properties.Remove('state')
        $bad | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $mutated -Encoding utf8
        try {
            Test-AoCaptureEnvelope -Path $mutated -RequiredTopLevel @('state', 'health')
            throw 'self-test: mutated capture should have failed envelope validation'
        }
        catch {
            if ($_.Exception.Message -notmatch "missing top-level 'state'") {
                throw
            }
        }
        Write-Host '[PASS] argv-shape guard self-test (capture mutation fails closed)'
        exit 0
    }
    finally {
        Remove-Item -LiteralPath $mutated -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '== AO 0.10 argv-shape guard (Issue #619) =='
$aoPath = Get-ResolvedAoExecutable
if ($aoPath) {
  $version = try { (& $aoPath version 2>&1 | Out-String).Trim() } catch { 'unknown' }
  Write-Host "ao executable: $aoPath"
  Write-Host "ao version: $version"
}
else {
  Write-Host 'ao executable: (not on PATH — deterministic capture tier only)'
}

# Deterministic capture envelope checks
$null = Test-AoCaptureEnvelope -Path (Join-Path $CapturesDir 'daemon-status.raw.json') -RequiredTopLevel @('state', 'health', 'ready', 'dataDir')
$sessionLs = Test-AoCaptureEnvelope -Path (Join-Path $CapturesDir 'session-ls.raw.json') -RequiredTopLevel @('data', 'meta')
$orchLs = Test-AoCaptureEnvelope -Path (Join-Path $CapturesDir 'orchestrator-ls.raw.json') -RequiredTopLevel @('data')
$sessionGet = Test-AoCaptureEnvelope -Path (Join-Path $CapturesDir 'session-get-worker.raw.json') -RequiredTopLevel @('session')
if ($sessionGet.session.PSObject.Properties.Name -contains 'reports') {
    throw 'session-get capture must not include session.reports on AO 0.10'
}
if ($orchLs.data[0].isTerminated -ne $true) {
    throw 'orchestrator-ls capture must document terminated rows in default listing (data[0].isTerminated=true)'
}
Write-Host '[PASS] deterministic AO 0.10 capture envelope checks'

# Live argv acceptance probes (no running session required)
Invoke-AoArgvProbe -AoArgs @('status', '--json') -Label 'ao status --json'
Invoke-AoArgvProbe -AoArgs @('session', 'ls', '--json') -Label 'ao session ls --json'
Invoke-AoArgvProbe -AoArgs @('session', 'ls', '--json', '-p', 'orchestrator-pack') -Label 'ao session ls --json -p orchestrator-pack'
Invoke-AoArgvProbe -AoArgs @('session', 'ls', '--json', '--include-terminated') -Label 'ao session ls --json --include-terminated'
Invoke-AoArgvProbe -AoArgs @('session', 'ls', '--json', '-p', 'orchestrator-pack', '--include-terminated') -Label 'ao session ls --json -p orchestrator-pack --include-terminated'
Invoke-AoArgvProbe -AoArgs @('orchestrator', 'ls', '--json') -Label 'ao orchestrator ls --json'
Test-OrchestratorLsRejectsIncludeTerminated

$sampleId = $null
if ($sessionLs.data -and $sessionLs.data.Count -gt 0) {
    $sampleId = [string]$sessionLs.data[0].id
}
if ($sampleId) {
    Invoke-AoArgvProbe -AoArgs @('session', 'get', $sampleId, '--json', '-p', 'orchestrator-pack') -Label "ao session get $sampleId --json -p orchestrator-pack"
}
else {
    Write-Host '[SKIP] session get argv probe: no session id in capture'
}

if ($LiveDoctor) {
    Write-Host '== live doctor tier (operator-only) =='
    . $Lib
    $health = Get-AoDaemonHealthJson
    if (-not $health.state) { throw 'live doctor: ao status missing state' }
    $workers = Get-AoSessionLsJson
    $orch = Get-AoOrchestratorLsJson
    Assert-AoListPayloadShape -Payload $workers -Label 'live ao session ls'
    Assert-AoListPayloadShape -Payload $orch -Label 'live ao orchestrator ls'
    $liveId = $null
    if ($workers.data -and $workers.data.Count -gt 0) {
        $liveId = [string]$workers.data[0].id
    }
    if ($liveId) {
        $detail = Get-AoSessionGetJson -SessionId $liveId -Project 'orchestrator-pack'
        if ($detail.session.PSObject.Properties.Name -contains 'reports') {
            throw 'live doctor: ao session get must not expose session.reports on AO 0.10'
        }
        Write-Host "[PASS] live doctor: ao session get $liveId"
    }
    else {
        Write-Host '[SKIP] live doctor session get: no live worker session row'
    }
}

Write-Host '[PASS] AO 0.10 argv-shape guard (Issue #619)'
exit 0
