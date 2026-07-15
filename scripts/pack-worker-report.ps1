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
