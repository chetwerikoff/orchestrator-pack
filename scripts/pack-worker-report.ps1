#requires -Version 5.1
param(
    [Parameter(Position = 0)][string]$State = '',
    [string]$RepoRoot = '',
    [string]$Runtime = '',
    [string]$WorkerId = '',
    [string]$Generation = '',
    [string]$RepoSlug = '',
    [int]$PrNumber = 0,
    [string]$HeadSha = '',
    [string]$DeliveryRunId = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $Root 'scripts/lib/WorkerReportStore.ps1')
$DebugBinding = $env:OPK_WORKER_REPORT_DEBUG -eq '1'

function Write-WorkerReportDebug {
    param([string]$Message)
    if ($DebugBinding) { [Console]::Error.WriteLine("pack-worker-report debug: $Message") }
}

function Invoke-WorkerSmokeReadyGate {
    param([string]$RepoRoot, [int]$PrNumber, [string]$HeadSha, [int]$IssueNumber, [string]$IssueBodyFile)
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { return @{ ok = $false; reason = 'node_runtime_missing' } }
    $args = @(
        '--experimental-strip-types', (Join-Path $RepoRoot 'scripts/lib/Invoke-TypeScriptCli.ts'),
        '--script', (Join-Path $RepoRoot 'scripts/worker-smoke-run.ts'), '--', 'gate-check',
        '--pr', [string]$PrNumber, '--head-sha', $HeadSha, '--issue-body-file', $IssueBodyFile,
        '--repo-root', $RepoRoot, '--cwd', $RepoRoot, '--json'
    )
    if ($IssueNumber -gt 0) { $args += @('--issue', [string]$IssueNumber) }
    $output = & $node.Source @args 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { return @{ ok = $false; reason = "worker_smoke_gate_failed:$output" } }
    try {
        $parsed = $output.Trim() | ConvertFrom-Json
        return @{ ok = [bool]$parsed.ok; reason = [string]$parsed.reason }
    }
    catch { return @{ ok = $false; reason = 'worker_smoke_gate_parse_failed' } }
}

if ([string]::IsNullOrWhiteSpace($State)) { exit 0 }
if (-not $RepoRoot -or -not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
    $cwd = (Get-Location).Path
    $RepoRoot = if (Test-Path -LiteralPath (Join-Path $cwd '.git')) { $cwd } else { $Root }
}
$HeadSha = Resolve-PackWorkerReportWorktreeHeadSha -RepoRoot $RepoRoot -HeadSha $HeadSha
$RepoSlug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug -RepoRoot $RepoRoot
if (-not $HeadSha -or -not $RepoSlug) { Write-WorkerReportDebug 'missing GitHub/repository binding'; exit 0 }

$resolvedWorker = Resolve-PackWorkerReportRuntimeWorker -RepoRoot $RepoRoot -Runtime $Runtime `
    -WorkerId $WorkerId -Generation $Generation
if (-not $resolvedWorker.ok) { Write-WorkerReportDebug "worker binding rejected: $($resolvedWorker.reason)"; exit 0 }
$worker = $resolvedWorker.worker
$trustedBinding = Resolve-PackWorkerReportTrustedBinding -Worker $worker -RepoRoot $RepoRoot `
    -WorktreeHeadSha $HeadSha -PrNumber $PrNumber
if (-not $trustedBinding.ok) { Write-WorkerReportDebug "PR/head binding rejected: $($trustedBinding.reason)"; exit 0 }
$PrNumber = [int]$trustedBinding.prNumber
$HeadSha = [string]$trustedBinding.headSha
$DeliveryRunId = Resolve-PackWorkerReportDeliveryRunId -ReportState $State -PrNumber $PrNumber `
    -HeadSha $HeadSha -DeliveryRunId $DeliveryRunId

if ($DryRun) {
    $record = @{ reportState = $State; accepted = $true; worker = $worker; repoSlug = $RepoSlug; prNumber = $PrNumber; headSha = $HeadSha }
    if ($DeliveryRunId) { $record.deliveryRunId = $DeliveryRunId }
    [pscustomobject]@{ ok = $true; dryRun = $true; record = $record } | ConvertTo-Json -Compress -Depth 10
    exit 0
}

if ($State -eq 'ready_for_review') {
    $issueNumber = 0
    $issueBody = ''
    try {
        $prJson = & gh pr view $PrNumber --json body 2>$null
        if ($LASTEXITCODE -eq 0 -and $prJson) {
            $body = [string](ConvertFrom-Json $prJson).body
            if ($body -match '(?im)^\s*(?:Closes|Fixes|Resolves)\s+#(\d+)') { $issueNumber = [int]$Matches[1] }
        }
        if ($issueNumber -gt 0) {
            $issueJson = & gh issue view $issueNumber --json body 2>$null
            if ($LASTEXITCODE -eq 0 -and $issueJson) { $issueBody = [string](ConvertFrom-Json $issueJson).body }
        }
    }
    catch { $issueBody = '' }
    $issueBodyFile = New-TemporaryFile
    try {
        [System.IO.File]::WriteAllText($issueBodyFile.FullName, $issueBody, [System.Text.UTF8Encoding]::new($false))
        $gate = Invoke-WorkerSmokeReadyGate -RepoRoot $RepoRoot -PrNumber $PrNumber -HeadSha $HeadSha `
            -IssueNumber $issueNumber -IssueBodyFile $issueBodyFile.FullName
        if (-not $gate.ok) {
            [pscustomobject]@{ ok = $false; reason = $gate.reason; state = $State } | ConvertTo-Json -Compress -Depth 5
            exit 1
        }
    }
    finally { Remove-Item -LiteralPath $issueBodyFile.FullName -Force -ErrorAction SilentlyContinue }
}

try {
    $result = Write-PackWorkerReportRecord -ReportState $State -Worker $worker -RepoSlug $RepoSlug `
        -PrNumber $PrNumber -HeadSha $HeadSha -RepoRoot $RepoRoot -TrustedBinding $trustedBinding `
        -DeliveryRunId $DeliveryRunId
    $result | ConvertTo-Json -Compress -Depth 20
}
catch {
    Write-WorkerReportDebug "store write failed: $($_.Exception.Message)"
    exit 0
}
