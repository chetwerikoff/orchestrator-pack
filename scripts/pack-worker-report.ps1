#requires -Version 5.1
param(
    [Parameter(Position = 0)]
    [string]$State = '',
    [string]$RepoRoot = '',
    [string]$SessionId = '',
    [string]$RepoSlug = '',
    [int]$PrNumber = 0,
    [string]$HeadSha = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $Root 'scripts/lib/WorkerReportStore.ps1')

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

if (-not $CallerSessionId -or -not $SessionId -or -not $RepoSlug -or -not $PrNumber -or -not $HeadSha) {
    # Binding is the trust boundary. Do not invent a substitute report channel.
    exit 0
}
if ($CallerSessionId -ne $SessionId) {
    exit 0
}

if ($DryRun) {
    [pscustomobject]@{
        ok     = $true
        dryRun = $true
        record = @{
            reportState = $State
            accepted    = $true
            sessionId   = $SessionId
            repoSlug    = $RepoSlug
            prNumber    = $PrNumber
            headSha     = $HeadSha
        }
    } | ConvertTo-Json -Compress -Depth 10
    exit 0
}

try {
    $result = Write-PackWorkerReportRecord -ReportState $State -SessionId $SessionId -RepoSlug $RepoSlug `
        -PrNumber $PrNumber -HeadSha $HeadSha -CallerSessionId $CallerSessionId
    $result | ConvertTo-Json -Compress -Depth 20
}
catch {
    exit 0
}
