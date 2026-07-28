#requires -Version 5.1
param(
    [Parameter(Position = 0)]
    [string]$State = '',
    [string]$RepoRoot = '',
    [string]$SessionId = '',
    [string]$RepoSlug = '',
    [int]$PrNumber = 0,
    [string]$HeadSha = '',
    [string]$DeliveryRunId = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $Root 'scripts/lib/WorkerReportStore.ps1')
$DebugBinding = $env:AO_WORKER_REPORT_DEBUG -eq '1'


function Invoke-WorkerSmokeReadyGate {
    param(
        [string]$RepoRoot,
        [int]$PrNumber,
        [string]$HeadSha,
        [int]$IssueNumber,
        [string]$IssueBodyFile
    )

    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) {
        return @{ ok = $false; reason = 'node_runtime_missing' }
    }
    $launcher = Join-Path $RepoRoot 'scripts/lib/Invoke-TypeScriptCli.ts'
    $gateScript = Join-Path $RepoRoot 'scripts/worker-smoke-run.ts'
    $args = @(
        '--experimental-strip-types', $launcher.Source,
        '--script', $gateScript, '--',
        'gate-check',
        '--pr', [string]$PrNumber,
        '--head-sha', $HeadSha,
        '--issue-body-file', $IssueBodyFile,
        '--repo-root', $RepoRoot,
        '--cwd', $RepoRoot,
        '--json'
    )
    if ($IssueNumber -gt 0) {
        $args += @('--issue', [string]$IssueNumber)
    }
    $output = & $node.Source @args 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        return @{ ok = $false; reason = "worker_smoke_gate_failed:$output" }
    }
    try {
        $parsed = $output.Trim() | ConvertFrom-Json
        if (-not $parsed.ok) {
            return @{ ok = $false; reason = [string]$parsed.reason }
        }
        return @{ ok = $true; reason = [string]$parsed.reason }
    }
    catch {
        return @{ ok = $false; reason = 'worker_smoke_gate_parse_failed' }
    }
}

function Write-WorkerReportDebug {
    param([string]$Message)

    if ($DebugBinding) {
        [Console]::Error.WriteLine("pack-worker-report debug: $Message")
    }
}

$DebugBinding = $env:AO_WORKER_REPORT_DEBUG -eq '1'
function Write-WorkerReportDebug {
    param([string]$Message)
    if ($DebugBinding) {
        [Console]::Error.WriteLine("pack-worker-report debug: $Message")
    }
}

if ([string]::IsNullOrWhiteSpace($State)) {
    # Workers may lack a reportable state in defensive invocations; skip only the report write.
    exit 0
}

$CallerSessionId = Resolve-PackWorkerReportCallerSessionId
if (-not $SessionId) {
    if ($env:AO_WORKER_SESSION_ID) { $SessionId = $env:AO_WORKER_SESSION_ID }
    elseif ($env:AO_SESSION_ID) { $SessionId = $env:AO_SESSION_ID }
}
if (-not $RepoSlug) {
    if ($env:AO_REPO_SLUG) { $RepoSlug = $env:AO_REPO_SLUG }
    elseif ($env:GITHUB_REPOSITORY) { $RepoSlug = $env:GITHUB_REPOSITORY }
}
if (-not $PrNumber -and $env:AO_PR_NUMBER) {
    $PrNumber = [int]$env:AO_PR_NUMBER
}
if (-not $HeadSha) {
    if ($env:AO_HEAD_SHA) { $HeadSha = $env:AO_HEAD_SHA }
    elseif ($env:GITHUB_SHA) { $HeadSha = $env:GITHUB_SHA }
}
if (-not $HeadSha) {
    $headCwd = if ($RepoRoot -and (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
        $RepoRoot
    }
    else {
        (Get-Location).Path
    }
    $previous = Get-Location
    try {
        Set-Location $headCwd
        $HeadSha = [string]((& git rev-parse HEAD 2>$null | Select-Object -First 1))
    }
    finally {
        Set-Location $previous
    }
}

if (-not $RepoRoot -or -not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
    $cwd = (Get-Location).Path
    if (Test-Path -LiteralPath (Join-Path $cwd '.git') -PathType Container) {
        $RepoRoot = $cwd
    }
    else {
        $RepoRoot = $Root
    }
}
$RepoSlug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug -RepoRoot $RepoRoot

if (-not $CallerSessionId -or -not $SessionId -or [string]::IsNullOrWhiteSpace($HeadSha)) {
    Write-WorkerReportDebug "binding inputs incomplete callerSessionId=$([bool]$CallerSessionId) sessionId=$([bool]$SessionId) headSha=$([bool]$HeadSha)"
    # Binding is the trust boundary. Do not invent a substitute report channel.
    Write-WorkerReportDebug "binding inputs incomplete callerSessionId=$([bool]$CallerSessionId) sessionId=$([bool]$SessionId) headSha=$([bool]$HeadSha)"
    exit 0
}
if ($CallerSessionId -ne $SessionId) {
    Write-WorkerReportDebug "session mismatch caller=$CallerSessionId target=$SessionId"
    exit 0
}

$requestedPrNumber = $PrNumber
$requestedHeadSha = $HeadSha
$trustedBinding = Resolve-PackWorkerReportTrustedBinding -SessionId $CallerSessionId `
    -RepoRoot $RepoRoot -RepoSlug $RepoSlug -WorktreeHeadSha $HeadSha
if (-not $trustedBinding -or -not $trustedBinding.ok) {
    $reason = if ($trustedBinding -and $trustedBinding.reason) { [string]$trustedBinding.reason } else { 'trust_boundary_binding_unresolved' }
    Write-WorkerReportDebug "trusted binding rejected reason=$reason repoSlug=$RepoSlug headSha=$HeadSha"
    exit 0
}
$SessionId = [string]$CallerSessionId
$PrNumber = [int]$trustedBinding.prNumber
$HeadSha = [string]$trustedBinding.headSha
if (-not $RepoSlug) {
    $RepoSlug = Resolve-WorkerReportStoreRepoSlug -RepoSlug '' -RepoRoot $RepoRoot
}
if (-not $RepoSlug -or $PrNumber -le 0 -or [string]::IsNullOrWhiteSpace($HeadSha)) {
    exit 0
}
$DeliveryRunId = Resolve-PackWorkerReportDeliveryRunId -ReportState $State -SessionId $SessionId `
    -PrNumber $PrNumber -HeadSha $HeadSha -DeliveryRunId $DeliveryRunId
if (($requestedPrNumber -gt 0 -and $requestedPrNumber -ne $PrNumber) `
        -or (-not [string]::IsNullOrWhiteSpace($requestedHeadSha) -and $requestedHeadSha -ne $HeadSha)) {
    Write-WorkerReportDebug "requested binding differs from trusted binding requestedPr=$requestedPrNumber trustedPr=$PrNumber"
    exit 0
}

if ($DryRun) {
    $record = @{
        reportState = $State
        accepted    = $true
        sessionId   = $SessionId
        repoSlug    = $RepoSlug
        prNumber    = $PrNumber
        headSha     = $HeadSha
    }
    if ($DeliveryRunId) {
        $record.deliveryRunId = $DeliveryRunId
    }
    [pscustomobject]@{
        ok     = $true
        dryRun = $true
        record = $record
    } | ConvertTo-Json -Compress -Depth 10
    exit 0
}


if ($State -eq 'ready_for_review') {
    $issueNumber = 0
    if ($env:AO_ISSUE_NUMBER) {
        $issueNumber = [int]$env:AO_ISSUE_NUMBER
    }
    $issueBodyFile = New-TemporaryFile
    try {
        if ($issueNumber -gt 0) {
            $issueJson = & gh issue view $issueNumber --json body 2>$null
            if ($LASTEXITCODE -eq 0 -and $issueJson) {
                $issueBody = ([string](ConvertFrom-Json $issueJson).body)
                Set-Content -LiteralPath $issueBodyFile.FullName -Value $issueBody -Encoding utf8NoBOM
            }
        }
        if (-not (Test-Path -LiteralPath $issueBodyFile.FullName) -or (Get-Item $issueBodyFile.FullName).Length -eq 0) {
            Set-Content -LiteralPath $issueBodyFile.FullName -Value '' -Encoding utf8NoBOM
        }
        $smokeGate = Invoke-WorkerSmokeReadyGate -RepoRoot $RepoRoot -PrNumber $PrNumber -HeadSha $HeadSha -IssueNumber $issueNumber -IssueBodyFile $issueBodyFile.FullName
        if (-not $smokeGate.ok) {
            Write-WorkerReportDebug "worker smoke gate rejected ready_for_review reason=$($smokeGate.reason)"
            [pscustomobject]@{
                ok     = $false
                reason = $smokeGate.reason
                state  = $State
            } | ConvertTo-Json -Compress -Depth 5
            exit 1
        }
    }
    finally {
        Remove-Item -LiteralPath $issueBodyFile.FullName -Force -ErrorAction SilentlyContinue
    }
}

try {
    $result = Write-PackWorkerReportRecord -ReportState $State -SessionId $SessionId -RepoSlug $RepoSlug `
        -PrNumber $PrNumber -HeadSha $HeadSha -CallerSessionId $CallerSessionId -RepoRoot $RepoRoot `
        -TrustedBinding $trustedBinding -DeliveryRunId $DeliveryRunId
    $result | ConvertTo-Json -Compress -Depth 20
}
catch {
    Write-WorkerReportDebug "store write failed: $($_.Exception.Message)"
    exit 0
}
